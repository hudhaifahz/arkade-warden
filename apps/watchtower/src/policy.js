const HOUR = 60 * 60;

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
