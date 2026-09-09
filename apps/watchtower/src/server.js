import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RestIndexerProvider } from "@arkade-os/sdk";
import { alertFingerprint, classifyEntry } from "./policy.js";

const port = Number(process.env.PORT ?? "3000");
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "300000");
const heartbeatStaleMs = Number(process.env.HEARTBEAT_STALE_MS ?? "900000");
const alertCooldownMs = Number(process.env.ALERT_COOLDOWN_MS ?? "3600000");
const arkadeUrl = process.env.ARKADE_URL;
const directEntries = JSON.parse(process.env.WATCH_ENTRIES_JSON ?? "[]");
const ingestToken = process.env.INGEST_TOKEN;
const statusToken = process.env.STATUS_TOKEN;
const statePath = process.env.STATE_PATH;
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
const alertWebhookBearer = process.env.ALERT_WEBHOOK_BEARER;
const mode = arkadeUrl ? "direct" : "heartbeat";

if (!Array.isArray(directEntries)) throw new Error("WATCH_ENTRIES_JSON must be an array");
if (mode === "heartbeat" && (!ingestToken || ingestToken.length < 32)) {
  throw new Error("Heartbeat mode requires an INGEST_TOKEN of at least 32 characters");
}
for (const entry of directEntries) {
  if (!entry.id || !entry.contractId || !entry.script || !entry.finalAt) {
    throw new Error("Every direct watch entry requires id, contractId, script, and finalAt");
  }
}

const indexer = arkadeUrl ? new RestIndexerProvider(arkadeUrl) : undefined;
const alerts = new Map();
const loadHeartbeat = () => {
  if (!statePath || !existsSync(statePath)) return undefined;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    console.error("Could not load prior heartbeat state", error);
    return undefined;
  }
};
let latestHeartbeat = loadHeartbeat();
let snapshot = {
  mode,
  checkedAt: undefined,
  healthy: false,
  entries: [],
  serviceError: mode === "heartbeat" ? "Waiting for first home heartbeat" : "Initial check has not completed",
};

const tokenMatches = (provided, expected) => {
  if (!provided || !expected) return false;
  const received = createHash("sha256").update(provided).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(received, wanted);
};
const bearer = (request) => String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

const readJson = async (request, maxBytes = 250_000) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const saveHeartbeat = (heartbeat) => {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
};

const checkMac = async (healthUrl) => {
  if (!healthUrl) return true;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    return response.ok;
  } catch {
    return false;
  }
};

const notify = async (report, checkedAt) => {
  if (!alertWebhookUrl || report.findings.length === 0) return;
  const fingerprint = alertFingerprint(report);
  const previous = alerts.get(report.id);
  if (previous?.fingerprint === fingerprint && Date.now() - previous.sentAt < alertCooldownMs) return;
  const headers = { "content-type": "application/json" };
  if (alertWebhookBearer) headers.authorization = `Bearer ${alertWebhookBearer}`;
  const response = await fetch(alertWebhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "frontier-crown-arkade-watchtower",
      checkedAt,
      report: {
        id: report.id,
        contractId: report.contractId,
        status: report.status,
        totalSats: report.totalSats,
        recoverableSats: report.recoverableSats,
        earliestExpiry: report.earliestExpiry,
        finalAt: report.finalAt,
        findings: report.findings,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Alert webhook returned ${response.status}`);
  alerts.set(report.id, { fingerprint, sentAt: Date.now() });
};

const checkDirectEntry = async (entry) => {
  const [spendableResult, recoverableResult, macOnline] = await Promise.all([
    indexer.getVtxos({ scripts: [entry.script], spendableOnly: true }),
    indexer.getVtxos({ scripts: [entry.script], recoverableOnly: true }),
    checkMac(entry.healthUrl),
  ]);
  return classifyEntry({ entry, spendable: spendableResult.vtxos, recoverable: recoverableResult.vtxos, macOnline });
};

const checkHeartbeatEntry = (entry, homeOnline) => classifyEntry({
  entry,
  spendable: entry.spendableCount > 0 ? [{ value: entry.totalSats, expiresAt: entry.earliestExpiry }] : [],
  recoverable: entry.recoverableSats > 0 ? [{ value: entry.recoverableSats, expiresAt: entry.earliestExpiry }] : [],
  macOnline: homeOnline,
});

const checkAll = async () => {
  const checkedAt = new Date().toISOString();
  try {
    let entries;
    if (mode === "direct") {
      entries = await Promise.all(directEntries.map(checkDirectEntry));
    } else {
      if (!latestHeartbeat?.receivedAt || !Array.isArray(latestHeartbeat.entries)) {
        throw new Error("Waiting for first home heartbeat");
      }
      const homeOnline = Date.now() - Date.parse(latestHeartbeat.receivedAt) <= heartbeatStaleMs;
      entries = latestHeartbeat.entries.map((entry) => checkHeartbeatEntry(entry, homeOnline));
    }
    snapshot = {
      mode,
      checkedAt,
      heartbeatReceivedAt: latestHeartbeat?.receivedAt,
      healthy: entries.every((entry) => entry.status === "healthy"),
      entries,
      serviceError: undefined,
    };
    for (const report of entries) {
      await notify(report, checkedAt).catch((error) => console.error("Alert delivery failed", error));
    }
    console.log(JSON.stringify({ event: "watch-check", checkedAt, entries: entries.map(({ id, status, findings }) => ({ id, status, findings })) }));
  } catch (error) {
    snapshot = { mode, checkedAt, healthy: false, entries: [], serviceError: String(error?.message ?? error) };
    console.error("Watch check failed", error);
  }
};

const respondJson = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/healthz") return respondJson(response, 200, { service: "ok", mode, checkedAt: snapshot.checkedAt });
    if (url.pathname === "/ingest" && request.method === "POST" && mode === "heartbeat") {
      if (!tokenMatches(bearer(request), ingestToken)) return respondJson(response, 401, { error: "Unauthorized" });
      const body = await readJson(request);
      if (!Array.isArray(body.entries)) throw new Error("Heartbeat entries must be an array");
      for (const entry of body.entries) {
        if (!entry.id || !entry.contractId || !entry.finalAt || !Number.isSafeInteger(entry.totalSats) || !Number.isSafeInteger(entry.recoverableSats)) {
          throw new Error("Heartbeat entry is invalid");
        }
      }
      latestHeartbeat = { receivedAt: new Date().toISOString(), sentAt: body.sentAt, entries: body.entries };
      saveHeartbeat(latestHeartbeat);
      await checkAll();
      return respondJson(response, 202, { ok: true, checkedAt: snapshot.checkedAt });
    }
    if (url.pathname === "/status") {
      if (statusToken && !tokenMatches(bearer(request), statusToken)) return respondJson(response, 401, { error: "Unauthorized" });
      return respondJson(response, snapshot.serviceError ? 503 : 200, snapshot);
    }
    return respondJson(response, 404, { error: "Not found" });
  } catch (error) {
    return respondJson(response, 400, { error: String(error?.message ?? error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Arkade watchtower listening on ${port} in ${mode} mode`);
  void checkAll();
});
setInterval(() => void checkAll(), pollIntervalMs).unref();
