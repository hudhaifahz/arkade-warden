const HOUR = 60 * 60;

const ageSeconds = (value, nowMs) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor((nowMs - parsed) / 1_000) : undefined;
};

export const classifyEntry = ({ entry, spendable, recoverable, now = new Date(), macOnline = true }) => {
  const nowMs = now.getTime();
  const finalMs = Date.parse(entry.finalAt);
  if (!Number.isFinite(finalMs)) throw new Error(`Invalid finalAt for ${entry.id}`);

  const totalSats = spendable.reduce((sum, coin) => sum + Number(coin.value), 0);
  const recoverableSats = recoverable.reduce((sum, coin) => sum + Number(coin.value), 0);
  const expiries = spendable
    .map((coin) => coin.expiresAt instanceof Date ? coin.expiresAt.getTime() : Date.parse(coin.expiresAt))
    .filter(Number.isFinite);
  const expiryMs = expiries.length ? Math.min(...expiries) : undefined;
  const secondsUntilExpiry = expiryMs === undefined ? undefined : Math.floor((expiryMs - nowMs) / 1_000);
  const finalCovered = expiryMs !== undefined && finalMs <= expiryMs;
  const findings = [];

  if (!macOnline) findings.push({ severity: "warning", code: "home-offline", message: "Home renewal service is unreachable" });
  if (recoverableSats > 0) {
    findings.push({ severity: "critical", code: "recovery-required", message: `${recoverableSats} sats require expiry recovery` });
  }
  if (entry.expectedValueSats !== undefined && totalSats !== entry.expectedValueSats && recoverableSats === 0) {
    findings.push({
      severity: "critical",
      code: "value-drift",
      message: `Expected ${entry.expectedValueSats} sats but indexed ${totalSats}`,
    });
  }
  if (spendable.length > 0 && expiryMs === undefined) {
    findings.push({ severity: "critical", code: "expiry-unknown", message: "Spendable VTXO has no indexed expiry" });
  }
  if (entry.renewal && totalSats > 0) {
    const renewal = entry.renewal;
    const supervisorAge = ageSeconds(renewal.supervisorCheckedAt, nowMs);
    const exitBundleAge = ageSeconds(renewal.exitBundleUpdatedAt, nowMs);
    if (renewal.signerCount < 2) {
      findings.push({ severity: "critical", code: "signer-redundancy-lost", message: "Fewer than two approved renewal signers remain" });
    }
    if (renewal.delegateOnlineCount === 0) {
      findings.push({ severity: "critical", code: "delegates-offline", message: "Both approved renewal delegates are unreachable" });
    } else if (renewal.delegateOnlineCount < renewal.delegateCount) {
      findings.push({ severity: "warning", code: "delegate-redundancy-lost", message: "One approved renewal delegate is unreachable" });
    }
    if (renewal.completedRenewals > renewal.maxRenewals) {
      findings.push({ severity: "critical", code: "renewal-limit-exceeded", message: "Renewal counter exceeds the signed mandate" });
    }
    if (["failed-safe", "manual-recovery-required"].includes(renewal.supervisorState)) {
      findings.push({ severity: "critical", code: "renewal-supervisor-failed", message: "Automatic renewal stopped safely and needs phone review" });
    }
    if (supervisorAge === undefined || supervisorAge > HOUR / 2) {
      findings.push({ severity: "critical", code: "renewal-supervisor-stale", message: "Renewal supervisor has not reported for 30 minutes" });
    } else if (supervisorAge > HOUR / 6) {
      findings.push({ severity: "warning", code: "renewal-supervisor-delayed", message: "Renewal supervisor is more than 10 minutes behind" });
    }
    if (exitBundleAge === undefined) {
      findings.push({
        severity: renewal.supervisorState === "awaiting-funding" || renewal.supervisorState === "not-yet-observed" ? "warning" : "critical",
        code: "exit-bundle-missing",
        message: "Current recovery package metadata has not been captured",
      });
    } else if (exitBundleAge > HOUR / 2) {
      findings.push({ severity: "warning", code: "exit-bundle-stale", message: "Current recovery package metadata is more than 30 minutes old" });
    }
  }
  if (!finalCovered && secondsUntilExpiry !== undefined && secondsUntilExpiry <= 24 * HOUR) {
    findings.push({ severity: "critical", code: "expiry-critical", message: "Phone rollover or recovery is required within 24 hours" });
  } else if (!finalCovered && secondsUntilExpiry !== undefined && secondsUntilExpiry <= 72 * HOUR) {
    findings.push({ severity: "warning", code: "renewal-due", message: "Automatic renewal should now be in progress" });
  }

  return {
    id: entry.id,
    contractId: entry.contractId,
    totalSats,
    recoverableSats,
    spendableCount: spendable.length,
    earliestExpiry: expiryMs === undefined ? undefined : new Date(expiryMs).toISOString(),
    secondsUntilExpiry,
    finalAt: new Date(finalMs).toISOString(),
    finalCovered,
    macOnline,
    findings,
    status: findings.some((finding) => finding.severity === "critical")
      ? "critical"
      : findings.length
        ? "warning"
        : "healthy",
  };
};

export const alertFingerprint = (report) =>
  `${report.id}:${report.status}:${report.findings.map((finding) => finding.code).sort().join(",")}`;
