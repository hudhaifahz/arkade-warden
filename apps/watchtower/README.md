# Arkade renewal watchtower

This is a remote, watch-only companion for long-lived Arkade escrow contracts.
It checks public Arkade index data and a home-service health endpoint, then
raises a webhook alert when renewal is due, the home service is offline, value
changes unexpectedly, or expiry recovery is required.

It must never receive wallet seeds, signing keys, admin credentials, macaroons,
or operator passwords. It cannot renew, release, refund, or redirect funds.

## Configuration

- `ARKADE_URL`: public Arkade server URL.
- `WATCH_ENTRIES_JSON`: JSON array of public watch descriptors. Each entry uses
  `id`, `contractId`, hex `script`, ISO `finalAt`, optional
  `expectedValueSats`, and optional `healthUrl`.
- `ALERT_WEBHOOK_URL`: optional HTTPS webhook for phone notifications.
- `ALERT_WEBHOOK_BEARER`: optional webhook credential.
- `POLL_INTERVAL_MS`: defaults to five minutes.
- `ALERT_COOLDOWN_MS`: defaults to one hour for unchanged alerts.

`/healthz` reports process liveness. `/status` reports the last public watch
result. Do not put confidential customer or contract metadata in watch labels.
