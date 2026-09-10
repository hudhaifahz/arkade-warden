# Arkade mobile gateway

This loopback-only gateway exposes the official Arkade wallet and a private,
read-only owner console through one authenticated origin.

- local URL: `http://127.0.0.1:3270`
- stable HTTPS URL: your authenticated Cloudflare edge hostname
- owner console: `/owner`
- public Arkade API proxy after owner authentication: `/v1/*`
- wallet secrets remain in the browser that creates or restores the wallet
- Arkade admin endpoints, seeds, signer material, and arbitrary withdrawals are
  not proxied
- Warden release/refund signing is confirmation-gated in the bound mobile
  wallet; seller claims are restricted to that same bound Arkade address
- parallel short escrow creation, manual rollover, delegated-rollover
  preauthorization, and swept-escrow recovery all use owner-authenticated JSON
  routes; every transaction signature still happens in the bound mobile wallet
- seven-day and longer creation remains server-gated until the indexed funded
  rollover and expiry-recovery proofs both pass
- the hardened alpha route lets the bound phone approve one fee-, count-,
  destination-, party-, and final-date-bounded renewal mandate; the local
  supervisor then creates only exact stock Arkade intents for newly indexed
  VTXOs

Provide `OWNER_CONSOLE_TOKEN` at runtime from macOS Keychain or another local
secret store. Also set `ESCROW_DIRECTORY`; optional origin variables are listed
in `server.mjs`. Never store the token in a plist, command line, source file, or
public deployment manifest. The resulting HTTPS session lasts 24 hours.
