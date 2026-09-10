import assert from "node:assert/strict";
import test from "node:test";
import { createNostrNotifier, formatWatchtowerAlert, parseRelays } from "../src/nostr-alert.js";

test("requires encrypted-alert relays to use secure WebSockets", () => {
  assert.deepEqual(parseRelays(" wss://one.example, wss://two.example,wss://one.example "), [
    "wss://one.example",
    "wss://two.example",
  ]);
  assert.throws(() => parseRelays("ws://insecure.example"), /must use wss/);
});

test("formats an actionable alert without exposing a script or address", () => {
  const message = formatWatchtowerAlert({
    id: "escrow-a1b2",
    status: "critical",
    totalSats: 1_000,
    earliestExpiry: "2026-09-10T12:00:00.000Z",
    finalAt: "2026-10-01T12:00:00.000Z",
    findings: [{ code: "home-offline", message: "Home heartbeat is stale" }],
  }, "2026-09-09T12:00:00.000Z");
  assert.match(message, /CRITICAL/);
  assert.match(message, /1,000 sats/);
  assert.match(message, /home-offline/);
  assert.doesNotMatch(message, /ark1|script/i);
});

test("gift-wraps an alert and succeeds when at least one inbox relay accepts it", async () => {
  let published;
  const pool = {
    publish(relays, event) {
      published = { relays, event };
      return [Promise.resolve("ok"), Promise.reject(new Error("offline"))];
    },
    destroy() {},
  };
  const notifier = createNostrNotifier({
    recipient: "npub1p2ehwtdsz3axv7sppsg0zl02zawwfp9pvpgvk8psldrzcx8fkk7s5uwwhy",
    privateKey: "01".padStart(64, "0"),
    relays: "wss://one.example,wss://two.example",
    pool,
  });
  const result = await notifier.send("test alert");
  assert.equal(published.event.kind, 1059);
  assert.equal(published.event.tags[0][0], "p");
  assert.deepEqual(result.acceptedRelays, ["wss://one.example"]);
});
