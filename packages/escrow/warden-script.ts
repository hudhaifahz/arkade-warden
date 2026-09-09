import {
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  VtxoScript,
} from "@arkade-os/sdk";

export type WardenScriptParams = {
  buyerPubkey: Uint8Array;
  sellerPubkey: Uint8Array;
  arbiterPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  refundAt: number;
  delegatePubkey?: Uint8Array;
  renewalPubkey?: Uint8Array;
  exitDelaySeconds?: number;
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
  if (params.delegateApproval === "bounded-renewal-key" && !params.renewalPubkey) {
    throw new Error("Bounded renewal scripts require a dedicated renewal public key");
  }
  const delegatePath = params.delegatePubkey
    ? MultisigTapscript.encode({
        pubkeys:
          params.delegateApproval === "bounded-renewal-key"
            ? [params.renewalPubkey!, params.delegatePubkey, params.serverPubkey]
            : params.delegateApproval === "buyer-with-seller-authorization"
            ? [params.buyerPubkey, params.delegatePubkey, params.serverPubkey]
            : [params.buyerPubkey, params.sellerPubkey, params.delegatePubkey, params.serverPubkey],
      }).script
    : undefined;
  const renewalIntentPath = params.renewalPubkey
    ? MultisigTapscript.encode({ pubkeys: [params.renewalPubkey, params.serverPubkey] }).script
    : undefined;
  if (
    params.exitDelaySeconds !== undefined &&
    (!Number.isInteger(params.exitDelaySeconds) || params.exitDelaySeconds < 512)
  ) {
    throw new Error("Warden stock-compatible exit delay is invalid");
  }
  const exitPaths = params.exitDelaySeconds
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
  const leaves = delegatePath
    ? [collaborativePath, delegatePath, ...(renewalIntentPath ? [renewalIntentPath] : []), arbiterPath, refundPath, ...exitPaths]
    : [collaborativePath, arbiterPath, refundPath, ...exitPaths];
  return {
    collaborativePath,
    arbiterPath,
    refundPath,
    delegatePath,
    renewalIntentPath,
    exitPaths,
    script: new VtxoScript(leaves),
  };
};
