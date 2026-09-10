import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import type { RenewalHistory } from "./renewal-policy.js";
import type { SignedRenewalMandate } from "./renewal-mandate.js";

export type RenewalOutpoint = { txid: string; vout: number };

export type RenewalReceiptTerms = {
  version: 1;
  mandateId: string;
  sequence: number;
  input: RenewalOutpoint & { value: number; expiresAt: string };
  successor: RenewalOutpoint & { value: number; expiresAt: string; address: string; script: string };
  feeSats: number;
  signerPubkey: string;
  delegatePubkey: string;
  commitmentTxid: string;
  completedAt: string;
};

export type SignedRenewalReceipt = RenewalReceiptTerms & { signature: string };

export type RenewalJournal = {
  schemaVersion: 1;
  mandateId: string;
  initialOutpoint: RenewalOutpoint;
  receipts: SignedRenewalReceipt[];
};

const outpoint = ({ txid, vout }: RenewalOutpoint) => `${txid}:${vout}`;
const validTxid = (value: string) => /^[0-9a-f]{64}$/i.test(value);

const canonicalReceipt = (receipt: RenewalReceiptTerms) => JSON.stringify({
  version: receipt.version,
  mandateId: receipt.mandateId,
  sequence: receipt.sequence,
  input: receipt.input,
  successor: receipt.successor,
  feeSats: receipt.feeSats,
  signerPubkey: receipt.signerPubkey,
  delegatePubkey: receipt.delegatePubkey,
  commitmentTxid: receipt.commitmentTxid,
  completedAt: receipt.completedAt,
});

export const renewalReceiptDigest = (receipt: RenewalReceiptTerms) =>
  new Uint8Array(createHash("sha256").update(canonicalReceipt(receipt), "utf8").digest());

export const deriveRenewalHistory = (
  mandate: SignedRenewalMandate,
  journal: RenewalJournal,
): RenewalHistory & { currentOutpoint: RenewalOutpoint } => {
  if (journal.schemaVersion !== 1 || journal.mandateId !== mandate.mandateId) {
    throw new Error("Renewal journal is bound to a different mandate");
  }
  if (!validTxid(journal.initialOutpoint.txid) || !Number.isInteger(journal.initialOutpoint.vout) || journal.initialOutpoint.vout < 0) {
    throw new Error("Renewal journal initial outpoint is invalid");
  }
  let expected = journal.initialOutpoint;
  let totalFeesSats = 0;
  let lastSuccessAt: string | undefined;
  const spent = new Set<string>();
  for (const [index, receipt] of journal.receipts.entries()) {
    if (receipt.version !== 1 || receipt.mandateId !== mandate.mandateId || receipt.sequence !== index + 1) {
      throw new Error("Renewal journal sequence is invalid");
    }
    if (outpoint(receipt.input) !== outpoint(expected)) throw new Error("Renewal journal successor chain is broken");
    if (spent.has(outpoint(receipt.input))) throw new Error("Renewal journal replays an input");
    if (!validTxid(receipt.input.txid) || !validTxid(receipt.successor.txid) || !validTxid(receipt.commitmentTxid)) {
      throw new Error("Renewal journal transaction identifier is invalid");
    }
    if (receipt.input.value - receipt.successor.value !== receipt.feeSats || receipt.feeSats < 0) {
      throw new Error("Renewal journal value conservation failed");
    }
    if (receipt.successor.address !== mandate.terms.escrowAddress || receipt.successor.script !== mandate.terms.escrowScript) {
      throw new Error("Renewal journal successor destination changed");
    }
    if (Date.parse(receipt.successor.expiresAt) <= Date.parse(receipt.input.expiresAt)) {
      throw new Error("Renewal journal successor did not extend expiry");
    }
    if (!mandate.terms.renewalSigners.some(({ pubkey }) => pubkey === receipt.signerPubkey)) {
      throw new Error("Renewal journal used an unapproved signer");
    }
    if (!mandate.terms.delegates.some(({ pubkey }) => pubkey === receipt.delegatePubkey)) {
      throw new Error("Renewal journal used an unapproved delegate");
    }
    if (!schnorr.verify(hex.decode(receipt.signature), renewalReceiptDigest(receipt), hex.decode(receipt.signerPubkey))) {
      throw new Error("Renewal journal receipt signature is invalid");
    }
    spent.add(outpoint(receipt.input));
    expected = { txid: receipt.successor.txid, vout: receipt.successor.vout };
    totalFeesSats += receipt.feeSats;
    lastSuccessAt = receipt.completedAt;
  }
  return {
    completedRenewals: journal.receipts.length,
    totalFeesSats,
    lastSuccessAt,
    currentOutpoint: expected,
  };
};

export const readRenewalJournal = (path: string): RenewalJournal => JSON.parse(readFileSync(path, "utf8")) as RenewalJournal;

export const writeRenewalJournalAtomic = (path: string, journal: RenewalJournal) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

export const appendRenewalReceipt = (path: string, mandate: SignedRenewalMandate, receipt: SignedRenewalReceipt) => {
  if (!existsSync(path)) throw new Error("Renewal journal does not exist");
  const journal = readRenewalJournal(path);
  deriveRenewalHistory(mandate, { ...journal, receipts: [...journal.receipts, receipt] });
  writeRenewalJournalAtomic(path, { ...journal, receipts: [...journal.receipts, receipt] });
};
