import {
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  decodeTapscript,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { buildWardenScript } from "./warden-script.js";

type BuiltWardenScript = ReturnType<typeof buildWardenScript>;

const sameKey = (left: Uint8Array, right: Uint8Array) => hex.encode(left) === hex.encode(right);

export const assertStockArkdWardenScript = (
  built: BuiltWardenScript,
  expected: { serverPubkey: Uint8Array; minimumExitDelaySeconds: number },
) => {
  if (built.finalBuyerExitPath) {
    throw new Error("Stock arkd does not accept the combined conditional-time buyer exit leaf");
  }
  if (built.exitPaths.length !== 3 || built.script.exitPaths().length !== 3) {
    throw new Error("Stock Warden requires exactly three operator-independent two-party exit leaves");
  }

  const forfeitPaths = [
    built.collaborativePath,
    ...built.delegatePaths,
    ...built.renewalIntentPaths,
    built.arbiterPath,
    built.refundPath,
  ];
  for (const path of forfeitPaths) {
    const closure = decodeTapscript(path);
    if (!MultisigTapscript.is(closure) && !CLTVMultisigTapscript.is(closure)) {
      throw new Error("Stock Warden contains an unsupported forfeit closure");
    }
    if (!closure.params.pubkeys.some((key) => sameKey(key, expected.serverPubkey))) {
      throw new Error("Stock Warden forfeit closure is missing the arkd signer");
    }
  }

  for (const path of built.exitPaths) {
    const closure = decodeTapscript(path);
    if (!CSVMultisigTapscript.is(closure)) {
      throw new Error("Stock Warden exit closure must be a plain CSV multisig");
    }
    if (
      closure.params.timelock.type !== "seconds" ||
      closure.params.timelock.value < BigInt(expected.minimumExitDelaySeconds)
    ) {
      throw new Error("Stock Warden exit delay is below the arkd minimum");
    }
    if (closure.params.pubkeys.length !== 2) {
      throw new Error("Stock Warden operator-independent exit must require exactly two parties");
    }
  }

  const encoded = new Set(built.leaves.map(hex.encode));
  if (encoded.size !== built.leaves.length) throw new Error("Stock Warden contains duplicate tapscript leaves");
  return built;
};
