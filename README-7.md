# UMARSHOYI-SUB — Cloudflare

```
public/index.html      the app screen
public/data-plans.js   plan helper
worker.js              the backend (login, wallet, Flutterwave, purchases, admin)
provider.js            VTU provider connection (the ONLY file to edit when we add the API)
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

## Testing without the provider
Set `TEST_MODE = "1"` in wrangler.toml and deploy: purchases/OTP/airtime-to-cash pretend to succeed
(OTP code is 123456). Set it back to "0" before real customers use the app.
With TEST_MODE "0" and no provider connected, purchases are refused and the wallet is never charged.
