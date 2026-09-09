# Frontier Crown Arkade Renewal Watchtower

## Outcome

Long escrows present one final date to the buyer and seller. Stock Arkade VTXOs
continue to renew underneath that agreement until the final date is covered.
Users should not have to understand or schedule the roughly seven-day VTXO
lifecycle.

## Renewal mandate

Both parties approve a bounded mandate when a long escrow is created. It binds:

- the exact escrow contract, address, parties, and final date;
- a dedicated renewal-only public key held in the Mac Keychain;
- the approved Fulmine delegate;
- the exact successor address;
- per-renewal and cumulative fee ceilings;
- a maximum renewal count derived from the escrow duration;
- pause and revoke controls.

The automatic signer must refuse releases, refunds, changed destinations,
changed parties, fee-cap increases, renewals after the final date is covered,
and unrelated transactions. Manual buyer-and-seller rollover remains available
from the mobile wallet at all times.

## Redundancy timeline

1. At 72 hours before VTXO expiry, the Mac prepares and submits a constrained
   renewal to Fulmine.
2. If no exact successor is indexed within 30 minutes, the owner is notified to
   use the phone-signed rollover.
3. At 24 hours remaining, the alert becomes critical and stays visible until a
   successor or recovery transaction is verified.
4. If the VTXO expires, the existing stock recovery path remains available.

## Watchtower boundary

The future remote watchtower is watch-only. It receives contract ID, public
script/address, final date, expected value, public outpoint, and alert routing.
It receives no wallet seed, renewal key, buyer key, seller key, macaroon, or
operator password.

It checks the public Arkade indexer and the Frontier Crown health endpoint every
five minutes. It alerts on an offline Mac, a missed renewal, destination/value
drift, a fee-policy breach, or entry into the 24-hour critical window. It cannot
renew, release, refund, or redirect funds.

## Test gates

- Unit-test final-date, fee, count, pause, and fallback decisions.
- Fund a fresh 1,000-sat long-duration test escrow.
- Prove one renewal using the dedicated key without a phone signature.
- Prove that changed destination, amount, parties, fee, and final date are rejected.
- Stop the local renewal service and prove the remote watchtower raises a phone
  fallback alert.
- Complete a phone-signed fallback rollover and verify the exact successor.
- Only then enable bounded renewal by default for new long escrows.
