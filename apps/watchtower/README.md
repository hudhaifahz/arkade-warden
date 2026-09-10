# Arkade renewal watchtower

This is a remote, watch-only companion for long-lived Arkade escrow contracts.
It can query a public Arkade indexer directly, or accept a scoped outbound
heartbeat from a private home node. It raises a private Nostr message or
webhook alert when renewal is due, the home service is offline, value changes
unexpectedly, or expiry recovery is required.

It must never receive wallet seeds, signing keys, admin credentials, macaroons,
or operator passwords. It cannot renew, release, refund, or redirect funds.

## Configuration

- `ARKADE_URL`: optional public Arkade server URL. Omit it for heartbeat mode.
- `WATCH_ENTRIES_JSON`: JSON array of public watch descriptors. Each entry uses
  `id`, `contractId`, hex `script`, ISO `finalAt`, optional
  `expectedValueSats`, and optional `healthUrl`.
- `ALERT_WEBHOOK_URL`: optional HTTPS webhook for phone notifications.
- `ALERT_WEBHOOK_BEARER`: optional webhook credential.
- `NOSTR_RECIPIENT_NPUB`: recipient npub for private NIP-17 messages.
- `NOSTR_PRIVATE_KEY`: dedicated watchtower-bot private key in 64-character hex.
  Generate a new key for this service; never use a personal Nostr key.
- `NOSTR_RELAYS`: comma-separated NIP-17 inbox relays from the recipient's
  kind `10050` event.
- `INGEST_TOKEN`: required in heartbeat mode; use at least 32 random characters.
- `STATUS_TOKEN`: optional bearer token protecting `/status`.
- `STATE_PATH`: optional persisted heartbeat file, such as `/data/state.json`.
- `HEARTBEAT_STALE_MS`: defaults to 15 minutes.
- `POLL_INTERVAL_MS`: defaults to five minutes.
- `ALERT_COOLDOWN_MS`: defaults to one hour for unchanged alerts.

`/healthz` reports process liveness. `/status` reports the last watch result.
In heartbeat mode, run `npm run heartbeat` on the private node with
`ARKADE_URL`, `INGEST_URL`, and the same `INGEST_TOKEN`. Set `ESCROW_ROOT` to
discover funded contracts automatically, or provide `WATCH_ENTRIES_JSON`.
Do not put confidential customer or contract metadata in watch labels.

For hardened Warden contracts, the home heartbeat also sends only public,
opaque status: supervisor freshness/state, bounded-renewal count, signer count,
delegate availability, and recovery-metadata freshness. The Railway service
still receives no participant, operator, renewal, or delegate spending key.
