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

const loadCatalogEntries = () => {
  if (!escrowRoot) return [];
  const directory = resolve(escrowRoot, "contracts");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "active.json")
    .flatMap((name) => {
      try {
        const record = JSON.parse(readFileSync(resolve(directory, name), "utf8"));
        if (!record.contractId || !record.escrowAddress || !Number.isSafeInteger(record.refundAt)) return [];
        const opaqueId = createHash("sha256").update(record.contractId).digest("hex").slice(0, 24);
        return [{
          id: opaqueId,
          contractId: opaqueId,
          address: record.escrowAddress,
          finalAt: new Date(record.refundAt * 1_000).toISOString(),
          expectedValueSats: Number.isSafeInteger(record.expectedValueSats) ? record.expectedValueSats : undefined,
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

const indexer = new RestIndexerProvider(arkadeUrl);
const reports = await Promise.all(entries.map(async (entry) => {
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
