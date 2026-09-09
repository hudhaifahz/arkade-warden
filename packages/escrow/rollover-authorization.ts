import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

export type RolloverAuthorizationTerms = {
  contractId: string;
  input: { txid: string; vout: number; value: number; expiresAt?: string };
  successor: { address: string; value: number; refundAt: string };
  quotedFeeSats: number;
  maxFeeSats: number;
  delegate: {
    url: string;
    pubkey: string;
    feeSats: number;
    delegateAt: string;
    authorizationExpiresAt: string;
  };
};

export const rolloverAuthorizationDigest = (terms: RolloverAuthorizationTerms) => {
  const canonical = JSON.stringify({
    version: 1,
    purpose: "frontier-crown-warden-delegated-rollover",
    contractId: terms.contractId,
    input: terms.input,
    successor: terms.successor,
    quotedFeeSats: terms.quotedFeeSats,
    maxFeeSats: terms.maxFeeSats,
    delegate: terms.delegate,
  });
  return new Uint8Array(createHash("sha256").update(canonical, "utf8").digest());
};

export const verifySellerRolloverAuthorization = (
  terms: RolloverAuthorizationTerms,
  sellerPubkey: string,
  signature: string,
) => schnorr.verify(hex.decode(signature), rolloverAuthorizationDigest(terms), hex.decode(sellerPubkey));
