import { getPublicKey, nip17, nip19, SimplePool } from "nostr-tools";

const parseRecipient = (value) => {
  if (!value) throw new Error("NOSTR_RECIPIENT_NPUB is required");
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const decoded = nip19.decode(value);
  if (decoded.type !== "npub") throw new Error("NOSTR_RECIPIENT_NPUB must be an npub or 64-character hex public key");
  return decoded.data;
};

const parsePrivateKey = (value) => {
  if (!/^[0-9a-f]{64}$/i.test(value ?? "")) {
    throw new Error("NOSTR_PRIVATE_KEY must be a 64-character hex private key");
  }
  return Buffer.from(value, "hex");
};

export const parseRelays = (value) => {
  const relays = String(value ?? "")
    .split(",")
    .map((relay) => relay.trim())
    .filter(Boolean);
  if (relays.length === 0) throw new Error("NOSTR_RELAYS must include at least one wss:// relay");
  for (const relay of relays) {
    const url = new URL(relay);
    if (url.protocol !== "wss:") throw new Error(`Nostr relay must use wss://: ${relay}`);
  }
  return [...new Set(relays)];
};

export const formatWatchtowerAlert = (report, checkedAt) => {
  const findings = report.findings.map(({ code, message }) => `- ${code}: ${message}`).join("\n");
  return [
    `Frontier Crown Arkade watchtower: ${report.status.toUpperCase()}`,
    `Escrow: ${report.id}`,
    `Checked: ${checkedAt}`,
    `Value: ${report.totalSats.toLocaleString("en-US")} sats`,
    report.earliestExpiry ? `Arkade expiry: ${report.earliestExpiry}` : undefined,
    report.finalAt ? `Escrow final date: ${report.finalAt}` : undefined,
    findings,
    "Open the Frontier Crown wallet on your phone to review. Never share a seed or private key in reply.",
  ].filter(Boolean).join("\n");
};

export const createNostrNotifier = ({ recipient, privateKey, relays, pool = new SimplePool() }) => {
  const recipientPublicKey = parseRecipient(recipient);
  const senderPrivateKey = parsePrivateKey(privateKey);
  const relayUrls = parseRelays(relays);
  const senderPublicKey = getPublicKey(senderPrivateKey);

  return {
    senderNpub: nip19.npubEncode(senderPublicKey),
    async send(message) {
      const event = nip17.wrapEvent(senderPrivateKey, { publicKey: recipientPublicKey }, message, "Arkade watchtower");
      const results = await Promise.allSettled(pool.publish(relayUrls, event, { maxWait: 12_000 }));
      const acceptedRelays = results
        .map((result, index) => ({ result, relay: relayUrls[index] }))
        .filter(({ result }) => result.status === "fulfilled")
        .map(({ relay }) => relay);
      if (acceptedRelays.length === 0) {
        const reasons = results.map((result) => result.status === "rejected" ? String(result.reason) : "unknown").join("; ");
        throw new Error(`No Nostr relay accepted the alert: ${reasons}`);
      }
      return { eventId: event.id, acceptedRelays };
    },
    close() {
      pool.destroy();
    },
  };
};
