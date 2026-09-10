# Hardened bounded renewals

## Alpha boundary

This is mainnet-alpha software. Use only a deliberately small escrow whose loss
would be acceptable. The existing funded Warden contracts are not migrated or
modified by this feature.

Stock Arkade cannot pre-sign a transaction spending a future VTXO because that
VTXO's outpoint does not exist yet. Warden therefore separates two approvals:

1. the buyer and seller sign one long-lived, bounded Warden mandate;
2. the renewal signer creates each exact stock Arkade intent only after the
   current VTXO exists.

The mandate is enforced by the Warden signer, not by `arkd`. The stock server
continues to validate ordinary intents, forfeits, batch transactions, and exit
closures without any patch.

## Mandate invariants

The signed mandate fixes:

- Bitcoin mainnet, reviewed `arkd` version, operator URL and signer public key;
- contract ID, Arkade address, output script, buyer, seller, and arbiter;
- final escrow timestamp and stock unilateral-exit delay;
- approved primary/recovery renewal public keys;
- approved primary/backup Fulmine delegate identities and endpoints;
- maximum renewals, maximum fee per renewal, and maximum cumulative fees;
- exact successor address and script, unchanged parties, and required stock
  exit leaves.

Hardened script version 5 also adds a stock-recognized conditional CSV exit for
the buyer alone. It can be spent only after both the signed escrow final time
and Arkade's advertised unilateral-exit delay. This preserves escrow before the
deadline while removing the operator, seller, arbiter, renewal signer, and
delegate from the buyer's final recovery path.

Every renewal conserves value exactly: `successor = input - approved fee`.
There is no general-purpose send capability in the supervisor.

## Durable state and replay protection

The counter is reconstructed from an append-only journal of signed renewal
receipts. Each receipt binds the consumed outpoint, successor outpoint, values,
expiry extension, commitment transaction, signer, delegate, and sequence. A
stale or repeated input, broken successor chain, invalid receipt signature, or
changed destination fails closed.

## Failure behavior

- Primary signer failure: retry the same input with the approved recovery
  signer.
- Primary delegate failure: retry the same terms with the approved backup
  delegate.
- Both delegates unavailable: stop and request manual recovery; never relax the
  mandate.
- Operator unavailable: do not sign. Alert the parties and move to the stock
  unilateral-exit recovery plan.
- Supervisor restart: reconstruct the current outpoint, count, and cumulative
  fees from the signed journal before authorizing anything.
- Final escrow date covered by the current VTXO: stop renewing.

The two local Fulmine instances provide process-level delegate redundancy, not
Mac-level or operator-level high availability. The Railway watchtower now
checks the local heartbeat, supervisor freshness, both delegate identities,
renewal count, VTXO value/expiry, and recovery-metadata freshness without any
spending key. A production deployment still needs a second operator deployment
strategy and a participant-held, tested unilateral-exit package.

## Mainnet-alpha test

The mobile owner UI can create an isolated 10-day, 1,000-sat contract. Creation
moves no sats. The buyer reviews and signs the mandate once; the seller approval
is signed by the configured Keychain identity. The contract includes two
renewal signer routes, two delegate routes, three two-party stock exit closures,
and one buyer-only final recovery closure.

Do not fund the alpha address until the dashboard shows the approved contract,
the mandate ID, two signers, two delegates, and the fixed final date. A funded
multi-renewal test is not complete until the indexer proves each predecessor was
consumed and each successor has a later Arkade expiry.

The current unilateral-exit component validates and preserves the contract,
VTXO, tap tree, and exit-path metadata. Broadcasting a fully prebuilt exit chain
from a participant-owned device remains a release gate; a metadata bundle alone
must not be described as completed unilateral-exit proof.
