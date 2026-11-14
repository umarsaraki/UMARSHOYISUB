# UMARSHOYI-SUB — Cloudflare

```
public/index.html      the app screen
public/data-plans.js   plan helper
worker.js              the backend (login, wallet, Flutterwave, purchases, admin)
provider.js            Legitdataway connection; catalog.js = plans and costs
catalog.js             server-side prices (generated from index.html)
wrangler.toml          Cloudflare settings
```

## Deploy
1. `npm install`
2. Secrets (each command asks you to paste the value):
   - `npx wrangler secret put AUTH_SECRET`        (any long random text)
   - `npx wrangler secret put FLW_SECRET_KEY`     (Flutterwave secret key)
   - `npx wrangler secret put FLW_WEBHOOK_HASH`   (any text you choose; use the same in Flutterwave)
3. In `wrangler.toml` set `ADMIN_EMAILS = "your@email.com"`.
4. `npx wrangler deploy`
5. Flutterwave dashboard → Settings → Webhooks:
   - URL: `https://YOUR-SITE/api/webhook/flutterwave`
   - Secret hash: the same text as FLW_WEBHOOK_HASH
6. Open `https://YOUR-SITE/api/health` — it shows what is configured.

## Legitdataway (airtime, data, cable, electricity, exam PINs, cards)
Files: `catalog.js` (what is sold + YOUR COST), `provider.js` (API calls), `worker.js`.
1. Deploy, open Admin Panel -> Settings -> Keys -> **Legitdataway API token**, paste the token and save (it is stored encrypted, never in a file).
2. Admin Panel -> Overview -> **Legitdataway callback address**: copy it into the Legitdataway dashboard. It contains a secret; press *Replace* if it ever leaks.
3. Admin Panel -> Settings -> **Profit**: set % and/or fixed naira per service. Customer price = cost + profit. When Legitdataway raises a price, raise the profit here (no code change). To change a plan or cost, edit one line in `catalog.js`.
4. Keep money in your Legitdataway wallet. Cable plans, 9mobile data and most cards are empty in `catalog.js` = shown as "Coming soon". JAMB is `available:false`.
Pending purchases have no status API: they are settled by the webhook, or by you (Admin -> Transactions -> Confirm / Fail & refund after checking the Legitdataway dashboard).
Webhook safety: secret URL, constant-time check, rate limit, request-id must be one of your own pending purchases, settles once only.
