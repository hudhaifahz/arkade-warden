export type RenewalMandate = {
  version: 1;
  contractId: string;
  escrowAddress: string;
  buyerPubkey: string;
  sellerPubkey: string;
  renewalPubkey: string;
  delegatePubkey: string;
  finalAt: string;
  triggerBeforeExpirySeconds: number;
  manualFallbackAfterSeconds: number;
  maxFeePerRolloverSats: number;
  maxTotalFeeSats: number;
  maxRenewals: number;
  exactSuccessorAddress: true;
  preserveParties: true;
  paused: boolean;
};

export type RenewalHistory = {
  completedRenewals: number;
  totalFeesSats: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
};

export type RenewalDecision = {
  action: "none" | "schedule" | "manual-fallback" | "critical" | "stop";
  reason: string;
  secondsUntilExpiry: number;
};

export const boundedRenewalCap = (durationSeconds: number, triggerBeforeExpirySeconds = 72 * 60 * 60) => {
  const stockVtxoLifetimeSeconds = 7 * 24 * 60 * 60;
  const renewalCycleSeconds = stockVtxoLifetimeSeconds - triggerBeforeExpirySeconds;
  if (renewalCycleSeconds <= 0) throw new Error("Renewal trigger must be earlier than stock VTXO expiry");
  return Math.ceil(durationSeconds / renewalCycleSeconds) + 1;
};

export const renewalDecision = (
  mandate: RenewalMandate,
  history: RenewalHistory,
  vtxoExpiresAt: string,
  now = new Date(),
): RenewalDecision => {
  const nowMs = now.getTime();
  const expiryMs = Date.parse(vtxoExpiresAt);
  const finalMs = Date.parse(mandate.finalAt);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(finalMs)) throw new Error("Renewal timing is invalid");
  const secondsUntilExpiry = Math.floor((expiryMs - nowMs) / 1_000);
  if (mandate.paused) return { action: "stop", reason: "Renewal mandate is paused", secondsUntilExpiry };
  if (history.completedRenewals >= mandate.maxRenewals) {
    return { action: "stop", reason: "Renewal-count ceiling reached", secondsUntilExpiry };
  }
  if (history.totalFeesSats >= mandate.maxTotalFeeSats && mandate.maxTotalFeeSats > 0) {
    return { action: "stop", reason: "Cumulative renewal-fee ceiling reached", secondsUntilExpiry };
  }
  // Once the escrow's refund date arrives before this VTXO expires, another
  // renewal adds no safety and must not be attempted.
  if (finalMs <= expiryMs) {
    return { action: "stop", reason: "Current VTXO already covers the escrow final date", secondsUntilExpiry };
  }
  if (secondsUntilExpiry <= 24 * 60 * 60) {
    return { action: "critical", reason: "Phone-signed recovery or rollover required", secondsUntilExpiry };
  }
  const attemptAgeSeconds = history.lastAttemptAt
    ? Math.floor((nowMs - Date.parse(history.lastAttemptAt)) / 1_000)
    : undefined;
  if (
    secondsUntilExpiry <= mandate.triggerBeforeExpirySeconds &&
    attemptAgeSeconds !== undefined &&
    attemptAgeSeconds >= mandate.manualFallbackAfterSeconds
  ) {
    return { action: "manual-fallback", reason: "Automatic renewal missed its confirmation window", secondsUntilExpiry };
  }
  if (secondsUntilExpiry <= mandate.triggerBeforeExpirySeconds) {
    return { action: "schedule", reason: "Bounded automatic renewal window reached", secondsUntilExpiry };
  }
  return { action: "none", reason: "Renewal is not due", secondsUntilExpiry };
};
