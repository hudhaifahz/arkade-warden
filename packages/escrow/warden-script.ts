import {
  CLTVMultisigTapscript,
  ConditionCSVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  VtxoScript,
} from "@arkade-os/sdk";
import { Script } from "@scure/btc-signer";

export type WardenScriptParams = {
  buyerPubkey: Uint8Array;
  sellerPubkey: Uint8Array;
  arbiterPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  refundAt: number;
  delegatePubkey?: Uint8Array;
  delegatePubkeys?: Uint8Array[];
  renewalPubkey?: Uint8Array;
  renewalPubkeys?: Uint8Array[];
  exitDelaySeconds?: number;
  finalBuyerUnilateralExit?: boolean;
  delegateApproval?: "buyer-and-seller" | "buyer-with-seller-authorization" | "bounded-renewal-key";
};

export const buildWardenScript = (params: WardenScriptParams) => {
  const collaborativePath = MultisigTapscript.encode({
    pubkeys: [params.buyerPubkey, params.sellerPubkey, params.serverPubkey],
  }).script;
  const arbiterPath = MultisigTapscript.encode({
    pubkeys: [params.arbiterPubkey, params.serverPubkey],
  }).script;
  const refundPath = CLTVMultisigTapscript.encode({
    pubkeys: [params.buyerPubkey, params.serverPubkey],
    absoluteTimelock: BigInt(params.refundAt),
  }).script;
  const renewalPubkeys = params.renewalPubkeys ?? (params.renewalPubkey ? [params.renewalPubkey] : []);
  const delegatePubkeys = params.delegatePubkeys ?? (params.delegatePubkey ? [params.delegatePubkey] : []);
  if (params.delegateApproval === "bounded-renewal-key" && renewalPubkeys.length === 0) {
    throw new Error("Bounded renewal scripts require a dedicated renewal public key");
  }
  const delegatePaths = delegatePubkeys.flatMap((delegatePubkey) => {
    if (params.delegateApproval === "bounded-renewal-key") {
      return renewalPubkeys.map((renewalPubkey) => MultisigTapscript.encode({
        pubkeys: [renewalPubkey, delegatePubkey, params.serverPubkey],
      }).script);
    }
    return [MultisigTapscript.encode({
      pubkeys:
        params.delegateApproval === "buyer-with-seller-authorization"
          ? [params.buyerPubkey, delegatePubkey, params.serverPubkey]
          : [params.buyerPubkey, params.sellerPubkey, delegatePubkey, params.serverPubkey],
    }).script];
  });
  const renewalIntentPaths = renewalPubkeys.map((renewalPubkey) =>
    MultisigTapscript.encode({ pubkeys: [renewalPubkey, params.serverPubkey] }).script,
  );
  if (
    params.exitDelaySeconds !== undefined &&
    (!Number.isInteger(params.exitDelaySeconds) || params.exitDelaySeconds < 512)
  ) {
    throw new Error("Warden stock-compatible exit delay is invalid");
  }
  const cooperativeExitPaths = params.exitDelaySeconds
    ? [
        CSVMultisigTapscript.encode({
          pubkeys: [params.buyerPubkey, params.sellerPubkey],
          timelock: { value: BigInt(params.exitDelaySeconds), type: "seconds" },
        }).script,
        CSVMultisigTapscript.encode({
          pubkeys: [params.buyerPubkey, params.arbiterPubkey],
          timelock: { value: BigInt(params.exitDelaySeconds), type: "seconds" },
        }).script,
        CSVMultisigTapscript.encode({
          pubkeys: [params.sellerPubkey, params.arbiterPubkey],
          timelock: { value: BigInt(params.exitDelaySeconds), type: "seconds" },
        }).script,
      ]
    : [];
  const finalBuyerExitPath = params.exitDelaySeconds && params.finalBuyerUnilateralExit
    ? ConditionCSVMultisigTapscript.encode({
        conditionScript: Script.encode([
          params.refundAt,
          "CHECKLOCKTIMEVERIFY",
          "DROP",
          1,
        ]),
        pubkeys: [params.buyerPubkey],
        timelock: { value: BigInt(params.exitDelaySeconds), type: "seconds" },
      }).script
    : undefined;
  const exitPaths = finalBuyerExitPath
    ? [...cooperativeExitPaths, finalBuyerExitPath]
    : cooperativeExitPaths;
  const leaves = [collaborativePath, ...delegatePaths, ...renewalIntentPaths, arbiterPath, refundPath, ...exitPaths];
  return {
    collaborativePath,
    arbiterPath,
    refundPath,
    delegatePath: delegatePaths[0],
    delegatePaths,
    renewalIntentPath: renewalIntentPaths[0],
    renewalIntentPaths,
    exitPaths,
    finalBuyerExitPath,
    leaves,
    script: new VtxoScript(leaves),
  };
};
