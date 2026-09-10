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

const healthyRenewal = {
  mandateId: "mandate",
  supervisorCheckedAt: "2026-09-09T11:58:00Z",
  supervisorState: "wait",
  maxRenewals: 4,
  completedRenewals: 1,
  exitBundleUpdatedAt: "2026-09-09T11:58:00Z",
  signerCount: 2,
  delegateCount: 2,
  delegateOnlineCount: 2,
};

test("accepts a fresh redundant bounded-renewal heartbeat", () => {
  const report = classifyEntry({ entry: { ...entry, renewal: healthyRenewal }, spendable: [coin("2026-09-15T12:00:00Z")], recoverable: [], now });
  assert.equal(report.status, "healthy");
});

test("warns when one delegate is down but the backup remains", () => {
  const report = classifyEntry({
    entry: { ...entry, renewal: { ...healthyRenewal, delegateOnlineCount: 1 } },
    spendable: [coin("2026-09-15T12:00:00Z")],
    recoverable: [],
    now,
  });
  assert.equal(report.status, "warning");
  assert.ok(report.findings.some(({ code }) => code === "delegate-redundancy-lost"));
});

test("becomes critical when the supervisor and both delegates fail", () => {
  const report = classifyEntry({
    entry: {
      ...entry,
      renewal: {
        ...healthyRenewal,
        supervisorCheckedAt: "2026-09-09T10:00:00Z",
        supervisorState: "failed-safe",
        delegateOnlineCount: 0,
      },
    },
    spendable: [coin("2026-09-15T12:00:00Z")],
    recoverable: [],
    now,
  });
  assert.equal(report.status, "critical");
  assert.ok(report.findings.some(({ code }) => code === "renewal-supervisor-failed"));
  assert.ok(report.findings.some(({ code }) => code === "delegates-offline"));
  assert.ok(report.findings.some(({ code }) => code === "renewal-supervisor-stale"));
});
