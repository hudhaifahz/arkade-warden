import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  ArkAddress,
  CSVMultisigTapscript,
  DefaultVtxo,
  Estimator,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  MultisigTapscript,
  RestArkProvider,
  RestIndexerProvider,
  Transaction,
  VtxoScript,
  Wallet,
  buildOffchainTx,
  configureEventSource,
  networks,
  type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { EventSource } from "eventsource";
import {
  defaultActivationGates,
  durationPresetById,
  durationPresets,
  longTermAutomationReady,
  type ActivationGates,
  type DurationPresetId,
} from "./catalog.js";
import { assessSettlementProof, type ProofCoin, type SettlementProofSession } from "./proofs.js";
import { buildWardenScript } from "./warden-script.js";
import { applyRequiredTapscriptSignatures } from "./mobile-signing.js";
import { assessFunding } from "./funding-policy.js";
import { rolloverAuthorizationDigest } from "./rollover-authorization.js";

type LegacyTimeContractRecord = {
  schemaVersion: 1;
  contractId: string;
  createdAt: string;
  serviceUrl: string;
  network: "bitcoin";
  serverPubkey: string;
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  refundAt: number;
  escrowAddress: string;
};

type HeightContractRecord = {
  schemaVersion: 2;
  contractId: string;
  createdAt: string;
  serviceUrl: string;
  network: "bitcoin";
  serverPubkey: string;
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  refundLockType: "height";
  refundDelayBlocks: number;
  refundBlockHeight: number;
  escrowAddress: string;
};

type MobileHeightContractRecord = Omit<HeightContractRecord, "schemaVersion"> & {
  schemaVersion: 3;
  buyerControl: "mobile-wallet";
  buyerArkadeAddress: string;
};

type MobileTimeContractRecord = {
  schemaVersion: 4;
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
  rolloverPolicy: {
    mode: "mutual-stock-batch";
    warningThresholdSeconds: number;
    automaticExecution: false;
    preserveContractScript: true;
  };
};

type ManagedTimeContractRecord = {
  schemaVersion: 5;
  scriptVersion?: 2 | 3;
  exitDelaySeconds?: number;
  predecessorContractId?: string;
  contractId: string;
  createdAt: string;
  label: string;
  presetId: DurationPresetId;
  durationLabel: string;
  expectedAmountSats?: number;
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
  lifecycle: "open";
  rolloverRequired: boolean;
  rolloverPolicy: {
    mode: "mutual-stock-batch" | "preauthorized-delegated-stock-batch";
    warningThresholdSeconds: number;
    automaticExecution: boolean;
    preserveContractScript: true;
    activationGate: "not-required" | "manual-rollover-and-recovery-proof";
    delegateUrl?: string;
    delegatePubkey?: string;
  };
};

type HardenedTimeContractRecord = {
  schemaVersion: 6;
  scriptVersion: 4 | 5;
  exitDelaySeconds: number;
  contractId: string;
  createdAt: string;
  label: string;
  durationLabel: string;
  expectedAmountSats: number;
  serviceUrl: string;
  network: "bitcoin";
  serverPubkey: string;
  buyerPubkey: string;
  buyerControl: "mobile-wallet";
  buyerArkadeAddress: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  refundLockType: "time";
  refundAt: number;
  escrowAddress: string;
  escrowScript: string;
  lifecycle: "open";
  rolloverRequired: true;
  rolloverPolicy: {
    mode: "bounded-renewal-mandate";
    warningThresholdSeconds: number;
    automaticExecution: true;
    preserveContractScript: true;
  };
  hardenedRenewal: {
    mandateId: string;
    mandatePath: string;
    maxRenewals: number;
    finalAt: string;
    renewalPubkeys: string[];
    delegatePubkeys: string[];
    state: "approved-awaiting-funding" | "active" | "completed" | "manual-recovery-required";
    activationTest?: boolean;
  };
};

type ContractRecord =
  | LegacyTimeContractRecord
  | HeightContractRecord
  | MobileHeightContractRecord
  | MobileTimeContractRecord
  | ManagedTimeContractRecord
  | HardenedTimeContractRecord;

type BuyerBinding = {
  schemaVersion: 1;
  buyerPubkey: string;
  buyerArkadeAddress: string;
  serverPubkey: string;
  registeredAt: string;
};

type SigningSession = {
  schemaVersion: 1;
  sessionId: string;
  contractPath: string;
  contractId: string;
  action: "release" | "refund" | "migrate";
  buyerPubkey: string;
  value: number;
  createdAt: string;
  expiresAt: string;
  stage: "awaiting_ark_signature" | "awaiting_checkpoint_signatures" | "finalized";
  unsignedArkTx: string;
  unsignedCheckpoints: string[];
  arkTxid?: string;
  serverSignedCheckpoints?: string[];
  result?: { arkTxid: string; finalizedAt: string };
  destinationContractId?: string;
  destinationAddress?: string;
};

type EscrowAction = "release" | "refund" | "migrate";

type IndexedVtxo = {
  txid: string;
  vout: number;
  value: number;
  expiresAt?: string;
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
  result?: {
    commitmentTxid: string;
    completedAt: string;
  };
  error?: string;
};

const serviceUrl = process.env.ARKADE_URL ?? "http://127.0.0.1:7270";
const command = process.argv[2] ?? "status";
const escrowRoot = resolve(process.env.ESCROW_ROOT ?? process.cwd());
const legacyContractPath = resolve(
  process.env.ESCROW_CONTRACT ?? "contracts/warden-alpha-18-blocks.json",
);
const activePointerPath = resolve(escrowRoot, "contracts/active.json");
const bindingPath = resolve(escrowRoot, "bindings/mobile-buyer.json");
const rotationLockPath = resolve(escrowRoot, "contracts/.rotation.lock");
const sessionsDirectory = resolve(escrowRoot, "sessions");
const contractsDirectory = resolve(escrowRoot, "contracts");
const rolloverSessionsDirectory = resolve(escrowRoot, "rollover-sessions");
const recoverySessionsDirectory = resolve(escrowRoot, "recovery-sessions");
const activationGatesPath = resolve(escrowRoot, "activation-gates.json");
const delegateUrl = process.env.ARKADE_DELEGATE_URL ?? "http://127.0.0.1:7372";
const account = process.env.USER;
if (!account) throw new Error("USER is unavailable");

const keychainMnemonic = (role: "buyer" | "seller" | "arbiter") =>
  execFileSync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-a",
      account,
      "-s",
      `frontiercrown.arkade.mainnet.escrow.${role}`,
      "-w",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();

const bitcoinCliPath = (() => {
  const configured = process.env.BITCOIN_CLI;
  if (configured) return configured;
  const candidates = [
    "/opt/homebrew/bin/bitcoin-cli",
    "/Applications/Bitcoin-Qt.app/Contents/MacOS/bitcoin-cli",
    "/usr/local/bin/bitcoin-cli",
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("bitcoin-cli not found; set BITCOIN_CLI to its absolute path");
  return found;
})();

const currentBlockHeight = () => {
  const output = execFileSync(bitcoinCliPath, ["getblockcount"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const height = Number(output);
  if (!Number.isSafeInteger(height) || height < 0 || height >= 500_000_000) {
    throw new Error(`Invalid Bitcoin block height from local Core: ${output}`);
  }
  return height;
};

const writeJsonAtomic = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const readActivationGates = (): ActivationGates => {
  if (!existsSync(activationGatesPath)) return defaultActivationGates();
  const gates = readJson<ActivationGates>(activationGatesPath);
  if (gates.schemaVersion !== 1) throw new Error("Unsupported Warden activation-gate record");
  return gates;
};

const seller = MnemonicIdentity.fromMnemonic(keychainMnemonic("seller"), { isMainnet: true });
const arbiter = MnemonicIdentity.fromMnemonic(keychainMnemonic("arbiter"), { isMainnet: true });
const arkProvider = new RestArkProvider(serviceUrl);
const indexerProvider = new RestIndexerProvider(serviceUrl);
const info = await arkProvider.getInfo();
if (info.network !== "bitcoin") throw new Error(`Refusing mainnet escrow against network ${info.network}`);
const reviewedServiceVersions = new Set(["v0.9.16"]);
if (!reviewedServiceVersions.has(info.version)) {
  throw new Error(`Refusing unreviewed arkd version ${info.version}`);
}

const serverPubkey = hex.decode(info.signerPubkey).slice(1);
const serverPubkeyHex = hex.encode(serverPubkey);
const sellerPubkey = await seller.xOnlyPublicKey();
const arbiterPubkey = await arbiter.xOnlyPublicKey();

const readBinding = (): BuyerBinding | undefined => {
  if (!existsSync(bindingPath)) return undefined;
  const binding = readJson<BuyerBinding>(bindingPath);
  if (binding.schemaVersion !== 1 || binding.serverPubkey !== serverPubkeyHex) {
    throw new Error("Mobile buyer binding does not match this Arkade server");
  }
  return binding;
};

const resolveActiveContractPath = () => {
  if (!existsSync(activePointerPath)) return legacyContractPath;
  const pointer = readJson<{ schemaVersion: 1; contractFile: string }>(activePointerPath);
  if (pointer.schemaVersion !== 1 || basename(pointer.contractFile) !== pointer.contractFile) {
    throw new Error("Invalid active contract pointer");
  }
  return resolve(escrowRoot, "contracts", pointer.contractFile);
};

const readContract = (path = resolveActiveContractPath()) => readJson<ContractRecord>(path);

const contractEntries = () =>
  readdirSync(contractsDirectory)
    .filter((name) => name.endsWith(".json") && name !== "active.json")
    .map((name) => {
      const path = resolve(contractsDirectory, name);
      const record = readContract(path);
      validateContract(record);
      return { path, record };
    });

const contractEntryById = (contractId?: string) => {
  if (!contractId) {
    const path = resolveActiveContractPath();
    return { path, record: readContract(path) };
  }
  if (!/^[0-9a-f-]{36}$/i.test(contractId)) throw new Error("Invalid contract id");
  const entry = contractEntries().find(({ record }) => record.contractId === contractId);
  if (!entry) throw new Error(`Unknown escrow contract ${contractId}`);
  return entry;
};

const isTimeContract = (
  record: ContractRecord,
): record is LegacyTimeContractRecord | MobileTimeContractRecord | ManagedTimeContractRecord | HardenedTimeContractRecord =>
  record.schemaVersion === 1 || record.schemaVersion === 4 || record.schemaVersion === 5 || record.schemaVersion === 6;

const isMobileContract = (
  record: ContractRecord,
): record is MobileHeightContractRecord | MobileTimeContractRecord | ManagedTimeContractRecord | HardenedTimeContractRecord =>
  record.schemaVersion === 3 || record.schemaVersion === 4 || record.schemaVersion === 5 || record.schemaVersion === 6;

const isStockCompatibleContract = (record: ContractRecord) =>
  (record.schemaVersion === 4 || record.schemaVersion === 5 || record.schemaVersion === 6) &&
  (record.scriptVersion === 2 || record.scriptVersion === 3 || record.scriptVersion === 4 || record.scriptVersion === 5) &&
  Number.isInteger(record.exitDelaySeconds) &&
  record.exitDelaySeconds! >= Number(info.unilateralExitDelay);

const buildContract = (
  buyerPubkey: Uint8Array,
  refundLocktime: number,
  delegatePubkeyHex?: string,
  exitDelaySeconds?: number,
  scriptVersion: 2 | 3 | 4 | 5 = 2,
  renewalPubkeyHexes?: string[],
  delegatePubkeyHexes?: string[],
) => {
  const built = buildWardenScript({
    buyerPubkey,
    sellerPubkey,
    arbiterPubkey,
    serverPubkey,
    refundAt: refundLocktime,
    delegatePubkey: delegatePubkeyHex ? hex.decode(delegatePubkeyHex) : undefined,
    delegatePubkeys: delegatePubkeyHexes?.map(hex.decode),
    renewalPubkeys: renewalPubkeyHexes?.map(hex.decode),
    exitDelaySeconds,
    delegateApproval:
      scriptVersion === 4 || scriptVersion === 5
        ? "bounded-renewal-key"
        : scriptVersion === 3
          ? "buyer-with-seller-authorization"
          : "buyer-and-seller",
    finalBuyerUnilateralExit: scriptVersion === 5,
  });
  return {
    collaborativePath: built.collaborativePath,
    delegatePath: built.delegatePath,
    exitPaths: built.exitPaths,
    refundPath: built.refundPath,
    escrowScript: built.script,
    escrowAddress: built.script.address(networks.bitcoin.hrp, serverPubkey).encode(),
  };
};

const validateContract = (record: ContractRecord) => {
  if (record.network !== "bitcoin" || record.serviceUrl !== serviceUrl) {
    throw new Error("Contract network or service URL does not match this run");
  }
  if (record.serverPubkey !== serverPubkeyHex) {
    throw new Error("Operator signer changed; refusing to derive or spend contract");
  }
  if (record.sellerPubkey !== hex.encode(sellerPubkey) || record.arbiterPubkey !== hex.encode(arbiterPubkey)) {
    throw new Error("Seller or arbiter identity does not match the contract record");
  }
  const refundLocktime = isTimeContract(record) ? record.refundAt : record.refundBlockHeight;
  const delegatePubkey = record.schemaVersion === 5 ? record.rolloverPolicy.delegatePubkey : undefined;
  const renewalPubkeys = record.schemaVersion === 6 ? record.hardenedRenewal.renewalPubkeys : undefined;
  const delegatePubkeys = record.schemaVersion === 6 ? record.hardenedRenewal.delegatePubkeys : undefined;
  const exitDelaySeconds =
    (record.schemaVersion === 4 || record.schemaVersion === 5 || record.schemaVersion === 6) &&
    (record.scriptVersion === 2 || record.scriptVersion === 3 || record.scriptVersion === 4 || record.scriptVersion === 5)
    ? record.exitDelaySeconds
    : undefined;
  const built = buildContract(
    hex.decode(record.buyerPubkey),
    refundLocktime,
    delegatePubkey,
    exitDelaySeconds,
    record.schemaVersion === 4 || record.schemaVersion === 5 || record.schemaVersion === 6 ? record.scriptVersion ?? 2 : 2,
    renewalPubkeys,
    delegatePubkeys,
  );
  if (built.escrowAddress !== record.escrowAddress) {
    throw new Error("Stored escrow address failed deterministic re-derivation");
  }
  return built;
};

const indexedEscrowVtxos = async (
  record: ContractRecord,
  filter: "spendable" | "recoverable",
): Promise<IndexedVtxo[]> => {
  const { escrowScript } = validateContract(record);
  const { vtxos } = await indexerProvider.getVtxos({
    scripts: [hex.encode(escrowScript.pkScript)],
    ...(filter === "spendable" ? { spendableOnly: true } : { recoverableOnly: true }),
  });
  return vtxos.map(({ txid, vout, value, expiresAt }) => ({
    txid,
    vout,
    value,
    expiresAt: expiresAt?.toISOString(),
  }));
};

const escrowVtxos = (record: ContractRecord) => indexedEscrowVtxos(record, "spendable");
const recoverableEscrowVtxos = (record: ContractRecord) => indexedEscrowVtxos(record, "recoverable");

const defaultVtxoScript = (pubKey: Uint8Array) => {
  const collaborativePath = MultisigTapscript.encode({ pubkeys: [pubKey, serverPubkey] }).script;
  const unilateralExitDelay = Number(info.unilateralExitDelay);
  const exitPath = CSVMultisigTapscript.encode({
    pubkeys: [pubKey],
    timelock: {
      value: BigInt(unilateralExitDelay),
      type: unilateralExitDelay < 512 ? "blocks" : "seconds",
    },
  }).script;
  const script = new VtxoScript([collaborativePath, exitPath]);
  return { collaborativePath, exitPath, script };
};

const sellerVtxos = async (filter: "spendable" | "recoverable"): Promise<IndexedVtxo[]> => {
  const { script } = defaultVtxoScript(sellerPubkey);
  const { vtxos } = await indexerProvider.getVtxos({
    scripts: [hex.encode(script.pkScript)],
    ...(filter === "spendable" ? { spendableOnly: true } : { recoverableOnly: true }),
  });
  return vtxos.map(({ txid, vout, value, expiresAt }) => ({
    txid,
    vout,
    value,
    expiresAt: expiresAt?.toISOString(),
  }));
};

const expirySummary = (spendable: IndexedVtxo[], recoverable: IndexedVtxo[]) => {
  const earliestExpiryMs = spendable.reduce<number | undefined>((earliest, vtxo) => {
    const candidate = vtxo.expiresAt ? Date.parse(vtxo.expiresAt) : Number.NaN;
    if (!Number.isFinite(candidate)) return earliest;
    return earliest === undefined ? candidate : Math.min(earliest, candidate);
  }, undefined);
  const expiresInSeconds = earliestExpiryMs === undefined
    ? undefined
    : Math.floor((earliestExpiryMs - Date.now()) / 1_000);
  const expiryRisk = recoverable.length > 0 || (expiresInSeconds !== undefined && expiresInSeconds <= 0)
    ? "recoverable"
    : expiresInSeconds !== undefined && expiresInSeconds <= 24 * 60 * 60
      ? "critical"
      : expiresInSeconds !== undefined && expiresInSeconds <= 72 * 60 * 60
        ? "warning"
        : "safe";
  return {
    earliestVtxoExpiry: earliestExpiryMs === undefined ? undefined : new Date(earliestExpiryMs).toISOString(),
    expiresInSeconds,
    expiryRisk,
  };
};

const rolloverFeeQuote = async (
  record: MobileTimeContractRecord | ManagedTimeContractRecord | HardenedTimeContractRecord,
  vtxo: IndexedVtxo,
) => {
  const { escrowScript } = validateContract(record);
  const { vtxos } = await indexerProvider.getVtxos({
    scripts: [hex.encode(escrowScript.pkScript)],
    spendableOnly: true,
  });
  const raw = vtxos.find((candidate) => candidate.txid === vtxo.txid && candidate.vout === vtxo.vout);
  if (!raw) throw new Error("Escrow VTXO changed while quoting rollover");
  const estimator = new Estimator(info.fees.intentFee);
  const inputFee = estimator.evalOffchainInput({
    amount: BigInt(raw.value),
    type: raw.isSwept ? "recoverable" : "vtxo",
    weight: 0,
    birth: raw.createdAt,
    expiry: raw.expiresAt,
  }).satoshis;
  let successorValue = raw.value - inputFee;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const outputFee = estimator.evalOffchainOutput({
      amount: BigInt(successorValue),
      script: hex.encode(escrowScript.pkScript),
    }).satoshis;
    const next = raw.value - inputFee - outputFee;
    if (next === successorValue) break;
    successorValue = next;
  }
  if (!Number.isSafeInteger(successorValue) || successorValue < Number(info.dust)) {
    throw new Error("Rollover output would be below the Arkade dust limit");
  }
  return {
    inputValue: raw.value,
    successorValue,
    feeSats: raw.value - successorValue,
  };
};

const delegatedRolloverFeeQuote = async (
  record: ManagedTimeContractRecord,
  vtxo: IndexedVtxo,
  delegate: Awaited<ReturnType<typeof resolveDelegateInfo>>,
  delegateAt: Date,
) => {
  const { escrowScript } = validateContract(record);
  const { vtxos } = await indexerProvider.getVtxos({
    scripts: [hex.encode(escrowScript.pkScript)],
    spendableOnly: true,
  });
  const raw = vtxos.find((candidate) => candidate.txid === vtxo.txid && candidate.vout === vtxo.vout);
  if (!raw) throw new Error("Escrow VTXO changed while quoting delegated rollover");
  const atSeconds = delegateAt.getTime() / 1_000;
  const feeConfig = {
    ...info.fees.intentFee,
    offchainInput: info.fees.intentFee.offchainInput?.replace("now()", `double(${atSeconds})`),
    offchainOutput: info.fees.intentFee.offchainOutput?.replace("now()", `double(${atSeconds})`),
  };
  const estimator = new Estimator(feeConfig);
  const inputFee = estimator.evalOffchainInput({
    amount: BigInt(raw.value),
    type: "vtxo",
    weight: 0,
    birth: raw.createdAt,
    expiry: raw.expiresAt,
  }).satoshis;
  const delegateOutputFee = delegate.feeSats > 0
    ? estimator.evalOffchainOutput({
        amount: BigInt(delegate.feeSats),
        script: hex.encode(ArkAddress.decode(delegate.address).pkScript),
      }).satoshis
    : 0;
  const successorValue = raw.value - inputFee - delegateOutputFee - delegate.feeSats;
  if (!Number.isSafeInteger(successorValue) || successorValue < Number(info.dust)) {
    throw new Error("Delegated rollover output would be below the Arkade dust limit");
  }
  return {
    inputValue: raw.value,
    successorValue,
    feeSats: raw.value - successorValue,
  };
};

const recoveryFeeQuote = async (
  record: MobileTimeContractRecord | ManagedTimeContractRecord | HardenedTimeContractRecord,
  vtxo: IndexedVtxo,
  destinationAddress: string,
) => {
  const { escrowScript } = validateContract(record);
  const { vtxos } = await indexerProvider.getVtxos({
    scripts: [hex.encode(escrowScript.pkScript)],
    recoverableOnly: true,
  });
  const raw = vtxos.find((candidate) => candidate.txid === vtxo.txid && candidate.vout === vtxo.vout);
  if (!raw || raw.isSwept !== true) throw new Error("Escrow VTXO is not recoverable through a stock batch");
  const destinationScript = hex.encode(ArkAddress.decode(destinationAddress).pkScript);
  const estimator = new Estimator(info.fees.intentFee);
  const inputFee = estimator.evalOffchainInput({
    amount: BigInt(raw.value),
    type: "recoverable",
    weight: 0,
    birth: raw.createdAt,
    expiry: raw.expiresAt,
  }).satoshis;
  let successorValue = raw.value - inputFee;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const outputFee = estimator.evalOffchainOutput({
      amount: BigInt(successorValue),
      script: destinationScript,
    }).satoshis;
    const next = raw.value - inputFee - outputFee;
    if (next === successorValue) break;
    successorValue = next;
  }
  if (!Number.isSafeInteger(successorValue) || successorValue < Number(info.dust)) {
    throw new Error("Recovery output would be below the Arkade dust limit");
  }
  return {
    inputValue: raw.value,
    successorValue,
    feeSats: raw.value - successorValue,
    destinationScript,
  };
};

const hasPendingSession = (contractId: string) => {
  if (!existsSync(sessionsDirectory)) return false;
  return readdirSync(sessionsDirectory)
    .filter((name) => name.endsWith(".json"))
    .some((name) => {
      try {
        const session = readJson<SigningSession>(resolve(sessionsDirectory, name));
        return (
          session.contractId === contractId &&
          session.stage !== "finalized" &&
          Date.parse(session.expiresAt) >= Date.now()
        );
      } catch {
        return true;
      }
    });
};

const pendingRolloverSession = (contractId: string) => {
  if (!existsSync(rolloverSessionsDirectory)) return false;
  return readdirSync(rolloverSessionsDirectory)
    .filter((name) => name.endsWith(".json") && !name.includes(".response."))
    .flatMap((name) => {
      try {
        const session = readJson<RolloverSession>(resolve(rolloverSessionsDirectory, name));
        return (
          session.contractId === contractId &&
          session.stage !== "completed" &&
          session.stage !== "failed" &&
          Date.parse(session.expiresAt) >= Date.now()
        ) ? [session] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
};

const hasPendingRollover = (contractId: string) => Boolean(pendingRolloverSession(contractId));

const pendingRecoverySession = (contractId: string) => {
  if (!existsSync(recoverySessionsDirectory)) return false;
  return readdirSync(recoverySessionsDirectory)
    .filter((name) => name.endsWith(".json") && !name.includes(".response."))
    .flatMap((name) => {
      try {
        const session = readJson<RecoverySession>(resolve(recoverySessionsDirectory, name));
        return (
          session.contractId === contractId &&
          session.stage !== "completed" &&
          session.stage !== "failed" &&
          Date.parse(session.expiresAt) >= Date.now()
        ) ? [session] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
};

const hasPendingRecovery = (contractId: string) => Boolean(pendingRecoverySession(contractId));

const completedDelegatedAuthorization = (contractId: string, input?: { txid: string; vout: number }) => {
  if (!existsSync(rolloverSessionsDirectory)) return undefined;
  return readdirSync(rolloverSessionsDirectory)
    .filter((name) => name.endsWith(".json") && !name.includes(".response."))
    .map((name) => {
      try {
        return readJson<RolloverSession>(resolve(rolloverSessionsDirectory, name));
      } catch {
        return undefined;
      }
    })
    .filter((session): session is RolloverSession => Boolean(session))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .find(
      (session) =>
        session?.contractId === contractId &&
        session.execution === "preauthorized-delegated-stock-batch" &&
        session.stage === "completed" &&
        session.result?.authorizationId &&
        (!input || (session.input.txid === input.txid && session.input.vout === input.vout)),
    );
};

const isExpired = (record: ContractRecord, height: number) =>
  isTimeContract(record)
    ? Math.floor(Date.now() / 1000) >= record.refundAt
    : height >= record.refundBlockHeight;

const refundDelaySeconds = () => {
  const value = Number(process.env.ESCROW_REFUND_SECONDS ?? "10800");
  if (!Number.isInteger(value) || value < 600 || value > 10 * 365 * 24 * 60 * 60) {
    throw new Error("Refund delay must be an integer from 600 seconds through 10 years");
  }
  return value;
};

const rolloverWarningSeconds = () => {
  const value = Number(process.env.ESCROW_ROLLOVER_WARNING_SECONDS ?? "259200");
  if (!Number.isInteger(value) || value < 3_600 || value > 7 * 24 * 60 * 60) {
    throw new Error("Rollover warning must be an integer from 1 hour through 7 days");
  }
  return value;
};

const uniqueRefundAt = (
  buyerPubkey: Uint8Array,
  candidate: number,
  delegatePubkey?: string,
  exitDelaySeconds?: number,
  scriptVersion: 2 | 3 = 2,
) => {
  const existingAddresses = new Set(contractEntries().map(({ record }) => record.escrowAddress));
  let refundAt = candidate;
  for (let attempts = 0; attempts < 120; attempts += 1) {
    const address = buildContract(
      buyerPubkey,
      refundAt,
      delegatePubkey,
      exitDelaySeconds,
      scriptVersion,
    ).escrowAddress;
    if (!existingAddresses.has(address)) return { refundAt, escrowAddress: address };
    refundAt += 1;
  }
  throw new Error("Unable to derive a unique Warden escrow address");
};

const createMobileContract = (binding: BuyerBinding) => {
  const createdAtSeconds = Math.floor(Date.now() / 1_000);
  const refundDelay = refundDelaySeconds();
  const exitDelaySeconds = Number(info.unilateralExitDelay);
  const buyerPubkey = hex.decode(binding.buyerPubkey);
  const { refundAt, escrowAddress } = uniqueRefundAt(
    buyerPubkey,
    createdAtSeconds + refundDelay,
    undefined,
    exitDelaySeconds,
  );
  const record: MobileTimeContractRecord = {
    schemaVersion: 4,
    scriptVersion: 2,
    exitDelaySeconds,
    contractId: randomUUID(),
    createdAt: new Date(createdAtSeconds * 1_000).toISOString(),
    serviceUrl,
    network: "bitcoin",
    serverPubkey: serverPubkeyHex,
    buyerPubkey: binding.buyerPubkey,
    buyerControl: "mobile-wallet",
    buyerArkadeAddress: binding.buyerArkadeAddress,
    sellerPubkey: hex.encode(sellerPubkey),
    arbiterPubkey: hex.encode(arbiterPubkey),
    refundLockType: "time",
    refundDelaySeconds: refundDelay,
    refundAt,
    escrowAddress,
    rolloverPolicy: {
      mode: "mutual-stock-batch",
      warningThresholdSeconds: rolloverWarningSeconds(),
      automaticExecution: false,
      preserveContractScript: true,
    },
  };
  const contractFile = `warden-mobile-time-${createdAtSeconds}-${record.contractId}.json`;
  const newPath = resolve(escrowRoot, "contracts", contractFile);
  mkdirSync(dirname(newPath), { recursive: true });
  writeFileSync(newPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  writeJsonAtomic(activePointerPath, {
    schemaVersion: 1,
    contractFile,
    activatedAt: new Date().toISOString(),
    previousContractFile: basename(resolveActiveContractPath()),
  });
  return { path: newPath, record };
};

const resolveDelegateInfo = async () => {
  const response = await fetch(`${delegateUrl}/v1/delegate/info`);
  if (!response.ok) throw new Error(`Delegate information is unavailable (${response.status})`);
  const delegate = (await response.json()) as {
    pubkey: string;
    fee: string;
    delegateAddress: string;
  };
  if (!/^(02|03)[0-9a-f]{64}$/i.test(delegate.pubkey)) {
    throw new Error("Delegate returned an invalid compressed public key");
  }
  const delegateAddress = ArkAddress.decode(delegate.delegateAddress);
  if (
    delegateAddress.hrp !== networks.bitcoin.hrp ||
    hex.encode(delegateAddress.serverPubKey) !== serverPubkeyHex
  ) {
    throw new Error("Delegate belongs to a different Arkade operator or network");
  }
  const feeSats = Number(delegate.fee);
  if (!Number.isSafeInteger(feeSats) || feeSats < 0) throw new Error("Delegate returned an invalid fee");
  return {
    url: delegateUrl,
    pubkey: delegate.pubkey.slice(2).toLowerCase(),
    compressedPubkey: delegate.pubkey.toLowerCase(),
    feeSats,
    address: delegate.delegateAddress,
  };
};

const createManagedContract = async (
  binding: BuyerBinding,
  presetId: string,
  expectedAmountSats: number,
  requestedLabel?: string,
) => {
  const preset = durationPresetById(presetId);
  if (
    !Number.isSafeInteger(expectedAmountSats) ||
    expectedAmountSats < Number(info.dust) ||
    expectedAmountSats > 21_000_000 * 100_000_000
  ) {
    throw new Error(`Expected escrow amount must be an integer of at least ${info.dust} sats`);
  }
  const gates = readActivationGates();
  if (preset.rolloverRequired && !longTermAutomationReady(gates)) {
    throw new Error(
      `${preset.label} escrows require the funded manual-rollover and expiry-recovery proofs before funding is enabled`,
    );
  }
  const createdAtSeconds = Math.floor(Date.now() / 1_000);
  const buyerPubkey = hex.decode(binding.buyerPubkey);
  const delegate = preset.rolloverRequired ? await resolveDelegateInfo() : undefined;
  const exitDelaySeconds = Number(info.unilateralExitDelay);
  const { refundAt, escrowAddress } = uniqueRefundAt(
    buyerPubkey,
    createdAtSeconds + preset.durationSeconds,
    delegate?.pubkey,
    exitDelaySeconds,
    3,
  );
  const label = (requestedLabel?.trim() || `Warden ${preset.label}`).slice(0, 80);
  if (!label || /[\u0000-\u001f]/.test(label)) throw new Error("Escrow label contains unsupported characters");
  const record: ManagedTimeContractRecord = {
    schemaVersion: 5,
    scriptVersion: 3,
    exitDelaySeconds,
    contractId: randomUUID(),
    createdAt: new Date(createdAtSeconds * 1_000).toISOString(),
    label,
    presetId: preset.id,
    durationLabel: preset.label,
    expectedAmountSats,
    serviceUrl,
    network: "bitcoin",
    serverPubkey: serverPubkeyHex,
    buyerPubkey: binding.buyerPubkey,
    buyerControl: "mobile-wallet",
    buyerArkadeAddress: binding.buyerArkadeAddress,
    sellerPubkey: hex.encode(sellerPubkey),
    arbiterPubkey: hex.encode(arbiterPubkey),
    refundLockType: "time",
    refundDelaySeconds: refundAt - createdAtSeconds,
    refundAt,
    escrowAddress,
    lifecycle: "open",
    rolloverRequired: preset.rolloverRequired,
    rolloverPolicy: {
      mode: preset.rolloverRequired ? "preauthorized-delegated-stock-batch" : "mutual-stock-batch",
      warningThresholdSeconds: rolloverWarningSeconds(),
      automaticExecution: preset.rolloverRequired,
      preserveContractScript: true,
      activationGate: preset.rolloverRequired
        ? "manual-rollover-and-recovery-proof"
        : "not-required",
      delegateUrl: delegate?.url,
      delegatePubkey: delegate?.pubkey,
    },
  };
  const contractFile = `warden-${preset.id}-${createdAtSeconds}-${record.contractId}.json`;
  const newPath = resolve(contractsDirectory, contractFile);
  writeFileSync(newPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { path: newPath, record };
};

const stockMigrationTargetFor = (record: ManagedTimeContractRecord) => {
  if (record.scriptVersion === 3) {
    throw new Error("This escrow already uses the Fulmine-compatible stock script");
  }
  if (isExpired(record, currentBlockHeight())) {
    throw new Error("This escrow has expired; refund it to the buyer wallet instead of renewing its agreement");
  }
  const existing = contractEntries().find(
    ({ record: candidate }) =>
      candidate.schemaVersion === 5 &&
      candidate.predecessorContractId === record.contractId &&
      candidate.scriptVersion === 3,
  );
  if (existing) return existing as { path: string; record: ManagedTimeContractRecord };

  const exitDelaySeconds = Number(info.unilateralExitDelay);
  const built = buildContract(
    hex.decode(record.buyerPubkey),
    record.refundAt,
    record.rolloverPolicy.delegatePubkey,
    exitDelaySeconds,
    3,
  );
  const successor: ManagedTimeContractRecord = {
    ...record,
    scriptVersion: 3,
    exitDelaySeconds,
    predecessorContractId: record.contractId,
    contractId: randomUUID(),
    createdAt: new Date().toISOString(),
    label: `${record.label} · Fulmine-compatible`.slice(0, 80),
    refundDelaySeconds: record.refundAt - Math.floor(Date.now() / 1_000),
    escrowAddress: built.escrowAddress,
  };
  if (contractEntries().some(({ record: candidate }) => candidate.escrowAddress === successor.escrowAddress)) {
    throw new Error("Stock migration address already belongs to another escrow");
  }
  const contractFile = `warden-migrated-${Date.now()}-${successor.contractId}.json`;
  const path = resolve(contractsDirectory, contractFile);
  writeFileSync(path, `${JSON.stringify(successor, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { path, record: successor };
};

const ensureActive = async () => {
  const binding = readBinding();
  const currentPath = resolveActiveContractPath();
  const current = readContract(currentPath);
  validateContract(current);
  const height = currentBlockHeight();
  const [vtxos, recoverableVtxos] = await Promise.all([
    escrowVtxos(current),
    recoverableEscrowVtxos(current),
  ]);
  const replacementRequired = isExpired(current, height) || !isStockCompatibleContract(current);
  if (
    !binding ||
    !replacementRequired ||
    vtxos.length > 0 ||
    recoverableVtxos.length > 0 ||
    hasPendingSession(current.contractId) ||
    hasPendingRollover(current.contractId) ||
    hasPendingRecovery(current.contractId)
  ) {
    return { path: currentPath, record: current, rotated: false, binding };
  }

  let lock: number;
  try {
    mkdirSync(dirname(rotationLockPath), { recursive: true });
    lock = openSync(rotationLockPath, "wx", 0o600);
  } catch {
    return { path: currentPath, record: current, rotated: false, binding };
  }
  try {
    const latestPath = resolveActiveContractPath();
    const latest = readContract(latestPath);
    const [latestVtxos, latestRecoverableVtxos] = await Promise.all([
      escrowVtxos(latest),
      recoverableEscrowVtxos(latest),
    ]);
    const latestHeight = currentBlockHeight();
    const latestReplacementRequired =
      isExpired(latest, latestHeight) || !isStockCompatibleContract(latest);
    if (
      !latestReplacementRequired ||
      latestVtxos.length > 0 ||
      latestRecoverableVtxos.length > 0 ||
      hasPendingSession(latest.contractId) ||
      hasPendingRollover(latest.contractId) ||
      hasPendingRecovery(latest.contractId)
    ) {
      return { path: latestPath, record: latest, rotated: false, binding };
    }
    const next = createMobileContract(binding);
    return { ...next, rotated: true, binding };
  } finally {
    closeSync(lock);
    unlinkSync(rotationLockPath);
  }
};

const statusFor = async (record: ContractRecord, rotated = false, binding = readBinding()) => {
  const [vtxos, recoverableVtxos] = await Promise.all([
    escrowVtxos(record),
    recoverableEscrowVtxos(record),
  ]);
  const height = currentBlockHeight();
  const activeRolloverSession = pendingRolloverSession(record.contractId);
  const activeRecoverySession = pendingRecoverySession(record.contractId);
  const expiry = expirySummary(vtxos, recoverableVtxos);
  const funding = assessFunding(
    record.schemaVersion === 5 || record.schemaVersion === 6 ? record.expectedAmountSats : undefined,
    vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0),
  );
  const refundStatus =
    isTimeContract(record)
      ? {
          refundLockType: "time",
          refundAt: new Date(record.refundAt * 1000).toISOString(),
          remainingSeconds: Math.max(0, record.refundAt - Math.floor(Date.now() / 1_000)),
        }
      : {
          refundLockType: record.refundLockType,
          refundBlockHeight: record.refundBlockHeight,
          currentBlockHeight: height,
          remainingBlocks: Math.max(0, record.refundBlockHeight - height),
          estimatedTimeRemainingMinutes: Math.max(0, record.refundBlockHeight - height) * 10,
        };
  const rollover = await (async () => {
    if (record.schemaVersion !== 4 && record.schemaVersion !== 5 && record.schemaVersion !== 6) {
      return { supported: false, state: "legacy-contract", execution: "disabled" };
    }
    if (!isStockCompatibleContract(record)) {
      return { supported: false, state: "stock-script-migration-required", execution: "disabled" };
    }
    if (recoverableVtxos.length > 0) {
      return { supported: true, state: "recover-first", execution: "mutual-stock-batch" };
    }
    if (vtxos.length === 0) {
      return { supported: true, state: "not-funded", execution: "mutual-stock-batch" };
    }
    if (funding.state === "underfunded" || funding.state === "overfunded") {
      return { supported: false, state: funding.state, execution: "disabled" };
    }
    if (expiry.expiresInSeconds === undefined) {
      return { supported: true, state: "expiry-unknown", execution: "mutual-stock-batch" };
    }
    if (isExpired(record, height)) {
      return { supported: true, state: "refund-unlocked", execution: "mutual-stock-batch" };
    }
    if (record.refundAt <= Math.floor(Date.now() / 1_000) + expiry.expiresInSeconds) {
      const quote = await rolloverFeeQuote(record, vtxos[0]);
      return {
        supported: true,
        state: "available-for-activation-test",
        execution: "mutual-stock-batch",
        automaticExecution: false,
        activationTestOnly: true,
        quotedFeeSats: quote.feeSats,
        successorValue: quote.successorValue,
      };
    }
    const quote = await rolloverFeeQuote(record, vtxos[0]);
    return {
      supported: true,
      state:
        expiry.expiresInSeconds <= record.rolloverPolicy.warningThresholdSeconds
          ? "ready-for-mutual-signing"
          : "not-due",
      execution: "mutual-stock-batch",
      warningThresholdSeconds: record.rolloverPolicy.warningThresholdSeconds,
      automaticExecution: record.rolloverPolicy.automaticExecution,
      quotedFeeSats: quote.feeSats,
      successorValue: quote.successorValue,
    };
  })();
  const automaticRollover = record.schemaVersion === 5
    ? await delegatedRolloverPlanFor(record)
    : record.schemaVersion === 6
      ? {
          supported: true,
          state: record.hardenedRenewal.state,
          execution: "bounded-renewal-mandate",
          automaticExecution: true,
          mandateId: record.hardenedRenewal.mandateId,
          maxRenewals: record.hardenedRenewal.maxRenewals,
          finalAt: record.hardenedRenewal.finalAt,
          signerCount: record.hardenedRenewal.renewalPubkeys.length,
          delegateCount: record.hardenedRenewal.delegatePubkeys.length,
          activationTest: record.hardenedRenewal.activationTest,
        }
    : {
        supported: false,
        state: "managed-contract-required",
        execution: "disabled",
        automaticExecution: false,
      };
  return {
    contractId: record.contractId,
    createdAt: record.createdAt,
    network: info.network,
    serviceVersion: info.version,
    escrowAddress: record.escrowAddress,
    label: record.schemaVersion === 5 || record.schemaVersion === 6 ? record.label : undefined,
    presetId: record.schemaVersion === 5 ? record.presetId : record.schemaVersion === 6 ? "hardened-alpha" : undefined,
    durationLabel: record.schemaVersion === 5 || record.schemaVersion === 6 ? record.durationLabel : undefined,
    expectedAmountSats: record.schemaVersion === 5 || record.schemaVersion === 6 ? record.expectedAmountSats : undefined,
    fundingState: funding.state,
    fundedAmountSats: funding.fundedAmountSats,
    remainingAmountSats: "remainingAmountSats" in funding ? funding.remainingAmountSats : undefined,
    overfundedAmountSats: "overfundedAmountSats" in funding ? funding.overfundedAmountSats : undefined,
    managed: record.schemaVersion === 5 || record.schemaVersion === 6,
    stockCompatible: isStockCompatibleContract(record),
    rolloverRequired: record.schemaVersion === 5 || record.schemaVersion === 6 ? record.rolloverRequired : false,
    parties: {
      buyerPubkey: record.buyerPubkey,
      sellerPubkey: record.sellerPubkey,
      arbiterPubkey: record.arbiterPubkey,
    },
    buyerControl: isMobileContract(record) ? record.buyerControl : "local-keychain",
    buyerBound: Boolean(binding),
    buyerArkadeAddress: isMobileContract(record) ? record.buyerArkadeAddress : undefined,
    rotated,
    expired: isExpired(record, height),
    signingInProgress:
      hasPendingSession(record.contractId) ||
      Boolean(activeRolloverSession) ||
      Boolean(activeRecoverySession),
    rolloverSessionId: activeRolloverSession ? activeRolloverSession.sessionId : undefined,
    recoverySessionId: activeRecoverySession ? activeRecoverySession.sessionId : undefined,
    ...expiry,
    ...refundStatus,
    rollover,
    automaticRollover,
    recovery: await recoveryPlanFor(record),
    spendableVtxos: vtxos,
    recoverableVtxos,
  };
};

const dashboard = async () => {
  const proofStatus = await verifyActivationGates();
  const activePath = resolveActiveContractPath();
  const binding = readBinding();
  const contracts = await Promise.all(
    contractEntries().map(async ({ path, record }) => ({
      ...(await statusFor(record, false, binding)),
      active: path === activePath,
    })),
  );
  contracts.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    const leftFunded = left.spendableVtxos.length + left.recoverableVtxos.length;
    const rightFunded = right.spendableVtxos.length + right.recoverableVtxos.length;
    if (leftFunded !== rightFunded) return rightFunded - leftFunded;
    return right.contractId.localeCompare(left.contractId);
  });
  const [sellerSpendable, sellerRecoverable] = await Promise.all([
    sellerVtxos("spendable"),
    sellerVtxos("recoverable"),
  ]);
  const sellerAddress = defaultVtxoScript(sellerPubkey)
    .script.address(networks.bitcoin.hrp, serverPubkey).encode();
  const activationGates = proofStatus.gates;
  const automaticLongTermReady = longTermAutomationReady(activationGates);
  return {
    currentBlockHeight: currentBlockHeight(),
    binding,
    contracts,
    presets: durationPresets.map((preset) => ({
      ...preset,
      creationEnabled: !preset.rolloverRequired || automaticLongTermReady,
      disabledReason:
        preset.rolloverRequired && !automaticLongTermReady
          ? "Complete one funded manual rollover and one expiry-recovery drill first"
          : undefined,
    })),
    activationGates,
    proofAudit: proofStatus.audit,
    seller: {
      address: sellerAddress,
      destinationArkadeAddress: binding?.buyerArkadeAddress,
      spendableVtxos: sellerSpendable,
      recoverableVtxos: sellerRecoverable,
      ...expirySummary(sellerSpendable, sellerRecoverable),
    },
    protection: {
      warningThresholdSeconds: 72 * 60 * 60,
      criticalThresholdSeconds: 24 * 60 * 60,
      unilateralExitDelaySeconds: Number(info.unilateralExitDelay),
      policy: "Every escrow has an independent address and deadline. Automatic long-term rollover remains disabled until the funded manual-rollover and expiry-recovery gates are verified.",
    },
  };
};

const rolloverPlanFor = async (record: ContractRecord) => {
  const [vtxos, recoverableVtxos] = await Promise.all([
    escrowVtxos(record),
    recoverableEscrowVtxos(record),
  ]);
  const common = {
    contractId: record.contractId,
    escrowAddress: record.escrowAddress,
    execution: "stock-arkd-batch",
    automaticExecution: false,
    requiredApprovals: ["buyer-mobile-wallet", "seller-keychain"],
  };
  if (record.schemaVersion !== 4 && record.schemaVersion !== 5 && record.schemaVersion !== 6) {
    return { ...common, state: "legacy-contract-not-rollover-enabled" };
  }
  if (!isStockCompatibleContract(record)) {
    return { ...common, state: "stock-script-migration-required" };
  }
  if (hasPendingSession(record.contractId)) return { ...common, state: "signing-session-in-progress" };
  if (recoverableVtxos.length > 0) return { ...common, state: "recover-first" };
  if (vtxos.length === 0) return { ...common, state: "not-funded" };
  const funding = assessFunding(
    record.schemaVersion === 5 || record.schemaVersion === 6 ? record.expectedAmountSats : undefined,
    vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0),
  );
  if (funding.state === "underfunded" || funding.state === "overfunded") {
    return { ...common, state: funding.state };
  }
  if (vtxos.length !== 1) return { ...common, state: "manual-review-required", inputCount: vtxos.length };
  if (isExpired(record, currentBlockHeight())) return { ...common, state: "refund-unlocked" };
  const [vtxo] = vtxos;
  const expiryMs = vtxo.expiresAt ? Date.parse(vtxo.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiryMs)) return { ...common, state: "expiry-unknown" };
  const secondsUntilVtxoExpiry = Math.floor((expiryMs - Date.now()) / 1_000);
  if (record.refundAt * 1_000 <= expiryMs) {
    const feeQuote = await rolloverFeeQuote(record, vtxo);
    return {
      ...common,
      state: "available-for-activation-test",
      activationTestOnly: true,
      secondsUntilVtxoExpiry,
      input: { txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, expiresAt: vtxo.expiresAt },
      successor: {
        address: record.escrowAddress,
        value: feeQuote.successorValue,
        refundAt: new Date(record.refundAt * 1_000).toISOString(),
      },
      quotedFeeSats: feeQuote.feeSats,
      invariants: {
        sameBuyer: true,
        sameSeller: true,
        sameArbiter: true,
        sameRefundDeadline: true,
        sameContractScript: true,
        valueChangeAllowed: "stock settlement fee only; capped approval still required",
      },
    };
  }
  const state = secondsUntilVtxoExpiry <= record.rolloverPolicy.warningThresholdSeconds
    ? "ready-for-mutual-signing"
    : "not-due";
  const feeQuote = await rolloverFeeQuote(record, vtxo);
  return {
    ...common,
    state,
    secondsUntilVtxoExpiry,
    warningThresholdSeconds: record.rolloverPolicy.warningThresholdSeconds,
    input: { txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, expiresAt: vtxo.expiresAt },
    successor: {
      address: record.escrowAddress,
      value: feeQuote.successorValue,
      refundAt: new Date(record.refundAt * 1_000).toISOString(),
    },
    quotedFeeSats: feeQuote.feeSats,
    invariants: {
      sameBuyer: true,
      sameSeller: true,
      sameArbiter: true,
      sameRefundDeadline: true,
      sameContractScript: true,
      valueChangeAllowed: "stock settlement fee only; capped approval still required",
    },
  };
};

const recoveryPlanFor = async (record: ContractRecord) => {
  const common = {
    contractId: record.contractId,
    execution: "stock-arkd-recovery-batch",
    automaticExecution: false,
  };
  if (record.schemaVersion !== 4 && record.schemaVersion !== 5 && record.schemaVersion !== 6) {
    return { ...common, state: "mobile-time-contract-required" };
  }
  if (!isStockCompatibleContract(record)) {
    return { ...common, state: "stock-script-migration-required" };
  }
  const binding = readBinding();
  if (
    !binding ||
    binding.buyerPubkey !== record.buyerPubkey ||
    binding.buyerArkadeAddress !== record.buyerArkadeAddress
  ) {
    return { ...common, state: "bound-buyer-wallet-required" };
  }
  if (hasPendingSession(record.contractId) || hasPendingRollover(record.contractId)) {
    return { ...common, state: "another-signing-session-in-progress" };
  }
  if (hasPendingRecovery(record.contractId)) return { ...common, state: "recovery-in-progress" };
  const recoverable = await recoverableEscrowVtxos(record);
  if (recoverable.length === 0) return { ...common, state: "not-recoverable" };
  if (recoverable.length !== 1) {
    return { ...common, state: "manual-review-required", inputCount: recoverable.length };
  }
  const refundUnlocked = isExpired(record, currentBlockHeight());
  const destinationAddress = refundUnlocked ? record.buyerArkadeAddress : record.escrowAddress;
  const [input] = recoverable;
  const quote = await recoveryFeeQuote(record, input, destinationAddress);
  return {
    ...common,
    state: "ready-for-expiry-recovery",
    mode: refundUnlocked ? "buyer-refund-after-expiry" : "mutual-preserve-escrow",
    input,
    destination: {
      address: destinationAddress,
      script: quote.destinationScript,
      value: quote.successorValue,
    },
    quotedFeeSats: quote.feeSats,
    requiredApprovals: refundUnlocked
      ? ["buyer-mobile-wallet"]
      : ["buyer-mobile-wallet", "seller-keychain"],
    invariants: {
      exactInput: `${input.txid}:${input.vout}`,
      exactDestination: destinationAddress,
      feeCapRequired: true,
      sweptInputRequired: true,
      preservesEscrowBeforeRefundDeadline: !refundUnlocked,
      refundsBuyerAfterRefundDeadline: refundUnlocked,
    },
  };
};

const proofCoin = (coin: VirtualCoin): ProofCoin => ({
  txid: coin.txid,
  vout: coin.vout,
  value: coin.value,
  script: coin.script,
  isSpent: coin.isSpent,
  isSwept: coin.isSwept,
  spentBy: coin.spentBy,
  settledBy: coin.settledBy,
  commitmentTxIds: coin.commitmentTxIds,
  expiresAt: coin.expiresAt,
});

const commitmentExists = async (txid: string) => {
  try {
    const commitment = await indexerProvider.getCommitmentTx(txid);
    return Boolean(commitment.startedAt && commitment.endedAt);
  } catch {
    return false;
  }
};

const assessSessionEvidence = async (
  session: SettlementProofSession,
  requireSweptInput: boolean,
  requireLaterExpiry: boolean,
) => {
  const [{ vtxos: inputRows }, { vtxos: destinationRows }] = await Promise.all([
    indexerProvider.getVtxos({
      outpoints: [{ txid: session.input.txid, vout: session.input.vout }],
    }),
    indexerProvider.getVtxos({ scripts: [session.destination.script] }),
  ]);
  const commitmentTxid = session.result?.commitmentTxid;
  return assessSettlementProof({
    session,
    commitmentExists: Boolean(commitmentTxid && (await commitmentExists(commitmentTxid))),
    inputCoin: inputRows[0] ? proofCoin(inputRows[0]) : undefined,
    destinationCoins: destinationRows.map(proofCoin),
    requireSweptInput,
    requireLaterExpiry,
  });
};

const completedSessionFiles = <T extends { stage: string; result?: { completedAt?: string } }>(directory: string) => {
  if (!existsSync(directory)) return [] as T[];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.includes(".response."))
    .flatMap((name) => {
      try {
        const session = readJson<T>(resolve(directory, name));
        return session.stage === "completed" ? [session] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) =>
      String(right.result?.completedAt ?? "").localeCompare(String(left.result?.completedAt ?? "")),
    );
};

const verifyActivationGates = async () => {
  const gates = readActivationGates();
  let changed = false;
  const audit: {
    manualRollover: { verified: boolean; reason?: string };
    expiryRecovery: { verified: boolean; reason?: string };
  } = {
    manualRollover: { verified: gates.fundedManualRollover.verified },
    expiryRecovery: { verified: gates.expiryRecoveryDrill.verified },
  };

  if (!gates.fundedManualRollover.verified) {
    const sessions = completedSessionFiles<RolloverSession>(rolloverSessionsDirectory).filter(
      (session) => session.execution === "manual-stock-batch" && Boolean(session.result?.commitmentTxid),
    );
    audit.manualRollover.reason = sessions.length === 0 ? "no-completed-funded-manual-rollover" : "evidence-not-indexed";
    for (const session of sessions) {
      const record = contractEntryById(session.contractId).record;
      const destinationScript = hex.encode(validateContract(record).escrowScript.pkScript);
      const assessment = await assessSessionEvidence(
        {
          stage: session.stage,
          execution: session.execution ?? "manual-stock-batch",
          input: session.input,
          destination: { script: destinationScript, value: session.successor.value },
          result: session.result,
        },
        false,
        true,
      );
      if (!assessment.verified) {
        audit.manualRollover.reason = assessment.reason;
        continue;
      }
      gates.fundedManualRollover = {
        verified: true,
        contractId: session.contractId,
        commitmentTxid: assessment.commitmentTxid,
        verifiedAt: new Date().toISOString(),
      };
      audit.manualRollover = { verified: true };
      changed = true;
      break;
    }
  }

  if (!gates.expiryRecoveryDrill.verified) {
    const sessions = completedSessionFiles<RecoverySession>(recoverySessionsDirectory).filter(
      (session) => Boolean(session.result?.commitmentTxid),
    );
    audit.expiryRecovery.reason = sessions.length === 0 ? "no-completed-expiry-recovery" : "evidence-not-indexed";
    for (const session of sessions) {
      const assessment = await assessSessionEvidence(
        {
          stage: session.stage,
          execution: session.execution,
          input: session.input,
          destination: session.destination,
          result: session.result,
        },
        true,
        true,
      );
      if (!assessment.verified) {
        audit.expiryRecovery.reason = assessment.reason;
        continue;
      }
      gates.expiryRecoveryDrill = {
        verified: true,
        contractId: session.contractId,
        recoveryTxid: assessment.commitmentTxid,
        verifiedAt: new Date().toISOString(),
      };
      audit.expiryRecovery = { verified: true };
      changed = true;
      break;
    }
  }

  if (
    gates.fundedManualRollover.verified &&
    gates.expiryRecoveryDrill.verified &&
    !gates.automaticLongTerm.enabled
  ) {
    gates.automaticLongTerm = { enabled: true, enabledAt: new Date().toISOString() };
    changed = true;
  }
  if (changed) writeJsonAtomic(activationGatesPath, gates);
  return { gates, audit };
};

const delegatedRolloverPlanFor = async (
  record: ContractRecord,
  options: { activationTest?: boolean; activationDelegateAt?: Date } = {},
) => {
  const common = {
    contractId: record.contractId,
    escrowAddress: record.escrowAddress,
    execution: "preauthorized-delegated-stock-batch",
    automaticExecution: true,
    requiredApprovals: ["buyer-mobile-wallet", "seller-keychain"],
  };
  if (record.schemaVersion !== 5) return { ...common, state: "managed-contract-required" };
  if (!record.rolloverRequired) return { ...common, state: "rollover-not-required" };
  if (record.scriptVersion !== 3) {
    return { ...common, state: "fulmine-script-migration-required" };
  }
  if (!longTermAutomationReady(readActivationGates())) {
    return { ...common, state: "activation-gates-not-proven" };
  }
  if (!record.rolloverPolicy.delegatePubkey || !record.rolloverPolicy.delegateUrl) {
    return { ...common, state: "delegate-path-not-configured" };
  }
  const manualPlan = await rolloverPlanFor(record);
  if (!("input" in manualPlan)) return { ...common, state: manualPlan.state };
  const priorAuthorization = completedDelegatedAuthorization(record.contractId, manualPlan.input);
  if (priorAuthorization && !options.activationTest) {
    return {
      ...common,
      state: "already-preauthorized",
      authorizationId: priorAuthorization.result?.authorizationId,
      delegateAt: priorAuthorization.result?.delegateAt,
    };
  }
  const expiryMs = manualPlan.input.expiresAt ? Date.parse(manualPlan.input.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiryMs)) return { ...common, state: "expiry-unknown" };
  const delegateAt = new Date(
    options.activationTest
      ? options.activationDelegateAt?.getTime() ?? Date.now() + 90_000
      : Math.max(Date.now() + 60_000, expiryMs - record.rolloverPolicy.warningThresholdSeconds * 1_000),
  );
  const delegate = await resolveDelegateInfo();
  if (delegate.url !== record.rolloverPolicy.delegateUrl || delegate.pubkey !== record.rolloverPolicy.delegatePubkey) {
    return { ...common, state: "delegate-identity-changed" };
  }
  const quote = await delegatedRolloverFeeQuote(record, manualPlan.input, delegate, delegateAt);
  return {
    ...common,
    state: options.activationTest
      ? "ready-for-activation-test"
      : "ready-for-mutual-preauthorization",
    activationTest: Boolean(options.activationTest),
    replacesAuthorizationId: priorAuthorization?.result?.authorizationId,
    input: manualPlan.input,
    successor: {
      address: record.escrowAddress,
      value: quote.successorValue,
      refundAt: new Date(record.refundAt * 1_000).toISOString(),
    },
    quotedFeeSats: quote.feeSats,
    delegate: {
      url: delegate.url,
      pubkey: delegate.pubkey,
      feeSats: delegate.feeSats,
      delegateAt: delegateAt.toISOString(),
    },
    constraints: {
      exactInput: `${manualPlan.input.txid}:${manualPlan.input.vout}`,
      exactDestination: record.escrowAddress,
      sameContractScript: true,
      sameParties: true,
      sameRefundDeadline: true,
      notValidBefore: delegateAt.toISOString(),
      feeCapRequired: true,
    },
  };
};

const parsePayload = <T>() => {
  const encoded = process.argv[3];
  if (!encoded) throw new Error("Missing command payload");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
};

const sessionPath = (sessionId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid signing session id");
  return resolve(sessionsDirectory, `${sessionId}.json`);
};

const rolloverSessionPath = (sessionId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid rollover session id");
  return resolve(rolloverSessionsDirectory, `${sessionId}.json`);
};

const readRolloverSession = (sessionId: string) => {
  const session = readJson<RolloverSession>(rolloverSessionPath(sessionId));
  if (session.sessionId !== sessionId) throw new Error("Rollover session mismatch");
  return session;
};

const rolloverResponsePath = (sessionId: string, requestId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw new Error("Invalid rollover request id");
  return resolve(rolloverSessionsDirectory, `${sessionId}.response.${requestId}.json`);
};

const recoverySessionPath = (sessionId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Invalid recovery session id");
  return resolve(recoverySessionsDirectory, `${sessionId}.json`);
};

const readRecoverySession = (sessionId: string) => {
  const session = readJson<RecoverySession>(recoverySessionPath(sessionId));
  if (session.sessionId !== sessionId) throw new Error("Recovery session mismatch");
  return session;
};

const recoveryResponsePath = (sessionId: string, requestId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw new Error("Invalid recovery request id");
  return resolve(recoverySessionsDirectory, `${sessionId}.response.${requestId}.json`);
};

const readSession = (sessionId: string) => {
  const session = readJson<SigningSession>(sessionPath(sessionId));
  if (session.sessionId !== sessionId) throw new Error("Signing session mismatch");
  if (Date.parse(session.expiresAt) < Date.now()) throw new Error("Signing session expired; prepare again");
  return session;
};

const storeSession = (session: SigningSession) => writeJsonAtomic(sessionPath(session.sessionId), session);

if (command === "bind-mobile") {
  const { buyerPubkey, buyerArkadeAddress } = parsePayload<{ buyerPubkey: string; buyerArkadeAddress: string }>();
  if (!/^[0-9a-f]{64}$/i.test(buyerPubkey)) throw new Error("Buyer public key must be 32-byte hex");
  const decoded = ArkAddress.decode(buyerArkadeAddress);
  if (hex.encode(decoded.serverPubKey) !== serverPubkeyHex || decoded.hrp !== networks.bitcoin.hrp) {
    throw new Error("Buyer address belongs to a different Arkade server or network");
  }
  const expectedAddress = new DefaultVtxo.Script({
    pubKey: hex.decode(buyerPubkey),
    serverPubKey: serverPubkey,
    csvTimelock: { value: BigInt(info.unilateralExitDelay), type: "seconds" },
  })
    .address(networks.bitcoin.hrp, serverPubkey)
    .encode();
  if (expectedAddress !== buyerArkadeAddress) {
    throw new Error("Buyer address does not match the mobile wallet public key");
  }
  const binding: BuyerBinding = {
    schemaVersion: 1,
    buyerPubkey: buyerPubkey.toLowerCase(),
    buyerArkadeAddress,
    serverPubkey: serverPubkeyHex,
    registeredAt: new Date().toISOString(),
  };
  writeJsonAtomic(bindingPath, binding);
  const active = await ensureActive();
  console.log(JSON.stringify({ ok: true, binding, escrow: await statusFor(active.record, active.rotated, binding) }, null, 2));
  process.exit(0);
}

if (command === "init") {
  const buyer = MnemonicIdentity.fromMnemonic(keychainMnemonic("buyer"), { isMainnet: true });
  const buyerPubkey = await buyer.xOnlyPublicKey();
  const refundDelay = refundDelaySeconds();
  if (existsSync(legacyContractPath)) throw new Error(`Contract already exists at ${legacyContractPath}`);
  const refundAt = Math.floor(Date.now() / 1_000) + refundDelay;
  const { escrowAddress } = buildContract(buyerPubkey, refundAt);
  const record: LegacyTimeContractRecord = {
    schemaVersion: 1,
    contractId: randomUUID(),
    createdAt: new Date().toISOString(),
    serviceUrl,
    network: "bitcoin",
    serverPubkey: serverPubkeyHex,
    buyerPubkey: hex.encode(buyerPubkey),
    sellerPubkey: hex.encode(sellerPubkey),
    arbiterPubkey: hex.encode(arbiterPubkey),
    refundAt,
    escrowAddress,
  };
  mkdirSync(dirname(legacyContractPath), { recursive: true });
  writeFileSync(legacyContractPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}

if (command === "ensure-active" || command === "status") {
  const active = await ensureActive();
  console.log(JSON.stringify(await statusFor(active.record, active.rotated, active.binding), null, 2));
  process.exit(0);
}

if (command === "dashboard") {
  console.log(JSON.stringify(await dashboard(), null, 2));
  process.exit(0);
}

if (command === "verify-gates") {
  console.log(JSON.stringify(await verifyActivationGates(), null, 2));
  process.exit(0);
}

if (command === "create-managed") {
  const payload = parsePayload<{
    presetId: string;
    label?: string;
    buyerPubkey: string;
    expectedAmountSats: number;
  }>();
  const binding = readBinding();
  if (!binding) throw new Error("Bind the mobile wallet before creating an escrow");
  if (payload.buyerPubkey.toLowerCase() !== binding.buyerPubkey) {
    throw new Error("The connected mobile wallet does not match the bound buyer");
  }
  const created = await createManagedContract(
    binding,
    payload.presetId,
    payload.expectedAmountSats,
    payload.label,
  );
  console.log(JSON.stringify(await statusFor(created.record, false, binding), null, 2));
  process.exit(0);
}

if (command === "rollover-plan") {
  const payload = process.argv[3] ? parsePayload<{ contractId?: string }>() : {};
  const selected = contractEntryById(payload.contractId);
  console.log(JSON.stringify(await rolloverPlanFor(selected.record), null, 2));
  process.exit(0);
}

if (command === "delegated-rollover-plan") {
  const payload = process.argv[3] ? parsePayload<{ contractId?: string }>() : {};
  const selected = contractEntryById(payload.contractId);
  console.log(JSON.stringify(await delegatedRolloverPlanFor(selected.record), null, 2));
  process.exit(0);
}

if (command === "delegated-rollover-activation-plan") {
  const payload = parsePayload<{ contractId: string }>();
  const selected = contractEntryById(payload.contractId);
  console.log(JSON.stringify(await delegatedRolloverPlanFor(selected.record, { activationTest: true }), null, 2));
  process.exit(0);
}

if (command === "start-rollover") {
  const payload = parsePayload<{
    contractId: string;
    confirmContractId: string;
    expectedInputValue: number;
    expectedFeeSats: number;
    maxFeeSats: number;
  }>();
  if (payload.contractId !== payload.confirmContractId) throw new Error("Rollover contract confirmation mismatch");
  if (!Number.isSafeInteger(payload.expectedInputValue) || payload.expectedInputValue <= 0) {
    throw new Error("Expected rollover value must be a positive integer number of sats");
  }
  if (!Number.isSafeInteger(payload.expectedFeeSats) || payload.expectedFeeSats < 0) {
    throw new Error("Expected rollover fee must be a non-negative integer number of sats");
  }
  if (!Number.isSafeInteger(payload.maxFeeSats) || payload.maxFeeSats < payload.expectedFeeSats) {
    throw new Error("Maximum rollover fee must cover the displayed quote");
  }
  const selected = contractEntryById(payload.contractId);
  const plan = await rolloverPlanFor(selected.record);
  if (!("input" in plan) || !("successor" in plan) || !("quotedFeeSats" in plan)) {
    throw new Error(`Rollover is unavailable: ${plan.state}`);
  }
  if (
    plan.state !== "ready-for-mutual-signing" &&
    plan.state !== "not-due" &&
    plan.state !== "available-for-activation-test"
  ) {
    throw new Error(`Rollover is unavailable: ${plan.state}`);
  }
  if (plan.input.value !== payload.expectedInputValue || plan.quotedFeeSats !== payload.expectedFeeSats) {
    throw new Error("Rollover value or fee changed; refresh and approve the new quote");
  }
  if (plan.quotedFeeSats > payload.maxFeeSats) throw new Error("Rollover fee exceeds the approved cap");
  if (hasPendingRollover(payload.contractId)) throw new Error("A rollover is already active for this contract");
  const session: RolloverSession = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    contractId: payload.contractId,
    contractPath: selected.path,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    stage: "queued",
    input: plan.input,
    successor: plan.successor,
    quotedFeeSats: plan.quotedFeeSats,
    maxFeeSats: payload.maxFeeSats,
    execution: "manual-stock-batch",
    automaticExecution: false,
    requiredApprovals: ["buyer-mobile-wallet", "seller-keychain"],
    events: [{ at: new Date().toISOString(), type: "owner-approved" }],
  };
  mkdirSync(rolloverSessionsDirectory, { recursive: true });
  writeJsonAtomic(rolloverSessionPath(session.sessionId), session);
  const logPath = resolve(rolloverSessionsDirectory, `${session.sessionId}.log`);
  const log = openSync(logPath, "a", 0o600);
  const worker = spawn(resolve(escrowRoot, "node_modules/.bin/tsx"), [
    resolve(escrowRoot, "rollover-worker.ts"),
    session.sessionId,
  ], {
    cwd: escrowRoot,
    detached: true,
    env: { ...process.env, ESCROW_ROOT: escrowRoot, ARKADE_URL: serviceUrl },
    stdio: ["ignore", log, log],
  });
  worker.unref();
  closeSync(log);
  session.workerPid = worker.pid;
  console.log(JSON.stringify(session, null, 2));
  process.exit(0);
}

if (command === "preauthorize-rollover") {
  const payload = parsePayload<{
    contractId: string;
    confirmContractId: string;
    expectedInputValue: number;
    expectedFeeSats: number;
    maxFeeSats: number;
    expectedDelegateAt: string;
    activationTest?: boolean;
    replacesAuthorizationId?: string;
  }>();
  if (payload.contractId !== payload.confirmContractId) throw new Error("Authorization contract confirmation mismatch");
  if (!Number.isSafeInteger(payload.expectedInputValue) || payload.expectedInputValue <= 0) {
    throw new Error("Expected rollover value must be a positive integer number of sats");
  }
  if (!Number.isSafeInteger(payload.expectedFeeSats) || payload.expectedFeeSats < 0) {
    throw new Error("Expected rollover fee must be a non-negative integer number of sats");
  }
  if (!Number.isSafeInteger(payload.maxFeeSats) || payload.maxFeeSats < payload.expectedFeeSats) {
    throw new Error("Maximum rollover fee must cover the displayed quote");
  }
  const selected = contractEntryById(payload.contractId);
  const activationDelegateAt = payload.activationTest === true
    ? new Date(payload.expectedDelegateAt)
    : undefined;
  if (activationDelegateAt) {
    const activationTime = activationDelegateAt.getTime();
    if (
      !Number.isFinite(activationTime) ||
      activationTime < Date.now() - 30_000 ||
      activationTime > Date.now() + 10 * 60_000
    ) {
      throw new Error("Activation-test timing expired; refresh and approve a new short-lived plan");
    }
  }
  const plan = await delegatedRolloverPlanFor(selected.record, {
    activationTest: payload.activationTest === true,
    activationDelegateAt,
  });
  if (!("input" in plan) || !("successor" in plan) || !("quotedFeeSats" in plan) || !("delegate" in plan)) {
    throw new Error(`Delegated rollover is unavailable: ${plan.state}`);
  }
  if (
    plan.state !== "ready-for-mutual-preauthorization" &&
    plan.state !== "ready-for-activation-test"
  ) {
    throw new Error(`Delegated rollover is unavailable: ${plan.state}`);
  }
  if (
    plan.input.value !== payload.expectedInputValue ||
    plan.quotedFeeSats !== payload.expectedFeeSats ||
    plan.delegate.delegateAt !== payload.expectedDelegateAt
  ) {
    throw new Error("Delegated rollover terms changed; refresh and approve the new authorization");
  }
  if (plan.quotedFeeSats > payload.maxFeeSats) throw new Error("Delegated rollover fee exceeds the approved cap");
  if (payload.activationTest === true) {
    if (!plan.replacesAuthorizationId || plan.replacesAuthorizationId !== payload.replacesAuthorizationId) {
      throw new Error("The pending rollover authorization changed; refresh before replacing it");
    }
  } else if (payload.replacesAuthorizationId) {
    throw new Error("Replacement authorization is only permitted for the explicit activation test");
  }
  if (hasPendingRollover(payload.contractId)) throw new Error("A rollover is already active for this contract");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  const session: RolloverSession = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    contractId: payload.contractId,
    contractPath: selected.path,
    createdAt: new Date().toISOString(),
    expiresAt,
    stage: "queued",
    input: plan.input,
    successor: plan.successor,
    quotedFeeSats: plan.quotedFeeSats,
    maxFeeSats: payload.maxFeeSats,
    execution: "preauthorized-delegated-stock-batch",
    automaticExecution: true,
    activationTest: payload.activationTest === true,
    replacesAuthorizationId: plan.replacesAuthorizationId,
    requiredApprovals: ["buyer-mobile-wallet", "seller-keychain"],
    delegate: {
      ...plan.delegate,
      authorizationExpiresAt: expiresAt,
    },
    events: [{ at: new Date().toISOString(), type: "owner-approved-delegated-rollover" }],
  };
  session.sellerAuthorization = {
    scheme: "bip340-sha256",
    pubkey: selected.record.sellerPubkey,
    signature: hex.encode(
      await seller.signMessage(
        rolloverAuthorizationDigest({
          contractId: session.contractId,
          input: session.input,
          successor: session.successor,
          quotedFeeSats: session.quotedFeeSats,
          maxFeeSats: session.maxFeeSats,
          delegate: session.delegate!,
        }),
        "schnorr",
      ),
    ),
  };
  mkdirSync(rolloverSessionsDirectory, { recursive: true });
  writeJsonAtomic(rolloverSessionPath(session.sessionId), session);
  const logPath = resolve(rolloverSessionsDirectory, `${session.sessionId}.log`);
  const log = openSync(logPath, "a", 0o600);
  const worker = spawn(resolve(escrowRoot, "node_modules/.bin/tsx"), [
    resolve(escrowRoot, "rollover-worker.ts"),
    session.sessionId,
  ], {
    cwd: escrowRoot,
    detached: true,
    env: { ...process.env, ESCROW_ROOT: escrowRoot, ARKADE_URL: serviceUrl },
    stdio: ["ignore", log, log],
  });
  worker.unref();
  closeSync(log);
  session.workerPid = worker.pid;
  console.log(JSON.stringify(session, null, 2));
  process.exit(0);
}

if (command === "rollover-status") {
  const { sessionId } = parsePayload<{ sessionId: string }>();
  console.log(JSON.stringify(readRolloverSession(sessionId), null, 2));
  process.exit(0);
}

if (command === "rollover-sign") {
  const { sessionId, requestId, signedPsbt } = parsePayload<{
    sessionId: string;
    requestId: string;
    signedPsbt: string;
  }>();
  const session = readRolloverSession(sessionId);
  if (session.stage !== "awaiting_mobile_signature" || session.request?.requestId !== requestId) {
    throw new Error("Rollover is not awaiting this signature");
  }
  if (Date.parse(session.expiresAt) < Date.now()) throw new Error("Rollover session expired");
  if (typeof signedPsbt !== "string" || signedPsbt.length < 20 || signedPsbt.length > 1_000_000) {
    throw new Error("Invalid signed rollover transaction");
  }
  const responsePath = rolloverResponsePath(sessionId, requestId);
  if (existsSync(responsePath)) throw new Error("This rollover signature was already submitted");
  writeJsonAtomic(responsePath, { schemaVersion: 1, sessionId, requestId, signedPsbt, submittedAt: new Date().toISOString() });
  console.log(JSON.stringify({ ok: true, sessionId, requestId }, null, 2));
  process.exit(0);
}

if (command === "recovery-plan") {
  const payload = process.argv[3] ? parsePayload<{ contractId?: string }>() : {};
  const selected = contractEntryById(payload.contractId);
  console.log(JSON.stringify(await recoveryPlanFor(selected.record), null, 2));
  process.exit(0);
}

if (command === "start-recovery") {
  const payload = parsePayload<{
    contractId: string;
    confirmContractId: string;
    expectedInputValue: number;
    expectedDestination: string;
    expectedDestinationValue: number;
    expectedFeeSats: number;
    maxFeeSats: number;
  }>();
  if (payload.contractId !== payload.confirmContractId) throw new Error("Recovery contract confirmation mismatch");
  for (const [label, value] of [
    ["input value", payload.expectedInputValue],
    ["destination value", payload.expectedDestinationValue],
    ["quoted fee", payload.expectedFeeSats],
    ["maximum fee", payload.maxFeeSats],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Recovery ${label} must be integer sats`);
  }
  if (payload.expectedInputValue <= 0 || payload.expectedDestinationValue <= 0) {
    throw new Error("Recovery values must be positive");
  }
  if (payload.maxFeeSats < payload.expectedFeeSats) throw new Error("Maximum recovery fee must cover the quote");
  const selected = contractEntryById(payload.contractId);
  const plan = await recoveryPlanFor(selected.record);
  if (
    plan.state !== "ready-for-expiry-recovery" ||
    !("input" in plan) ||
    !("destination" in plan) ||
    !("quotedFeeSats" in plan) ||
    !("mode" in plan)
  ) {
    throw new Error(`Recovery is unavailable: ${plan.state}`);
  }
  if (
    plan.input.value !== payload.expectedInputValue ||
    plan.destination.address !== payload.expectedDestination ||
    plan.destination.value !== payload.expectedDestinationValue ||
    plan.quotedFeeSats !== payload.expectedFeeSats
  ) {
    throw new Error("Recovery input, destination, value, or fee changed; refresh and approve again");
  }
  if (plan.quotedFeeSats > payload.maxFeeSats) throw new Error("Recovery fee exceeds the approved cap");
  if (hasPendingRecovery(payload.contractId)) throw new Error("A recovery is already active for this contract");
  const mode = plan.mode as RecoverySession["execution"];
  if (mode !== "mutual-preserve-escrow" && mode !== "buyer-refund-after-expiry") {
    throw new Error("Unsupported recovery mode");
  }
  const session: RecoverySession = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    contractId: payload.contractId,
    contractPath: selected.path,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    stage: "queued",
    execution: mode,
    input: plan.input,
    destination: plan.destination,
    quotedFeeSats: plan.quotedFeeSats,
    maxFeeSats: payload.maxFeeSats,
    requiredApprovals:
      mode === "buyer-refund-after-expiry"
        ? ["buyer-mobile-wallet"]
        : ["buyer-mobile-wallet", "seller-keychain"],
    events: [{ at: new Date().toISOString(), type: "owner-approved-expiry-recovery" }],
  };
  mkdirSync(recoverySessionsDirectory, { recursive: true });
  writeJsonAtomic(recoverySessionPath(session.sessionId), session);
  const logPath = resolve(recoverySessionsDirectory, `${session.sessionId}.log`);
  const log = openSync(logPath, "a", 0o600);
  const worker = spawn(resolve(escrowRoot, "node_modules/.bin/tsx"), [
    resolve(escrowRoot, "recovery-worker.ts"),
    session.sessionId,
  ], {
    cwd: escrowRoot,
    detached: true,
    env: { ...process.env, ESCROW_ROOT: escrowRoot, ARKADE_URL: serviceUrl },
    stdio: ["ignore", log, log],
  });
  worker.unref();
  closeSync(log);
  session.workerPid = worker.pid;
  console.log(JSON.stringify(session, null, 2));
  process.exit(0);
}

if (command === "recovery-status") {
  const { sessionId } = parsePayload<{ sessionId: string }>();
  console.log(JSON.stringify(readRecoverySession(sessionId), null, 2));
  process.exit(0);
}

if (command === "recovery-sign") {
  const { sessionId, requestId, signedPsbt } = parsePayload<{
    sessionId: string;
    requestId: string;
    signedPsbt: string;
  }>();
  const session = readRecoverySession(sessionId);
  if (session.stage !== "awaiting_mobile_signature" || session.request?.requestId !== requestId) {
    throw new Error("Recovery is not awaiting this signature");
  }
  if (Date.parse(session.expiresAt) < Date.now()) throw new Error("Recovery session expired");
  if (typeof signedPsbt !== "string" || signedPsbt.length < 20 || signedPsbt.length > 1_000_000) {
    throw new Error("Invalid signed recovery transaction");
  }
  const responsePath = recoveryResponsePath(sessionId, requestId);
  if (existsSync(responsePath)) throw new Error("This recovery signature was already submitted");
  writeJsonAtomic(responsePath, { schemaVersion: 1, sessionId, requestId, signedPsbt, submittedAt: new Date().toISOString() });
  console.log(JSON.stringify({ ok: true, sessionId, requestId }, null, 2));
  process.exit(0);
}

if (command === "rotate-empty") {
  const binding = readBinding();
  if (!binding) throw new Error("A mobile buyer must be bound before rotating the escrow");
  const currentPath = resolveActiveContractPath();
  const current = readContract(currentPath);
  validateContract(current);
  const [vtxos, recoverableVtxos] = await Promise.all([
    escrowVtxos(current),
    recoverableEscrowVtxos(current),
  ]);
  if (vtxos.length > 0) throw new Error("Refusing to rotate a funded escrow");
  if (recoverableVtxos.length > 0) throw new Error("Refusing to rotate an escrow with recoverable funds");
  if (hasPendingSession(current.contractId)) throw new Error("Refusing to rotate an escrow with a signing session");
  if (hasPendingRollover(current.contractId)) throw new Error("Refusing to rotate an escrow with a rollover session");
  if (hasPendingRecovery(current.contractId)) throw new Error("Refusing to rotate an escrow with a recovery session");
  const next = createMobileContract(binding);
  console.log(JSON.stringify(await statusFor(next.record, true, binding), null, 2));
  process.exit(0);
}

const activePath = resolveActiveContractPath();
const record = readContract(activePath);
const built = validateContract(record);

if (command === "address") {
  console.log(record.escrowAddress);
  process.exit(0);
}

if (command === "prepare-mobile") {
  const { action, contractId } = parsePayload<{
    action: EscrowAction;
    contractId?: string;
  }>();
  if (action !== "release" && action !== "refund" && action !== "migrate") {
    throw new Error("Unsupported escrow action");
  }
  const selected = contractEntryById(contractId);
  const selectedRecord = selected.record;
  const selectedBuilt = validateContract(selectedRecord);
  const binding = readBinding();
  if (!binding || !isMobileContract(selectedRecord) || selectedRecord.buyerPubkey !== binding.buyerPubkey) {
    throw new Error("This escrow is not controlled by the bound mobile wallet");
  }
  if (hasPendingSession(selectedRecord.contractId)) {
    throw new Error("This escrow already has a signing session in progress");
  }
  if (action === "refund" && !isExpired(selectedRecord, currentBlockHeight())) {
    throw new Error(
      isTimeContract(selectedRecord)
        ? `Refund is timelocked until ${new Date(selectedRecord.refundAt * 1_000).toISOString()}`
        : `Refund is timelocked until Bitcoin block ${selectedRecord.refundBlockHeight}`,
    );
  }
  if (action === "migrate" && selectedRecord.schemaVersion !== 5) {
    throw new Error("Only a managed Warden escrow can be migrated in place");
  }
  const migrationTarget = action === "migrate"
    ? stockMigrationTargetFor(selectedRecord as ManagedTimeContractRecord)
    : undefined;
  const vtxos = await escrowVtxos(selectedRecord);
  if (vtxos.length === 0) throw new Error("No spendable escrow VTXOs were found");
  const totalValue = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
  if (!Number.isSafeInteger(totalValue) || totalValue <= 0) throw new Error("Escrow total is invalid");
  const funding = assessFunding(
    selectedRecord.schemaVersion === 5 || selectedRecord.schemaVersion === 6 ? selectedRecord.expectedAmountSats : undefined,
    totalValue,
  );
  if (action === "release" && funding.state === "underfunded") {
    throw new Error(`Escrow is underfunded by ${funding.remainingAmountSats} sats`);
  }
  if (action === "release" && funding.state === "overfunded") {
    throw new Error(
      `Escrow is overfunded by ${funding.overfundedAmountSats} sats; release is frozen for independent review`,
    );
  }
  const buyerPubkey = hex.decode(selectedRecord.buyerPubkey);
  const recipientPubkey = action === "release" ? sellerPubkey : buyerPubkey;
  const recipientScript = migrationTarget
    ? validateContract(migrationTarget.record).escrowScript
    : defaultVtxoScript(recipientPubkey).script;
  const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
  const spendPath = selectedBuilt.escrowScript.findLeaf(
    hex.encode(action === "refund" ? selectedBuilt.refundPath : selectedBuilt.collaborativePath),
  );
  const inputs = vtxos.map((vtxo) => ({
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: spendPath,
    tapTree: selectedBuilt.escrowScript.encode(),
  }));
  const { arkTx, checkpoints } = buildOffchainTx(
    inputs,
    [{ amount: BigInt(totalValue), script: recipientScript.pkScript }],
    serverUnrollScript,
  );
  const session: SigningSession = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    contractPath: selected.path,
    contractId: selectedRecord.contractId,
    action,
    buyerPubkey: selectedRecord.buyerPubkey,
    value: totalValue,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    stage: "awaiting_ark_signature",
    unsignedArkTx: base64.encode(arkTx.toPSBT()),
    unsignedCheckpoints: checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    destinationContractId: migrationTarget?.record.contractId,
    destinationAddress: migrationTarget?.record.escrowAddress,
  };
  storeSession(session);
  console.log(JSON.stringify({
    sessionId: session.sessionId,
    action,
    value: session.value,
    contractId: selectedRecord.contractId,
    escrowAddress: selectedRecord.escrowAddress,
    ...(isTimeContract(selectedRecord)
      ? { refundAt: new Date(selectedRecord.refundAt * 1_000).toISOString() }
      : { refundBlockHeight: selectedRecord.refundBlockHeight }),
    expiresAt: session.expiresAt,
    destinationContractId: session.destinationContractId,
    destinationAddress: session.destinationAddress,
    arkTx: session.unsignedArkTx,
  }, null, 2));
  process.exit(0);
}

if (command === "submit-mobile-ark") {
  const { sessionId, signedArkTx } = parsePayload<{ sessionId: string; signedArkTx: string }>();
  const session = readSession(sessionId);
  if (session.stage !== "awaiting_ark_signature") throw new Error("Signing session is not awaiting the Ark transaction signature");
  if (dirname(session.contractPath) !== contractsDirectory) throw new Error("Signing session contract path is invalid");
  const sessionRecord = readContract(session.contractPath);
  if (session.contractId !== sessionRecord.contractId) throw new Error("Signing session contract changed");
  validateContract(sessionRecord);
  let combined = applyRequiredTapscriptSignatures(signedArkTx, session.unsignedArkTx, session.buyerPubkey);
  if (session.action === "release" || session.action === "migrate") {
    combined = await seller.sign(Transaction.fromPSBT(combined.toPSBT()));
  }
  const submitted = await arkProvider.submitTx(base64.encode(combined.toPSBT()), session.unsignedCheckpoints);
  session.arkTxid = submitted.arkTxid;
  session.serverSignedCheckpoints = submitted.signedCheckpointTxs;
  session.stage = "awaiting_checkpoint_signatures";
  storeSession(session);
  console.log(JSON.stringify({
    sessionId,
    action: session.action,
    value: session.value,
    arkTxid: session.arkTxid,
    checkpoints: session.serverSignedCheckpoints,
    expiresAt: session.expiresAt,
  }, null, 2));
  process.exit(0);
}

if (command === "finalize-mobile") {
  const { sessionId, signedCheckpoints } = parsePayload<{ sessionId: string; signedCheckpoints: string[] }>();
  const session = readSession(sessionId);
  if (session.stage !== "awaiting_checkpoint_signatures" || !session.arkTxid || !session.serverSignedCheckpoints) {
    throw new Error("Signing session is not awaiting checkpoint signatures");
  }
  if (dirname(session.contractPath) !== contractsDirectory) throw new Error("Signing session contract path is invalid");
  const sessionRecord = readContract(session.contractPath);
  if (session.contractId !== sessionRecord.contractId) throw new Error("Signing session contract changed");
  validateContract(sessionRecord);
  if (signedCheckpoints.length !== session.serverSignedCheckpoints.length) throw new Error("Checkpoint count mismatch");
  const finalizedCheckpoints = await Promise.all(
    signedCheckpoints.map(async (signed, index) => {
      let combined = applyRequiredTapscriptSignatures(
        signed,
        session.serverSignedCheckpoints![index],
        session.buyerPubkey,
      );
      if (session.action === "release" || session.action === "migrate") {
        combined = await seller.sign(Transaction.fromPSBT(combined.toPSBT()), [0]);
      }
      return base64.encode(combined.toPSBT());
    }),
  );
  await arkProvider.finalizeTx(session.arkTxid, finalizedCheckpoints);
  session.stage = "finalized";
  session.result = { arkTxid: session.arkTxid, finalizedAt: new Date().toISOString() };
  storeSession(session);
  console.log(JSON.stringify({
    result: session.action === "release" ? "released" : session.action === "migrate" ? "migrated" : "refunded",
    contractId: session.contractId,
    destinationContractId: session.destinationContractId,
    destinationAddress: session.destinationAddress,
    arkTxid: session.arkTxid,
    value: session.value,
  }, null, 2));
  process.exit(0);
}

if (command === "claim-seller") {
  const { destinationArkadeAddress, expectedValue } = parsePayload<{
    destinationArkadeAddress: string;
    expectedValue: number;
  }>();
  const binding = readBinding();
  if (!binding) throw new Error("Bind the mobile wallet before claiming seller proceeds");
  if (destinationArkadeAddress !== binding.buyerArkadeAddress) {
    throw new Error("Seller proceeds may only be claimed to the currently bound mobile wallet");
  }
  if (!Number.isSafeInteger(expectedValue) || expectedValue <= 0) {
    throw new Error("Expected seller amount must be a positive integer number of sats");
  }
  const decoded = ArkAddress.decode(destinationArkadeAddress);
  if (hex.encode(decoded.serverPubKey) !== serverPubkeyHex || decoded.hrp !== networks.bitcoin.hrp) {
    throw new Error("Seller claim destination belongs to a different Arkade server or network");
  }
  const expectedDestination = defaultVtxoScript(hex.decode(binding.buyerPubkey))
    .script.address(networks.bitcoin.hrp, serverPubkey).encode();
  if (expectedDestination !== destinationArkadeAddress) {
    throw new Error("Seller claim destination does not match the bound mobile wallet public key");
  }
  const [vtxos, recoverableVtxos] = await Promise.all([
    sellerVtxos("spendable"),
    sellerVtxos("recoverable"),
  ]);
  if (recoverableVtxos.length > 0) {
    throw new Error("Seller proceeds include expired recoverable VTXOs; recover them before claiming");
  }
  if (vtxos.length === 0) throw new Error("No spendable seller proceeds are available");
  const total = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
  if (total !== expectedValue) {
    throw new Error(`Seller balance changed; expected ${expectedValue} sats but found ${total} sats`);
  }
  const sellerScript = defaultVtxoScript(sellerPubkey);
  const destinationScript = defaultVtxoScript(hex.decode(binding.buyerPubkey)).script;
  const inputs = vtxos.map((vtxo) => ({
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: sellerScript.script.findLeaf(hex.encode(sellerScript.collaborativePath)),
    tapTree: sellerScript.script.encode(),
  }));
  const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
  const { arkTx, checkpoints } = buildOffchainTx(
    inputs,
    [{ amount: BigInt(total), script: destinationScript.pkScript }],
    serverUnrollScript,
  );
  const sellerSignedArkTx = await seller.sign(Transaction.fromPSBT(arkTx.toPSBT()));
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(sellerSignedArkTx.toPSBT()),
    checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  );
  const finalizedCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (checkpoint) => {
      const sellerSigned = await seller.sign(Transaction.fromPSBT(base64.decode(checkpoint)), [0]);
      return base64.encode(sellerSigned.toPSBT());
    }),
  );
  await arkProvider.finalizeTx(arkTxid, finalizedCheckpoints);
  console.log(JSON.stringify({
    result: "seller-proceeds-claimed",
    destinationArkadeAddress,
    arkTxid,
    value: total,
  }, null, 2));
  process.exit(0);
}

if (command === "recover-seller") {
  const { expectedValue } = parsePayload<{ expectedValue: number }>();
  if (!Number.isSafeInteger(expectedValue) || expectedValue <= 0) {
    throw new Error("Expected recoverable seller amount must be a positive integer number of sats");
  }
  const recoverableVtxos = await sellerVtxos("recoverable");
  const grossRecoverable = recoverableVtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
  if (grossRecoverable === 0) throw new Error("No recoverable seller proceeds are available");
  if (grossRecoverable !== expectedValue) {
    throw new Error(`Seller recoverable balance changed; expected ${expectedValue} sats but found ${grossRecoverable} sats`);
  }
  configureEventSource((url) => new EventSource(url));
  const sellerWallet = await Wallet.create({
    identity: seller,
    arkServerUrl: serviceUrl,
    walletMode: "static",
    settlementConfig: false,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });
  try {
    await sellerWallet.restore();
    const manager = await sellerWallet.getVtxoManager();
    const balance = await manager.getRecoverableBalance();
    if (balance.recoverable <= 0n) throw new Error("Seller wallet found no recoverable balance after restore");
    const arkTxid = await manager.recoverVtxos();
    console.log(JSON.stringify({
      result: "seller-proceeds-recovered",
      arkTxid,
      grossValue: grossRecoverable,
      recoveredValue: Number(balance.recoverable),
    }, null, 2));
  } finally {
    await sellerWallet.dispose();
  }
  process.exit(0);
}

if (command !== "release" && command !== "refund") {
  throw new Error("Usage: npm run escrow -- init|status|dashboard|rollover-plan|start-rollover|rollover-status|rollover-sign|address|bind-mobile|rotate-empty|prepare-mobile|submit-mobile-ark|finalize-mobile|claim-seller|recover-seller|release|refund");
}

const buyer = MnemonicIdentity.fromMnemonic(keychainMnemonic("buyer"), { isMainnet: true });
const localBuyerPubkey = await buyer.xOnlyPublicKey();
if (record.buyerPubkey !== hex.encode(localBuyerPubkey)) {
  throw new Error("Direct CLI signing is disabled for a mobile-wallet buyer; use the wallet UI");
}
if (command === "release" && process.env.CONFIRM_ESCROW_RELEASE !== record.contractId) {
  throw new Error(`Release blocked. Set CONFIRM_ESCROW_RELEASE=${record.contractId}`);
}
if (command === "refund") {
  if (!isExpired(record, currentBlockHeight())) throw new Error("Refund timelock has not expired");
  if (process.env.CONFIRM_ESCROW_REFUND !== record.contractId) {
    throw new Error(`Refund blocked. Set CONFIRM_ESCROW_REFUND=${record.contractId}`);
  }
}

const vtxos = await escrowVtxos(record);
if (vtxos.length === 0) throw new Error("No spendable escrow VTXOs were found");
const totalValue = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
if (!Number.isSafeInteger(totalValue) || totalValue <= 0) throw new Error("Escrow total is invalid");
const recipientPubkey = command === "release" ? sellerPubkey : localBuyerPubkey;
const recipientScript = defaultVtxoScript(recipientPubkey).script;
const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
const spendPath = built.escrowScript.findLeaf(
  hex.encode(command === "release" ? built.collaborativePath : built.refundPath),
);
const inputs = vtxos.map((vtxo) => ({
  txid: vtxo.txid,
  vout: vtxo.vout,
  value: vtxo.value,
  tapLeafScript: spendPath,
  tapTree: built.escrowScript.encode(),
}));
const { arkTx, checkpoints } = buildOffchainTx(
  inputs,
  [{ amount: BigInt(totalValue), script: recipientScript.pkScript }],
  serverUnrollScript,
);
const signedByBuyer = await buyer.sign(Transaction.fromPSBT(arkTx.toPSBT()));
const fullySigned = command === "release" ? await seller.sign(Transaction.fromPSBT(signedByBuyer.toPSBT())) : signedByBuyer;
const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
  base64.encode(fullySigned.toPSBT()),
  checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
);
const finalizedCheckpoints = await Promise.all(
  signedCheckpointTxs.map(async (checkpoint) => {
    const buyerSigned = await buyer.sign(Transaction.fromPSBT(base64.decode(checkpoint)), [0]);
    const fullySignedCheckpoint = command === "release"
      ? await seller.sign(Transaction.fromPSBT(buyerSigned.toPSBT()), [0])
      : buyerSigned;
    return base64.encode(fullySignedCheckpoint.toPSBT());
  }),
);
await arkProvider.finalizeTx(arkTxid, finalizedCheckpoints);
console.log(JSON.stringify({
  result: command === "release" ? "released" : "refunded",
  contractId: record.contractId,
  arkTxid,
  value: totalValue,
}, null, 2));
