import { Intent, Transaction, type SignedIntent } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

export type DelegatedIntentConstraints = {
  input: { txid: string; vout: number; value: number };
  destination: { script: string; value: number };
  delegate: { pubkey: string; feeSats: number; feeScript?: string };
  validAt: number;
  quotedFeeSats: number;
  maxFeeSats: number;
};

const sameStrings = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const assertDelegatedIntentConstraints = (
  intent: SignedIntent<Intent.RegisterMessage>,
  forfeitTxs: string[],
  expected: DelegatedIntentConstraints,
) => {
  if (intent.message.type !== "register") throw new Error("Delegate intent must register a stock batch intent");
  if (intent.message.valid_at !== Math.floor(expected.validAt)) {
    throw new Error("Delegate intent activation time changed");
  }
  if (intent.message.expire_at !== 0) throw new Error("Unexpected delegate intent expiry policy");
  if (intent.message.onchain_output_indexes.length !== 0) {
    throw new Error("Delegate intent unexpectedly contains on-chain outputs");
  }
  if (!sameStrings(intent.message.cosigners_public_keys, [expected.delegate.pubkey])) {
    throw new Error("Delegate intent cosigner changed");
  }
  if (forfeitTxs.length !== 1) throw new Error("Delegate package must contain exactly one forfeit transaction");

  const proof = Transaction.fromPSBT(base64.decode(intent.proof));
  if (proof.inputsLength !== 2) throw new Error("Delegate proof must contain exactly one approved VTXO");
  const input = proof.getInput(1);
  if (
    !input.txid ||
    hex.encode(input.txid) !== expected.input.txid ||
    input.index !== expected.input.vout ||
    input.witnessUtxo?.amount !== BigInt(expected.input.value)
  ) {
    throw new Error("Delegate proof input changed");
  }

  const expectedOutputs = expected.delegate.feeSats > 0
    ? [
        { script: expected.delegate.feeScript, value: expected.delegate.feeSats },
        expected.destination,
      ]
    : [expected.destination];
  if (expectedOutputs.some((output) => !output.script)) {
    throw new Error("Delegate fee destination is missing");
  }
  if (proof.outputsLength !== expectedOutputs.length) {
    throw new Error("Delegate proof output count changed");
  }
  expectedOutputs.forEach((expectedOutput, index) => {
    const output = proof.getOutput(index);
    if (
      !output.script ||
      hex.encode(output.script) !== expectedOutput.script ||
      output.amount !== BigInt(expectedOutput.value)
    ) {
      throw new Error(`Delegate proof output ${index} changed`);
    }
  });

  const totalFee = Intent.fee(proof) + expected.delegate.feeSats;
  if (totalFee !== expected.quotedFeeSats) throw new Error("Delegate proof fee changed");
  if (totalFee > expected.maxFeeSats) throw new Error("Delegate proof fee exceeds the approved cap");
  return { totalFee, proof };
};
