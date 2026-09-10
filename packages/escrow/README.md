# Warden mainnet-alpha escrow

This is a three-path Arkade VTXO contract:

1. buyer + seller + operator release;
2. arbiter + operator dispute resolution path;
3. buyer + operator refund after an absolute timelock.

The executable flows implement cooperative release and the buyer's timed
refund. Mainnet identities are stored in the macOS login Keychain, while the
contract record contains only public keys and the derived Arkade address.

The mobile Warden dashboard scans every contract file, including archived
contracts, and reports both spendable and operator-recoverable VTXOs. A refund
request includes the public contract ID so an archived funded escrow cannot be
hidden by the active-contract pointer. Funded or recoverable contracts are
never rotated automatically.

The managed escrow catalog adds independent 3-hour, 24-hour, 3-day, 7-day,
10-day, 30-day, 3-month, 6-month, and 12-month presets. Every created escrow
has its own immutable contract ID, unique address, recorded buyer/seller/
arbiter public keys, refund timestamp, and rollover status. The first three
presets may be created in parallel immediately. Seven-day and longer creation
is disabled until `activation-gates.json` contains independently verified
funded manual-rollover and expiry-recovery evidence. The gate verifier enables
automatic long-term operation only after both indexed proofs pass.

Seller release proceeds use the fixed seller identity in Keychain. The
`claim-seller` flow can only send all currently spendable seller VTXOs to the
Arkade address of the currently bound mobile wallet, with an exact expected
balance check to prevent stale confirmations. `recover-seller` uses the SDK's
operator-assisted recovery round for expired seller VTXOs; recovered proceeds
must then be claimed to the mobile wallet.

Expiry warnings begin 72 hours before the indexed Arkade batch expiry and
become critical at 24 hours. New contracts use a stock-compatible absolute
Unix-time refund lock (three hours by default); that contract deadline is
independent of the Arkade VTXO expiry. For escrow-contract VTXOs, refund or release while spendable;
operator-recoverable custom-contract funds remain visible and block rotation.
The dedicated recovery workflow consumes the exact swept input in a stock
batch. Before the Warden refund deadline it recreates the same escrow; after
that deadline it returns the recovered value to the recorded buyer address.
Both routes require a mobile buyer signature and an exact fee cap, while the
still-active escrow route also requires the seller signature.

The rollover monitor distinguishes the contract deadline from the VTXO batch
deadline. It reports when a long-running funded contract must enter a fresh
stock Arkade batch. Execution requires an owner-approved, fee-capped session and
explicit mobile approval for each buyer signature; the seller co-signs locally
only after that signature verifies. The destination must reproduce the same
contract script, and no value or terms may change except the displayed stock
settlement fee.

New managed contracts include an additional buyer + seller + Fulmine delegate
+ operator tapscript path. The locally hosted official Fulmine service accepts
only a pre-signed Arkade intent and its pre-signed forfeit transaction. The
authorization fixes the input, successor contract address, original parties,
original refund deadline, activation time, and approved fee cap before the
delegate receives it. Fulmine then joins an ordinary stock arkd batch near the
authorized time; it never receives either party's seed.

`npm run escrow -- rollover-plan` is read-only. It reports whether the active
contract needs a rollover and the exact successor invariants; it never registers
an intent or signs a transaction. `start-rollover`, `rollover-status`, and
`rollover-sign` back the owner-authenticated mobile flow. See `ROLLOVER.md` for
the first-funded-test boundary.

`recovery-plan`, `start-recovery`, `recovery-status`, and `recovery-sign` back
the equally constrained expiry-recovery flow. `verify-gates` never trusts a
session result alone: it checks the commitment in the stock index, confirms the
old input was swept/consumed as required, finds one exact live successor at the
approved destination, and confirms the Arkade expiry was extended.

`release` is blocked unless `CONFIRM_ESCROW_RELEASE` exactly matches the public
contract ID. Do not run it until the funded VTXO, destination, fees, and backup
have all been reviewed.

`refund` is blocked both by the contract timelock and by a separate
`CONFIRM_ESCROW_REFUND` value matching the contract ID.

The experimental stock-closure path adds a buyer-and-seller signed bounded
renewal mandate, independent primary/recovery renewal keys, independent
primary/backup Fulmine delegates, signed journal reconstruction, automatic
stock-intent creation for each newly indexed VTXO, and three
operator-independent two-party recovery exits. It does not claim a
single-participant unilateral escape. See
[`docs/HARDENED_RENEWALS.md`](../../docs/HARDENED_RENEWALS.md) for the threat
model, fail-closed behavior, and remaining mainnet-alpha release gates.
