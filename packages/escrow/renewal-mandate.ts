import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

export type RenewalDelegate = {
  url: string;
  pubkey: string;
  priority: number;
  maxFeeSats: number;
};

export type RenewalSigner = {
  pubkey: string;
  priority: number;
  role: "primary" | "recovery";
};

export type RenewalMandateTerms = {
  version: 1;
  purpose: "frontier-crown-warden-bounded-renewal";
  network: "bitcoin";
  contractId: string;
  escrowAddress: string;
  escrowScript: string;
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  arkServerUrl: string;
  arkServerPubkey: string;
  arkServerVersion: string;
  expectedExitDelaySeconds: number;
  finalAt: string;
  createdAt: string;
  triggerBeforeExpirySeconds: number;
  manualFallbackAfterSeconds: number;
  maxFeePerRolloverSats: number;
  maxTotalFeeSats: number;
  maxRenewals: number;
  renewalSigners: RenewalSigner[];
  delegates: RenewalDelegate[];
  exactSuccessorAddress: true;
  preserveScript: true;
  preserveParties: true;
  requireStockExitLeaves: true;
};

export type SignedRenewalMandate = {
  mandateId: string;
  terms: RenewalMandateTerms;
  approvals: {
    buyer: { pubkey: string; signature: string };
    seller: { pubkey: string; signature: string };
  };
};

const isXOnlyPubkey = (value: string) => /^[0-9a-f]{64}$/i.test(value);
const isScript = (value: string) => value.length >= 4 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);

const canonicalTerms = (terms: RenewalMandateTerms) => JSON.stringify({
  version: terms.version,
  purpose: terms.purpose,
  network: terms.network,
  contractId: terms.contractId,
  escrowAddress: terms.escrowAddress,
  escrowScript: terms.escrowScript,
  buyerPubkey: terms.buyerPubkey,
  sellerPubkey: terms.sellerPubkey,
  arbiterPubkey: terms.arbiterPubkey,
  arkServerUrl: terms.arkServerUrl,
  arkServerPubkey: terms.arkServerPubkey,
  arkServerVersion: terms.arkServerVersion,
  expectedExitDelaySeconds: terms.expectedExitDelaySeconds,
  finalAt: terms.finalAt,
  createdAt: terms.createdAt,
  triggerBeforeExpirySeconds: terms.triggerBeforeExpirySeconds,
  manualFallbackAfterSeconds: terms.manualFallbackAfterSeconds,
  maxFeePerRolloverSats: terms.maxFeePerRolloverSats,
  maxTotalFeeSats: terms.maxTotalFeeSats,
  maxRenewals: terms.maxRenewals,
  renewalSigners: [...terms.renewalSigners].sort((a, b) => a.priority - b.priority || a.pubkey.localeCompare(b.pubkey)),
  delegates: [...terms.delegates].sort((a, b) => a.priority - b.priority || a.pubkey.localeCompare(b.pubkey)),
  exactSuccessorAddress: terms.exactSuccessorAddress,
  preserveScript: terms.preserveScript,
  preserveParties: terms.preserveParties,
  requireStockExitLeaves: terms.requireStockExitLeaves,
});

export const assertRenewalMandateTerms = (terms: RenewalMandateTerms) => {
  if (terms.version !== 1 || terms.purpose !== "frontier-crown-warden-bounded-renewal") {
    throw new Error("Unsupported renewal mandate");
  }
  if (terms.network !== "bitcoin") throw new Error("Renewal mandate is not mainnet");
  if (!terms.contractId || !terms.escrowAddress || !isScript(terms.escrowScript)) {
    throw new Error("Renewal mandate contract binding is incomplete");
  }
  for (const [name, value] of Object.entries({
    buyer: terms.buyerPubkey,
    seller: terms.sellerPubkey,
    arbiter: terms.arbiterPubkey,
    server: terms.arkServerPubkey,
  })) {
    if (!isXOnlyPubkey(value)) throw new Error(`Renewal mandate ${name} public key is invalid`);
  }
  if (!terms.arkServerUrl.startsWith("http")) throw new Error("Renewal mandate server URL is invalid");
  if (!terms.arkServerVersion) throw new Error("Renewal mandate server version is missing");
  if (!Number.isInteger(terms.expectedExitDelaySeconds) || terms.expectedExitDelaySeconds < 512) {
    throw new Error("Renewal mandate exit delay is invalid");
  }
  const createdAt = Date.parse(terms.createdAt);
  const finalAt = Date.parse(terms.finalAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(finalAt) || finalAt <= createdAt) {
    throw new Error("Renewal mandate time bounds are invalid");
  }
  for (const [name, value] of Object.entries({
    triggerBeforeExpirySeconds: terms.triggerBeforeExpirySeconds,
    manualFallbackAfterSeconds: terms.manualFallbackAfterSeconds,
    maxFeePerRolloverSats: terms.maxFeePerRolloverSats,
    maxTotalFeeSats: terms.maxTotalFeeSats,
    maxRenewals: terms.maxRenewals,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Renewal mandate ${name} is invalid`);
  }
  if (terms.maxRenewals < 1) throw new Error("Renewal mandate must allow at least one renewal");
  if (terms.renewalSigners.length < 2) throw new Error("Renewal mandate requires a primary and recovery signer");
  if (terms.delegates.length < 2) throw new Error("Renewal mandate requires a primary and backup delegate");
  const signerKeys = new Set<string>();
  for (const signer of terms.renewalSigners) {
    if (!isXOnlyPubkey(signer.pubkey) || !Number.isInteger(signer.priority) || signer.priority < 0) {
      throw new Error("Renewal mandate signer is invalid");
    }
    if (signerKeys.has(signer.pubkey)) throw new Error("Renewal mandate repeats a signer");
    signerKeys.add(signer.pubkey);
  }
  if (terms.renewalSigners.filter(({ role }) => role === "primary").length !== 1) {
    throw new Error("Renewal mandate requires exactly one primary signer");
  }
  const delegateKeys = new Set<string>();
  for (const delegate of terms.delegates) {
    if (!delegate.url.startsWith("http") || !isXOnlyPubkey(delegate.pubkey)) {
      throw new Error("Renewal mandate delegate is invalid");
    }
    if (!Number.isInteger(delegate.priority) || delegate.priority < 0 || !Number.isSafeInteger(delegate.maxFeeSats) || delegate.maxFeeSats < 0) {
      throw new Error("Renewal mandate delegate limits are invalid");
    }
    if (delegate.maxFeeSats > terms.maxFeePerRolloverSats) {
      throw new Error("Delegate fee ceiling exceeds the mandate per-renewal ceiling");
    }
    if (delegateKeys.has(delegate.pubkey)) throw new Error("Renewal mandate repeats a delegate");
    delegateKeys.add(delegate.pubkey);
  }
  if (!terms.exactSuccessorAddress || !terms.preserveScript || !terms.preserveParties || !terms.requireStockExitLeaves) {
    throw new Error("Renewal mandate safety invariants must be enabled");
  }
  return terms;
};

export const renewalMandateDigest = (terms: RenewalMandateTerms) => {
  assertRenewalMandateTerms(terms);
  return new Uint8Array(createHash("sha256").update(canonicalTerms(terms), "utf8").digest());
};

export const renewalMandateId = (terms: RenewalMandateTerms) => hex.encode(renewalMandateDigest(terms));

export const verifySignedRenewalMandate = (mandate: SignedRenewalMandate) => {
  const digest = renewalMandateDigest(mandate.terms);
  if (mandate.mandateId !== hex.encode(digest)) throw new Error("Renewal mandate identifier changed");
  if (mandate.approvals.buyer.pubkey !== mandate.terms.buyerPubkey) throw new Error("Renewal mandate buyer approval changed");
  if (mandate.approvals.seller.pubkey !== mandate.terms.sellerPubkey) throw new Error("Renewal mandate seller approval changed");
  if (!schnorr.verify(hex.decode(mandate.approvals.buyer.signature), digest, hex.decode(mandate.terms.buyerPubkey))) {
    throw new Error("Renewal mandate buyer signature is invalid");
  }
  if (!schnorr.verify(hex.decode(mandate.approvals.seller.signature), digest, hex.decode(mandate.terms.sellerPubkey))) {
    throw new Error("Renewal mandate seller signature is invalid");
  }
  return mandate;
};
