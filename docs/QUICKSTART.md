# Quick start

Arkade Warden is an application-layer escrow toolkit for an existing Arkade
operator. It does not install Bitcoin Core, fund an operator wallet, or turn a
machine into a production service by itself.

## Prerequisites

- an isolated test environment or deliberately tiny mainnet-alpha budget;
- stock `arkd v0.9.16` plus a funded operator wallet;
- Node.js 22 or newer;
- macOS for the included Keychain identity adapter;
- the Arkade wallet source at the commit listed in
  [`wallet-extension/README.md`](../wallet-extension/README.md) if using the
  mobile Warden screen;
- two independently reachable Fulmine delegates for automatic rollover.

Use a separate machine or regtest first. The included scripts assume a local
Arkade public API such as `http://127.0.0.1:7270`; never point the owner gateway
at arkd's private admin port.

## Install and verify

```sh
git clone https://github.com/hudhaifahz/arkade-warden.git
cd arkade-warden/packages/escrow
npm ci
npm run check
npm test
```

The tests cover exact funding, stock closure preflight, mobile signature merge,
mandate signatures, fee and renewal ceilings, replay resistance, delegate
failover, journal reconstruction, and recovery-bundle invariants.

## Configure identities

The included adapter reads five identities from the macOS login Keychain:

- buyer;
- seller;
- arbiter;
- primary renewal signer;
- recovery renewal signer.

`npm run provision` creates missing identities only after
`CONFIRM_MAINNET_KEY_PROVISION=I_UNDERSTAND` is supplied. Review that script and
establish encrypted, tested backups before using it. Do not fund an identity
that exists only in one laptop's Keychain.

For a real multi-party escrow, replace the local seller and arbiter adapters
with participant-controlled signing devices. The demonstration defaults are
not a substitute for organizational key separation.

## Run the private owner gateway

Copy `apps/home-gateway/run.example.sh`, set these values from a local secret
store, and keep the listener on loopback:

- `OWNER_CONSOLE_TOKEN`: at least 32 random characters;
- `ESCROW_DIRECTORY`: absolute path to `packages/escrow`;
- `WALLET_ORIGIN`: locally built Arkade wallet;
- `ARKADE_ORIGIN`: stock arkd public port;
- `ARKADE_ADMIN_ORIGIN`: loopback-only admin port.

The owner gateway and Warden screen are private. Do not share their URL or
access token with community wallet users.

## Create a v6 alpha contract

The Warden mobile flow performs these steps:

1. bind the buyer wallet public key and Arkade address;
2. draft a fixed-value contract and run stock-closure preflight;
3. show the final date, maximum renewals, fee ceilings, signers, delegates, and
   exact successor destination;
4. collect the buyer's mandate signature and configured seller approval;
5. return a unique Arkade funding address without moving funds;
6. require exact funding before release or automated renewal can proceed.

Fund only after checking the contract ID, parties, network, amount, final date,
and recovery model. A successful draft is not proof of a successful rollover.

## Operate renewals

Run `renewal-supervisor.ts` from a durable local scheduler. On every pass it
reconstructs the current outpoint and counters from signed receipts, checks the
stock operator identity and version, refreshes the recovery metadata, and only
then schedules an eligible renewal.

The process fails closed on changed terms, stale inputs, excessive fees,
unavailable signers/delegates, parser incompatibility, or operator outage. Pair
it with the watchtower described in `apps/watchtower/README.md`.

## Before increasing amounts

- complete multiple funded renewals rather than a single activation round;
- execute recovery from participant-held devices while the operator is down;
- test signer and delegate failover independently;
- verify backups by restoration, not inspection;
- commission an independent review of scripts and signing policy.
