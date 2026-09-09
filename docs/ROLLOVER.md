# Warden rollover: stock-compatible design

## Safety boundary

The Arkade server remains the official `ghcr.io/arkade-os/arkd:v0.9.16`
image. Rollover is implemented in the Warden application and must use the
server's normal intent and batch-settlement protocol. No server validation rule
may be patched or bypassed.

## Meaning of rollover

A rollover consumes an expiring escrow VTXO in a stock Arkade batch and creates
a fresh VTXO committing to the exact same escrow script. A direct offchain Ark
transaction is not a rollover because it remains under the prior batch's
expiry.

Stock arkd also requires every batch input script to contain a CSV exit leaf.
Warden script version 2 therefore includes three operator-free, two-party exit
paths after the operator-advertised delay: buyer+seller, buyer+arbiter, and
seller+arbiter. No individual party gets a unilateral shortcut around the
escrow agreement.

The successor must preserve buyer, seller, arbiter, absolute refund timestamp,
and contract script. Value may change only for a separately displayed and
capped stock settlement fee.

## Approval policy

The first implementation is mutual:

1. the mobile buyer approves and signs the batch intent and later forfeits;
2. the seller identity in macOS Keychain approves and co-signs;
3. the operator participates through the normal stock Arkade protocol;
4. the Warden verifies the proposed batch output reproduces the original
   contract before either party completes signing.

No funded rollover runs automatically. Empty expired contracts may still rotate
to a fresh address because no value is at risk.

The automatic design uses the official Fulmine delegate rather than modifying
arkd. A managed contract commits to a separate delegate path requiring buyer,
seller, delegate, and operator signatures. Buyer and seller pre-sign the exact
intent and forfeit package; Fulmine can submit that package after its fixed
`valid_at` time but cannot change its input, output, parties, refund timestamp,
or value beyond the approved stock fee. Submission also sets the stock SDK's
`reject_replace` flag, so Fulmine must reject an attempt to replace the already
approved delegation package for that input.

## Delivered implementation

- schema 4 and 5 time-based contracts using the stock-required exit closure;
- an explicit, phone-signed migration for early funded contracts that lacked
  the exit closure, preserving their value, parties, and absolute refund time;
- 72-hour VTXO-expiry monitoring with separate contract-refund timing;
- deterministic `rollover-plan` output and invariant checks;
- refusal states for legacy contracts, empty inputs, active signing sessions,
  recovered inputs, unknown expiry, and already-unlocked refunds.
- a durable 30-minute batch session that pauses for each mobile signature;
- exact unsigned-transaction comparison before accepting a phone signature;
- local seller co-signing only after the buyer signature verifies;
- fee quote and exact cap checks before stock intent registration;
- an independent pre-submission decoder that rejects changed inputs, outputs,
  delegate identity, activation time, total fee, or extra on-chain outputs;
- one-shot delegate submission with stock `reject_replace` enabled;
- stock batch-event progress, failure, and final commitment persistence;
- a resumable mobile workflow for interrupted tabs or phone connectivity.
- atomic multi-deposit release/refund signing, with one checkpoint per input;
- fixed expected amounts for new managed escrows, with release disabled while
  underfunded or overfunded and no buyer-triggered pre-deadline return path;
- a dedicated swept-VTXO recovery workflow that preserves an active Warden
  escrow or returns an expired one to the recorded buyer;
- an evidence verifier that requires the indexed commitment, consumed input,
  exact successor destination/value, and later successor expiry before a proof
  gate changes.

## Activation boundary

The end-to-end batch state machine is installed, but its first funded execution
must still be treated as an alpha activation test. Use a deliberately tiny
script-version-2 escrow, review the displayed fee and deadline, keep the phone connected
through every signature prompt, and verify that the successor VTXO has a later
indexed batch expiry before treating rollover as operationally proven.

`activation-gates.json` intentionally keeps seven-day and longer contract
creation and delegated rollover disabled. Do not change those booleans merely
because local tests pass. The verifier records the real commitment transaction
from the tiny funded manual rollover and the real recovery transaction from the
expiry drill. Only after both independently verify does it enable long-term
creation and delegated rollover.
