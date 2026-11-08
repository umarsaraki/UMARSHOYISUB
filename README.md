# UMARSHOYI-SUB — Cloudflare project

## Project layout

```text
public/
  index.html
  data-plans.js
worker.js
wrangler.toml
package.json
README.md
original-backup.html
```

`public/index.html` is the existing frontend, with its original UI and features retained. `public/data-plans.js` contains the existing Sabildata plan normalization helper, separated into the `public` folder as requested. `original-backup.html` is the untouched source backup.

## Important migration status

This package is a migration workspace, not yet a production-complete replacement for the original Supabase backend. The supplied HTML contains the Supabase project URL/key and frontend calls, but it does not contain the Supabase Edge Function source code, database policies/triggers, Flutterwave virtual-account implementation, or the VTU provider transaction implementation. Those server-side behaviors cannot safely be recreated from the HTML alone.

The current `worker.js` provides the D1 schema bootstrap, basic email/password signup/login/session handling, profile and transaction read endpoints, and a Flutterwave hosted-checkout initiation endpoint. The existing frontend still has Supabase calls; do not deploy this as a completed migration until those calls are connected to the Worker and the remaining function routes are migrated and tested.

## Cloudflare setup

1. Install Node.js, then run `npm install`.
2. Create the D1 database with `npm run db:create`.
3. Copy the returned database ID into `wrangler.toml` (`database_id`).
4. Set secrets:
   - `npx wrangler secret put AUTH_SECRET` (use a long random secret)
   - `npx wrangler secret put FLW_SECRET_KEY` (Flutterwave secret key; never put it in frontend code)
5. Set `FLW_REDIRECT_URL` as a Worker variable if you have a dedicated return URL.
6. Run `npm run dev` for local testing; deploy with `npm run deploy` only after integration and payment verification.

D1 tables are created by the Worker on API requests using `CREATE TABLE IF NOT EXISTS`.

## Preserved integrations

- Flutterwave remains the payment provider for wallet funding.
- The existing VTU provider has not been replaced.
- The frontend design and existing product pages have been retained.

## Not yet migrated

Supabase Edge Function routes such as `get-sabildata-plans`, data/airtime/cable/electricity/exam purchases, OTP, withdrawals, admin management, and virtual-account creation still require their original server-side logic and provider credentials/configuration. The Worker returns an explicit not-migrated response for routes whose implementation is not available rather than reporting fake success.
