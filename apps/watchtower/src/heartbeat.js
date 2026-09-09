import { RestIndexerProvider } from "@arkade-os/sdk";

const arkadeUrl = process.env.ARKADE_URL;
const ingestUrl = process.env.INGEST_URL;
const ingestToken = process.env.INGEST_TOKEN;
const entries = JSON.parse(process.env.WATCH_ENTRIES_JSON ?? "[]");

if (!arkadeUrl || !ingestUrl || !ingestToken) {
  throw new Error("ARKADE_URL, INGEST_URL, and INGEST_TOKEN are required");
}
if (!Array.isArray(entries) || entries.length === 0) throw new Error("At least one watch entry is required");

const indexer = new RestIndexerProvider(arkadeUrl);
const reports = await Promise.all(entries.map(async (entry) => {
  if (!entry.id || !entry.contractId || !entry.script || !entry.finalAt) {
    throw new Error("Every watch entry requires id, contractId, script, and finalAt");
  }
  const [spendableResult, recoverableResult] = await Promise.all([
    indexer.getVtxos({ scripts: [entry.script], spendableOnly: true }),
    indexer.getVtxos({ scripts: [entry.script], recoverableOnly: true }),
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

const response = await fetch(ingestUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
  body: JSON.stringify({ sentAt: new Date().toISOString(), entries: reports }),
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`Watchtower ingest returned ${response.status}`);
console.log(JSON.stringify({ event: "watch-heartbeat-sent", entries: reports.length }));
