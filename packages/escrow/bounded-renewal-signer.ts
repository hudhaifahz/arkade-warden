import type { SignedRenewalMandate } from "./renewal-mandate.js";
import { verifySignedRenewalMandate } from "./renewal-mandate.js";
import type { RenewalJournal } from "./renewal-journal.js";
import { deriveRenewalHistory } from "./renewal-journal.js";
import { renewalDecision } from "./renewal-policy.js";

export type RenewalProposal = {
  input: { txid: string; vout: number; value: number; expiresAt: string };
  successor: { address: string; script: string; value: number; refundAt: string };
  quotedFeeSats: number;
  signerPubkey: string;
  delegatePubkey: string;
  arkServerUrl: string;
  arkServerPubkey: string;
  arkServerVersion: string;
  network: "bitcoin";
  exitDelaySeconds: number;
};

export type OperatorState = { online: boolean; indexerOnline: boolean };

export type RenewalAuthorization = {
  action: "authorize";
  sequence: number;
  mandateId: string;
  signerPubkey: string;
  delegatePubkey: string;
  proposal: RenewalProposal;
};

const sameOutpoint = (a: { txid: string; vout: number }, b: { txid: string; vout: number }) =>
  a.txid === b.txid && a.vout === b.vout;

export const authorizeBoundedRenewal = (
  mandate: SignedRenewalMandate,
  journal: RenewalJournal,
  proposal: RenewalProposal,
  operator: OperatorState,
  now = new Date(),
  options: { activationTest?: boolean } = {},
): RenewalAuthorization => {
  verifySignedRenewalMandate(mandate);
  if (!operator.online || !operator.indexerOnline) {
    throw new Error("Operator unavailable; do not sign and start the unilateral-exit recovery path");
  }
  const terms = mandate.terms;
  const history = deriveRenewalHistory(mandate, journal);
  if (!sameOutpoint(proposal.input, history.currentOutpoint)) throw new Error("Renewal input is stale or replayed");
  if (proposal.network !== terms.network || proposal.arkServerUrl !== terms.arkServerUrl) {
    throw new Error("Renewal operator changed");
  }
  if (proposal.arkServerPubkey !== terms.arkServerPubkey || proposal.arkServerVersion !== terms.arkServerVersion) {
    throw new Error("Renewal operator identity or version changed");
  }
  if (proposal.exitDelaySeconds !== terms.expectedExitDelaySeconds) throw new Error("Renewal exit delay changed");
  if (proposal.successor.address !== terms.escrowAddress || proposal.successor.script !== terms.escrowScript) {
    throw new Error("Renewal successor destination changed");
  }
  if (proposal.successor.refundAt !== terms.finalAt) throw new Error("Renewal final escrow date changed");
  if (proposal.input.value - proposal.successor.value !== proposal.quotedFeeSats || proposal.quotedFeeSats < 0) {
    throw new Error("Renewal value conservation failed");
  }
  if (proposal.quotedFeeSats > terms.maxFeePerRolloverSats) throw new Error("Renewal fee exceeds the per-renewal ceiling");
  if (history.totalFeesSats + proposal.quotedFeeSats > terms.maxTotalFeeSats) {
    throw new Error("Renewal fee exceeds the cumulative ceiling");
  }
  if (history.completedRenewals >= terms.maxRenewals) throw new Error("Renewal count ceiling reached");
  if (!terms.renewalSigners.some(({ pubkey }) => pubkey === proposal.signerPubkey)) {
    throw new Error("Renewal signer is not approved");
  }
  const delegate = terms.delegates.find(({ pubkey }) => pubkey === proposal.delegatePubkey);
  if (!delegate) throw new Error("Renewal delegate is not approved");
  if (proposal.quotedFeeSats > delegate.maxFeeSats) throw new Error("Renewal fee exceeds the delegate ceiling");

  const decision = renewalDecision(
    {
      version: 1,
      contractId: terms.contractId,
      escrowAddress: terms.escrowAddress,
      buyerPubkey: terms.buyerPubkey,
      sellerPubkey: terms.sellerPubkey,
      renewalPubkey: proposal.signerPubkey,
      delegatePubkey: proposal.delegatePubkey,
      finalAt: terms.finalAt,
      triggerBeforeExpirySeconds: terms.triggerBeforeExpirySeconds,
      manualFallbackAfterSeconds: terms.manualFallbackAfterSeconds,
      maxFeePerRolloverSats: terms.maxFeePerRolloverSats,
      maxTotalFeeSats: terms.maxTotalFeeSats,
      maxRenewals: terms.maxRenewals,
      exactSuccessorAddress: true,
      preserveParties: true,
      paused: false,
    },
    history,
    proposal.input.expiresAt,
    now,
  );
  if (!options.activationTest && decision.action !== "schedule") {
    throw new Error(`Renewal is not eligible for automatic signing: ${decision.reason}`);
  }
  if (decision.action === "stop") throw new Error(`Renewal is forbidden: ${decision.reason}`);
  return {
    action: "authorize",
    sequence: history.completedRenewals + 1,
    mandateId: mandate.mandateId,
    signerPubkey: proposal.signerPubkey,
    delegatePubkey: proposal.delegatePubkey,
    proposal,
  };
};

export const selectRenewalSigner = (
  mandate: SignedRenewalMandate,
  availability: Record<string, boolean>,
) => [...mandate.terms.renewalSigners]
  .sort((a, b) => a.priority - b.priority)
  .find(({ pubkey }) => availability[pubkey]);

export const selectRenewalDelegate = (
  mandate: SignedRenewalMandate,
  availability: Record<string, boolean>,
) => [...mandate.terms.delegates]
  .sort((a, b) => a.priority - b.priority)
  .find(({ pubkey }) => availability[pubkey]);
