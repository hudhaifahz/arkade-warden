import assert from "node:assert/strict";
import test from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  ConditionCSVMultisigTapscript,
  CSVMultisigTapscript,
  Intent,
  MnemonicIdentity,
  MultisigTapscript,
  buildOffchainTx,
  decodeTapscript,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import {
  defaultActivationGates,
  durationPresetById,
  durationPresets,
  longTermAutomationReady,
} from "./catalog.js";
import { assessSettlementProof, type ProofCoin } from "./proofs.js";
import { assertDelegatedIntentConstraints } from "./delegation.js";
import { exactTapscriptSighash } from "./signing.js";
import { buildWardenScript } from "./warden-script.js";
import { applyRequiredTapscriptSignatures } from "./mobile-signing.js";
import { assessFunding } from "./funding-policy.js";
import {
  rolloverAuthorizationDigest,
  verifySellerRolloverAuthorization,
  type RolloverAuthorizationTerms,
} from "./rollover-authorization.js";
import { boundedRenewalCap, renewalDecision, type RenewalMandate } from "./renewal-policy.js";
import {
  renewalMandateDigest,
  renewalMandateId,
  verifySignedRenewalMandate,
  type RenewalMandateTerms,
  type SignedRenewalMandate,
} from "./renewal-mandate.js";
import {
  deriveRenewalHistory,
  renewalReceiptDigest,
  type RenewalJournal,
  type SignedRenewalReceipt,
} from "./renewal-journal.js";
import {
  authorizeBoundedRenewal,
  classifyRenewalRouteFailure,
  delegatedAuthorizationExpired,
  delegatedAuthorizationIsActive,
  selectRenewalDelegate,
  selectRenewalSigner,
  type RenewalProposal,
} from "./bounded-renewal-signer.js";
import { assertUnilateralExitBundle, type UnilateralExitBundle } from "./unilateral-exit-bundle.js";
import { assertStockArkdWardenScript } from "./stock-arkd-closures.js";

test("duration catalog contains the nine requested unique presets", () => {
  assert.equal(durationPresets.length, 9);
  assert.equal(new Set(durationPresets.map(({ id }) => id)).size, 9);
  assert.deepEqual(durationPresets.slice(0, 3).map(({ id }) => id), ["3h", "24h", "3d"]);
});

test("seven days and longer always require rollover", () => {
  assert.equal(durationPresetById("3d").rolloverRequired, false);
  assert.equal(durationPresetById("7d").rolloverRequired, true);
  assert.equal(durationPresetById("12mo").rolloverRequired, true);
});

test("automatic long-term activation requires all three explicit gates", () => {
  const gates = defaultActivationGates();
  assert.equal(longTermAutomationReady(gates), false);
  gates.fundedManualRollover.verified = true;
  gates.expiryRecoveryDrill.verified = true;
  assert.equal(longTermAutomationReady(gates), false);
  gates.automaticLongTerm.enabled = true;
  assert.equal(longTermAutomationReady(gates), true);
});

const input: ProofCoin = {
  txid: "a".repeat(64),
  vout: 0,
  value: 1_000,
  script: "00",
  isSpent: true,
  isSwept: true,
  spentBy: "b".repeat(64),
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
};

const successor: ProofCoin = {
  txid: "c".repeat(64),
  vout: 1,
  value: 990,
  script: "11",
  settledBy: "d".repeat(64),
  commitmentTxIds: ["d".repeat(64)],
  expiresAt: new Date("2026-09-08T00:00:00.000Z"),
};

test("proof verifier requires an indexed consumed input and exact live successor", () => {
  const session = {
    stage: "completed",
    execution: "manual-stock-batch",
    input: { txid: input.txid, vout: 0, value: 1_000, expiresAt: input.expiresAt?.toISOString() },
    destination: { script: successor.script, value: 990 },
    result: { commitmentTxid: "d".repeat(64) },
  };
  assert.deepEqual(
    assessSettlementProof({
      session,
      commitmentExists: true,
      inputCoin: input,
      destinationCoins: [successor],
      requireSweptInput: true,
      requireLaterExpiry: true,
    }),
    {
      verified: true,
      commitmentTxid: "d".repeat(64),
      successor: {
        txid: successor.txid,
        vout: 1,
        value: 990,
        expiresAt: successor.expiresAt?.toISOString(),
      },
    },
  );
  assert.deepEqual(
    assessSettlementProof({
      session,
      commitmentExists: true,
      inputCoin: { ...input, isSwept: false },
      destinationCoins: [successor],
      requireSweptInput: true,
      requireLaterExpiry: true,
    }),
    { verified: false, reason: "input-was-not-swept" },
  );
});

test("proof verifier rejects a changed destination or non-extended rollover", () => {
  const session = {
    stage: "completed",
    execution: "manual-stock-batch",
    input: { txid: input.txid, vout: 0, value: 1_000, expiresAt: input.expiresAt?.toISOString() },
    destination: { script: "22", value: 990 },
    result: { commitmentTxid: "d".repeat(64) },
  };
  assert.deepEqual(
    assessSettlementProof({
      session,
      commitmentExists: true,
      inputCoin: input,
      destinationCoins: [successor],
      requireSweptInput: false,
      requireLaterExpiry: true,
    }),
    { verified: false, reason: "successor-not-found" },
  );
  assert.deepEqual(
    assessSettlementProof({
      session: { ...session, destination: { script: successor.script, value: 990 } },
      commitmentExists: true,
      inputCoin: input,
      destinationCoins: [{ ...successor, expiresAt: input.expiresAt }],
      requireSweptInput: false,
      requireLaterExpiry: true,
    }),
    { verified: false, reason: "successor-expiry-not-extended" },
  );
});

const delegateIntentFixture = () => {
  const inputTxid = "12".repeat(32);
  const validXOnlyKey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const inputScript = `5120${validXOnlyKey}`;
  const delegateScript = `5120${validXOnlyKey}`;
  const destinationScript = `5120${validXOnlyKey}`;
  const delegatePubkey = `02${validXOnlyKey}`;
  const validAt = 1_800_000_000;
  const proof = Intent.create(
    {
      type: "register",
      onchain_output_indexes: [],
      valid_at: validAt,
      expire_at: 0,
      cosigners_public_keys: [delegatePubkey],
    },
    [{
      txid: hex.decode(inputTxid),
      index: 3,
      witnessUtxo: { amount: 1_000n, script: hex.decode(inputScript) },
    }],
    [
      { amount: 2n, script: hex.decode(delegateScript) },
      { amount: 990n, script: hex.decode(destinationScript) },
    ],
  );
  return {
    intent: {
      message: {
        type: "register" as const,
        onchain_output_indexes: [],
        valid_at: validAt,
        expire_at: 0,
        cosigners_public_keys: [delegatePubkey],
      },
      proof: base64.encode(proof.toPSBT()),
    },
    constraints: {
      input: { txid: inputTxid, vout: 3, value: 1_000 },
      destination: { script: destinationScript, value: 990 },
      delegate: { pubkey: delegatePubkey, feeSats: 2, feeScript: delegateScript },
      validAt,
      quotedFeeSats: 10,
      maxFeeSats: 10,
    },
  };
};

test("delegated rollover verifier accepts only the exact approved stock intent", () => {
  const { intent, constraints } = delegateIntentFixture();
  assert.equal(assertDelegatedIntentConstraints(intent, ["forfeit"], constraints).totalFee, 10);
  assert.throws(
    () => assertDelegatedIntentConstraints(intent, ["forfeit"], {
      ...constraints,
      destination: { ...constraints.destination, value: 989 },
    }),
    /output 1 changed/,
  );
  assert.throws(
    () => assertDelegatedIntentConstraints(intent, ["forfeit"], {
      ...constraints,
      maxFeeSats: 9,
    }),
    /fee exceeds the approved cap/,
  );
});

test("stock signing verifier permits the PSBT's exact reviewed sighash only", () => {
  const validXOnlyKey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const proof = Intent.create(
    { type: "delete", expire_at: 0 },
    [{
      txid: hex.decode("17".repeat(32)),
      index: 0,
      witnessUtxo: { amount: 1_000n, script: hex.decode(`5120${validXOnlyKey}`) },
    }],
  );
  assert.equal(exactTapscriptSighash(proof, 0), 0x01);
  proof.updateInput(0, { sighashType: 0x02 }, true);
  assert.throws(() => exactTapscriptSighash(proof, 0), /unreviewed sighash type 0x02/);
});

test("stock-compatible Warden scripts contain three two-party exit leaves", () => {
  const key = (byte: number) => {
    const bytes = new Uint8Array(32);
    bytes[31] = byte;
    return bytes;
  };
  const built = buildWardenScript({
    buyerPubkey: key(1),
    sellerPubkey: key(2),
    arbiterPubkey: key(3),
    serverPubkey: key(4),
    refundAt: 1_800_000_000,
    exitDelaySeconds: 86_016,
  });
  assert.equal(built.exitPaths.length, 3);
  assert.equal(built.script.exitPaths().length, 3);
  for (const exitPath of built.script.exitPaths()) {
    assert.equal(exitPath.params.timelock.type, "seconds");
    assert.equal(exitPath.params.timelock.value, 86_016n);
    assert.equal(exitPath.params.pubkeys.length, 2);
  }
});

test("Fulmine-compatible Warden delegation carries one owner signature slot", () => {
  const key = (byte: number) => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    return schnorr.getPublicKey(privateKey);
  };
  const buyer = key(1);
  const seller = key(2);
  const delegate = key(5);
  const built = buildWardenScript({
    buyerPubkey: buyer,
    sellerPubkey: seller,
    arbiterPubkey: key(3),
    serverPubkey: key(4),
    delegatePubkey: delegate,
    delegateApproval: "buyer-with-seller-authorization",
    refundAt: 1_800_000_000,
    exitDelaySeconds: 86_016,
  });
  const closure = decodeTapscript(built.delegatePath!);
  assert.equal(MultisigTapscript.is(closure), true);
  if (!MultisigTapscript.is(closure)) throw new Error("Expected multisig delegate path");
  assert.deepEqual(closure.params.pubkeys, [buyer, delegate, key(4)]);
});

test("bounded renewal key is isolated from buyer and seller fallback paths", () => {
  const key = (byte: number) => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    return schnorr.getPublicKey(privateKey);
  };
  const buyer = key(1);
  const seller = key(2);
  const renewal = key(6);
  const server = key(4);
  const built = buildWardenScript({
    buyerPubkey: buyer,
    sellerPubkey: seller,
    arbiterPubkey: key(3),
    serverPubkey: server,
    delegatePubkey: key(5),
    renewalPubkey: renewal,
    delegateApproval: "bounded-renewal-key",
    finalBuyerUnilateralExit: true,
    refundAt: 1_800_000_000,
    exitDelaySeconds: 86_016,
  });
  const delegated = decodeTapscript(built.delegatePath!);
  const intent = decodeTapscript(built.renewalIntentPath!);
  const fallback = decodeTapscript(built.collaborativePath);
  assert.equal(MultisigTapscript.is(delegated), true);
  assert.equal(MultisigTapscript.is(intent), true);
  assert.equal(MultisigTapscript.is(fallback), true);
  if (!MultisigTapscript.is(delegated) || !MultisigTapscript.is(intent) || !MultisigTapscript.is(fallback)) {
    throw new Error("Expected multisig renewal and fallback paths");
  }
  assert.deepEqual(delegated.params.pubkeys, [renewal, key(5), server]);
  assert.deepEqual(intent.params.pubkeys, [renewal, server]);
  assert.deepEqual(fallback.params.pubkeys, [buyer, seller, server]);
});

test("hardened Warden script carries two signer and two delegate routes plus stock exits", () => {
  const key = (byte: number) => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    return schnorr.getPublicKey(privateKey);
  };
  const built = buildWardenScript({
    buyerPubkey: key(1),
    sellerPubkey: key(2),
    arbiterPubkey: key(3),
    serverPubkey: key(4),
    renewalPubkeys: [key(6), key(7)],
    delegatePubkeys: [key(8), key(9)],
    delegateApproval: "bounded-renewal-key",
    finalBuyerUnilateralExit: true,
    refundAt: 1_800_000_000,
    exitDelaySeconds: 86_016,
  });
  assert.equal(built.delegatePaths.length, 4);
  assert.equal(built.renewalIntentPaths.length, 2);
  assert.equal(built.exitPaths.length, 4);
  assert.equal(built.script.exitPaths().length, 4);
  assert.ok(built.finalBuyerExitPath);
  const finalExit = decodeTapscript(built.finalBuyerExitPath!);
  assert.equal(ConditionCSVMultisigTapscript.is(finalExit), true);
  if (!ConditionCSVMultisigTapscript.is(finalExit)) throw new Error("Expected conditional CSV buyer exit");
  assert.equal(finalExit.params.pubkeys.length, 1);
  assert.deepEqual(finalExit.params.pubkeys[0], key(1));
  assert.deepEqual(
    finalExit.params.conditionScript,
    Script.encode([1_800_000_000, "CHECKLOCKTIMEVERIFY", "DROP", 1]),
  );
  const routes = built.delegatePaths.map((path) => {
    const decoded = decodeTapscript(path);
    assert.equal(MultisigTapscript.is(decoded), true);
    if (!MultisigTapscript.is(decoded)) throw new Error("Expected multisig delegate route");
    return decoded.params.pubkeys.map(hex.encode);
  });
  assert.deepEqual(routes, [
    [hex.encode(key(6)), hex.encode(key(8)), hex.encode(key(4))],
    [hex.encode(key(7)), hex.encode(key(8)), hex.encode(key(4))],
    [hex.encode(key(6)), hex.encode(key(9)), hex.encode(key(4))],
    [hex.encode(key(7)), hex.encode(key(9)), hex.encode(key(4))],
  ]);
});

test("stock arkd preflight accepts the hardened closure-only tree", () => {
  const key = (byte: number) => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    return schnorr.getPublicKey(privateKey);
  };
  const server = key(4);
  const built = buildWardenScript({
    buyerPubkey: key(1),
    sellerPubkey: key(2),
    arbiterPubkey: key(3),
    serverPubkey: server,
    renewalPubkeys: [key(6), key(7)],
    delegatePubkeys: [key(8), key(9)],
    delegateApproval: "bounded-renewal-key",
    refundAt: 1_800_000_000,
    exitDelaySeconds: 86_016,
  });
  assert.equal(assertStockArkdWardenScript(built, {
    serverPubkey: server,
    minimumExitDelaySeconds: 86_016,
  }), built);
  assert.equal(built.exitPaths.length, 3);
  assert.equal(built.finalBuyerExitPath, undefined);
});

test("stock arkd preflight rejects the old combined time-and-exit leaf", () => {
  const key = (byte: number) => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    return schnorr.getPublicKey(privateKey);
  };
  const server = key(4);
  const built = buildWardenScript({
    buyerPubkey: key(1),
    sellerPubkey: key(2),
    arbiterPubkey: key(3),
    serverPubkey: server,
    renewalPubkeys: [key(6), key(7)],
    delegatePubkeys: [key(8), key(9)],
    delegateApproval: "bounded-renewal-key",
    finalBuyerUnilateralExit: true,
    refundAt: 1_800_000_000,
    exitDelaySeconds: 86_016,
  });
  assert.throws(
    () => assertStockArkdWardenScript(built, { serverPubkey: server, minimumExitDelaySeconds: 86_016 }),
    /does not accept/,
  );
});

test("seller authorization binds the exact delegated rollover terms", async () => {
  const seller = MnemonicIdentity.fromMnemonic(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { isMainnet: true },
  );
  const terms: RolloverAuthorizationTerms = {
    contractId: "88017bdd-3be1-4df8-adc5-f206a77ca8d7",
    input: { txid: "12".repeat(32), vout: 0, value: 1_000, expiresAt: "2026-09-16T05:37:37.000Z" },
    successor: { address: "ark1test", value: 1_000, refundAt: "2026-09-16T20:58:31.000Z" },
    quotedFeeSats: 0,
    maxFeeSats: 0,
    delegate: {
      url: "http://127.0.0.1:7372",
      pubkey: "34".repeat(32),
      feeSats: 0,
      delegateAt: "2026-09-13T05:37:37.000Z",
      authorizationExpiresAt: "2026-09-09T21:33:59.072Z",
    },
  };
  const signature = await seller.signMessage(rolloverAuthorizationDigest(terms), "schnorr");
  const pubkey = hex.encode(await seller.xOnlyPublicKey());
  assert.equal(verifySellerRolloverAuthorization(terms, pubkey, hex.encode(signature)), true);
  assert.equal(
    verifySellerRolloverAuthorization(
      { ...terms, maxFeeSats: 1 },
      pubkey,
      hex.encode(signature),
    ),
    false,
  );
});

test("legacy Warden scripts remain decodable but intentionally have no exit leaf", () => {
  const key = (byte: number) => {
    const bytes = new Uint8Array(32);
    bytes[31] = byte;
    return bytes;
  };
  const built = buildWardenScript({
    buyerPubkey: key(1),
    sellerPubkey: key(2),
    arbiterPubkey: key(3),
    serverPubkey: key(4),
    refundAt: 1_800_000_000,
  });
  assert.equal(built.exitPaths.length, 0);
  assert.equal(built.script.exitPaths().length, 0);
});

test("mobile signature merge verifies every input in a multi-deposit spend", async () => {
  const buyer = MnemonicIdentity.fromMnemonic(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { isMainnet: true },
  );
  const seller = MnemonicIdentity.fromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    { isMainnet: true },
  );
  const buyerPubkey = await buyer.xOnlyPublicKey();
  const sellerPubkey = await seller.xOnlyPublicKey();
  const script = buildWardenScript({
    buyerPubkey,
    sellerPubkey,
    arbiterPubkey: sellerPubkey,
    serverPubkey: sellerPubkey,
    refundAt: 1_900_000_000,
    exitDelaySeconds: 86_016,
  });
  const tapLeafScript = script.script.findLeaf(hex.encode(script.collaborativePath));
  const { arkTx } = buildOffchainTx(
    [
      { txid: "31".repeat(32), vout: 0, value: 1_000, tapLeafScript, tapTree: script.script.encode() },
      { txid: "32".repeat(32), vout: 0, value: 1_000, tapLeafScript, tapTree: script.script.encode() },
    ],
    [{ amount: 2_000n, script: script.script.pkScript }],
    CSVMultisigTapscript.encode({
      pubkeys: [sellerPubkey],
      timelock: { type: "seconds", value: 86_016n },
    }),
  );
  const signed = await buyer.sign(arkTx);
  const merged = applyRequiredTapscriptSignatures(
    base64.encode(signed.toPSBT()),
    base64.encode(arkTx.toPSBT()),
    hex.encode(buyerPubkey),
  );
  assert.equal(merged.inputsLength, 2);
  assert.equal(merged.getInput(0).tapScriptSig?.length, 1);
  assert.equal(merged.getInput(1).tapScriptSig?.length, 1);
});

test("fixed escrow funding distinguishes exact, underfunded, and overfunded balances", () => {
  assert.equal(assessFunding(1_000, 0).state, "unfunded");
  assert.deepEqual(assessFunding(1_000, 600), {
    state: "underfunded",
    expectedAmountSats: 1_000,
    fundedAmountSats: 600,
    remainingAmountSats: 400,
    overfundedAmountSats: 0,
  });
  assert.equal(assessFunding(1_000, 1_000).state, "funded");
  assert.deepEqual(assessFunding(1_000, 2_000), {
    state: "overfunded",
    expectedAmountSats: 1_000,
    fundedAmountSats: 2_000,
    remainingAmountSats: 0,
    overfundedAmountSats: 1_000,
  });
});

test("bounded renewal stops once the current VTXO covers the escrow final date", () => {
  const mandate: RenewalMandate = {
    version: 1,
    contractId: "contract",
    escrowAddress: "ark1test",
    buyerPubkey: "11".repeat(32),
    sellerPubkey: "22".repeat(32),
    renewalPubkey: "33".repeat(32),
    delegatePubkey: "44".repeat(32),
    finalAt: "2026-09-16T20:58:31.000Z",
    triggerBeforeExpirySeconds: 72 * 60 * 60,
    manualFallbackAfterSeconds: 30 * 60,
    maxFeePerRolloverSats: 0,
    maxTotalFeeSats: 0,
    maxRenewals: 4,
    exactSuccessorAddress: true,
    preserveParties: true,
    paused: false,
  };
  assert.equal(
    renewalDecision(mandate, { completedRenewals: 1, totalFeesSats: 0 }, "2026-09-16T21:51:11.000Z", new Date("2026-09-10T00:00:00Z")).action,
    "stop",
  );
  assert.equal(boundedRenewalCap(365 * 24 * 60 * 60), 93);
});

test("bounded renewal escalates from automatic attempt to phone fallback", () => {
  const mandate: RenewalMandate = {
    version: 1,
    contractId: "contract",
    escrowAddress: "ark1test",
    buyerPubkey: "11".repeat(32),
    sellerPubkey: "22".repeat(32),
    renewalPubkey: "33".repeat(32),
    delegatePubkey: "44".repeat(32),
    finalAt: "2026-10-01T00:00:00.000Z",
    triggerBeforeExpirySeconds: 72 * 60 * 60,
    manualFallbackAfterSeconds: 30 * 60,
    maxFeePerRolloverSats: 0,
    maxTotalFeeSats: 0,
    maxRenewals: 8,
    exactSuccessorAddress: true,
    preserveParties: true,
    paused: false,
  };
  const now = new Date("2026-09-10T00:00:00Z");
  const expiry = "2026-09-12T23:00:00Z";
  assert.equal(renewalDecision(mandate, { completedRenewals: 0, totalFeesSats: 0 }, expiry, now).action, "schedule");
  assert.equal(
    renewalDecision(
      mandate,
      { completedRenewals: 0, totalFeesSats: 0, lastAttemptAt: "2026-09-09T23:00:00Z" },
      expiry,
      now,
    ).action,
    "manual-fallback",
  );
});

const hardenedMandateFixture = () => {
  const privateKey = (byte: number) => {
    const key = new Uint8Array(32);
    key[31] = byte;
    return key;
  };
  const pubkey = (byte: number) => hex.encode(schnorr.getPublicKey(privateKey(byte)));
  const terms: RenewalMandateTerms = {
    version: 1,
    purpose: "frontier-crown-warden-bounded-renewal",
    network: "bitcoin",
    contractId: "hardened-contract",
    escrowAddress: "ark1hardenedescrow",
    escrowScript: `5120${pubkey(10)}`,
    buyerPubkey: pubkey(1),
    sellerPubkey: pubkey(2),
    arbiterPubkey: pubkey(3),
    arkServerUrl: "https://ark.frontiercrown.com",
    arkServerPubkey: pubkey(4),
    arkServerVersion: "v0.9.16",
    expectedExitDelaySeconds: 86_016,
    createdAt: "2026-09-01T00:00:00.000Z",
    finalAt: "2026-10-01T00:00:00.000Z",
    triggerBeforeExpirySeconds: 72 * 60 * 60,
    manualFallbackAfterSeconds: 30 * 60,
    maxFeePerRolloverSats: 5,
    maxTotalFeeSats: 20,
    maxRenewals: 8,
    renewalSigners: [
      { pubkey: pubkey(6), priority: 0, role: "primary" },
      { pubkey: pubkey(7), priority: 1, role: "recovery" },
    ],
    delegates: [
      { url: "https://delegate-1.frontiercrown.com", pubkey: pubkey(8), priority: 0, maxFeeSats: 5 },
      { url: "https://delegate-2.frontiercrown.com", pubkey: pubkey(9), priority: 1, maxFeeSats: 5 },
    ],
    exactSuccessorAddress: true,
    preserveScript: true,
    preserveParties: true,
    requireStockExitLeaves: true,
  };
  const digest = renewalMandateDigest(terms);
  const mandate: SignedRenewalMandate = {
    mandateId: renewalMandateId(terms),
    terms,
    approvals: {
      buyer: { pubkey: terms.buyerPubkey, signature: hex.encode(schnorr.sign(digest, privateKey(1))) },
      seller: { pubkey: terms.sellerPubkey, signature: hex.encode(schnorr.sign(digest, privateKey(2))) },
    },
  };
  return { privateKey, pubkey, mandate };
};

const hardenedProposal = (
  mandate: SignedRenewalMandate,
  inputTxid: string,
  inputValue: number,
  inputExpiresAt: string,
  signerPubkey = mandate.terms.renewalSigners[0].pubkey,
  delegatePubkey = mandate.terms.delegates[0].pubkey,
): RenewalProposal => ({
  input: { txid: inputTxid, vout: 0, value: inputValue, expiresAt: inputExpiresAt },
  successor: {
    address: mandate.terms.escrowAddress,
    script: mandate.terms.escrowScript,
    value: inputValue - 1,
    refundAt: mandate.terms.finalAt,
  },
  quotedFeeSats: 1,
  signerPubkey,
  delegatePubkey,
  arkServerUrl: mandate.terms.arkServerUrl,
  arkServerPubkey: mandate.terms.arkServerPubkey,
  arkServerVersion: mandate.terms.arkServerVersion,
  network: "bitcoin",
  exitDelaySeconds: mandate.terms.expectedExitDelaySeconds,
});

test("buyer and seller signatures bind every hardened renewal mandate limit", () => {
  const { mandate } = hardenedMandateFixture();
  assert.equal(verifySignedRenewalMandate(mandate), mandate);
  assert.throws(
    () => verifySignedRenewalMandate({ ...mandate, terms: { ...mandate.terms, maxRenewals: 9 } }),
    /identifier changed/,
  );
  assert.throws(
    () => verifySignedRenewalMandate({ ...mandate, terms: { ...mandate.terms, escrowAddress: "ark1attacker" } }),
    /identifier changed/,
  );
});

test("hardened signer authorizes three sequential stock renewals and reconstructs its counter", () => {
  const { privateKey, mandate } = hardenedMandateFixture();
  const journal: RenewalJournal = {
    schemaVersion: 1,
    mandateId: mandate.mandateId,
    initialOutpoint: { txid: "11".repeat(32), vout: 0 },
    receipts: [],
  };
  let inputTxid = journal.initialOutpoint.txid;
  let inputValue = 1_000;
  const expiries = [
    "2026-09-05T00:00:00.000Z",
    "2026-09-09T00:00:00.000Z",
    "2026-09-13T00:00:00.000Z",
    "2026-09-17T00:00:00.000Z",
  ];
  for (let index = 0; index < 3; index += 1) {
    const proposal = hardenedProposal(mandate, inputTxid, inputValue, expiries[index]);
    const authorization = authorizeBoundedRenewal(
      mandate,
      journal,
      proposal,
      { online: true, indexerOnline: true },
      new Date(Date.parse(expiries[index]) - 48 * 60 * 60 * 1_000),
    );
    assert.equal(authorization.sequence, index + 1);
    const successorTxid = `${index + 2}`.repeat(64).slice(0, 64);
    const receiptTerms = {
      version: 1 as const,
      mandateId: mandate.mandateId,
      sequence: authorization.sequence,
      input: proposal.input,
      successor: {
        txid: successorTxid,
        vout: 0,
        value: proposal.successor.value,
        expiresAt: expiries[index + 1],
        address: proposal.successor.address,
        script: proposal.successor.script,
      },
      feeSats: proposal.quotedFeeSats,
      signerPubkey: proposal.signerPubkey,
      delegatePubkey: proposal.delegatePubkey,
      commitmentTxid: `${index + 5}`.repeat(64).slice(0, 64),
      completedAt: new Date(Date.parse(expiries[index]) - 47 * 60 * 60 * 1_000).toISOString(),
    };
    const receipt: SignedRenewalReceipt = {
      ...receiptTerms,
      signature: hex.encode(schnorr.sign(renewalReceiptDigest(receiptTerms), privateKey(6))),
    };
    journal.receipts.push(receipt);
    inputTxid = successorTxid;
    inputValue -= 1;
  }
  assert.deepEqual(deriveRenewalHistory(mandate, journal), {
    completedRenewals: 3,
    totalFeesSats: 3,
    lastSuccessAt: journal.receipts[2].completedAt,
    currentOutpoint: { txid: inputTxid, vout: 0 },
  });
});

test("hardened signer refuses theft, replay, wrong operator, excessive fee, and offline operation", () => {
  const { mandate } = hardenedMandateFixture();
  const journal: RenewalJournal = {
    schemaVersion: 1,
    mandateId: mandate.mandateId,
    initialOutpoint: { txid: "11".repeat(32), vout: 0 },
    receipts: [],
  };
  const proposal = hardenedProposal(mandate, journal.initialOutpoint.txid, 1_000, "2026-09-05T00:00:00.000Z");
  const now = new Date("2026-09-03T00:00:00.000Z");
  assert.throws(
    () => authorizeBoundedRenewal(mandate, journal, { ...proposal, successor: { ...proposal.successor, address: "ark1attacker" } }, { online: true, indexerOnline: true }, now),
    /destination changed/,
  );
  assert.throws(
    () => authorizeBoundedRenewal(mandate, journal, { ...proposal, successor: { ...proposal.successor, value: 900 } }, { online: true, indexerOnline: true }, now),
    /value conservation failed/,
  );
  assert.throws(
    () => authorizeBoundedRenewal(mandate, journal, { ...proposal, arkServerPubkey: "ff".repeat(32) }, { online: true, indexerOnline: true }, now),
    /identity or version changed/,
  );
  assert.throws(
    () => authorizeBoundedRenewal(mandate, journal, { ...proposal, quotedFeeSats: 6, successor: { ...proposal.successor, value: 994 } }, { online: true, indexerOnline: true }, now),
    /per-renewal ceiling/,
  );
  assert.throws(
    () => authorizeBoundedRenewal(mandate, journal, proposal, { online: false, indexerOnline: true }, now),
    /unilateral-exit recovery path/,
  );
  assert.throws(
    () => authorizeBoundedRenewal(mandate, { ...journal, initialOutpoint: { txid: "22".repeat(32), vout: 0 } }, proposal, { online: true, indexerOnline: true }, now),
    /stale or replayed/,
  );
});

test("hardened redundancy selects recovery signer and backup delegate without changing terms", () => {
  const { mandate } = hardenedMandateFixture();
  const primarySigner = mandate.terms.renewalSigners[0];
  const recoverySigner = mandate.terms.renewalSigners[1];
  const primaryDelegate = mandate.terms.delegates[0];
  const backupDelegate = mandate.terms.delegates[1];
  assert.equal(
    selectRenewalSigner(mandate, { [primarySigner.pubkey]: false, [recoverySigner.pubkey]: true })?.pubkey,
    recoverySigner.pubkey,
  );
  assert.equal(
    selectRenewalDelegate(mandate, { [primaryDelegate.pubkey]: false, [backupDelegate.pubkey]: true })?.pubkey,
    backupDelegate.pubkey,
  );
  const journal: RenewalJournal = {
    schemaVersion: 1,
    mandateId: mandate.mandateId,
    initialOutpoint: { txid: "11".repeat(32), vout: 0 },
    receipts: [],
  };
  const proposal = hardenedProposal(
    mandate,
    journal.initialOutpoint.txid,
    1_000,
    "2026-09-05T00:00:00.000Z",
    recoverySigner.pubkey,
    backupDelegate.pubkey,
  );
  assert.equal(
    authorizeBoundedRenewal(mandate, journal, proposal, { online: true, indexerOnline: true }, new Date("2026-09-03T00:00:00Z")).action,
    "authorize",
  );
});

test("software validation failures do not consume signer or delegate redundancy", () => {
  assert.deepEqual(classifyRenewalRouteFailure("Rollover refund deadline changed"), {
    signer: false,
    delegate: false,
  });
  assert.deepEqual(classifyRenewalRouteFailure("Renewal signer unavailable"), {
    signer: true,
    delegate: false,
  });
  assert.deepEqual(classifyRenewalRouteFailure("Fulmine delegate unavailable"), {
    signer: false,
    delegate: true,
  });
});

test("completed delegated authorization stays reserved only until its signed expiry", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  const active = { stage: "completed", expiresAt: "2026-09-09T12:01:00Z" };
  const expired = { stage: "completed", expiresAt: "2026-09-09T12:00:00Z" };
  assert.equal(delegatedAuthorizationIsActive(active, now), true);
  assert.equal(delegatedAuthorizationExpired(active, now), false);
  assert.equal(delegatedAuthorizationIsActive(expired, now), false);
  assert.equal(delegatedAuthorizationExpired(expired, now), true);
  assert.equal(delegatedAuthorizationIsActive({ stage: "queued" }, now), true);
  assert.equal(delegatedAuthorizationExpired({ stage: "failed" }, now), false);
});

test("operator-outage recovery bundle preserves the current VTXO and all stock exit paths", () => {
  const { mandate } = hardenedMandateFixture();
  const bundle: UnilateralExitBundle = {
    schemaVersion: 2,
    mandateId: mandate.mandateId,
    contractId: mandate.terms.contractId,
    arkServerUrl: mandate.terms.arkServerUrl,
    arkServerPubkey: mandate.terms.arkServerPubkey,
    network: "bitcoin",
    currentVtxo: {
      txid: "11".repeat(32),
      vout: 0,
      value: 1_000,
      expiresAt: "2026-09-05T00:00:00.000Z",
      tapTree: "aa",
      script: mandate.terms.escrowScript,
    },
    exitPaths: ["aa", "bb", "cc", "dd"],
    finalBuyerExitPath: "dd",
    participantKeys: [mandate.terms.buyerPubkey, mandate.terms.sellerPubkey, mandate.terms.arbiterPubkey],
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  assert.equal(assertUnilateralExitBundle(mandate, bundle), bundle);
  assert.throws(() => assertUnilateralExitBundle(mandate, { ...bundle, exitPaths: ["aa"] }), /all Warden exit paths/);
  assert.throws(
    () => assertUnilateralExitBundle(mandate, { ...bundle, finalBuyerExitPath: "ee" }),
    /buyer-only final recovery path/,
  );
});

test("stock recovery bundle requires three operator-independent two-party exits", () => {
  const { mandate } = hardenedMandateFixture();
  const bundle: UnilateralExitBundle = {
    schemaVersion: 3,
    mandateId: mandate.mandateId,
    contractId: mandate.terms.contractId,
    arkServerUrl: mandate.terms.arkServerUrl,
    arkServerPubkey: mandate.terms.arkServerPubkey,
    network: "bitcoin",
    currentVtxo: {
      txid: "11".repeat(32),
      vout: 0,
      value: 1_000,
      expiresAt: "2026-09-05T00:00:00.000Z",
      tapTree: "aa",
      script: mandate.terms.escrowScript,
    },
    exitPaths: ["aa", "bb", "cc"],
    recoveryModel: "operator-independent-two-party-stock-exit",
    participantKeys: [mandate.terms.buyerPubkey, mandate.terms.sellerPubkey, mandate.terms.arbiterPubkey],
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  assert.equal(assertUnilateralExitBundle(mandate, bundle), bundle);
  assert.throws(
    () => assertUnilateralExitBundle(mandate, { ...bundle, exitPaths: ["aa", "bb"] }),
    /does not preserve/,
  );
});
