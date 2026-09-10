# Arkade Warden v6

[![CI](https://github.com/hudhaifahz/arkade-warden/actions/workflows/ci.yml/badge.svg)](https://github.com/hudhaifahz/arkade-warden/actions/workflows/ci.yml)

Arkade Warden is an experimental, Bitcoin-native escrow and renewal toolkit for
Arkade. It combines stock-compatible VTXO scripts, explicit mobile signatures,
bounded rollover policy, expiry recovery, an owner gateway, and a remote
watch-only service with NIP-17 private messages for missed-renewal alerts.

Version 6 replaces the rejected conditional-time exit used in the earlier
prototype with closure shapes accepted by unmodified `arkd v0.9.16`. A funded
1,000-sat mainnet-alpha activation test completed one zero-fee automatic
rollover and produced an indexed successor VTXO plus a signed renewal receipt.
That is useful interoperability evidence, not a production audit.

This repository contains source and reproducible policy tests only. It does not
contain funded contract records, wallet state, outpoints, browser wallets,
operator data, passwords, or signing keys.

## Repository map

- `packages/escrow`: Warden scripts, mobile signing, funding rules, rollover,
  recovery, bounded-renewal policy, and tests.
- `apps/watchtower`: Railway-ready watch-only monitoring service.
- `apps/home-gateway`: authenticated loopback gateway for a home Arkade server.
- `apps/cloudflare-edge`: optional private HTTPS edge proxy.
- `apps/community-edge`: optional public-only proxy for ordinary Arkade wallets.
- `wallet-extension`: Warden screen and small integration patch for the MIT
  Arkade wallet at the pinned upstream commit documented there.
- `docs`: rollover operations and watchtower product requirements.

## Start here

1. Read the [quick start](docs/QUICKSTART.md).
2. Review the [v6 security and renewal model](docs/HARDENED_RENEWALS.md).
3. Inspect the [sanitized mainnet-alpha proof](docs/MAINNET_ALPHA_PROOF.md).
4. Operators considering public wallet access should read the
   [community-node guide](docs/COMMUNITY_NODE.md).

```sh
git clone https://github.com/hudhaifahz/arkade-warden.git
cd arkade-warden/packages/escrow
npm ci
npm run check
npm test
```

## Current release boundary

| Capability | v6 status |
| --- | --- |
| Stock `arkd v0.9.16` closure parsing | Verified against the stock Go parser |
| Exact-value, fixed-destination bounded mandate | Tested |
| Funded automatic stock-batch rollover | One mainnet-alpha renewal verified |
| Signed receipt and replay-safe journal reconstruction | Verified for that renewal |
| Primary/recovery signer and primary/backup delegate policy | Tested; continuing live observation |
| Participant-held recovery broadcast without the operator | Designed and metadata-validated; full device drill remains open |
| Independent audit or production readiness | Not complete |

## Safety boundary

This is alpha software and not a custody product. Start with a disposable test
amount. Keep operator and participant keys on their intended devices. The
watchtower receives only an opaque contract identifier, totals, and timing from
the private home heartbeat; it cannot spend.

See each package README for setup and testing. The project is licensed under
MIT to remain compatible with the upstream Arkade wallet.
