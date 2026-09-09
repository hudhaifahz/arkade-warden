import assert from "node:assert/strict";
import test from "node:test";
import { classifyEntry } from "../src/policy.js";

const now = new Date("2026-09-09T12:00:00Z");
const entry = {
  id: "test",
  contractId: "contract",
  finalAt: "2026-10-01T12:00:00Z",
  expectedValueSats: 1_000,
};
const coin = (expiresAt, value = 1_000) => ({ value, expiresAt });

test("reports healthy while expiry is outside renewal window", () => {
  const report = classifyEntry({ entry, spendable: [coin("2026-09-15T12:00:00Z")], recoverable: [], now });
  assert.equal(report.status, "healthy");
});

test("warns inside the automatic renewal window", () => {
  const report = classifyEntry({ entry, spendable: [coin("2026-09-12T00:00:00Z")], recoverable: [], now });
  assert.equal(report.status, "warning");
  assert.equal(report.findings[0].code, "renewal-due");
});

test("becomes critical inside the phone fallback window", () => {
  const report = classifyEntry({ entry, spendable: [coin("2026-09-10T11:00:00Z")], recoverable: [], now });
  assert.equal(report.status, "critical");
  assert.ok(report.findings.some(({ code }) => code === "expiry-critical"));
});

test("does not demand rollover once current VTXO covers final date", () => {
  const shortEntry = { ...entry, finalAt: "2026-09-10T00:00:00Z" };
  const report = classifyEntry({ entry: shortEntry, spendable: [coin("2026-09-10T11:00:00Z")], recoverable: [], now });
  assert.equal(report.status, "healthy");
  assert.equal(report.finalCovered, true);
});

test("detects value drift, recoverable funds, and offline home service", () => {
  const report = classifyEntry({
    entry,
    spendable: [coin("2026-09-15T12:00:00Z", 900)],
    recoverable: [coin("2026-09-08T12:00:00Z", 100)],
    now,
    macOnline: false,
  });
  assert.equal(report.status, "critical");
  assert.deepEqual(report.findings.map(({ code }) => code), ["home-offline", "recovery-required"]);
});
