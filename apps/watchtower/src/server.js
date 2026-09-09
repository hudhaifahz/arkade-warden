import { createServer } from "node:http";
import { RestIndexerProvider } from "@arkade-os/sdk";
import { alertFingerprint, classifyEntry } from "./policy.js";

const port = Number(process.env.PORT ?? "3000");
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "300000");
const alertCooldownMs = Number(process.env.ALERT_COOLDOWN_MS ?? "3600000");
const arkadeUrl = process.env.ARKADE_URL;
const watchEntries = JSON.parse(process.env.WATCH_ENTRIES_JSON ?? "[]");
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
const alertWebhookBearer = process.env.ALERT_WEBHOOK_BEARER;

if (!arkadeUrl) throw new Error("ARKADE_URL is required");
if (!Array.isArray(watchEntries)) throw new Error("WATCH_ENTRIES_JSON must be an array");
for (const entry of watchEntries) {
  if (!entry.id || !entry.contractId || !entry.script || !entry.finalAt) {
    throw new Error("Every watch entry requires id, contractId, script, and finalAt");
  }
}

const indexer = new RestIndexerProvider(arkadeUrl);
const alerts = new Map();
let snapshot = {
  checkedAt: undefined,
  healthy: false,
  entries: [],
  serviceError: "Initial check has not completed",
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

const notify = async (report) => {
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
      checkedAt: snapshot.checkedAt,
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

const checkEntry = async (entry) => {
  const [spendableResult, recoverableResult, macOnline] = await Promise.all([
    indexer.getVtxos({ scripts: [entry.script], spendableOnly: true }),
    indexer.getVtxos({ scripts: [entry.script], recoverableOnly: true }),
    checkMac(entry.healthUrl),
  ]);
  return classifyEntry({
    entry,
    spendable: spendableResult.vtxos,
    recoverable: recoverableResult.vtxos,
    macOnline,
  });
};

const checkAll = async () => {
  const checkedAt = new Date().toISOString();
  try {
    const entries = await Promise.all(watchEntries.map(checkEntry));
    snapshot = {
      checkedAt,
      healthy: entries.every((entry) => entry.status === "healthy"),
      entries,
      serviceError: undefined,
    };
    for (const report of entries) {
      await notify(report).catch((error) => console.error("Alert delivery failed", error));
    }
    console.log(JSON.stringify({ event: "watch-check", checkedAt, entries: entries.map(({ id, status, findings }) => ({ id, status, findings })) }));
  } catch (error) {
    snapshot = { checkedAt, healthy: false, entries: [], serviceError: String(error?.message ?? error) };
    console.error("Watch check failed", error);
  }
};

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return response.end(JSON.stringify({ service: "ok", checkedAt: snapshot.checkedAt }));
  }
  if (url.pathname === "/status") {
    response.writeHead(snapshot.serviceError ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
    return response.end(JSON.stringify(snapshot));
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Arkade watchtower listening on ${port}`);
  void checkAll();
});
setInterval(() => void checkAll(), pollIntervalMs).unref();
