import { type Transaction } from "@arkade-os/sdk";

const reviewedStockSighashes = new Set([0x00, 0x01, 0x81]);

export const exactTapscriptSighash = (tx: Transaction, inputIndex: number) => {
  const sighash = tx.getInput(inputIndex).sighashType ?? 0x00;
  if (!reviewedStockSighashes.has(sighash)) {
    throw new Error(`Stock rollover requested an unreviewed sighash type 0x${sighash.toString(16).padStart(2, "0")}`);
  }
  return sighash;
};
