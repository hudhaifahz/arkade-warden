# Community Arkade node

An Arkade wallet connects to an operator's public arkd URL. The operator
coordinates offchain transactions and provides batch liquidity; wallet users
keep their own keys. Arkade remains alpha software, and operator availability,
liquidity, fees, batch timing, and recovery readiness still matter.

## Frontier Crown alpha endpoint

Server URL:

```text
https://frontier-crown-arkade-community.hudhaifahz.workers.dev
```

This endpoint is intended for disposable, small-value experiments. It has no
uptime, liquidity, fee, support, or backward-compatibility guarantee. Check
`/v1/info` before connecting and independently verify that it reports Bitcoin
mainnet and the operator identity you expect.

It is served from a home operator. If the Mac, arkd, home connection, or tunnel
is unavailable, wallets cannot use the operator until service returns; keep
participant-controlled recovery data current.

The private owner console is a different service. Community users never need
an owner token and should never be asked for a seed, mnemonic, private key,
browser wallet database, or remote-control access.

## Connect a wallet

In an Arkade wallet that supports custom operators:

1. choose **Connect to server** or **Custom server**;
2. paste the server URL above exactly;
3. confirm the wallet reports Bitcoin mainnet;
4. create or restore the wallet locally on your own device;
5. back it up before receiving funds;
6. start with the minimum disposable amount.

The official Arkade CLI uses the same base URL:

```sh
ark init --password '<choose-locally>' \
  --server-url https://frontier-crown-arkade-community.hudhaifahz.workers.dev
```

Enter passwords interactively where supported so they do not remain in shell
history. Never send a mnemonic to the operator.

## What connecting provides

- the stock arkd public wallet API;
- receiving, sending, settlement, and exit behavior supported by the connected
  wallet and this pinned operator version;
- the operator's current liquidity and batch coordination.

It does not automatically install the Warden escrow interface, join a federation
of operators, provide Lightning swaps, or grant access to private operator
controls. Developers who want Warden v6 must integrate the wallet extension or
use the escrow package against their own reviewed deployment.

## Operator deployment boundary

`apps/community-edge` is deliberately separate from `apps/cloudflare-edge`:

- community edge binds only to arkd's public port;
- only `/v1/*`, `/healthz`, and the informational root are reachable;
- `/owner`, `/admin`, and non-API paths are rejected;
- cookies and authorization headers are removed before forwarding;
- responses stream through the Worker and are never cached;
- the private arkd admin port is not attached to the service.

Before production use, add per-client rate limiting, monitor operator liquidity
and batch failures, define an incident shutdown procedure, and test that admin
and owner routes return 404 from the public hostname. The Frontier Crown
endpoint currently has method, path, and declared-request-size limits plus
Cloudflare's network protections; it does not promise per-user quotas.

Primary references:

- [arkd repository and operator warning](https://github.com/arkade-os/arkd)
- [Arkade operator role](https://docs.arkadeos.com/learn/faq/who-is-the-arkade-operator)
- [Arkade CLI custom server setup](https://github.com/arkade-os/cli)
