import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  ArkAddress,
  Estimator,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  RestArkProvider,
  Transaction,
  VtxoScript,
  Wallet,
  configureEventSource,
  contractHandlers,
  networks,
  verifyTapscriptSignatures,
  type Contract,
  type ContractHandler,
  type Identity,
  type PathContext,
  type SignerSession,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { EventSource } from "eventsource";
import { exactTapscriptSighash } from "./signing.js";
import { buildWardenScript } from "./warden-script.js";

type MobileTimeContractRecord = {
  schemaVersion: 4 | 5;
  scriptVersion?: 2 | 3;
  exitDelaySeconds?: number;
  contractId: string;
  serviceUrl: string;
  network: "bitcoin";
  serverPubkey: string;
  buyerPubkey: string;
  buyerArkadeAddress: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  refundAt: number;
  escrowAddress: string;
  rolloverPolicy?: { delegatePubkey?: string };
};

type RecoverySession = {
  schemaVersion: 1;
  sessionId: string;
  contractId: string;
  contractPath: string;
  createdAt: string;
  expiresAt: string;
  stage: "queued" | "running" | "awaiting_mobile_signature" | "completed" | "failed";
  execution: "mutual-preserve-escrow" | "buyer-refund-after-expiry";
  input: { txid: string; vout: number; value: number; expiresAt?: string };
  destination: { address: string; script: string; value: number };
  quotedFeeSats: number;
  maxFeeSats: number;
  requiredApprovals: ["buyer-mobile-wallet"] | ["buyer-mobile-wallet", "seller-keychain"];
  workerPid?: number;
  request?: {
    requestId: string;
    purpose: string;
    psbt: string;
    inputIndexes: number[];
    createdAt: string;
  };
  events: Array<{ at: string; type: string }>;
  result?: { commitmentTxid: string; completedAt: string };
  error?: string;
};

type WardenParams = {
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  serverPubkey: string;
  refundAt: string;
  delegatePubkey?: string;
  spendPath: "collaborative" | "refund";
  scriptVersion?: string;
  exitDelaySeconds?: string;
};

const serviceUrl = process.env.ARKADE_URL ?? "http://127.0.0.1:7270";
const escrowRoot = resolve(process.env.ESCROW_ROOT ?? process.cwd());
const recoveryDirectory = resolve(escrowRoot, "recovery-sessions");
const sessionId = process.argv[2];
if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid recovery session id");
const sessionPath = resolve(recoveryDirectory, `${sessionId}.json`);

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJsonAtomic = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
const responsePath = (requestId: string) =>
  resolve(recoveryDirectory, `${sessionId}.response.${requestId}.json`);
const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

let session = readJson<RecoverySession>(sessionPath);
const updateSession = (patch: Partial<RecoverySession>, event?: string) => {
  session = {
    ...session,
    ...patch,
    events: event ? [...session.events, { at: new Date().toISOString(), type: event }] : session.events,
  };
  writeJsonAtomic(sessionPath, session);
};

const account = process.env.USER;
if (!account) throw new Error("USER is unavailable");
const keychainMnemonic = (role: "seller" | "arbiter") =>
  execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", `frontiercrown.arkade.mainnet.escrow.${role}`, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();

const seller = MnemonicIdentity.fromMnemonic(keychainMnemonic("seller"), { isMainnet: true });
const arbiter = MnemonicIdentity.fromMnemonic(keychainMnemonic("arbiter"), { isMainnet: true });

const scriptFor = (params: WardenParams) => {
  const built = buildWardenScript({
    buyerPubkey: hex.decode(params.buyerPubkey),
    sellerPubkey: hex.decode(params.sellerPubkey),
    arbiterPubkey: hex.decode(params.arbiterPubkey),
    serverPubkey: hex.decode(params.serverPubkey),
    refundAt: Number(params.refundAt),
    delegatePubkey: params.delegatePubkey ? hex.decode(params.delegatePubkey) : undefined,
    exitDelaySeconds:
      params.scriptVersion === "2" || params.scriptVersion === "3"
        ? Number(params.exitDelaySeconds)
        : undefined,
    delegateApproval:
      params.scriptVersion === "3" ? "buyer-with-seller-authorization" : "buyer-and-seller",
  });
  return {
    collaborativePath: built.collaborativePath,
    refundPath: built.refundPath,
    script: built.script,
  };
};

type WardenHandler = ContractHandler<WardenParams, VtxoScript> & {
  deriveTapscripts(script: VtxoScript, contract: Contract): {
    forfeitTapLeafScript: ReturnType<VtxoScript["findLeaf"]>;
    intentTapLeafScript: ReturnType<VtxoScript["findLeaf"]>;
    tapTree: Uint8Array;
  };
};

const wardenHandler: WardenHandler = {
  type: "frontier-crown-warden-recovery-v1",
  createScript(params: Record<string, string>) {
    return scriptFor(this.deserializeParams(params)).script;
  },
  serializeParams(params: WardenParams) {
    return { ...params };
  },
  deserializeParams(params: Record<string, string>) {
    const required = ["buyerPubkey", "sellerPubkey", "arbiterPubkey", "serverPubkey", "refundAt"] as const;
    for (const key of required) if (!params[key]) throw new Error(`Missing Warden parameter ${key}`);
    return {
      ...(Object.fromEntries(required.map((key) => [key, params[key]])) as Omit<WardenParams, "spendPath">),
      delegatePubkey: params.delegatePubkey,
      spendPath: params.spendPath === "refund" ? "refund" : "collaborative",
      scriptVersion: params.scriptVersion,
      exitDelaySeconds: params.exitDelaySeconds,
    };
  },
  selectPath(script: VtxoScript, contract: Contract, context: PathContext) {
    if (!context.collaborative) return null;
    const params = this.deserializeParams(contract.params);
    const built = scriptFor(params);
    const selected = params.spendPath === "refund" ? built.refundPath : built.collaborativePath;
    return { leaf: script.findLeaf(hex.encode(selected)) };
  },
  getAllSpendingPaths(script: VtxoScript, contract: Contract, context: PathContext) {
    const selected = this.selectPath(script, contract, context);
    return selected ? [selected] : [];
  },
  getSpendablePaths(script: VtxoScript, contract: Contract, context: PathContext) {
    const selected = this.selectPath(script, contract, context);
    return selected ? [selected] : [];
  },
  isGenericallySpendable() {
    return false;
  },
  assertSpendableNow(_script: VtxoScript, contract: Contract, context: PathContext) {
    if (!context.collaborative) throw new Error("Warden recovery requires a stock Arkade recovery batch");
    const params = this.deserializeParams(contract.params);
    if (params.spendPath !== "refund") return;
    const now = BigInt(Math.floor(context.chainTime ?? context.currentTime / 1_000));
    if (now < BigInt(params.refundAt)) {
      throw new Error(`Buyer recovery is timelocked until ${new Date(Number(params.refundAt) * 1_000).toISOString()}`);
    }
  },
  deriveTapscripts(script: VtxoScript, contract: Contract) {
    const params = this.deserializeParams(contract.params);
    const built = scriptFor(params);
    const selected = params.spendPath === "refund" ? built.refundPath : built.collaborativePath;
    const leaf = script.findLeaf(hex.encode(selected));
    return { forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, tapTree: script.encode() };
  },
};

class MobileRecoveryIdentity implements Identity {
  private requestNumber = 0;
  private signingQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly buyerPubkey: Uint8Array,
    private readonly sellerIdentity: MnemonicIdentity,
    private readonly includeSellerSignature: boolean,
  ) {}

  async xOnlyPublicKey() {
    return new Uint8Array(this.buyerPubkey);
  }

  async compressedPublicKey() {
    return Uint8Array.from([2, ...this.buyerPubkey]);
  }

  signerSession(): SignerSession {
    // The batch-tree signer is ephemeral and does not control the recovered output.
    return this.sellerIdentity.signerSession();
  }

  async signMessage(): Promise<Uint8Array> {
    throw new Error("Warden recovery does not authorize arbitrary message signing");
  }

  sign(tx: Transaction, inputIndexes?: number[]) {
    const pending = this.signingQueue.then(() => this.signOne(tx, inputIndexes));
    this.signingQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async signOne(tx: Transaction, inputIndexes?: number[]) {
    const indexes = inputIndexes ?? Array.from({ length: tx.inputsLength }, (_, index) => index);
    const requestId = randomUUID();
    const purpose = `approve-expiry-recovery-stock-signature-${this.requestNumber + 1}`;
    this.requestNumber += 1;
    updateSession(
      {
        stage: "awaiting_mobile_signature",
        request: {
          requestId,
          purpose,
          psbt: base64.encode(tx.toPSBT()),
          inputIndexes: indexes,
          createdAt: new Date().toISOString(),
        },
      },
      `mobile-signature-requested:${purpose}`,
    );
    const path = responsePath(requestId);
    while (!existsSync(path)) {
      if (Date.now() >= Date.parse(session.expiresAt)) throw new Error("Recovery signing session expired");
      await delay(350);
      session = readJson<RecoverySession>(sessionPath);
    }
    const response = readJson<{ sessionId: string; requestId: string; signedPsbt: string }>(path);
    if (response.sessionId !== sessionId || response.requestId !== requestId) {
      throw new Error("Recovery signature response mismatch");
    }
    const signed = Transaction.fromPSBT(base64.decode(response.signedPsbt));
    const original = Transaction.fromPSBT(tx.toPSBT());
    if (hex.encode(signed.unsignedTx) !== hex.encode(original.unsignedTx)) {
      throw new Error("Mobile recovery signature changed the prepared transaction");
    }
    const buyerHex = hex.encode(this.buyerPubkey);
    for (const index of indexes) {
      const buyerSignature = (signed.getInput(index).tapScriptSig ?? []).find(
        ([key]) => hex.encode(key.pubKey) === buyerHex,
      );
      if (!buyerSignature) throw new Error(`Mobile wallet omitted buyer signature for input ${index}`);
      const existing = original.getInput(index).tapScriptSig ?? [];
      original.updateInput(index, { tapScriptSig: [...existing, buyerSignature] }, true);
      verifyTapscriptSignatures(original, index, [buyerHex], [], [exactTapscriptSighash(original, index)]);
    }
    let fullySigned = original;
    if (this.includeSellerSignature) {
      fullySigned = await this.sellerIdentity.sign(original, indexes);
      const sellerHex = hex.encode(await this.sellerIdentity.xOnlyPublicKey());
      for (const index of indexes) {
        verifyTapscriptSignatures(
          fullySigned,
          index,
          [buyerHex, sellerHex],
          [],
          [exactTapscriptSighash(fullySigned, index)],
        );
      }
    }
    unlinkSync(path);
    updateSession({ stage: "running", request: undefined }, `mobile-signature-accepted:${purpose}`);
    return fullySigned;
  }
}

const run = async () => {
  if (session.stage !== "queued") throw new Error(`Recovery worker cannot start from ${session.stage}`);
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("Recovery session already expired");
  if (dirname(session.contractPath) !== resolve(escrowRoot, "contracts")) throw new Error("Invalid recovery contract path");
  if (basename(session.contractPath) === "active.json") throw new Error("Recovery must reference an immutable contract record");
  const record = readJson<MobileTimeContractRecord>(session.contractPath);
  if ((record.schemaVersion !== 4 && record.schemaVersion !== 5) || record.contractId !== session.contractId) {
    throw new Error("Recovery contract changed");
  }
  if (record.serviceUrl !== serviceUrl || record.network !== "bitcoin") throw new Error("Recovery network mismatch");
  const refundMode = session.execution === "buyer-refund-after-expiry";
  if (refundMode && record.refundAt > Math.floor(Date.now() / 1_000)) throw new Error("Buyer refund is not unlocked yet");
  if (!refundMode && record.escrowAddress !== session.destination.address) {
    throw new Error("Pre-deadline recovery must preserve the escrow address");
  }
  if (refundMode && record.buyerArkadeAddress !== session.destination.address) {
    throw new Error("Post-deadline recovery must return to the recorded buyer wallet");
  }

  const arkProvider = new RestArkProvider(serviceUrl);
  const info = await arkProvider.getInfo();
  if (info.version !== "v0.9.16" || info.network !== "bitcoin") {
    throw new Error("Recovery requires reviewed stock arkd v0.9.16");
  }
  if (
    (record.scriptVersion !== 2 && record.scriptVersion !== 3) ||
    record.exitDelaySeconds !== Number(info.unilateralExitDelay)
  ) {
    throw new Error("Recovery requires a stock-compatible Warden VTXO with the current exit delay");
  }
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  const serverHex = hex.encode(serverPubkey);
  const sellerHex = hex.encode(await seller.xOnlyPublicKey());
  const arbiterHex = hex.encode(await arbiter.xOnlyPublicKey());
  if (record.serverPubkey !== serverHex || record.sellerPubkey !== sellerHex || record.arbiterPubkey !== arbiterHex) {
    throw new Error("Recovery signer identities do not match the contract");
  }
  const params: WardenParams = {
    buyerPubkey: record.buyerPubkey,
    sellerPubkey: record.sellerPubkey,
    arbiterPubkey: record.arbiterPubkey,
    serverPubkey: record.serverPubkey,
    refundAt: String(record.refundAt),
    delegatePubkey: record.rolloverPolicy?.delegatePubkey,
    spendPath: refundMode ? "refund" : "collaborative",
    scriptVersion: String(record.scriptVersion),
    exitDelaySeconds: String(record.exitDelaySeconds),
  };
  const built = scriptFor(params);
  const derivedAddress = built.script.address(networks.bitcoin.hrp, serverPubkey).encode();
  if (derivedAddress !== record.escrowAddress) throw new Error("Recovery contract failed deterministic re-derivation");
  const decodedDestination = ArkAddress.decode(session.destination.address);
  if (
    decodedDestination.hrp !== networks.bitcoin.hrp ||
    hex.encode(decodedDestination.serverPubKey) !== record.serverPubkey ||
    hex.encode(decodedDestination.pkScript) !== session.destination.script
  ) {
    throw new Error("Recovery destination does not match the reviewed Arkade address");
  }

  if (!contractHandlers.has(wardenHandler.type)) contractHandlers.register(wardenHandler);
  configureEventSource((url) => new EventSource(url));
  const identity = new MobileRecoveryIdentity(hex.decode(record.buyerPubkey), seller, !refundMode);
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: serviceUrl,
    walletMode: "static",
    settlementConfig: false,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });
  try {
    if (refundMode && (await wallet.getAddress()) !== record.buyerArkadeAddress) {
      throw new Error("Recovery wallet address does not match the recorded buyer address");
    }
    const manager = await wallet.getContractManager();
    await manager.createContract({
      type: wardenHandler.type,
      label: `Warden recovery ${record.contractId}`,
      params: wardenHandler.serializeParams(params),
      script: hex.encode(built.script.pkScript),
      address: record.escrowAddress,
      metadata: { contractId: record.contractId, purpose: "expiry-recovery" },
    });
    const [entry] = await manager.getContractsWithVtxos({ script: hex.encode(built.script.pkScript) });
    if (!entry) throw new Error("Recovery contract was not registered in the stock wallet");
    const inputs = entry.vtxos.filter((vtxo) => !vtxo.isSpent && vtxo.isSwept);
    if (inputs.length !== 1) throw new Error(`Expected one recoverable Warden VTXO, found ${inputs.length}`);
    const [input] = inputs;
    if (input.txid !== session.input.txid || input.vout !== session.input.vout || input.value !== session.input.value) {
      throw new Error("Recoverable VTXO changed after approval");
    }

    const estimator = new Estimator(info.fees.intentFee);
    const inputFee = estimator.evalOffchainInput({
      amount: BigInt(input.value),
      type: "recoverable",
      weight: 0,
      birth: input.createdAt,
      expiry: input.expiresAt,
    }).satoshis;
    let destinationValue = input.value - inputFee;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const outputFee = estimator.evalOffchainOutput({
        amount: BigInt(destinationValue),
        script: session.destination.script,
      }).satoshis;
      const next = input.value - inputFee - outputFee;
      if (next === destinationValue) break;
      destinationValue = next;
    }
    const feeSats = input.value - destinationValue;
    if (feeSats !== session.quotedFeeSats || destinationValue !== session.destination.value) {
      throw new Error("Stock recovery fee changed; refresh and approve again");
    }
    if (feeSats > session.maxFeeSats) throw new Error("Stock recovery fee exceeds the approved cap");
    if (destinationValue < Number(info.dust)) throw new Error("Recovery output is below dust");

    updateSession({ stage: "running" }, "stock-recovery-batch-registration-started");
    const commitmentTxid = await wallet.settle(
      {
        inputs,
        outputs: [{ address: session.destination.address, amount: BigInt(destinationValue) }],
      },
      (event) => updateSession({}, `stock-recovery-batch:${event.type}`),
    );
    updateSession(
      {
        stage: "completed",
        request: undefined,
        result: { commitmentTxid, completedAt: new Date().toISOString() },
      },
      "expiry-recovery-completed",
    );
  } finally {
    await wallet.dispose();
  }
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  updateSession({ stage: "failed", request: undefined, error: message }, "expiry-recovery-failed");
  process.exitCode = 1;
});
