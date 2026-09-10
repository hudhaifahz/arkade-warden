import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MnemonicIdentity, RestArkProvider, networks } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { boundedRenewalCap } from "./renewal-policy.js";
import {
  renewalMandateDigest,
  renewalMandateId,
  verifySignedRenewalMandate,
  type RenewalDelegate,
  type RenewalMandateTerms,
  type SignedRenewalMandate,
} from "./renewal-mandate.js";
import { buildWardenScript } from "./warden-script.js";
import { assertStockArkdWardenScript } from "./stock-arkd-closures.js";

type BuyerBinding = {
  schemaVersion: 1;
  buyerPubkey: string;
  buyerArkadeAddress: string;
  serverPubkey: string;
  registeredAt: string;
};

type DraftSession = {
  schemaVersion: 1;
  sessionId: string;
  stage: "awaiting-buyer-approval";
  createdAt: string;
  expiresAt: string;
  expectedAmountSats: number;
  durationSeconds: number;
  label: string;
  terms: RenewalMandateTerms;
  sellerApproval: { pubkey: string; signature: string };
};

const root = resolve(process.env.ESCROW_ROOT ?? process.cwd());
const arkServerUrl = process.env.ARKADE_URL ?? "http://127.0.0.1:7270";
const primaryDelegateUrl = process.env.FULMINE_DELEGATE_URL ?? "http://127.0.0.1:7372";
const backupDelegateUrl = process.env.FULMINE_BACKUP_DELEGATE_URL ?? "http://127.0.0.1:7472";
const bindingPath = resolve(root, "bindings/mobile-buyer.json");
const draftsDirectory = resolve(root, "mandate-sessions");
const mandatesDirectory = resolve(root, "renewal-mandates");
const contractsDirectory = resolve(root, "contracts");

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJsonAtomic = (path: string, value: unknown, exclusive = false) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};

const account = process.env.USER;
if (!account) throw new Error("USER is unavailable");
const keychainIdentity = (role: "seller" | "arbiter" | "renewal" | "renewal-recovery") => {
  const mnemonic = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", `frontiercrown.arkade.mainnet.escrow.${role}`, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  return MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: true });
};

const delegateInfo = async (url: string, priority: number, maxFeeSats: number): Promise<RenewalDelegate> => {
  const response = await fetch(`${url}/v1/delegate/info`);
  if (!response.ok) throw new Error(`Renewal delegate ${priority + 1} is unavailable`);
  const value = await response.json() as { pubkey?: string; fee?: string };
  const pubkey = value.pubkey?.replace(/^(02|03)/, "").toLowerCase();
  const fee = Number(value.fee);
  if (!pubkey || !Number.isSafeInteger(fee) || fee < 0 || fee > maxFeeSats) {
    throw new Error(`Renewal delegate ${priority + 1} returned invalid terms`);
  }
  return { url, pubkey, priority, maxFeeSats };
};

const payload = <T>() => {
  const encoded = process.argv[3];
  if (!encoded) throw new Error("Missing command payload");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
};

const draft = async () => {
  const request = payload<{ durationSeconds?: number; expectedAmountSats?: number; label?: string }>();
  const durationSeconds = request.durationSeconds ?? 10 * 24 * 60 * 60;
  const expectedAmountSats = request.expectedAmountSats ?? 1_000;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 8 * 24 * 60 * 60 || durationSeconds > 365 * 24 * 60 * 60) {
    throw new Error("Hardened alpha duration must be from 8 days through 12 months");
  }
  if (!Number.isSafeInteger(expectedAmountSats) || expectedAmountSats < 1_000) {
    throw new Error("Hardened alpha amount must be at least 1,000 sats");
  }
  const binding = readJson<BuyerBinding>(bindingPath);
  const [info, primaryDelegate, backupDelegate] = await Promise.all([
    new RestArkProvider(arkServerUrl).getInfo(),
    delegateInfo(primaryDelegateUrl, 0, 25),
    delegateInfo(backupDelegateUrl, 1, 25),
  ]);
  if (info.network !== "bitcoin" || info.version !== "v0.9.16") {
    throw new Error("Hardened alpha requires reviewed stock arkd v0.9.16 on Bitcoin mainnet");
  }
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  const serverPubkeyHex = hex.encode(serverPubkey);
  if (binding.serverPubkey !== serverPubkeyHex) throw new Error("Mobile buyer binding belongs to another Arkade server");
  const seller = keychainIdentity("seller");
  const arbiter = keychainIdentity("arbiter");
  const renewal = keychainIdentity("renewal");
  const renewalRecovery = keychainIdentity("renewal-recovery");
  const [sellerPubkey, arbiterPubkey, renewalPubkey, recoveryPubkey] = await Promise.all([
    seller.xOnlyPublicKey(),
    arbiter.xOnlyPublicKey(),
    renewal.xOnlyPublicKey(),
    renewalRecovery.xOnlyPublicKey(),
  ]);
  const createdAt = new Date();
  const finalAt = new Date(createdAt.getTime() + durationSeconds * 1_000);
  const exitDelaySeconds = Number(info.unilateralExitDelay);
  const built = buildWardenScript({
    buyerPubkey: hex.decode(binding.buyerPubkey),
    sellerPubkey,
    arbiterPubkey,
    serverPubkey,
    refundAt: Math.floor(finalAt.getTime() / 1_000),
    renewalPubkeys: [renewalPubkey, recoveryPubkey],
    delegatePubkeys: [hex.decode(primaryDelegate.pubkey), hex.decode(backupDelegate.pubkey)],
    delegateApproval: "bounded-renewal-key",
    exitDelaySeconds,
  });
  assertStockArkdWardenScript(built, { serverPubkey, minimumExitDelaySeconds: exitDelaySeconds });
  const terms: RenewalMandateTerms = {
    version: 1,
    purpose: "frontier-crown-warden-bounded-renewal",
    network: "bitcoin",
    contractId: randomUUID(),
    escrowAddress: built.script.address(networks.bitcoin.hrp, serverPubkey).encode(),
    escrowScript: hex.encode(built.script.pkScript),
    buyerPubkey: binding.buyerPubkey,
    sellerPubkey: hex.encode(sellerPubkey),
    arbiterPubkey: hex.encode(arbiterPubkey),
    arkServerUrl,
    arkServerPubkey: serverPubkeyHex,
    arkServerVersion: info.version,
    expectedExitDelaySeconds: exitDelaySeconds,
    finalAt: finalAt.toISOString(),
    createdAt: createdAt.toISOString(),
    triggerBeforeExpirySeconds: 72 * 60 * 60,
    manualFallbackAfterSeconds: 30 * 60,
    maxFeePerRolloverSats: 25,
    maxTotalFeeSats: boundedRenewalCap(durationSeconds) * 25,
    maxRenewals: boundedRenewalCap(durationSeconds),
    renewalSigners: [
      { pubkey: hex.encode(renewalPubkey), priority: 0, role: "primary" },
      { pubkey: hex.encode(recoveryPubkey), priority: 1, role: "recovery" },
    ],
    delegates: [primaryDelegate, backupDelegate],
    exactSuccessorAddress: true,
    preserveScript: true,
    preserveParties: true,
    requireStockExitLeaves: true,
  };
  const digest = renewalMandateDigest(terms);
  const session: DraftSession = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    stage: "awaiting-buyer-approval",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1_000).toISOString(),
    expectedAmountSats,
    durationSeconds,
    label: (request.label?.trim() || "Hardened rollover alpha").slice(0, 80),
    terms,
    sellerApproval: {
      pubkey: hex.encode(sellerPubkey),
      signature: hex.encode(await seller.signMessage(digest, "schnorr")),
    },
  };
  if (process.env.HARDENED_DRAFT_DRY_RUN !== "true") {
    writeJsonAtomic(resolve(draftsDirectory, `${session.sessionId}.json`), session, true);
  }
  return {
    sessionId: session.sessionId,
    digest: hex.encode(digest),
    expiresAt: session.expiresAt,
    summary: {
      network: terms.network,
      amountSats: expectedAmountSats,
      durationSeconds,
      finalAt: terms.finalAt,
      maxRenewals: terms.maxRenewals,
      maxFeePerRolloverSats: terms.maxFeePerRolloverSats,
      maxTotalFeeSats: terms.maxTotalFeeSats,
      signerCount: terms.renewalSigners.length,
      delegateCount: terms.delegates.length,
      recoveryModel: "operator-independent-two-party-stock-exit",
      escrowAddress: terms.escrowAddress,
    },
  };
};

const approve = async () => {
  const request = payload<{ sessionId?: string; buyerSignature?: string }>();
  if (!request.sessionId || !/^[0-9a-f-]{36}$/i.test(request.sessionId)) throw new Error("Invalid mandate session");
  if (!request.buyerSignature || !/^[0-9a-f]{128}$/i.test(request.buyerSignature)) throw new Error("Invalid buyer mandate signature");
  const sessionPath = resolve(draftsDirectory, `${request.sessionId}.json`);
  const session = readJson<DraftSession>(sessionPath);
  if (session.sessionId !== request.sessionId || session.stage !== "awaiting-buyer-approval") throw new Error("Mandate session changed");
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("Mandate approval session expired");
  const mandate: SignedRenewalMandate = {
    mandateId: renewalMandateId(session.terms),
    terms: session.terms,
    approvals: {
      buyer: { pubkey: session.terms.buyerPubkey, signature: request.buyerSignature },
      seller: session.sellerApproval,
    },
  };
  verifySignedRenewalMandate(mandate);
  const mandatePath = resolve(mandatesDirectory, `${mandate.mandateId}.json`);
  writeJsonAtomic(mandatePath, mandate, true);
  const record = {
    schemaVersion: 6,
    scriptVersion: 6,
    contractId: session.terms.contractId,
    createdAt: session.terms.createdAt,
    label: session.label,
    durationLabel: `${Math.round(session.durationSeconds / 86_400)}-day hardened alpha`,
    expectedAmountSats: session.expectedAmountSats,
    serviceUrl: session.terms.arkServerUrl,
    network: session.terms.network,
    serverPubkey: session.terms.arkServerPubkey,
    buyerPubkey: session.terms.buyerPubkey,
    buyerControl: "mobile-wallet",
    buyerArkadeAddress: readJson<BuyerBinding>(bindingPath).buyerArkadeAddress,
    sellerPubkey: session.terms.sellerPubkey,
    arbiterPubkey: session.terms.arbiterPubkey,
    refundLockType: "time",
    refundAt: Math.floor(Date.parse(session.terms.finalAt) / 1_000),
    escrowAddress: session.terms.escrowAddress,
    escrowScript: session.terms.escrowScript,
    exitDelaySeconds: session.terms.expectedExitDelaySeconds,
    rolloverRequired: true,
    lifecycle: "open",
    rolloverPolicy: {
      mode: "bounded-renewal-mandate",
      warningThresholdSeconds: session.terms.triggerBeforeExpirySeconds,
      automaticExecution: true,
      preserveContractScript: true,
    },
    hardenedRenewal: {
      mandateId: mandate.mandateId,
      mandatePath,
      maxRenewals: session.terms.maxRenewals,
      finalAt: session.terms.finalAt,
      renewalPubkeys: session.terms.renewalSigners.map(({ pubkey }) => pubkey),
      delegatePubkeys: session.terms.delegates.map(({ pubkey }) => pubkey),
      state: "approved-awaiting-funding",
      activationTest: true,
    },
  };
  const contractPath = resolve(contractsDirectory, `warden-hardened-${Date.now()}-${record.contractId}.json`);
  writeJsonAtomic(contractPath, record, true);
  return { approved: true, mandateId: mandate.mandateId, contractPath, contract: record };
};

const supervise = () => {
  const executable = resolve(root, "node_modules/tsx/dist/cli.mjs");
  return JSON.parse(execFileSync(process.execPath, [executable, resolve(root, "renewal-supervisor.ts")], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  })) as unknown;
};

const command = process.argv[2];
const result = command === "draft"
  ? await draft()
  : command === "approve"
    ? await approve()
    : command === "supervise"
      ? supervise()
      : undefined;
if (!result) throw new Error("Use hardened-contract draft, approve, or supervise");
console.log(JSON.stringify(result));
