# Sanitized v6 mainnet-alpha proof

This document records the minimum evidence from the first funded v6 activation
without publishing wallet state, funded addresses, contract IDs, outpoints,
signatures, or participant keys.

## Observed result

- Date: 2026-09-09 Pacific / 2026-09-10 UTC.
- Network: Bitcoin mainnet.
- Operator: unmodified `arkd v0.9.16`.
- Test value: 1,000 sats.
- Script: Warden v6, preflighted as stock closure-only.
- Renewal: one automatically authorized Fulmine stock-batch rollover.
- Fee: 0 sats in this activation round.
- Conservation: the indexed successor remained exactly 1,000 sats.
- Expiry: the successor's indexed Arkade expiry was later than its predecessor.
- Journal: one signed receipt bound the predecessor, successor, value, expiry,
  commitment transaction, signer, delegate, and sequence.
- Supervisor after reconciliation: renewal not due.
- Watchtower: accepted a fresh heartbeat covering both funded alpha escrows.

## What this proves

The v6 tree can be accepted by the reviewed stock parser, funded as a custom
VTXO, consumed through the ordinary stock batch path, and replaced at the exact
same Warden address under the signed mandate.

## What this does not prove

- production safety or economic security;
- several consecutive renewals across the full contract term;
- successful recovery from a participant-owned device during operator outage;
- availability under public load or hostile traffic;
- compatibility with later arkd releases;
- independent code audit.

The detailed live artifacts remain private. Public fixtures and tests use
synthetic identifiers so copying this repository cannot identify or target a
funded contract.
