# Arkade community edge

Public-only Cloudflare Worker for an Arkade operator. It forwards stock arkd's
public `/v1/*` API through a VPC service binding and cannot reach the owner
gateway or private admin port.

1. Create an HTTP VPC service targeting only arkd's loopback-bound public port.
2. Replace the zero UUID in `wrangler.jsonc` with that service ID.
3. Run `npm ci`, `npm run types`, `npm run check`, and `npm test`.
4. Configure Cloudflare per-client rate limiting before production use.
5. Deploy and verify `/v1/info`, then verify `/owner` and `/v1/admin` return 404.

The checked-in zero UUID is an inert placeholder, not a live binding.
