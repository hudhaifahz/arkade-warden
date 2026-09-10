import type { SignedRenewalMandate } from "./renewal-mandate.js";

export type UnilateralExitBundle = {
  schemaVersion: 2 | 3;
  mandateId: string;
  contractId: string;
  arkServerUrl: string;
  arkServerPubkey: string;
  network: "bitcoin";
  currentVtxo: {
    txid: string;
    vout: number;
    value: number;
    expiresAt: string;
    tapTree: string;
    script: string;
  };
  exitPaths: string[];
  recoveryModel?: "buyer-only-final" | "operator-independent-two-party-stock-exit";
  finalBuyerExitPath?: string;
  participantKeys: string[];
  updatedAt: string;
};

export const assertUnilateralExitBundle = (mandate: SignedRenewalMandate, bundle: UnilateralExitBundle) => {
  if ((bundle.schemaVersion !== 2 && bundle.schemaVersion !== 3) || bundle.mandateId !== mandate.mandateId || bundle.contractId !== mandate.terms.contractId) {
    throw new Error("Unilateral-exit bundle is bound to a different mandate");
  }
  if (
    bundle.network !== mandate.terms.network ||
    bundle.arkServerUrl !== mandate.terms.arkServerUrl ||
    bundle.arkServerPubkey !== mandate.terms.arkServerPubkey
  ) {
    throw new Error("Unilateral-exit bundle operator binding changed");
  }
  if (!/^[0-9a-f]{64}$/i.test(bundle.currentVtxo.txid) || bundle.currentVtxo.value <= 0 || !bundle.currentVtxo.tapTree) {
    throw new Error("Unilateral-exit bundle VTXO data is incomplete");
  }
  if (bundle.currentVtxo.script !== mandate.terms.escrowScript) throw new Error("Unilateral-exit bundle script changed");
  const expectedExitPaths = bundle.schemaVersion === 2 ? 4 : 3;
  if (bundle.exitPaths.length < expectedExitPaths || bundle.exitPaths.some((path) => !path)) {
    throw new Error("Unilateral-exit bundle does not preserve all Warden exit paths");
  }
  if (bundle.schemaVersion === 2) {
    if (!bundle.finalBuyerExitPath || !bundle.exitPaths.includes(bundle.finalBuyerExitPath)) {
      throw new Error("Unilateral-exit bundle is missing the buyer-only final recovery path");
    }
  } else if (bundle.recoveryModel !== "operator-independent-two-party-stock-exit" || bundle.finalBuyerExitPath) {
    throw new Error("Stock recovery bundle must use the operator-independent two-party model");
  }
  const allowedParticipants = new Set([
    mandate.terms.buyerPubkey,
    mandate.terms.sellerPubkey,
    mandate.terms.arbiterPubkey,
  ]);
  if (bundle.participantKeys.length < 2 || bundle.participantKeys.some((key) => !allowedParticipants.has(key))) {
    throw new Error("Unilateral-exit bundle participant set is invalid");
  }
  return bundle;
};
