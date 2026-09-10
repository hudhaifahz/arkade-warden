# Cloudflare edge

This Worker forwards an authenticated Arkade home gateway through a Cloudflare
VPC service binding. Copy `wrangler.example.jsonc` to `wrangler.jsonc`, replace
the placeholder service ID, and review the Worker name before deployment.

Do not bind the Arkade admin port. Wallet and escrow authentication remains at
the home gateway; this Worker stores no wallet or signing secrets.
