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
  DelegateManagerImpl,
  Estimator,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Transaction,
  VtxoScript,
  Wallet,
  configureEventSource,
  contractHandlers,
  networks,
  verifyTapscriptSignatures,
  type Contract,
  type ContractHandler,
  type DelegateInfo,
  type DelegateProvider,
  type Identity,
  type PathContext,
  type SignerSession,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { EventSource } from "eventsource";
import { assertDelegatedIntentConstraints, type DelegatedIntentConstraints } from "./delegation.js";
import { exactTapscriptSighash } from "./signing.js";
import { buildWardenScript } from "./warden-script.js";
import {
  verifySellerRolloverAuthorization,
  type RolloverAuthorizationTerms,
} from "./rollover-authorization.js";

type MobileTimeContractRecord = {
  schemaVersion: 4 | 5;
  scriptVersion?: 2 | 3;
  exitDelaySeconds?: number;
  contractId: string;
  createdAt: string;
  serviceUrl: string;
  network: "bitcoin";
  serverPubkey: string;
  buyerPubkey: string;
  buyerControl: "mobile-wallet";
  buyerArkadeAddress: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  refundLockType: "time";
  refundDelaySeconds: number;
  refundAt: number;
  escrowAddress: string;
  rolloverPolicy?: {
    delegatePubkey?: string;
  };
};

type RolloverSession = {
  schemaVersion: 1;
  sessionId: string;
  contractId: string;
  contractPath: string;
  createdAt: string;
  expiresAt: string;
  stage: "queued" | "running" | "awaiting_mobile_signature" | "completed" | "failed";
  input: { txid: string; vout: number; value: number; expiresAt?: string };
  successor: { address: string; value: number; refundAt: string };
  quotedFeeSats: number;
  maxFeeSats: number;
  execution?: "manual-stock-batch" | "preauthorized-delegated-stock-batch";
  automaticExecution: boolean;
  activationTest?: boolean;
  replacesAuthorizationId?: string;
  requiredApprovals: ["buyer-mobile-wallet", "seller-keychain"];
  delegate?: {
    url: string;
    pubkey: string;
    feeSats: number;
    delegateAt: string;
    authorizationExpiresAt: string;
  };
  sellerAuthorization?: {
    scheme: "bip340-sha256";
    pubkey: string;
    signature: string;
  };
  workerPid?: number;
  request?: {
    requestId: string;
    purpose: string;
    psbt: string;
    inputIndexes: number[];
    createdAt: string;
  };
  events: Array<{ at: string; type: string }>;
  result?: {
    commitmentTxid?: string;
    completedAt: string;
    authorizationId?: string;
    delegateAt?: string;
    delegatedOutpoints?: Array<{ txid: string; vout: number }>;
  };
  error?: string;
};

type WardenParams = {
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  serverPubkey: string;
  refundAt: string;
  delegatePubkey?: string;
  spendPath?: "collaborative" | "delegate";
  scriptVersion?: string;
  exitDelaySeconds?: string;
};

const serviceUrl = process.env.ARKADE_URL ?? "http://127.0.0.1:7270";
const escrowRoot = resolve(process.env.ESCROW_ROOT ?? process.cwd());
const rolloverDirectory = resolve(escrowRoot, "rollover-sessions");
const sessionId = process.argv[2];
if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid rollover session id");
const sessionPath = resolve(rolloverDirectory, `${sessionId}.json`);

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJsonAtomic = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
const responsePath = (requestId: string) => resolve(rolloverDirectory, `${sessionId}.response.${requestId}.json`);
const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

let session = readJson<RolloverSession>(sessionPath);
const updateSession = (patch: Partial<RolloverSession>, event?: string) => {
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
    delegatePath: built.delegatePath,
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
  type: "frontier-crown-warden-v1",
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
      ...(Object.fromEntries(required.map((key) => [key, params[key]])) as WardenParams),
      delegatePubkey: params.delegatePubkey,
      spendPath: params.spendPath === "delegate" ? "delegate" : "collaborative",
      scriptVersion: params.scriptVersion,
      exitDelaySeconds: params.exitDelaySeconds,
    };
  },
  selectPath(script: VtxoScript, contract: Contract, context: PathContext) {
    if (!context.collaborative) return null;
    const params = this.deserializeParams(contract.params);
    const { collaborativePath, delegatePath } = scriptFor(params);
    const selected = params.spendPath === "delegate" ? delegatePath : collaborativePath;
    if (!selected) throw new Error("Warden delegate path is unavailable");
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
  assertSpendableNow(_script: VtxoScript, _contract: Contract, context: PathContext) {
    if (!context.collaborative) throw new Error("Warden rollover requires collaborative Arkade settlement");
  },
  deriveTapscripts(script: VtxoScript, contract: Contract) {
    const params = this.deserializeParams(contract.params);
    const { collaborativePath, delegatePath } = scriptFor(params);
    if (params.spendPath === "delegate") {
      if (!delegatePath) throw new Error("Warden delegate path is unavailable");
      return {
        // Fulmine appends its signature to this path only when it later builds
        // the forfeit.  The intent itself must already be fully signed before
        // Fulmine registers it with stock arkd.
        forfeitTapLeafScript: script.findLeaf(hex.encode(delegatePath)),
        intentTapLeafScript: script.findLeaf(hex.encode(collaborativePath)),
        tapTree: script.encode(),
      };
    }
    const leaf = script.findLeaf(hex.encode(collaborativePath));
    return { forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, tapTree: script.encode() };
  },
};

class MutualRemoteIdentity implements Identity {
  private requestNumber = 0;
  private signingQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly buyerPubkey: Uint8Array,
    private readonly sellerIdentity: MnemonicIdentity,
    private readonly sellerRequiredLeafScript: string,
  ) {}

  async xOnlyPublicKey() {
    return new Uint8Array(this.buyerPubkey);
  }

  async compressedPublicKey() {
    return Uint8Array.from([2, ...this.buyerPubkey]);
  }

  signerSession(): SignerSession {
    return this.sellerIdentity.signerSession();
  }

  async signMessage(): Promise<Uint8Array> {
    throw new Error("Warden rollover does not authorize arbitrary message signing");
  }

  sign(tx: Transaction, inputIndexes?: number[]) {
    const pending = this.signingQueue.then(() => this.signOne(tx, inputIndexes));
    this.signingQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async signOne(tx: Transaction, inputIndexes?: number[]) {
    const indexes = inputIndexes ?? Array.from({ length: tx.inputsLength }, (_, index) => index);
    const requestId = randomUUID();
    const purpose = `approve-rollover-stock-signature-${this.requestNumber + 1}`;
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
      if (Date.now() >= Date.parse(session.expiresAt)) throw new Error("Rollover signing session expired");
      await delay(350);
      session = readJson<RolloverSession>(sessionPath);
    }
    const response = readJson<{ sessionId: string; requestId: string; signedPsbt: string }>(path);
    if (response.sessionId !== sessionId || response.requestId !== requestId) {
      throw new Error("Rollover signature response mismatch");
    }
    const signed = Transaction.fromPSBT(base64.decode(response.signedPsbt));
    const original = Transaction.fromPSBT(tx.toPSBT());
    if (hex.encode(signed.unsignedTx) !== hex.encode(original.unsignedTx)) {
      throw new Error("Mobile rollover signature changed the prepared transaction");
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
    const sellerIndexes = indexes.filter((index) =>
      (original.getInput(index).tapLeafScript ?? []).some(
        ([, leafScript]) => {
          // @scure's PSBT tuple carries the tapscript followed by its leaf
          // version byte, while VtxoScript.findLeaf addresses the raw script.
          const encoded = hex.encode(leafScript);
          return encoded === this.sellerRequiredLeafScript || encoded === `${this.sellerRequiredLeafScript}c0`;
        },
      ),
    );
    const mutuallySigned = sellerIndexes.length > 0
      ? await this.sellerIdentity.sign(original, sellerIndexes)
      : original;
    const sellerHex = hex.encode(await this.sellerIdentity.xOnlyPublicKey());
    for (const index of indexes) {
      verifyTapscriptSignatures(
        mutuallySigned,
        index,
        sellerIndexes.includes(index) ? [buyerHex, sellerHex] : [buyerHex],
        [],
        [exactTapscriptSighash(mutuallySigned, index)],
      );
    }
    unlinkSync(path);
    updateSession({ stage: "running", request: undefined }, `mobile-signature-accepted:${purpose}`);
    return mutuallySigned;
  }
}

class FulmineDelegateProvider implements DelegateProvider {
  private readonly submitter: RestDelegateProvider;
  private constraints?: DelegatedIntentConstraints;

  constructor(readonly url: string, private readonly rejectReplace: boolean) {
    this.submitter = new RestDelegateProvider(url);
  }

  async getDelegateInfo(): Promise<DelegateInfo> {
    const response = await fetch(`${this.url}/v1/delegate/info`);
    if (!response.ok) throw new Error(`Delegate information is unavailable (${response.status})`);
    const value = (await response.json()) as DelegateInfo;
    return {
      ...value,
      delegateAddress: value.delegateAddress || value.delegatorAddress || "",
    };
  }

  lockConstraints(constraints: DelegatedIntentConstraints) {
    if (this.constraints) throw new Error("Delegate constraints are already locked");
    this.constraints = constraints;
  }

  async delegate(...args: Parameters<DelegateProvider["delegate"]>) {
    const [intent, forfeitTxs, options] = args;
    if (!this.constraints) throw new Error("Delegate constraints were not locked before submission");
    assertDelegatedIntentConstraints(intent, forfeitTxs, this.constraints);
    return this.submitter.delegate(intent, forfeitTxs, {
      ...options,
      rejectReplace: this.rejectReplace,
    });
  }
}

const run = async () => {
  if (session.stage !== "queued") throw new Error(`Rollover worker cannot start from ${session.stage}`);
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("Rollover session already expired");
  if (dirname(session.contractPath) !== resolve(escrowRoot, "contracts")) throw new Error("Invalid rollover contract path");
  if (basename(session.contractPath) === "active.json") throw new Error("Rollover must reference an immutable contract record");
  const record = readJson<MobileTimeContractRecord>(session.contractPath);
  if ((record.schemaVersion !== 4 && record.schemaVersion !== 5) || record.contractId !== session.contractId) {
    throw new Error("Rollover contract changed");
  }
  if (record.serviceUrl !== serviceUrl || record.network !== "bitcoin") throw new Error("Rollover network mismatch");
  if (record.escrowAddress !== session.successor.address) throw new Error("Rollover destination changed");
  if (new Date(record.refundAt * 1_000).toISOString() !== session.successor.refundAt) {
    throw new Error("Rollover refund deadline changed");
  }
  if (record.refundAt <= Math.floor(Date.now() / 1_000)) throw new Error("Refund is already unlocked; do not rollover");

  const arkProvider = new RestArkProvider(serviceUrl);
  const info = await arkProvider.getInfo();
  if (info.version !== "v0.9.16" || info.network !== "bitcoin") throw new Error("Rollover requires reviewed stock arkd v0.9.16");
  if (
    (record.scriptVersion !== 2 && record.scriptVersion !== 3) ||
    record.exitDelaySeconds !== Number(info.unilateralExitDelay)
  ) {
    throw new Error("Rollover requires a stock-compatible Warden VTXO with the current exit delay");
  }
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  const serverHex = hex.encode(serverPubkey);
  const sellerHex = hex.encode(await seller.xOnlyPublicKey());
  const arbiterHex = hex.encode(await arbiter.xOnlyPublicKey());
  if (record.serverPubkey !== serverHex || record.sellerPubkey !== sellerHex || record.arbiterPubkey !== arbiterHex) {
    throw new Error("Rollover signer identities do not match the contract");
  }
  const delegated = session.execution === "preauthorized-delegated-stock-batch";
  const params: WardenParams = {
    buyerPubkey: record.buyerPubkey,
    sellerPubkey: record.sellerPubkey,
    arbiterPubkey: record.arbiterPubkey,
    serverPubkey: record.serverPubkey,
    refundAt: String(record.refundAt),
    delegatePubkey: record.rolloverPolicy?.delegatePubkey,
    spendPath: delegated ? "delegate" : "collaborative",
    scriptVersion: String(record.scriptVersion),
    exitDelaySeconds: String(record.exitDelaySeconds),
  };
  const built = scriptFor(params);
  const derivedAddress = built.script.address(networks.bitcoin.hrp, serverPubkey).encode();
  if (derivedAddress !== record.escrowAddress) throw new Error("Rollover contract failed deterministic re-derivation");

  if (!contractHandlers.has(wardenHandler.type)) contractHandlers.register(wardenHandler);
  configureEventSource((url) => new EventSource(url));
  if (delegated && record.scriptVersion !== 3) {
    throw new Error("Delegated rollover requires the Fulmine-compatible Warden script");
  }
  const identity = new MutualRemoteIdentity(
    hex.decode(record.buyerPubkey),
    seller,
    hex.encode(built.collaborativePath),
  );
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
    const manager = await wallet.getContractManager();
    await manager.createContract({
      type: wardenHandler.type,
      label: `Warden rollover ${record.contractId}`,
      params: wardenHandler.serializeParams(params),
      script: hex.encode(built.script.pkScript),
      address: record.escrowAddress,
      metadata: { contractId: record.contractId, purpose: "mutual-rollover" },
    });
    const [entry] = await manager.getContractsWithVtxos({ script: hex.encode(built.script.pkScript) });
    if (!entry) throw new Error("Rollover contract was not registered in the stock wallet");
    const inputs = entry.vtxos.filter((vtxo) => !vtxo.isSpent && !vtxo.isSwept);
    if (inputs.length !== 1) throw new Error(`Expected one rollover VTXO, found ${inputs.length}`);
    const [input] = inputs;
    if (
      input.txid !== session.input.txid ||
      input.vout !== session.input.vout ||
      input.value !== session.input.value
    ) {
      throw new Error("Rollover VTXO changed after approval");
    }
    if (delegated) {
      if (!session.delegate || !params.delegatePubkey) throw new Error("Delegated rollover details are missing");
      if (params.delegatePubkey !== session.delegate.pubkey) throw new Error("Delegate public key changed");
      if (Date.parse(session.delegate.authorizationExpiresAt) <= Date.now()) {
        throw new Error("Delegated rollover authorization window expired before submission");
      }
      const sellerAuthorization = session.sellerAuthorization;
      const authorizationTerms: RolloverAuthorizationTerms = {
        contractId: session.contractId,
        input: session.input,
        successor: session.successor,
        quotedFeeSats: session.quotedFeeSats,
        maxFeeSats: session.maxFeeSats,
        delegate: session.delegate,
      };
      if (
        !sellerAuthorization ||
        sellerAuthorization.scheme !== "bip340-sha256" ||
        sellerAuthorization.pubkey !== record.sellerPubkey ||
        !verifySellerRolloverAuthorization(
          authorizationTerms,
          sellerAuthorization.pubkey,
          sellerAuthorization.signature,
        )
      ) {
        throw new Error("Seller rollover authorization is missing or invalid");
      }
      const provider = new FulmineDelegateProvider(
        session.delegate.url,
        !session.replacesAuthorizationId,
      );
      const delegateInfo = await provider.getDelegateInfo();
      const delegateXOnly = delegateInfo.pubkey.replace(/^(02|03)/, "").toLowerCase();
      if (delegateXOnly !== session.delegate.pubkey || Number(delegateInfo.fee) !== session.delegate.feeSats) {
        throw new Error("Delegate identity or fee changed; create a fresh authorization");
      }
      provider.lockConstraints({
        input: session.input,
        destination: {
          script: hex.encode(built.script.pkScript),
          value: session.successor.value,
        },
        delegate: {
          pubkey: delegateInfo.pubkey,
          feeSats: session.delegate.feeSats,
          feeScript: session.delegate.feeSats > 0
            ? hex.encode(ArkAddress.decode(delegateInfo.delegateAddress).pkScript)
            : undefined,
        },
        validAt: Date.parse(session.delegate.delegateAt) / 1_000,
        quotedFeeSats: session.quotedFeeSats,
        maxFeeSats: session.maxFeeSats,
      });
      const manager = new DelegateManagerImpl(provider, arkProvider, identity);
      updateSession({ stage: "running" }, "delegate-preauthorization-submission-started");
      const outcome = await manager.delegate(inputs, record.escrowAddress, new Date(session.delegate.delegateAt));
      if (outcome.failed.length > 0 || outcome.delegated.length !== inputs.length) {
        const reason = outcome.failed[0]?.error;
        throw new Error(`Delegate rejected rollover authorization${reason ? `: ${String(reason)}` : ""}`);
      }
      updateSession(
        {
          stage: "completed",
          request: undefined,
          result: {
            authorizationId: session.sessionId,
            delegateAt: session.delegate.delegateAt,
            delegatedOutpoints: outcome.delegated,
            completedAt: new Date().toISOString(),
          },
        },
        "delegated-rollover-preauthorized",
      );
      return;
    }

    const estimator = new Estimator(info.fees.intentFee);
    const inputFee = estimator.evalOffchainInput({
      amount: BigInt(input.value),
      type: "vtxo",
      weight: 0,
      birth: input.createdAt,
      expiry: input.expiresAt,
    }).satoshis;
    let successorValue = input.value - inputFee;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const outputFee = estimator.evalOffchainOutput({
        amount: BigInt(successorValue),
        script: hex.encode(built.script.pkScript),
      }).satoshis;
      const next = input.value - inputFee - outputFee;
      if (next === successorValue) break;
      successorValue = next;
    }
    const feeSats = input.value - successorValue;
    if (feeSats !== session.quotedFeeSats || successorValue !== session.successor.value) {
      throw new Error("Stock rollover fee changed; start again with a fresh approval");
    }
    if (feeSats > session.maxFeeSats) throw new Error("Stock rollover fee exceeds approved cap");
    if (successorValue < Number(info.dust)) throw new Error("Rollover successor is below dust");

    updateSession({ stage: "running" }, "stock-batch-registration-started");
    const commitmentTxid = await wallet.settle(
      {
        inputs,
        outputs: [{ address: record.escrowAddress, amount: BigInt(successorValue) }],
      },
      (event) => updateSession({}, `stock-batch:${event.type}`),
    );
    updateSession(
      { stage: "completed", request: undefined, result: { commitmentTxid, completedAt: new Date().toISOString() } },
      "rollover-completed",
    );
  } finally {
    await wallet.dispose();
  }
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  updateSession({ stage: "failed", request: undefined, error: message }, "rollover-failed");
  process.exitCode = 1;
});
