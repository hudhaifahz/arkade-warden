import { createNostrNotifier } from "./nostr-alert.js";

const notifier = createNostrNotifier({
  recipient: process.env.NOSTR_RECIPIENT_NPUB,
  privateKey: process.env.NOSTR_PRIVATE_KEY,
  relays: process.env.NOSTR_RELAYS,
});

try {
  const result = await notifier.send(
    `Frontier Crown Arkade watchtower test\nNostr alerts are connected. No action is required.\nSent: ${new Date().toISOString()}\nBot: ${notifier.senderNpub}`,
  );
  console.log(JSON.stringify({ event: "nostr-test-alert-sent", senderNpub: notifier.senderNpub, acceptedRelays: result.acceptedRelays }));
} finally {
  notifier.close();
}
