import { Transaction, verifyTapscriptSignatures } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

const assertSameUnsignedTransaction = (signed: Transaction, original: Transaction) => {
  if (hex.encode(signed.unsignedTx) !== hex.encode(original.unsignedTx)) {
    throw new Error("Signed PSBT transaction does not match the prepared transaction");
  }
};

export const applyRequiredTapscriptSignatures = (
  signedPsbt: string,
  originalPsbt: string,
  requiredPubkey: string,
) => {
  const signed = Transaction.fromPSBT(base64.decode(signedPsbt));
  const original = Transaction.fromPSBT(base64.decode(originalPsbt));
  assertSameUnsignedTransaction(signed, original);
  if (signed.inputsLength !== original.inputsLength) {
    throw new Error("Signed PSBT input count does not match the prepared transaction");
  }
  for (let inputIndex = 0; inputIndex < original.inputsLength; inputIndex += 1) {
    const signatures = signed.getInput(inputIndex).tapScriptSig ?? [];
    const requiredSignature = signatures.find(([key]) => hex.encode(key.pubKey) === requiredPubkey);
    if (!requiredSignature) {
      throw new Error(`Mobile wallet did not provide the required buyer signature for input ${inputIndex}`);
    }
    const existing = original.getInput(inputIndex).tapScriptSig ?? [];
    const withoutRequiredSigner = existing.filter(([key]) => hex.encode(key.pubKey) !== requiredPubkey);
    original.updateInput(inputIndex, { tapScriptSig: [...withoutRequiredSigner, requiredSignature] }, true);
    verifyTapscriptSignatures(original, inputIndex, [requiredPubkey]);
  }
  return original;
};
