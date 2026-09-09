# Arkade Warden

Arkade Warden is an experimental, Bitcoin-native escrow and renewal toolkit for
Arkade. It combines stock-compatible VTXO scripts, explicit mobile signatures,
bounded rollover policy, expiry recovery, an owner gateway, and a remote
watch-only service for missed-renewal alerts.

This repository contains source and reproducible policy tests only. It does not
contain funded contract records, wallet state, outpoints, browser wallets,
operator data, passwords, or signing keys.

## Repository map

- `packages/escrow`: Warden scripts, mobile signing, funding rules, rollover,
  recovery, bounded-renewal policy, and tests.
- `apps/watchtower`: Railway-ready watch-only monitoring service.
- `apps/home-gateway`: authenticated loopback gateway for a home Arkade server.
- `apps/cloudflare-edge`: optional private HTTPS edge proxy.
- `wallet-extension`: Warden screen and small integration patch for the MIT
  Arkade wallet at the pinned upstream commit documented there.
- `docs`: rollover operations and watchtower product requirements.

## Safety boundary

This is alpha software and not a custody product. Start with a disposable test
amount. Keep operator and participant keys on their intended devices. The
watchtower observes only public script and expiry data; it cannot spend.

See each package README for setup and testing. The project is licensed under
MIT to remain compatible with the upstream Arkade wallet.
