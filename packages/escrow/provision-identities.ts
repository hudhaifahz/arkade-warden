import { execFileSync } from "node:child_process";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const confirmation = process.env.CONFIRM_MAINNET_KEY_PROVISION;
if (confirmation !== "I_UNDERSTAND") {
  throw new Error(
    "Refusing to create mainnet keys. Set CONFIRM_MAINNET_KEY_PROVISION=I_UNDERSTAND.",
  );
}

const account = process.env.USER;
if (!account) throw new Error("USER is unavailable");

const services = [
  "frontiercrown.arkade.mainnet.escrow.buyer",
  "frontiercrown.arkade.mainnet.escrow.seller",
  "frontiercrown.arkade.mainnet.escrow.arbiter",
  "frontiercrown.arkade.mainnet.escrow.renewal",
];

for (const service of services) {
  try {
    execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      "-w",
    ], { stdio: "ignore" });
    continue;
  } catch {
    // Missing is expected on the first run.
  }

  const mnemonic = generateMnemonic(wordlist, 256);
  execFileSync("/usr/bin/security", [
    "add-generic-password",
    "-a",
    account,
    "-s",
    service,
    "-w",
    mnemonic,
  ], { stdio: "ignore" });
}

console.log(JSON.stringify({ provisioned: true, identities: services.length }));
