import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  ArkAddress,
  Estimator,
  MnemonicIdentity,
  RestArkProvider,
  RestIndexerProvider,
  networks,
  type VirtualCoin,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
  classifyRenewalRouteFailure,
  delegatedAuthorizationExpired,
  delegatedAuthorizationIsActive,
  selectRenewalDelegate,
  selectRenewalSigner,
} from "./bounded-renewal-signer.js";
import {
  deriveRenewalHistory,
  renewalReceiptDigest,
  writeRenewalJournalAtomic,
  type RenewalJournal,
  type SignedRenewalReceipt,
} from "./renewal-journal.js";
import { renewalDecision } from "./renewal-policy.js";
import { verifySignedRenewalMandate, type SignedRenewalMandate } from "./renewal-mandate.js";
import { buildWardenScript } from "./warden-script.js";
import { assertUnilateralExitBundle, type UnilateralExitBundle } from "./unilateral-exit-bundle.js";
import { assertStockArkdWardenScript } from "./stock-arkd-closures.js";

type HardenedContract = {
  schemaVersion: 6;
  scriptVersion: 5 | 6;
  contractId: string;
  serviceUrl: string;
  network: "bitcoin";
  serverPubkey: string;
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  refundAt: number;
  escrowAddress: string;
  escrowScript: string;
  exitDelaySeconds: number;
  hardenedRenewal: {
    mandateId: string;
    mandatePath: string;
    maxRenewals: number;
    finalAt: string;
    renewalPubkeys: string[];
    delegatePubkeys: string[];
    state: string;
    activationTest?: boolean;
  };
};

type DelegateStatus = {
  url: string;
  pubkey: string;
  feeSats: number;
  address: string;
  online: boolean;
};

type BoundedSession = {
  schemaVersion: 1;
  sessionId: string;
  contractId: string;
  contractPath: string;
  createdAt: string;
  expiresAt: string;
  stage: "queued";
  input: { txid: string; vout: number; value: number; expiresAt: string };
  successor: { address: string; value: number; refundAt: string };
  quotedFeeSats: number;
  maxFeeSats: number;
  execution: "bounded-renewal-stock-batch";
  automaticExecution: true;
  activationTest: boolean;
  requiredApprovals: ["buyer-and-seller-renewal-mandate"];
  mandatePath: string;
  journalPath: string;
  renewalSignerPubkey: string;
  delegate: {
    url: string;
    pubkey: string;
    feeSats: number;
    delegateAt: string;
    authorizationExpiresAt: string;
  };
  events: Array<{ at: string; type: string }>;
};

const root = resolve(process.env.ESCROW_ROOT ?? process.cwd());
const contractsDirectory = resolve(root, "contracts");
const sessionsDirectory = resolve(root, "rollover-sessions");
const journalsDirectory = resolve(root, "renewal-journals");
const exitBundlesDirectory = resolve(root, "unilateral-exit-bundles");
const supervisorStatusPath = resolve(root, "renewal-supervisor-status.json");
const workerPath = resolve(root, "rollover-worker.ts");
const activationTest = process.env.HARDENED_RENEWAL_ACTIVATION_TEST === "true";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJsonAtomic = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
const account = process.env.USER;
if (!account) throw new Error("USER is unavailable");
const keychainIdentity = (role: "renewal" | "renewal-recovery") => {
  const mnemonic = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", `frontiercrown.arkade.mainnet.escrow.${role}`, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  return MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: true });
};

const delegateStatus = async (url: string): Promise<DelegateStatus> => {
  try {
    const response = await fetch(`${url}/v1/delegate/info`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("unavailable");
    const value = await response.json() as {
      pubkey: string;
      fee: string;
      delegateAddress?: string;
      delegatorAddress?: string;
    };
    return {
      url,
      pubkey: value.pubkey.replace(/^(02|03)/, "").toLowerCase(),
      feeSats: Number(value.fee),
      address: value.delegateAddress || value.delegatorAddress || "",
      online: true,
    };
  } catch {
    return { url, pubkey: "", feeSats: 0, address: "", online: false };
  }
};

const unspent = (coins: VirtualCoin[]) => coins.filter((coin) => !coin.isSpent && !coin.isSwept);
const outpoint = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`;

const priorAuthorization = (contractId: string, input: { txid: string; vout: number }) => {
  if (!existsSync(sessionsDirectory)) return undefined;
  for (const name of readdirSync(sessionsDirectory).filter((value) => value.endsWith(".json"))) {
    try {
      const session = readJson<Record<string, any>>(resolve(sessionsDirectory, name));
      if (
        session.contractId === contractId &&
        session.execution === "bounded-renewal-stock-batch" &&
        session.input?.txid === input.txid &&
        session.input?.vout === input.vout &&
        delegatedAuthorizationIsActive(session)
      ) return session;
    } catch {
      // A corrupt unrelated session must not suppress renewal of this contract.
    }
  }
  return undefined;
};

const failedRoutes = (contractId: string, input: { txid: string; vout: number }) => {
  const signers = new Set<string>();
  const delegates = new Set<string>();
  if (!existsSync(sessionsDirectory)) return { signers, delegates };
  for (const name of readdirSync(sessionsDirectory).filter((value) => value.endsWith(".json"))) {
    try {
      const session = readJson<Record<string, any>>(resolve(sessionsDirectory, name));
      if (
        session.contractId === contractId &&
        session.execution === "bounded-renewal-stock-batch" &&
        session.input?.txid === input.txid &&
        session.input?.vout === input.vout
      ) {
        if (session.stage === "failed") {
          const failure = classifyRenewalRouteFailure(session.error);
          if (failure.signer && session.renewalSignerPubkey) signers.add(session.renewalSignerPubkey);
          if (failure.delegate && session.delegate?.pubkey) delegates.add(session.delegate.pubkey);
        }
        if (delegatedAuthorizationExpired(session) && session.delegate?.pubkey) {
          delegates.add(session.delegate.pubkey);
        }
      }
    } catch {
      // Ignore an unrelated unreadable session; live policy checks still fail closed.
    }
  }
  return { signers, delegates };
};

const quote = (
  info: Awaited<ReturnType<RestArkProvider["getInfo"]>>,
  input: VirtualCoin,
  delegate: DelegateStatus,
  delegateAt: Date,
) => {
  const atSeconds = delegateAt.getTime() / 1_000;
  const estimator = new Estimator({
    ...info.fees.intentFee,
    offchainInput: info.fees.intentFee.offchainInput?.replace("now()", `double(${atSeconds})`),
    offchainOutput: info.fees.intentFee.offchainOutput?.replace("now()", `double(${atSeconds})`),
  });
  const inputFee = estimator.evalOffchainInput({
    amount: BigInt(input.value),
    type: "vtxo",
    weight: 0,
    birth: input.createdAt,
    expiry: input.expiresAt,
  }).satoshis;
  const delegateOutputFee = delegate.feeSats > 0
    ? estimator.evalOffchainOutput({
        amount: BigInt(delegate.feeSats),
        script: hex.encode(ArkAddress.decode(delegate.address).pkScript),
      }).satoshis
    : 0;
  const successorValue = input.value - inputFee - delegateOutputFee - delegate.feeSats;
  return { successorValue, feeSats: input.value - successorValue };
};

const reconcileJournal = async (
  mandate: SignedRenewalMandate,
  journalPath: string,
  coins: VirtualCoin[],
  signerIdentities: Map<string, MnemonicIdentity>,
) => {
  const journal = readJson<RenewalJournal>(journalPath);
  const history = deriveRenewalHistory(mandate, journal);
  const current = coins.find((coin) => outpoint(coin) === outpoint(history.currentOutpoint));
  if (current && !current.isSpent && !current.isSwept) return journal;
  const authorization = priorAuthorization(mandate.terms.contractId, history.currentOutpoint);
  if (!authorization || authorization.stage !== "completed") return journal;
  const priorInput = current ?? {
    txid: authorization.input?.txid,
    vout: authorization.input?.vout,
    value: authorization.input?.value,
    expiresAt: authorization.input?.expiresAt ? new Date(authorization.input.expiresAt) : undefined,
  };
  const candidates = unspent(coins)
    .filter((coin) => coin.expiresAt && priorInput.expiresAt && coin.expiresAt.getTime() > priorInput.expiresAt.getTime())
    .sort((a, b) => b.expiresAt!.getTime() - a.expiresAt!.getTime());
  const successor = candidates[0];
  if (!successor || !successor.expiresAt || !priorInput.expiresAt) return journal;
  const signer = signerIdentities.get(authorization.renewalSignerPubkey);
  if (!signer) throw new Error("Renewal receipt signer is unavailable");
  const receiptTerms = {
    version: 1 as const,
    mandateId: mandate.mandateId,
    sequence: journal.receipts.length + 1,
    input: {
      txid: priorInput.txid,
      vout: priorInput.vout,
      value: priorInput.value,
      expiresAt: priorInput.expiresAt.toISOString(),
    },
    successor: {
      txid: successor.txid,
      vout: successor.vout,
      value: successor.value,
      expiresAt: new Date(successor.expiresAt).toISOString(),
      address: mandate.terms.escrowAddress,
      script: mandate.terms.escrowScript,
    },
    feeSats: priorInput.value - successor.value,
    signerPubkey: authorization.renewalSignerPubkey,
    delegatePubkey: authorization.delegate.pubkey,
    commitmentTxid: successor.settledBy || successor.commitmentTxIds?.[0] || authorization.result?.commitmentTxid,
    completedAt: new Date().toISOString(),
  };
  if (!receiptTerms.commitmentTxid) throw new Error("Indexed renewal successor lacks commitment proof");
  const receipt: SignedRenewalReceipt = {
    ...receiptTerms,
    signature: hex.encode(await signer.signMessage(renewalReceiptDigest(receiptTerms), "schnorr")),
  };
  const next = { ...journal, receipts: [...journal.receipts, receipt] };
  deriveRenewalHistory(mandate, next);
  writeRenewalJournalAtomic(journalPath, next);
  return next;
};

const supervise = async (contractPath: string, contract: HardenedContract) => {
  if (contract.scriptVersion !== 6) {
    return {
      contractId: contract.contractId,
      state: "manual-recovery-required",
      reason: "This alpha script is rejected by the stock arkd closure parser",
    };
  }
  const mandate = verifySignedRenewalMandate(readJson<SignedRenewalMandate>(contract.hardenedRenewal.mandatePath));
  if (mandate.mandateId !== contract.hardenedRenewal.mandateId) throw new Error("Contract mandate binding changed");
  const arkProvider = new RestArkProvider(contract.serviceUrl);
  const indexer = new RestIndexerProvider(contract.serviceUrl);
  const info = await arkProvider.getInfo();
  if (info.network !== "bitcoin" || info.version !== mandate.terms.arkServerVersion) throw new Error("Arkade operator version changed");
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  if (hex.encode(serverPubkey) !== mandate.terms.arkServerPubkey) throw new Error("Arkade operator identity changed");
  const built = buildWardenScript({
    buyerPubkey: hex.decode(contract.buyerPubkey),
    sellerPubkey: hex.decode(contract.sellerPubkey),
    arbiterPubkey: hex.decode(contract.arbiterPubkey),
    serverPubkey,
    refundAt: contract.refundAt,
    renewalPubkeys: contract.hardenedRenewal.renewalPubkeys.map(hex.decode),
    delegatePubkeys: contract.hardenedRenewal.delegatePubkeys.map(hex.decode),
    delegateApproval: "bounded-renewal-key",
    exitDelaySeconds: contract.exitDelaySeconds,
  });
  assertStockArkdWardenScript(built, {
    serverPubkey,
    minimumExitDelaySeconds: contract.exitDelaySeconds,
  });
  if (
    built.script.address(networks.bitcoin.hrp, serverPubkey).encode() !== contract.escrowAddress ||
    hex.encode(built.script.pkScript) !== contract.escrowScript ||
    built.script.exitPaths().length < 3
  ) throw new Error("Hardened contract failed deterministic stock-script validation");
  const { vtxos: coins } = await indexer.getVtxos({ scripts: [contract.escrowScript] });
  const spendable = unspent(coins);
  if (spendable.length === 0 && coins.length === 0) return { contractId: contract.contractId, state: "awaiting-funding" };
  if (spendable.length > 1) throw new Error("Hardened escrow has multiple spendable VTXOs; manual consolidation required");

  const primary = keychainIdentity("renewal");
  const recovery = keychainIdentity("renewal-recovery");
  const signerIdentities = new Map<string, MnemonicIdentity>([
    [hex.encode(await primary.xOnlyPublicKey()), primary],
    [hex.encode(await recovery.xOnlyPublicKey()), recovery],
  ]);
  const journalPath = resolve(journalsDirectory, `${mandate.mandateId}.json`);
  if (!existsSync(journalPath)) {
    const first = spendable[0];
    if (!first) return { contractId: contract.contractId, state: "manual-recovery-required" };
    writeRenewalJournalAtomic(journalPath, {
      schemaVersion: 1,
      mandateId: mandate.mandateId,
      initialOutpoint: { txid: first.txid, vout: first.vout },
      receipts: [],
    });
  }
  const journal = await reconcileJournal(mandate, journalPath, coins, signerIdentities);
  const history = deriveRenewalHistory(mandate, journal);
  const input = spendable.find((coin) => outpoint(coin) === outpoint(history.currentOutpoint));
  if (!input || !input.expiresAt) return { contractId: contract.contractId, state: "awaiting-indexed-successor" };
  const exitBundle: UnilateralExitBundle = {
    schemaVersion: 3,
    mandateId: mandate.mandateId,
    contractId: contract.contractId,
    arkServerUrl: contract.serviceUrl,
    arkServerPubkey: contract.serverPubkey,
    network: "bitcoin",
    currentVtxo: {
      txid: input.txid,
      vout: input.vout,
      value: input.value,
      expiresAt: input.expiresAt.toISOString(),
      tapTree: hex.encode(built.script.encode()),
      script: contract.escrowScript,
    },
    exitPaths: built.exitPaths.map(hex.encode),
    recoveryModel: "operator-independent-two-party-stock-exit",
    participantKeys: [contract.buyerPubkey, contract.sellerPubkey, contract.arbiterPubkey],
    updatedAt: new Date().toISOString(),
  };
  assertUnilateralExitBundle(mandate, exitBundle);
  writeJsonAtomic(resolve(exitBundlesDirectory, `${mandate.mandateId}.json`), exitBundle);
  const decision = renewalDecision(
    {
      version: 1,
      contractId: mandate.terms.contractId,
      escrowAddress: mandate.terms.escrowAddress,
      buyerPubkey: mandate.terms.buyerPubkey,
      sellerPubkey: mandate.terms.sellerPubkey,
      renewalPubkey: mandate.terms.renewalSigners[0].pubkey,
      delegatePubkey: mandate.terms.delegates[0].pubkey,
      finalAt: mandate.terms.finalAt,
      triggerBeforeExpirySeconds: mandate.terms.triggerBeforeExpirySeconds,
      manualFallbackAfterSeconds: mandate.terms.manualFallbackAfterSeconds,
      maxFeePerRolloverSats: mandate.terms.maxFeePerRolloverSats,
      maxTotalFeeSats: mandate.terms.maxTotalFeeSats,
      maxRenewals: mandate.terms.maxRenewals,
      exactSuccessorAddress: true,
      preserveParties: true,
      paused: false,
    },
    history,
    new Date(input.expiresAt).toISOString(),
  );
  const runActivationTest = activationTest || (contract.hardenedRenewal.activationTest === true && history.completedRenewals === 0);
  if (!runActivationTest && decision.action !== "schedule") return { contractId: contract.contractId, state: decision.action, reason: decision.reason };
  if (priorAuthorization(contract.contractId, input)) return { contractId: contract.contractId, state: "already-authorized" };

  const failed = failedRoutes(contract.contractId, input);
  const signer = selectRenewalSigner(
    mandate,
    Object.fromEntries([...signerIdentities.keys()].map((key) => [key, !failed.signers.has(key)])),
  );
  if (!signer) return { contractId: contract.contractId, state: "manual-recovery-required", reason: "No approved renewal signer is available" };
  const statuses = await Promise.all(mandate.terms.delegates.map(({ url }) => delegateStatus(url)));
  const selectedDelegate = selectRenewalDelegate(
    mandate,
    Object.fromEntries(statuses.map((status) => [status.pubkey, status.online && !failed.delegates.has(status.pubkey)])),
  );
  const delegate = statuses.find((status) => status.pubkey === selectedDelegate?.pubkey);
  if (!delegate || !delegate.online) return { contractId: contract.contractId, state: "manual-recovery-required", reason: "No approved delegate is available" };
  const delegateAt = new Date(Date.now() + 90_000);
  const fee = quote(info, input, delegate, delegateAt);
  if (fee.successorValue < Number(info.dust)) throw new Error("Renewal successor would be below Arkade dust");
  const now = new Date();
  const session: BoundedSession = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    contractId: contract.contractId,
    contractPath,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
    stage: "queued",
    input: { txid: input.txid, vout: input.vout, value: input.value, expiresAt: new Date(input.expiresAt).toISOString() },
    successor: { address: contract.escrowAddress, value: fee.successorValue, refundAt: mandate.terms.finalAt },
    quotedFeeSats: fee.feeSats,
    maxFeeSats: mandate.terms.maxFeePerRolloverSats,
    execution: "bounded-renewal-stock-batch",
    automaticExecution: true,
    activationTest: runActivationTest,
    requiredApprovals: ["buyer-and-seller-renewal-mandate"],
    mandatePath: contract.hardenedRenewal.mandatePath,
    journalPath,
    renewalSignerPubkey: signer.pubkey,
    delegate: {
      url: delegate.url,
      pubkey: delegate.pubkey,
      feeSats: delegate.feeSats,
      delegateAt: delegateAt.toISOString(),
      authorizationExpiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
    },
    events: [{ at: now.toISOString(), type: "bounded-renewal-scheduled" }],
  };
  writeJsonAtomic(resolve(sessionsDirectory, `${session.sessionId}.json`), session);
  const log = resolve(sessionsDirectory, `${session.sessionId}.log`);
  const logFd = openSync(log, "wx", 0o600);
  const child = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), workerPath, session.sessionId], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();
  return { contractId: contract.contractId, state: "scheduled", sessionId: session.sessionId, signer: signer.role, delegatePriority: selectedDelegate?.priority };
};

const checkedAt = new Date().toISOString();
const results = [];
for (const name of (existsSync(contractsDirectory) ? readdirSync(contractsDirectory) : []).filter((value) => value.startsWith("warden-hardened-") && value.endsWith(".json"))) {
  const path = resolve(contractsDirectory, name);
  const record = readJson<HardenedContract>(path);
  if (record.schemaVersion !== 6 || basename(path) === "active.json") continue;
  try {
    results.push(await supervise(path, record));
  } catch (error) {
    results.push({ contractId: record.contractId, state: "failed-safe", error: error instanceof Error ? error.message : String(error) });
  }
}
const report = { schemaVersion: 1, checkedAt, results };
writeJsonAtomic(supervisorStatusPath, report);
console.log(JSON.stringify(report));
