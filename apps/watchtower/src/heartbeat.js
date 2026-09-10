import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";

const arkadeUrl = process.env.ARKADE_URL;
const ingestUrl = process.env.INGEST_URL;
const ingestToken = process.env.INGEST_TOKEN;
const configuredEntries = JSON.parse(process.env.WATCH_ENTRIES_JSON ?? "[]");
const escrowRoot = process.env.ESCROW_ROOT;

if (!arkadeUrl || !ingestUrl || !ingestToken) {
  throw new Error("ARKADE_URL, INGEST_URL, and INGEST_TOKEN are required");
}
if (!Array.isArray(configuredEntries)) throw new Error("WATCH_ENTRIES_JSON must be an array");

const readOptionalJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const loadCatalogEntries = () => {
  if (!escrowRoot) return [];
  const directory = resolve(escrowRoot, "contracts");
  const supervisor = readOptionalJson(resolve(escrowRoot, "renewal-supervisor-status.json"));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "active.json")
    .flatMap((name) => {
      try {
        const record = JSON.parse(readFileSync(resolve(directory, name), "utf8"));
        if (!record.contractId || !record.escrowAddress || !Number.isSafeInteger(record.refundAt)) return [];
        const opaqueId = createHash("sha256").update(record.contractId).digest("hex").slice(0, 24);
        const opaqueMandateId = record.hardenedRenewal?.mandateId
          ? createHash("sha256").update(record.hardenedRenewal.mandateId).digest("hex").slice(0, 24)
          : undefined;
        const supervisorResult = supervisor?.results?.find((result) => result.contractId === record.contractId);
        const mandate = record.hardenedRenewal?.mandatePath
          ? readOptionalJson(record.hardenedRenewal.mandatePath)
          : undefined;
        const journal = record.hardenedRenewal?.mandateId
          ? readOptionalJson(resolve(escrowRoot, "renewal-journals", `${record.hardenedRenewal.mandateId}.json`))
          : undefined;
        const exitBundle = record.hardenedRenewal?.mandateId
          ? readOptionalJson(resolve(escrowRoot, "unilateral-exit-bundles", `${record.hardenedRenewal.mandateId}.json`))
          : undefined;
        return [{
          id: opaqueId,
          contractId: opaqueId,
          address: record.escrowAddress,
          finalAt: new Date(record.refundAt * 1_000).toISOString(),
          expectedValueSats: Number.isSafeInteger(record.expectedAmountSats) ? record.expectedAmountSats : undefined,
          renewal: record.schemaVersion === 6 && opaqueMandateId ? {
            mandateId: opaqueMandateId,
            supervisorCheckedAt: supervisor?.checkedAt,
            supervisorState: supervisorResult?.state ?? "not-yet-observed",
            maxRenewals: record.hardenedRenewal.maxRenewals,
            completedRenewals: Array.isArray(journal?.receipts) ? journal.receipts.length : 0,
            exitBundleUpdatedAt: exitBundle?.updatedAt,
            signerCount: Array.isArray(record.hardenedRenewal.renewalPubkeys) ? record.hardenedRenewal.renewalPubkeys.length : 0,
            delegateCount: Array.isArray(record.hardenedRenewal.delegatePubkeys) ? record.hardenedRenewal.delegatePubkeys.length : 0,
            _delegates: Array.isArray(mandate?.terms?.delegates) ? mandate.terms.delegates : [],
          } : undefined,
        }];
      } catch {
        return [];
      }
    });
};

const entries = configuredEntries.length > 0 ? configuredEntries : loadCatalogEntries();
if (entries.length === 0 && !escrowRoot) throw new Error("Set WATCH_ENTRIES_JSON or ESCROW_ROOT");
const scriptFor = (entry) => {
  if (entry.script) return entry.script;
  if (!entry.address) throw new Error("Watch entry requires script or Arkade address");
  const decoded = ArkAddress.decode(entry.address);
  return Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(decoded.vtxoTaprootKey)]).toString("hex");
};

const probeDelegate = async (delegate) => {
  try {
    const response = await fetch(`${delegate.url}/v1/delegate/info`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const info = await response.json();
    return String(info.pubkey ?? "").replace(/^(02|03)/, "").toLowerCase() === String(delegate.pubkey).toLowerCase();
  } catch {
    return false;
  }
};

const monitoredEntries = await Promise.all(entries.map(async (entry) => {
  if (!entry.renewal) return entry;
  const delegates = Array.isArray(entry.renewal._delegates) ? entry.renewal._delegates : [];
  const health = await Promise.all(delegates.map(probeDelegate));
  const { _delegates, ...renewal } = entry.renewal;
  return { ...entry, renewal: { ...renewal, delegateOnlineCount: health.filter(Boolean).length } };
}));

const indexer = new RestIndexerProvider(arkadeUrl);
const reports = await Promise.all(monitoredEntries.map(async (entry) => {
  if (!entry.id || !entry.contractId || !entry.finalAt) {
    throw new Error("Every watch entry requires id, contractId, and finalAt");
  }
  const script = scriptFor(entry);
  const [spendableResult, recoverableResult] = await Promise.all([
    indexer.getVtxos({ scripts: [script], spendableOnly: true }),
    indexer.getVtxos({ scripts: [script], recoverableOnly: true }),
  ]);
  const expiries = spendableResult.vtxos
    .map((coin) => coin.expiresAt?.toISOString())
    .filter(Boolean)
    .sort();
  return {
    id: entry.id,
    contractId: entry.contractId,
    finalAt: entry.finalAt,
    expectedValueSats: entry.expectedValueSats,
    totalSats: spendableResult.vtxos.reduce((sum, coin) => sum + Number(coin.value), 0),
    recoverableSats: recoverableResult.vtxos.reduce((sum, coin) => sum + Number(coin.value), 0),
    spendableCount: spendableResult.vtxos.length,
    earliestExpiry: expiries[0],
    renewal: entry.renewal,
  };
}));
const fundedReports = reports.filter((entry) => entry.totalSats > 0 || entry.recoverableSats > 0);

const response = await fetch(ingestUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
  body: JSON.stringify({ sentAt: new Date().toISOString(), entries: fundedReports }),
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`Watchtower ingest returned ${response.status}: ${await response.text()}`);
console.log(JSON.stringify({ event: "watch-heartbeat-sent", entries: fundedReports.length }));
