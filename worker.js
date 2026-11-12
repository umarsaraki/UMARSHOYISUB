// UMARSHOYI-SUB — Cloudflare Worker (D1 database)
// Auth, wallet, Flutterwave funding (+webhook, virtual account), purchases, OTP,
// airtime-to-cash withdrawals and admin tools. The VTU provider lives in provider.js.
import { runProvider, sendSms, convertAirtimeToCash, getDataPlans, getCablePlans, CABLE_PROVIDERS, verifySmartcard, verifyMeter, checkStatus, setWebhook, webhookHashOk, clearProviderCaches } from './provider.js';
import * as C from './catalog.js';

/* ------------------------------------------------------------------ schema */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, email_confirmed INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, full_name TEXT, username TEXT UNIQUE, phone TEXT, referral_code TEXT UNIQUE, referral_code_used TEXT, balance_ngn REAL NOT NULL DEFAULT 0, atc_balance REAL NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, is_banned INTEGER NOT NULL DEFAULT 0, transaction_pin_hash TEXT, transaction_pin_salt TEXT, pin_attempts INTEGER NOT NULL DEFAULT 0, pin_locked_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT, label TEXT, amount REAL NOT NULL DEFAULT 0, direction TEXT, status TEXT NOT NULL DEFAULT 'pending', provider_ref TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_ref ON transactions(provider_ref)`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT UNIQUE, tx_ref TEXT, amount REAL, currency TEXT, status TEXT, payload TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS virtual_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), account_number TEXT, bank_name TEXT, account_name TEXT, tx_ref TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS otps (user_id TEXT NOT NULL, phone TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, verified_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, phone))`,
  `CREATE TABLE IF NOT EXISTS remittances (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tx_ref TEXT NOT NULL UNIQUE, currency TEXT NOT NULL, source_amount REAL NOT NULL, rate REAL NOT NULL, fee_percent REAL NOT NULL, fee_amount REAL NOT NULL, receive_ngn REAL NOT NULL, bank_code TEXT NOT NULL, bank_name TEXT, account_number TEXT NOT NULL, account_name TEXT, status TEXT NOT NULL DEFAULT 'awaiting_payment', flw_tx_id TEXT, payout_ref TEXT, payout_attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_rem_user ON remittances(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), wallet TEXT NOT NULL, direction TEXT NOT NULL, amount REAL NOT NULL, ref TEXT NOT NULL UNIQUE, type TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, wallet, created_at)`,
  `CREATE TABLE IF NOT EXISTS bank_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), bank_code TEXT NOT NULL, bank_name TEXT, account_number TEXT NOT NULL, account_name TEXT NOT NULL, nickname TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, bank_code, account_number))`,
  `CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), wallet TEXT NOT NULL, amount REAL NOT NULL, fee REAL NOT NULL, net REAL NOT NULL, bank_code TEXT NOT NULL, bank_name TEXT, account_number TEXT NOT NULL, account_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reference TEXT NOT NULL UNIQUE, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS beneficiaries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), service TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, service, dedupe_key))`,
  `CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL REFERENCES users(id), referee_id TEXT NOT NULL UNIQUE REFERENCES users(id), code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reward_amount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, earned_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS user_notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_un_user ON user_notifications(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tx_id TEXT, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS admin_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];
// For databases created by the older worker: add columns that are missing.
const MIGRATIONS = [
  `ALTER TABLE profiles ADD COLUMN atc_balance REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE profiles ADD COLUMN pin_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE profiles ADD COLUMN pin_locked_until INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE profiles ADD COLUMN exchange_balance REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE profiles ADD COLUMN notif_seen_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'`,
  `ALTER TABLE transactions ADD COLUMN wallet TEXT NOT NULL DEFAULT 'main'`,
];
const SAFE_PROFILE = 'id,full_name,username,phone,referral_code,referral_code_used,balance_ngn,atc_balance,exchange_balance,is_admin,is_banned,created_at';
const WALLET_COL = { main: 'balance_ngn', exchange: 'exchange_balance', atc: 'atc_balance' };
const WALLET_NAME = { main: 'Main Wallet', exchange: 'Exchange Wallet', atc: 'Airtime-to-Cash Wallet' };

/* ----------------------------------------------------------------- helpers */
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization,verif-hash', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', ...extra } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const uid = () => crypto.randomUUID();
const enc = (s) => new TextEncoder().encode(s);
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64 = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const safeEq = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const now = () => Math.floor(Date.now() / 1000);
const money = (n) => Math.round(Number(n) * 100) / 100;
async function body(req) { try { return await req.json(); } catch { return {}; } }

// NOTE: Cloudflare Workers allows at most 100,000 PBKDF2 iterations.
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
async function sha256(text) { return b64(await crypto.subtle.digest('SHA-256', enc(text))); }
async function hmacKey(secret, usage) { return crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]); }
async function tokenFor(user, secret) {
  const payload = b64(enc(JSON.stringify({ sub: user.id, email: user.email, exp: now() + 60 * 60 * 24 * 7 })));
  return payload + '.' + b64(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc(payload)));
}
async function verifyToken(token, secret) {
  try {
    const [p, s] = token.split('.');
    if (!await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), unb64(s), enc(p))) return null;
    const v = JSON.parse(new TextDecoder().decode(unb64(p)));
    return v.exp > now() ? v : null;
  } catch { return null; }
}
async function authUser(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const v = token && await verifyToken(token, env.AUTH_SECRET);
  if (!v) return null;
  return await env.DB.prepare('SELECT u.id, u.email, p.is_admin, p.is_banned FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = ?').bind(v.sub).first();
}
const isAdminEmail = (env, email) => String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes(email);

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  for (const m of MIGRATIONS) { try { await env.DB.prepare(m).run(); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; } }
  await migrateReferralCodes(env);
  schemaReady = true;
}
// Referral codes look like USS1234 (USS + 4 digits). If all 4-digit codes are taken, 5 and then 6 digits are used.
async function newReferralCode(env) {
  for (let digits = 4; digits <= 6; digits++) {
    for (let i = 0; i < 25; i++) {
      const code = 'USS' + String(crypto.getRandomValues(new Uint32Array(1))[0] % (10 ** digits)).padStart(digits, '0');
      if (!(await env.DB.prepare('SELECT 1 FROM profiles WHERE referral_code=?').bind(code).first())) return code;
    }
  }
  throw new Error('No free referral code');
}
async function migrateReferralCodes(env) {   // accounts created before the USS format get a USS code once
  const old = (await env.DB.prepare("SELECT id FROM profiles WHERE referral_code IS NULL OR referral_code NOT LIKE 'USS%' LIMIT 500").all()).results;
  for (const r of old) await env.DB.prepare('UPDATE profiles SET referral_code=? WHERE id=?').bind(await newReferralCode(env), r.id).run();
}

/* -------------------------------------------------------------- PIN checks */
// Returns null when the PIN is right, otherwise an error message.
async function verifyPin(env, userId, pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) return 'Enter your 4-digit transaction PIN';
  const p = await env.DB.prepare('SELECT transaction_pin_hash h, transaction_pin_salt s, pin_attempts a, pin_locked_until l FROM profiles WHERE id=?').bind(userId).first();
  if (!p || !p.h) return 'You have not set a transaction PIN yet.';
  if (p.l > now()) return `Too many wrong PIN attempts. Try again in ${Math.ceil((p.l - now()) / 60)} minute(s).`;
  if (safeEq(await passwordHash(String(pin), p.s), p.h)) {
    if (p.a) await env.DB.prepare('UPDATE profiles SET pin_attempts=0 WHERE id=?').bind(userId).run();
    return null;
  }
  const attempts = p.a + 1;
  if (attempts >= 5) await env.DB.prepare('UPDATE profiles SET pin_attempts=0, pin_locked_until=? WHERE id=?').bind(now() + 900, userId).run();
  else await env.DB.prepare('UPDATE profiles SET pin_attempts=? WHERE id=?').bind(attempts, userId).run();
  return 'Wrong transaction PIN.';
}

/* ----------------------------------------------------------------- AUTH */
async function signup(req, env) {
  const x = await body(req), meta = x.options?.data || {};
  const email = String(x.email || '').trim().toLowerCase(), password = String(x.password || '');
  const username = String(meta.username || '').trim().toLowerCase(), pin = String(meta.raw_pin || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
  if (password.length < 6) return fail('Password must be at least 6 characters.');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail('Username must be 3-20 letters, numbers or underscore.');
  if (!/^\d{4}$/.test(pin)) return fail('Transaction PIN must be exactly 4 digits.');
  const id = uid(), salt = uid(), pinSalt = uid();
  // A referral code is optional. A wrong code never blocks registration: it is simply ignored.
  const usedRaw = String(meta.referral_code_used || '').trim().toUpperCase();
  const referrer = /^USS\d{4,6}$/.test(usedRaw) ? await env.DB.prepare('SELECT id FROM profiles WHERE referral_code=?').bind(usedRaw).first() : null;
  const refEnabled = env.REFERRAL_ENABLED !== '0', reward = Number(env.REFERRAL_REWARD ?? 500);
  try {
    const hash = await passwordHash(password, salt), pinHash = await passwordHash(pin, pinSalt);
    const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = await newReferralCode(env);
      const stmts = [
        env.DB.prepare('INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)').bind(id, email, hash, salt),
        env.DB.prepare('INSERT INTO profiles(id,full_name,username,phone,referral_code_used,referral_code,transaction_pin_hash,transaction_pin_salt,is_admin,notif_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .bind(id, String(meta.full_name || '').trim(), username, String(meta.phone || '').trim(), referrer ? usedRaw : '', code, pinHash, pinSalt, isAdminEmail(env, email) ? 1 : 0, nowStr),
      ];
      if (referrer && refEnabled) stmts.push(env.DB.prepare("INSERT INTO referrals(id,referrer_id,referee_id,code,status,reward_amount) VALUES(?,?,?,?,'pending',?)").bind(uid(), referrer.id, id, usedRaw, reward));
      try { await env.DB.batch(stmts); break; }
      catch (e) { if (attempt < 2 && String(e.message).includes('referral_code')) continue; throw e; }
    }
  } catch (e) {
    console.error('signup failed', e);
    const m = String(e?.message || e);
    if (m.includes('UNIQUE')) return fail('Email or username already exists.', 409);
    return fail('Could not create account: ' + m, 500);
  }
  const user = { id, email };
  return json({ user, session: { access_token: await tokenFor(user, env.AUTH_SECRET), token_type: 'bearer', user } });
}
async function login(req, env) {
  const x = await body(req), id = String(x.email || '').trim().toLowerCase();
  let u = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(id).first();
  if (!u) u = await env.DB.prepare('SELECT u.* FROM users u JOIN profiles p ON p.id=u.id WHERE p.username=?').bind(id).first();
  if (!u || !safeEq(await passwordHash(String(x.password || ''), u.password_salt), u.password_hash)) return fail('Invalid email/username or password.', 401);
  const p = await env.DB.prepare('SELECT is_banned FROM profiles WHERE id=?').bind(u.id).first();
  if (p?.is_banned) return fail('Your account has been suspended. Contact support.', 403);
  if (isAdminEmail(env, u.email)) await env.DB.prepare('UPDATE profiles SET is_admin=1 WHERE id=?').bind(u.id).run();
  const user = { id: u.id, email: u.email };
  return json({ user, session: { access_token: await tokenFor(user, env.AUTH_SECRET), token_type: 'bearer', user } });
}

/* ------------------------------------------------------- FLUTTERWAVE */
const FLW = 'https://api.flutterwave.com/v3';
async function flw(env, method, path, payload) {
  const r = await fetch(FLW + path, { method, headers: { authorization: `Bearer ${env.FLW_SECRET_KEY}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data.status === 'success', data };
}

// Step 1 of card/USSD funding: create a hosted payment link.
async function initiatePayment(req, env, user) {
  const n = Number((await body(req)).amount);
  if (!Number.isFinite(n) || n < 100 || n > 1000000) return fail('Enter a valid amount (minimum ₦100).');
  if (!env.FLW_SECRET_KEY) return fail('Payments are not set up yet. Please try again later.', 503);
  const profile = await env.DB.prepare('SELECT full_name, phone FROM profiles WHERE id=?').bind(user.id).first();
  const txRef = 'UMS-' + uid();
  const r = await flw(env, 'POST', '/payments', {
    tx_ref: txRef, amount: n, currency: 'NGN', redirect_url: env.FLW_REDIRECT_URL || new URL('/api/payment/return', req.url).toString(),
    customer: { email: user.email, name: profile?.full_name || user.email, phonenumber: profile?.phone || '' },
    customizations: { title: env.APP_NAME || 'Wallet Funding', description: 'Wallet funding' },
  });
  if (!r.ok) return fail(r.data.message || 'Could not start payment.', 502);
  await env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,metadata) VALUES(?,?,'fund','Wallet funding',?,'in','pending',?,?)").bind(uid(), user.id, n, txRef, JSON.stringify({ provider: 'flutterwave' })).run();
  const link = r.data.data.link;
  // `link` at the top for the new screen; `status` + nested `data` kept so older screens still work
  return json({ data: { status: 'success', link, tx_ref: txRef, data: { link, tx_ref: txRef } } });
}

// Verify a Flutterwave transaction with Flutterwave itself (never trust the browser/webhook body alone), then credit once.
async function settleFlutterwave(env, flwId) {
  if (!env.FLW_SECRET_KEY) return { ok: false, reason: 'no key' };
  const v = await flw(env, 'GET', `/transactions/${encodeURIComponent(flwId)}/verify`);
  const d = v.data?.data;
  if (!v.ok || !d || d.status !== 'successful') return { ok: false, reason: 'not successful' };
  if (String(d.tx_ref || '').startsWith('UMSX-')) return settleRemittance(env, d);   // exchange payment: never touches the wallet
  if (d.currency !== 'NGN') return { ok: false, reason: 'not successful' };
  const paid = money(d.amount);

  const pending = await env.DB.prepare("SELECT id,user_id,amount FROM transactions WHERE provider_ref=? AND type='fund'").bind(d.tx_ref).first();
  if (pending) {                      // hosted-checkout payment
    if (paid < pending.amount) return { ok: false, reason: 'amount mismatch' };
    const r = await env.DB.batch([
      env.DB.prepare("UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status='pending')").bind(pending.amount, pending.user_id, pending.id),
      env.DB.prepare("UPDATE transactions SET status='successful' WHERE id=? AND status='pending'").bind(pending.id),
    ]);
    return { ok: true, credited: r[1].meta.changes === 1 };
  }
  // bank transfer into a user's virtual account
  let userId = (await env.DB.prepare('SELECT user_id FROM virtual_accounts WHERE tx_ref=?').bind(d.tx_ref).first())?.user_id;
  if (!userId && d.customer?.email) userId = (await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(String(d.customer.email).toLowerCase()).first())?.id;
  if (!userId) return { ok: false, reason: 'unknown account' };
  const evId = uid();
  const r = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO payment_events(id,provider,event_id,tx_ref,amount,currency,status) VALUES(?,'flutterwave',?,?,?,'NGN','successful')").bind(evId, 'flw-' + d.id, d.tx_ref, paid),
    env.DB.prepare('UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND EXISTS(SELECT 1 FROM payment_events WHERE id=?)').bind(paid, userId, evId),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,metadata) SELECT ?,?,'fund','Bank transfer funding',?,'in','successful',?,? WHERE EXISTS(SELECT 1 FROM payment_events WHERE id=?)").bind(uid(), userId, paid, 'flw-' + d.id, JSON.stringify({ provider: 'flutterwave', via: 'virtual-account' }), evId),
  ]);
  return { ok: true, credited: r[0].meta.changes === 1 };
}

// The browser comes back here after paying on Flutterwave's page.
async function paymentReturn(req, env) {
  const q = new URL(req.url).searchParams, txRef = q.get('tx_ref'), id = q.get('transaction_id'), status = q.get('status');
  let outcome = 'failed';
  const isExchange = String(txRef || '').startsWith('UMSX-');
  if (status === 'successful' || status === 'completed') {
    const r = id ? await settleFlutterwave(env, id) : { ok: false };
    outcome = r.ok ? 'success' : 'pending';
  } else if (txRef && isExchange) {
    await env.DB.batch([
      env.DB.prepare("UPDATE transactions SET status='failed' WHERE id=(SELECT id FROM remittances WHERE tx_ref=? AND status='awaiting_payment') AND status='pending'").bind(txRef),
      env.DB.prepare("UPDATE remittances SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE tx_ref=? AND status='awaiting_payment'").bind(txRef),
    ]);
  } else if (txRef) {
    await env.DB.prepare("UPDATE transactions SET status='failed' WHERE provider_ref=? AND type='fund' AND status='pending'").bind(txRef).run();
  }
  return new Response(null, { status: 302, headers: { location: isExchange ? `/?exchange=${outcome}` : `/?funded=${outcome}` } });
}

// Flutterwave -> us. Set the URL in Flutterwave dashboard: https://YOUR-DOMAIN/api/webhook/flutterwave
async function flutterwaveWebhook(req, env) {
  if (!env.FLW_WEBHOOK_HASH || String(env.FLW_WEBHOOK_HASH).length < 16) return fail('Webhook secret missing or too short (min 16 characters).', 503);
  if (!safeEq(req.headers.get('verif-hash') || '', env.FLW_WEBHOOK_HASH)) return fail('Invalid signature.', 401);
  const evt = await body(req), d = evt.data || {};
  try {
    if (evt.event === 'charge.completed' && d.id) await settleFlutterwave(env, d.id);
    if (evt.event === 'transfer.completed' && d.reference) await settleTransfer(env, d.reference, String(d.status).toUpperCase());
  } catch (e) { console.error('webhook error', e); return fail('Processing error', 500); } // non-200 makes Flutterwave retry
  return json({ ok: true });
}

// VTUAgent -> us. Registered with POST /v1/webhook/set (Admin Panel has a button for it).
async function vtuagentWebhook(req, env) {
  const e = await body(req);
  if (!await webhookHashOk(env, e.reference, e.hash)) return fail('Invalid signature.', 401);
  const st = String(e.status || '').toLowerCase();
  try {
    if (st === 'success' || st === 'successful') { if (await settlePurchase(env, e.reference, 'success')) await recordRealCost(env, e.reference); }
    else if (st === 'failed' || st === 'refunded') await settlePurchase(env, e.reference, 'failed');
  } catch (err) { console.error('vtuagent webhook error', err); return fail('Processing error', 500); }
  return json({ ok: true });
}

// Virtual account (permanent bank account number for each user)
async function virtualAccount(req, env, user) {
  const have = await env.DB.prepare('SELECT * FROM virtual_accounts WHERE user_id=?').bind(user.id).first();
  if (have) return json({ account_number: have.account_number, bank_name: have.bank_name, account_name: have.account_name });
  const x = await body(req), bvn = String(x.bvn || ''), nin = String(x.nin || '');
  if (!/^\d{11}$/.test(bvn) && !/^\d{11}$/.test(nin)) return fail('ID_REQUIRED');
  if (!env.FLW_SECRET_KEY) return fail('Bank transfer funding is not set up yet. Please use card/link for now.', 503);
  const p = await env.DB.prepare('SELECT full_name, phone FROM profiles WHERE id=?').bind(user.id).first();
  const parts = String(p?.full_name || 'Customer').trim().split(/\s+/);
  const txRef = 'UMSVA-' + user.id;
  const r = await flw(env, 'POST', '/virtual-account-numbers', {
    email: user.email, is_permanent: true, tx_ref: txRef, firstname: parts[0], lastname: parts.slice(1).join(' ') || parts[0],
    phonenumber: p?.phone || undefined, narration: (env.APP_NAME || 'Wallet') + ' ' + (p?.full_name || ''), ...(bvn ? { bvn } : { nin }),
  });
  if (!r.ok) return fail(r.data.message || 'Could not create account number.', 502);
  const a = r.data.data, name = a.account_name || (p?.full_name || user.email);
  await env.DB.prepare('INSERT OR REPLACE INTO virtual_accounts(user_id,account_number,bank_name,account_name,tx_ref) VALUES(?,?,?,?,?)').bind(user.id, a.account_number, a.bank_name || a.bank || 'Bank', name, txRef).run();
  return json({ account_number: a.account_number, bank_name: a.bank_name || a.bank || 'Bank', account_name: name });
}

/* ------------------------------------------------------------- PURCHASES */
// Debit the wallet and record a pending transaction in ONE atomic step.
// Then call the provider. Refund automatically if the provider refuses.
// The transaction id is also the provider's request_ref (unique, used to look the purchase up later).
const VTU_KINDS = ['data', 'airtime', 'cable', 'electricity'];

// Referral reward: when a referred user completes their FIRST successful purchase, the referrer earns the reward in the MAIN wallet.
// The "pending" -> "earned" change and the credit happen in one atomic step, so a reward can never be paid twice.
async function maybeEarnReferral(env, userId, amount) {
  try {
    if (env.REFERRAL_ENABLED === '0') return;                       // switched off in Admin Panel: rewards stay pending
    if (Number(amount) < Number(env.REFERRAL_MIN_PURCHASE ?? 0)) return;
    const r = await env.DB.prepare("SELECT id, referrer_id, reward_amount FROM referrals WHERE referee_id=? AND status='pending'").bind(userId).first();
    if (!r) return;
    if (!(r.reward_amount > 0)) { await env.DB.prepare("UPDATE referrals SET status='earned', earned_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(r.id).run(); return; }
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE referrals SET status='earned', earned_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(r.id),
      env.DB.prepare('UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND changes() > 0').bind(r.reward_amount, r.referrer_id),
      env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,wallet) SELECT ?,?,'referral-bonus','Referral bonus',?,'in','successful',?,'main' WHERE changes() > 0").bind(uid(), r.referrer_id, r.reward_amount, 'refbonus-' + r.id),
    ]);
    if (res[0].meta.changes === 1) await notify(env, r.referrer_id, 'Referral reward', `You earned ₦${Number(r.reward_amount).toLocaleString()} because a friend you invited made their first purchase.`);
  } catch (e) { console.error('referral reward failed', e); }
}
async function settlePurchase(env, txId, outcome, extra = {}) {
  const t = await env.DB.prepare("SELECT id,user_id,amount FROM transactions WHERE id=? AND status='pending'").bind(txId).first();
  if (!t) return false;                                   // already settled: nothing to do (safe to call twice)
  if (outcome === 'success') {
    const r = await env.DB.prepare("UPDATE transactions SET status='successful', provider_ref=COALESCE(?,provider_ref) WHERE id=? AND status='pending'").bind(extra.ref ?? null, txId).run();
    if (r.meta.changes === 1) { await maybeEarnReferral(env, t.user_id, t.amount); return true; }
    return false;
  }
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status='pending')").bind(t.amount, t.user_id, txId),
    env.DB.prepare("UPDATE transactions SET status='failed' WHERE id=? AND status='pending'").bind(txId),
  ]);
  return r[1].meta.changes === 1;
}
// After a successful VTU purchase, read what VTUAgent really charged us, so "My Profit" is exact.
async function recordRealCost(env, txId) {
  try {
    const s = await checkStatus(env, txId);
    if (s.state === 'success' && s.cost != null) await env.DB.prepare("UPDATE transactions SET metadata=json_set(COALESCE(metadata,'{}'),'$.cost',?) WHERE id=?").bind(s.cost, txId).run();
  } catch (e) { console.error('cost lookup failed', e); }
}
// Resolve a pending VTU purchase by asking VTUAgent.
async function reconcileTx(env, t) {
  const s = await checkStatus(env, t.id);
  if (s.state === 'success') { if (await settlePurchase(env, t.id, 'success')) await recordRealCost(env, t.id); }
  else if (s.state === 'failed') await settlePurchase(env, t.id, 'failed');
  else if (s.state === 'missing') {      // VTUAgent never saw it: safe to refund once enough time has passed
    const age = Date.now() - Date.parse(String(t.created_at).replace(' ', 'T') + 'Z');
    if (age > 3 * 60 * 1000) await settlePurchase(env, t.id, 'failed');
  }
  return s.state;
}
async function reconcilePending(env) {
  await ensureSchema(env);
  const rows = (await env.DB.prepare("SELECT id,created_at FROM transactions WHERE status='pending' AND type IN ('data','airtime','cable','electricity') AND created_at < datetime('now','-90 seconds') ORDER BY created_at LIMIT 20").all()).results;
  for (const t of rows) { try { await reconcileTx(env, t); } catch (e) { console.error('reconcile failed', t.id, e); } }
}

const PENDING_MSG = 'Your request is being processed. Check Transaction History for the result. Please do not pay again.';
async function purchase(env, user, { pin, type, label, price, cost, kind, params, quantity }) {
  const pinErr = await verifyPin(env, user.id, pin);
  if (pinErr) return fail(pinErr);
  price = money(price);
  const txId = uid();
  const r = await env.DB.batch([
    env.DB.prepare('UPDATE profiles SET balance_ngn=balance_ngn-? WHERE id=? AND balance_ngn>=? AND is_banned=0').bind(price, user.id, price),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,metadata) SELECT ?,?,?,?,?,'out','pending',? WHERE changes() > 0").bind(txId, user.id, type, label, price, JSON.stringify({ cost: money(cost), kind })),
  ]);
  if (r[0].meta.changes !== 1) return fail('Insufficient balance. Please fund your wallet.');

  let res;
  try { res = await runProvider(env, kind, { ...params, quantity, requestRef: txId }); }
  catch (e) { console.error('provider error', e); return json({ data: { pending: true, id: txId, message: PENDING_MSG } }); } // stays pending; webhook/cron resolves it
  if (res.pending) return json({ data: { pending: true, id: txId, message: PENDING_MSG } });
  if (res.ok) {
    const ref = res.pins ? JSON.stringify(res.pins) : (res.token ? `Token: ${res.token}${res.units ? ' · ' + res.units + ' units' : ''}` : (res.ref || null));
    await settlePurchase(env, txId, 'success', { ref });
    if (VTU_KINDS.includes(kind)) await recordRealCost(env, txId);
    return json({ data: { ok: true, id: txId, token: res.token || null, units: res.units || null } });
  }
  await settlePurchase(env, txId, 'failed');
  return fail(res.error || 'Purchase failed. Your wallet was refunded.');
}

// ---- Bulk SMS helpers ----
const GSM7 = "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0";
const GSM7_EXT = "^{}\\[~]|\u20ac";
function smsPages(text) {            // how many SMS "pages" one message uses
  let units = 0, gsm = true;
  for (const ch of text) { if (GSM7.includes(ch)) units += 1; else if (GSM7_EXT.includes(ch)) units += 2; else { gsm = false; break; } }
  if (gsm) return units <= 160 ? 1 : Math.ceil(units / 153);
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}
function normalizeNgNumber(n) {      // -> 2348012345678 or null
  const d = String(n).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('234')) return d;
  if (d.length === 11 && d.startsWith('0')) return '234' + d.slice(1);
  if (d.length === 10 && /^[789]/.test(d)) return '234' + d;
  return null;
}
function parseRecipients(text) {
  const seen = new Set(), numbers = []; let invalid = 0;
  for (const part of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const n = normalizeNgNumber(part);
    if (!n) { invalid++; continue; }
    if (!seen.has(n)) { seen.add(n); numbers.push(n); }
  }
  return { numbers, invalid };
}
const smsPrice = (env) => { const v = Number(env.SMS_PRICE_PER_UNIT); return Number.isFinite(v) && v > 0 ? v : 0; };
const smsMax = (env) => Math.max(1, Math.min(5000, Number(env.SMS_MAX_RECIPIENTS) || 1000));

const NETS = ['mtn', 'glo', 'airtel', '9mobile'];
const validPhone = (p) => /^(0\d{10}|234\d{10})$/.test(String(p || ''));
function findDataPlan(network, code) {
  for (const cat of Object.keys(C.DATA_PLANS[network] || {})) { const p = C.DATA_PLANS[network][cat].find((x) => String(x.code) === String(code)); if (p) return { ...p, category: cat }; }
  return null;
}
const userPhone = async (env, id) => (await env.DB.prepare('SELECT phone FROM profiles WHERE id=?').bind(id).first())?.phone || '';
const qtyOf = (x, max) => { const q = Math.floor(Number(x)); return Number.isFinite(q) && q >= 1 && q <= max ? q : null; };

const FUNCTIONS = {
  async 'get-sabildata-plans'(x, env) { // live data plans (cost + markup). The browser only ever sees the selling price.
    try {
      const plans = (await getDataPlans(env)).map((p) => ({ network: p.network.toUpperCase(), data_id: p.code, plan: p.category, size: p.size, validity: p.valid, price: p.price }));
      return json({ plans });
    } catch (e) { console.error('plans error', e); return fail('Data plans are temporarily unavailable. Please try again shortly.', 503); }
  },
  async 'buy-data'(x, env, user) {
    const net = String(x.network || '').toLowerCase();
    let plans; try { plans = await getDataPlans(env); } catch (e) { console.error(e); return fail('Data plans are temporarily unavailable. Please try again shortly.', 503); }
    const plan = plans.find((p) => p.network === net && p.code === String(x.planCode));
    if (!plan) return fail('That data plan is not available. Please refresh and choose again.');
    if (!validPhone(x.phone)) return fail('Enter a valid phone number.');
    return purchase(env, user, { pin: x.pin, type: 'data', label: `${plan.size} ${net.toUpperCase()} data → ${x.phone}`, price: plan.price, cost: plan.cost, kind: 'data', params: { network: net, phone: x.phone, planCode: plan.code } });
  },
  async 'buy-airtime'(x, env, user) {
    const net = String(x.network || '').toLowerCase(), amt = money(x.amount);
    if (!NETS.includes(net)) return fail('Select a network.');
    if (!validPhone(x.phone)) return fail('Enter a valid phone number.');
    if (!(amt >= 50 && amt <= 100000)) return fail('Airtime amount must be between ₦50 and ₦100,000.');
    return purchase(env, user, { pin: x.pin, type: 'airtime', label: `${net.toUpperCase()} airtime → ${x.phone}`, price: amt, cost: amt, kind: 'airtime', params: { network: net, phone: x.phone, amount: amt } });
  },
  async 'get-cable-plans'(x, env) {
    const prov = String(x.provider || '').toLowerCase();
    if (!CABLE_PROVIDERS.includes(prov)) return fail('Select DStv, GOtv or Startimes.');
    try { return json({ plans: (await getCablePlans(env, prov)).map((p) => ({ code: p.code, name: p.name, price: p.price })) }); }
    catch (e) { console.error('cable plans error', e); return fail('Cable packages are temporarily unavailable. Please try again shortly.', 503); }
  },
  async 'verify-smartcard'(x, env) {
    const prov = String(x.provider || '').toLowerCase(), card = String(x.smartcard || '').trim();
    if (!CABLE_PROVIDERS.includes(prov)) return fail('Select DStv, GOtv or Startimes.');
    if (!/^\d{8,15}$/.test(card)) return fail('Enter a valid smartcard/IUC number.');
    try { const v = await verifySmartcard(env, prov, card); return v.ok ? json({ name: v.name, status: v.status, due: v.due }) : fail(v.error); }
    catch (e) { console.error('verify smartcard error', e); return fail('Could not verify the smartcard right now. Please try again.', 503); }
  },
  async 'buy-cable'(x, env, user) {
    const prov = String(x.provider || '').toLowerCase(), card = String(x.smartcard || '').trim();
    if (!CABLE_PROVIDERS.includes(prov)) return fail('Select DStv, GOtv or Startimes.');
    if (!/^\d{8,15}$/.test(card)) return fail('Enter a valid smartcard/IUC number.');
    let plans; try { plans = await getCablePlans(env, prov); } catch (e) { console.error(e); return fail('Cable packages are temporarily unavailable. Please try again shortly.', 503); }
    const plan = plans.find((p) => p.code === String(x.planCode));
    if (!plan) return fail('That cable package is not available. Please refresh and choose again.');
    const phone = await userPhone(env, user.id);
    if (!validPhone(phone)) return fail('Please add a valid phone number to your profile first.');
    return purchase(env, user, { pin: x.pin, type: 'cable', label: `${plan.name} → ${card}`, price: plan.price, cost: plan.cost, kind: 'cable', params: { provider: prov, planCode: plan.code, smartcard: card, amount: plan.cost, phone } });
  },
  async 'verify-meter'(x, env) {
    const disco = C.ELECTRICITY_DISCOS.find((d) => d.code === String(x.discoCode)), type = String(x.meterType || '').toLowerCase(), meter = String(x.meterNumber || '').trim();
    if (!disco) return fail('Select a distribution company.');
    if (!['prepaid', 'postpaid'].includes(type)) return fail('Select prepaid or postpaid.');
    if (!/^\d{6,15}$/.test(meter)) return fail('Enter a valid meter number.');
    try { const v = await verifyMeter(env, disco.code, meter, type); return v.ok ? json({ name: v.name, address: v.address }) : fail(v.error); }
    catch (e) { console.error('verify meter error', e); return fail('Could not verify the meter right now. Please try again.', 503); }
  },
  async 'buy-electricity'(x, env, user) {
    const amt = money(x.unitsAmount), disco = C.ELECTRICITY_DISCOS.find((d) => d.code === String(x.discoCode)), type = String(x.meterType || '').toLowerCase();
    if (!disco) return fail('Select a distribution company.');
    if (!['prepaid', 'postpaid'].includes(type)) return fail('Select prepaid or postpaid.');
    if (!/^\d{6,15}$/.test(String(x.meterNumber || ''))) return fail('Enter a valid meter number.');
    if (!(amt >= C.ELECTRICITY_MIN && amt <= C.ELECTRICITY_MAX)) return fail(`Amount must be between ₦${C.ELECTRICITY_MIN} and ₦${C.ELECTRICITY_MAX}.`);
    const phone = await userPhone(env, user.id);
    if (!validPhone(phone)) return fail('Please add a valid phone number to your profile first.');
    const fee = Math.floor(amt / 1000) * 100; // service fee shown on the app screen
    return purchase(env, user, { pin: x.pin, type: 'electricity', label: `${disco.name} ${type} → ${x.meterNumber}`, price: amt + fee, cost: amt * C.ELECTRICITY_COST_RATE, kind: 'electricity', params: { disco: disco.code, meterType: type, meterNumber: String(x.meterNumber), amount: amt, phone } });
  },
  async 'get-sms-info'(x, env) {
    return json({ available: smsPrice(env) > 0, price: smsPrice(env), max_recipients: smsMax(env) });
  },
  async 'buy-bulk-sms'(x, env, user) {
    const price = smsPrice(env);
    if (!price) return fail('Bulk SMS is not available yet.');
    const sender = String(x.sender || '').trim(), message = String(x.message || '').trim();
    if (!/^[A-Za-z0-9]{3,11}$/.test(sender)) return fail('Sender name must be 3 to 11 letters or numbers, with no spaces.');
    if (message.length < 1) return fail('Write your message.');
    const pages = smsPages(message);
    if (pages > 6) return fail('Your message is too long. Please shorten it.');
    const { numbers, invalid } = parseRecipients(x.recipients);
    if (!numbers.length) return fail('Add at least one valid phone number.');
    if (numbers.length > smsMax(env)) return fail(`You can send to at most ${smsMax(env)} numbers at a time.`);
    const units = numbers.length * pages, total = money(units * price);
    const unitCost = Number(env.SMS_COST_PER_UNIT) > 0 ? Number(env.SMS_COST_PER_UNIT) : price; // profit stays 0 until SMS_COST_PER_UNIT is set
    return purchase(env, user, { pin: x.pin, type: 'bulk-sms', label: `Bulk SMS to ${numbers.length} number${numbers.length > 1 ? 's' : ''} (${pages} page${pages > 1 ? 's' : ''})`, price: total, cost: units * unitCost, kind: 'bulk-sms', params: { sender, message, numbers, skipped: invalid } });
  },
  async 'buy-exam-pin'(x, env, user) {
    const t = C.EXAM_TYPES[String(x.examType || '')], q = qtyOf(x.quantity, 10);
    if (!t) return fail('Select an exam type.');
    if (!q) return fail('Quantity must be between 1 and 10.');
    return purchase(env, user, { pin: x.pin, type: 'exam', label: `${t.name} x${q}`, price: t.price * q, cost: t.cost * q, kind: 'exam', quantity: q, params: { examType: x.examType } });
  },
  async 'buy-data-card'(x, env, user) {
    const net = String(x.network || '').toLowerCase(), plan = findDataPlan(net, x.planCode), q = qtyOf(x.quantity, 100);
    if (!plan) return fail('That data plan is not available.');
    if (!q) return fail('Quantity must be between 1 and 100.');
    return purchase(env, user, { pin: x.pin, type: 'data-card', label: `${plan.size} ${net.toUpperCase()} Data Card x${q}`, price: plan.price * q, cost: plan.cost * q, kind: 'data-card', quantity: q, params: { network: net, planCode: plan.code } });
  },
  async 'buy-airtime-card'(x, env, user) {
    const net = String(x.network || '').toLowerCase(), unit = money(x.unitPrice), q = qtyOf(x.quantity, 100);
    if (!NETS.includes(net)) return fail('Select a network.');
    if (!(unit >= 50 && unit <= 5000)) return fail('Amount per PIN must be between ₦50 and ₦5,000.');
    if (!q) return fail('Quantity must be between 1 and 100.');
    return purchase(env, user, { pin: x.pin, type: 'airtime-card', label: `₦${unit} ${net.toUpperCase()} Recharge Card x${q}`, price: unit * q, cost: unit * q * 0.97, kind: 'airtime-card', quantity: q, params: { network: net, unit } });
  },
};

/* ---------------------------------------------- AIRTIME-TO-CASH, OTP, WITHDRAW */
let bankCache = null;
// Flutterwave tells us how a bank transfer ended. References that start with UMSW- are customer withdrawals.
async function settleTransfer(env, reference, status) {
  if (!String(reference).startsWith('UMSW-')) return;
  const wd = await env.DB.prepare('SELECT id,user_id,net FROM withdrawals WHERE reference=?').bind(reference).first();
  if (!wd) return;
  if (status === 'SUCCESSFUL') {
    const c = await env.DB.prepare("UPDATE withdrawals SET status='successful', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','processing')").bind(wd.id).run();
    if (c.meta.changes === 1) {
      await env.DB.prepare("UPDATE transactions SET status='successful' WHERE id=?").bind(wd.id).run();
      await notify(env, wd.user_id, 'Withdrawal successful', `\u20a6${Number(wd.net).toLocaleString()} has been sent to your bank account.`);
    }
  } else if (status === 'FAILED') await reverseWithdrawal(env, wd.id, 'The bank transfer failed');
}

/* ------------------------------------------------------------------ EXCHANGE (send money to Nigeria) */
// Customer pays by card in USD/GBP/EUR (Flutterwave checkout). After Flutterwave confirms the payment,
// the naira is paid straight to the recipient's bank account (Flutterwave Transfers). No wallet balance is held.
// Turned OFF by default. Turn on with EXCHANGE_ENABLED = "1" only after Flutterwave has approved this on your account.
// Currencies a customer abroad can pay in. Which ones are open is chosen in Admin Panel -> Settings.
// "options" = payment methods shown on Flutterwave's page. Names come from Flutterwave's "Payment methods" page.
// "account" = pay with bank (UK and EU only here; US bank debit is left out on purpose).
// NOTE: payment_options only takes effect when "Enable Dashboard Payment Options" is switched OFF in the Flutterwave account settings.
// TODO(before going live): ask Flutterwave in writing which currencies and methods are enabled on this account,
// and test each currency once with a small amount (the rate service may not cover every currency).
const X_CURRENCIES = {
  USD: { country: 'United States', options: 'card, googlepay, applepay' },
  GBP: { country: 'United Kingdom', options: 'card, account, googlepay, applepay' },
  EUR: { country: 'Europe', options: 'card, account, googlepay, applepay' },
  GHS: { country: 'Ghana', options: 'card' },
  KES: { country: 'Kenya', options: 'card' },
  ZAR: { country: 'South Africa', options: 'card, googlepay, applepay' },
  UGX: { country: 'Uganda', options: 'card' },
  TZS: { country: 'Tanzania', options: 'card' },
  RWF: { country: 'Rwanda', options: 'card' },
  MWK: { country: 'Malawi', options: 'card' },
  XOF: { country: 'West Africa (CFA)', options: 'card' },
  XAF: { country: 'Central Africa (CFA)', options: 'card' },
};
const X_DEFAULT_CURRENCIES = 'USD,GBP,EUR,GHS';
const xCfg = (env) => ({
  enabled: env.EXCHANGE_ENABLED === '1',
  feePct: Number(env.EXCHANGE_FEE_PERCENT ?? 10),
  min: Number(env.EXCHANGE_MIN_AMOUNT ?? 5),
  max: Number(env.EXCHANGE_MAX_AMOUNT ?? 100),
  dailyCount: Number(env.EXCHANGE_DAILY_COUNT ?? 3),
  currencies: String(env.EXCHANGE_CURRENCIES || X_DEFAULT_CURRENCIES).split(',').map((s) => s.trim().toUpperCase()).filter((s) => X_CURRENCIES[s]),
});
const rateCache = {};
// TODO(before going live): Flutterwave describes this rate as an ESTIMATE only. Confirm in writing how the real settlement rate is applied
// to card payments in USD/GBP/EUR on this account, and the exact Flutterwave fees (collection, conversion, transfer).
async function fxRate(env, currency) { // NGN per 1 unit of `currency`, from Flutterwave's transfer-rate estimate (cached 5 minutes)
  const hit = rateCache[currency];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.rate;
  const r = await flw(env, 'GET', `/transfers/rates?amount=100000&destination_currency=NGN&source_currency=${currency}`);
  const rate = Number(r.data?.data?.rate);
  if (!r.ok || !(rate > 1)) { if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.rate; throw new Error('Rate unavailable'); }
  rateCache[currency] = { at: Date.now(), rate };
  return rate;
}
// Limits (min / max per transfer) are set in USD. For other currencies they are converted with the same Flutterwave rates,
// so "100" means about $100 whether the customer pays in dollars, cedis or shillings.
async function xQuote(env, currency, amount) {
  const c = xCfg(env), rate = await fxRate(env, currency);
  const usdRate = currency === 'USD' ? rate : await fxRate(env, 'USD');
  const minAmount = Math.ceil(c.min * usdRate / rate * 100) / 100, maxAmount = Math.floor(c.max * usdRate / rate * 100) / 100;
  if (amount < minAmount - 1e-9 || amount > maxAmount + 1e-9) return { limit_error: `Amount must be between ${minAmount} and ${maxAmount} ${currency}.` };
  const fee = money(amount * c.feePct / 100), net = money(amount - fee);
  return { currency, amount, rate, fee_percent: c.feePct, fee_amount: fee, net_amount: net, receive_ngn: Math.floor(net * rate), min_amount: minAmount, max_amount: maxAmount };
}
async function xResolveAccount(env, bankCode, accountNumber) {
  const r = await flw(env, 'POST', '/accounts/resolve', { account_number: accountNumber, account_bank: bankCode });
  return r.ok && r.data?.data?.account_name ? String(r.data.data.account_name) : null;
}
async function loadBanks(env) {
  if (!bankCache) {
    if (!env.FLW_SECRET_KEY) throw new Error('Bank list is not available yet.');
    const r = await flw(env, 'GET', '/banks/NG');
    if (!r.ok) throw new Error('Could not load banks.');
    bankCache = r.data.data.map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name));
  }
  return bankCache;
}
const xValid = (x, c) => {
  if (!c.currencies.includes(String(x.currency))) return 'This currency is not available.';
  if (!(money(x.amount) > 0)) return 'Enter a valid amount.';
  return null;
};

// Card payment confirmed (verified with Flutterwave) -> credit the customer's EXCHANGE WALLET once.
// The customer keeps the naira there and withdraws whenever they choose. Nothing is sent to a bank automatically.
async function settleRemittance(env, d) {
  const r = await env.DB.prepare('SELECT * FROM remittances WHERE tx_ref=?').bind(d.tx_ref).first();
  if (!r) return { ok: false, reason: 'unknown exchange' };
  if (money(d.amount) < r.source_amount || d.currency !== r.currency) {
    await env.DB.prepare("UPDATE remittances SET status='amount_mismatch', flw_tx_id=?, error=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_payment'").bind(String(d.id), `Paid ${d.amount} ${d.currency}, expected ${r.source_amount} ${r.currency}`, r.id).run();
    return { ok: false, reason: 'amount mismatch' };
  }
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE remittances SET status='credited', flw_tx_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_payment'").bind(String(d.id), r.id),
    env.DB.prepare('UPDATE profiles SET exchange_balance=exchange_balance+? WHERE id=? AND changes() > 0').bind(r.receive_ngn, r.user_id),
    env.DB.prepare("INSERT INTO wallet_ledger(id,user_id,wallet,direction,amount,ref,type,note) SELECT ?,?,'exchange','in',?,?,'exchange',? WHERE changes() > 0").bind(uid(), r.user_id, r.receive_ngn, 'exchange-' + r.id, `${r.source_amount} ${r.currency} exchange`),
    env.DB.prepare("UPDATE transactions SET status='successful' WHERE id=? AND status='pending'").bind(r.id),
  ]);
  const credited = res[0].meta.changes === 1;
  if (credited) await notify(env, r.user_id, 'Exchange successful', `\u20a6${Number(r.receive_ngn).toLocaleString()} has been added to your Exchange Wallet.`);
  return { ok: true, credited };
}

FUNCTIONS['exchange-info'] = async (x, env) => {
  const c = xCfg(env);
  return json({ enabled: c.enabled, currencies: c.currencies.map((code) => ({ code, country: X_CURRENCIES[code].country })), min: c.min, max: c.max, fee_percent: c.feePct });
};
FUNCTIONS['get-banks'] = async (x, env) => {
  try { return json({ banks: await loadBanks(env) }); } catch (e) { return fail(String(e.message || 'Could not load banks.'), 503); }
};
FUNCTIONS['exchange-quote'] = async (x, env) => {
  const c = xCfg(env);
  if (!c.enabled) return fail('This service is not available yet.');
  const bad = xValid(x, c); if (bad) return fail(bad);
  try { const q = await xQuote(env, String(x.currency), money(x.amount)); return q.limit_error ? fail(q.limit_error) : json({ quote: q }); }
  catch (e) { console.error('quote error', e); return fail('Rates are temporarily unavailable. Please try again shortly.', 503); }
};
FUNCTIONS['exchange-create'] = async (x, env, user, req) => {
  const c = xCfg(env);
  if (!c.enabled) return fail('This service is not available yet.');
  if (!env.FLW_SECRET_KEY) return fail('This service is not available yet.', 503);
  const bad = xValid(x, c); if (bad) return fail(bad);
  const pinErr = await verifyPin(env, user.id, x.pin); if (pinErr) return fail(pinErr);
  const today = await env.DB.prepare("SELECT COUNT(*) n FROM remittances WHERE user_id=? AND status NOT IN ('cancelled','awaiting_payment') AND created_at > datetime('now','-1 day')").bind(user.id).first();
  if (today.n >= c.dailyCount) return fail(`You can make at most ${c.dailyCount} exchanges per day.`);
  let q; try { q = await xQuote(env, String(x.currency), money(x.amount)); } catch (e) { console.error(e); return fail('Rates are temporarily unavailable. Please try again shortly.', 503); }
  if (q.limit_error) return fail(q.limit_error);
  if (q.receive_ngn < 1) return fail('The amount is too small after fees.');
  const id = uid(), txRef = 'UMSX-' + id;
  const prof = await env.DB.prepare('SELECT full_name, phone FROM profiles WHERE id=?').bind(user.id).first();
  const p = await flw(env, 'POST', '/payments', { tx_ref: txRef, amount: q.amount, currency: q.currency, payment_options: X_CURRENCIES[q.currency].options, redirect_url: env.FLW_REDIRECT_URL || new URL('/api/payment/return', req.url).toString(),
    customer: { email: user.email, name: prof?.full_name || user.email, phonenumber: prof?.phone || '' }, customizations: { title: env.APP_NAME || 'Exchange', description: 'Add money to your Exchange Wallet' }, meta: { remittance_id: id } });
  if (!p.ok) return fail(p.data?.message || 'Could not start the payment.', 502);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO remittances(id,user_id,tx_ref,currency,source_amount,rate,fee_percent,fee_amount,receive_ngn,bank_code,account_number) VALUES(?,?,?,?,?,?,?,?,?,'','')").bind(id, user.id, txRef, q.currency, q.amount, q.rate, q.fee_percent, q.fee_amount, q.receive_ngn),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,wallet,metadata) VALUES(?,?,'exchange',?,?,'in','pending',?,'exchange',?)").bind(id, user.id, `Exchange (${q.currency} \u2192 NGN)`, q.receive_ngn, txRef, JSON.stringify({ currency: q.currency, source_amount: q.amount, rate: q.rate, fee_percent: q.fee_percent, fee_amount: q.fee_amount })),
  ]);
  return json({ data: { link: p.data.data.link, id, receive_ngn: q.receive_ngn } });
};

/* ------------------------------------------------------------------ WALLETS, HISTORY, WITHDRAWALS, FAVOURITES, REFERRALS */
const maskAcct = (n) => '******' + String(n).slice(-4);
const cfgNum = (env, key, dflt) => { const v = Number(env[key]); return env[key] !== undefined && env[key] !== '' && Number.isFinite(v) ? v : dflt; };
const wdCfg = (env) => ({ fee: money(cfgNum(env, 'WITHDRAW_FEE_FLAT', 0)), min: cfgNum(env, 'WITHDRAW_MIN_AMOUNT', 1000) });
const appBase = (env, req) => { const u = String(env.APP_URL || '').trim().replace(/\/+$/, ''); return /^https:\/\/[^\s]+$/.test(u) ? u : new URL(req.url).origin; };

async function notify(env, userId, title, message) {   // a personal notification (shows under the bell)
  try { await env.DB.prepare('INSERT INTO user_notifications(id,user_id,title,message) VALUES(?,?,?,?)').bind(uid(), userId, String(title).slice(0, 80), String(message).slice(0, 300)).run(); }
  catch (e) { console.error('notify failed', e); }
}
function ledgerIfChanged(env, p) {   // ledger line, only written when the statement before it changed a row
  return env.DB.prepare('INSERT INTO wallet_ledger(id,user_id,wallet,direction,amount,ref,type,note) SELECT ?,?,?,?,?,?,?,? WHERE changes() > 0').bind(uid(), p.userId, p.wallet, p.dir, p.amount, p.ref, p.type, p.note || null);
}

// A fingerprint for every transaction: HMAC-SHA256 with the server secret over fields that never change.
// Customers cannot forge it, and admins can check a receipt in Admin Panel -> Transactions -> Verify receipt.
async function txHash(env, t) {
  const key = await hmacKey(String(env.AUTH_SECRET), 'sign');
  const data = `tx1|${t.id}|${t.user_id}|${t.type}|${money(t.amount)}|${t.direction}|${t.created_at}`;
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(data)))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function timelineFor(t) {
  const ok = t.status === 'successful', bad = t.status === 'failed';
  const steps = [{ label: 'Request received', state: 'done', time: t.created_at }];
  if (t.type === 'exchange') steps.push({ label: ok ? 'Payment confirmed' : bad ? 'Payment not completed' : 'Waiting for payment confirmation', state: ok ? 'done' : bad ? 'failed' : 'pending' }, { label: 'Credited to Exchange Wallet', state: ok ? 'done' : 'pending' });
  else if (t.type === 'withdrawal') steps.push({ label: 'Amount taken from wallet', state: 'done' }, { label: ok ? 'Sent to your bank' : bad ? 'Failed. Money returned to your wallet' : 'Processing with the bank', state: ok ? 'done' : bad ? 'failed' : 'pending' });
  else if (t.direction === 'out') steps.push({ label: 'Paid from wallet', state: 'done' }, { label: ok ? 'Delivered' : bad ? 'Failed. Refunded to your wallet' : 'Processing', state: ok ? 'done' : bad ? 'failed' : 'pending' });
  else steps.push({ label: ok ? 'Money received' : bad ? 'Not completed' : 'Waiting for confirmation', state: ok ? 'done' : bad ? 'failed' : 'pending' });
  return steps;
}

FUNCTIONS['wallet-summary'] = async (x, env, user) => {
  const p = await env.DB.prepare('SELECT balance_ngn m, exchange_balance e, atc_balance a FROM profiles WHERE id=?').bind(user.id).first();
  const pe = await env.DB.prepare("SELECT COALESCE(SUM(receive_ngn),0) s FROM remittances WHERE user_id=? AND status='awaiting_payment' AND created_at > datetime('now','-1 day')").bind(user.id).first();
  return json({ main: money(p.m), exchange: money(p.e), atc: money(p.a), total: money(p.m + p.e + p.a), pending_exchange: money(pe.s), pending_atc: 0, withdraw: wdCfg(env) });
};
FUNCTIONS['app-config'] = async (x, env, user, req) => json({
  service_notice: env.SERVICE_NOTICE_ON === '0' ? '' : String(env.SERVICE_NOTICE || ''),
  support_whatsapp: String(env.SUPPORT_WHATSAPP || ''), support_email: String(env.SUPPORT_EMAIL || ''),
  referral: { enabled: env.REFERRAL_ENABLED !== '0', reward: cfgNum(env, 'REFERRAL_REWARD', 500) },
  app_url: appBase(env, req), exchange_enabled: env.EXCHANGE_ENABLED === '1', withdraw: wdCfg(env),
});

/* ----- notifications (personal ones + messages from the admin) ----- */
FUNCTIONS['my-notifications'] = async (x, env, user) => {
  const seen = (await env.DB.prepare('SELECT notif_seen_at s FROM profiles WHERE id=?').bind(user.id).first())?.s || '1970-01-01 00:00:00';
  const mine = (await env.DB.prepare('SELECT title,message,created_at FROM user_notifications WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').bind(user.id).all()).results;
  const all = (await env.DB.prepare('SELECT title,message,created_at FROM notifications ORDER BY created_at DESC LIMIT 30').all()).results.map((n) => ({ ...n, from_admin: true }));
  const items = [...mine, ...all].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60).map((n) => ({ ...n, unread: n.created_at > seen }));
  return json({ items, unread: items.filter((i) => i.unread).length });
};
FUNCTIONS['notifications-seen'] = async (x, env, user) => { await env.DB.prepare('UPDATE profiles SET notif_seen_at=CURRENT_TIMESTAMP WHERE id=?').bind(user.id).run(); return json({ ok: true }); };

/* ----- transactions ----- */
FUNCTIONS['tx-list'] = async (x, env, user) => {
  const where = ['user_id=?'], args = [user.id];
  if (['main', 'exchange', 'atc'].includes(x.wallet)) { where.push('wallet=?'); args.push(x.wallet); }
  if (['successful', 'pending', 'failed'].includes(x.status)) { where.push('status=?'); args.push(x.status); }
  const q = String(x.q || '').trim().slice(0, 60);
  if (q) { const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'; where.push("(label LIKE ? ESCAPE '\\' OR provider_ref LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')"); args.push(like, like, like); }
  const offset = Math.max(0, Math.floor(Number(x.offset) || 0)), W = where.join(' AND ');
  const items = (await env.DB.prepare(`SELECT id,type,label,amount,direction,status,wallet,created_at FROM transactions WHERE ${W} ORDER BY created_at DESC, rowid DESC LIMIT 20 OFFSET ?`).bind(...args, offset).all()).results;
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM transactions WHERE ${W}`).bind(...args).first()).n;
  return json({ items, total, page_size: 20 });
};
FUNCTIONS['tx-detail'] = async (x, env, user) => {
  const t = await env.DB.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').bind(String(x.id || ''), user.id).first();
  if (!t) return fail('Transaction not found.', 404);
  const hash = await txHash(env, t);
  let extra = null;
  if (t.type === 'exchange') extra = await env.DB.prepare('SELECT currency,source_amount,rate,fee_percent,fee_amount,receive_ngn FROM remittances WHERE id=?').bind(t.id).first();
  if (t.type === 'withdrawal') { const wd = await env.DB.prepare('SELECT wallet,amount,fee,net,bank_name,account_number,account_name,reference FROM withdrawals WHERE id=?').bind(t.id).first(); if (wd) extra = { ...wd, account_number: maskAcct(wd.account_number) }; }
  return json({ transaction: { id: t.id, type: t.type, label: t.label, amount: t.amount, direction: t.direction, status: t.status, wallet: t.wallet, created_at: t.created_at, reference: t.provider_ref, hash, short_hash: hash.slice(0, 16) }, extra, timeline: timelineFor(t) });
};

/* ----- saved bank accounts (verified with Flutterwave before saving) ----- */
FUNCTIONS['bank-accounts'] = async (x, env, user) => {
  const rows = (await env.DB.prepare('SELECT id,bank_name,account_number,account_name,nickname FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all()).results;
  return json({ items: rows.map((r) => ({ ...r, account_number: maskAcct(r.account_number) })) });
};
FUNCTIONS['bank-resolve'] = async (x, env) => {   // shows the account name before the customer saves a bank account
  const bank = String(x.bankCode || ''), acct = String(x.accountNumber || '');
  if (!bank || !/^\d{10}$/.test(acct)) return fail('Select a bank and enter a 10-digit account number.');
  if (!env.FLW_SECRET_KEY) return fail('This service is not available yet.', 503);
  const name = await xResolveAccount(env, bank, acct);
  return name ? json({ account_name: name }) : fail('Could not verify this account. Please check the bank and account number.');
};
FUNCTIONS['bank-account-add'] = async (x, env, user) => {
  const bank = String(x.bankCode || ''), acct = String(x.accountNumber || ''), nick = String(x.nickname || '').trim().slice(0, 30);
  if (!bank || !/^\d{10}$/.test(acct)) return fail('Select a bank and enter a 10-digit account number.');
  if (!env.FLW_SECRET_KEY) return fail('This service is not available yet.', 503);
  if ((await env.DB.prepare('SELECT COUNT(*) n FROM bank_accounts WHERE user_id=?').bind(user.id).first()).n >= 10) return fail('You can save up to 10 bank accounts. Remove one first.');
  let banks; try { banks = await loadBanks(env); } catch (e) { return fail('Could not load banks. Please try again.', 503); }
  const b = banks.find((k) => k.code === bank);
  if (!b) return fail('This bank is not supported.');
  const name = await xResolveAccount(env, bank, acct);
  if (!name) return fail('Could not verify this account. Please check the bank and account number.');
  const id = uid();
  try { await env.DB.prepare('INSERT INTO bank_accounts(id,user_id,bank_code,bank_name,account_number,account_name,nickname) VALUES(?,?,?,?,?,?,?)').bind(id, user.id, bank, b.name, acct, name, nick || null).run(); }
  catch (e) { return fail(String(e.message).includes('UNIQUE') ? 'This account is already saved.' : 'Could not save the account.', 409); }
  return json({ account: { id, bank_name: b.name, account_number: maskAcct(acct), account_name: name, nickname: nick || null } });
};
FUNCTIONS['bank-account-rename'] = async (x, env, user) => {
  const c = await env.DB.prepare('UPDATE bank_accounts SET nickname=? WHERE id=? AND user_id=?').bind(String(x.nickname || '').trim().slice(0, 30) || null, String(x.id || ''), user.id).run();
  return c.meta.changes === 1 ? json({ ok: true }) : fail('Account not found.', 404);
};
FUNCTIONS['bank-account-delete'] = async (x, env, user) => {
  const c = await env.DB.prepare('DELETE FROM bank_accounts WHERE id=? AND user_id=?').bind(String(x.id || ''), user.id).run();
  return c.meta.changes === 1 ? json({ ok: true }) : fail('Account not found.', 404);
};

/* ----- withdrawals: Exchange Wallet and Airtime-to-Cash Wallet only. The Main Wallet can never be withdrawn. ----- */
async function wdQuote(env, user, x) {
  const wallet = String(x.wallet || ''), amount = money(x.amount), c = wdCfg(env);
  if (wallet === 'main') return { error: 'The Main Wallet cannot be withdrawn. It is for buying services.' };
  if (!['exchange', 'atc'].includes(wallet)) return { error: 'Choose Exchange Wallet or Airtime-to-Cash Wallet.' };
  if (!(amount >= c.min)) return { error: `The minimum withdrawal is \u20a6${c.min.toLocaleString()}.` };
  const bal = money((await env.DB.prepare(`SELECT ${WALLET_COL[wallet]} b FROM profiles WHERE id=?`).bind(user.id).first()).b);
  if (amount > bal) return { error: `You only have \u20a6${bal.toLocaleString()} in this wallet.` };
  const net = money(amount - c.fee);
  if (!(net > 0)) return { error: 'The amount is too small after the fee.' };
  return { q: { wallet, amount, fee: c.fee, net, balance: bal, remaining: money(bal - amount) } };
}
FUNCTIONS['withdraw-quote'] = async (x, env, user) => { const r = await wdQuote(env, user, x); return r.error ? fail(r.error) : json({ quote: r.q }); };
FUNCTIONS['withdraw-create'] = async (x, env, user) => {
  const r = await wdQuote(env, user, x); if (r.error) return fail(r.error);
  const q = r.q;
  const bank = await env.DB.prepare('SELECT * FROM bank_accounts WHERE id=? AND user_id=?').bind(String(x.bankAccountId || ''), user.id).first();
  if (!bank) return fail('Choose one of your saved bank accounts.');
  if (!env.FLW_SECRET_KEY) return fail('Withdrawals are not available yet.', 503);
  const pinErr = await verifyPin(env, user.id, x.pin); if (pinErr) return fail(pinErr);
  const id = uid(), reference = 'UMSW-' + id, col = WALLET_COL[q.wallet];
  // One atomic step: take the money out of the wallet, create the withdrawal, the history line and the ledger line.
  // The wallet check inside the UPDATE stops two quick taps from withdrawing the same money twice.
  const b = await env.DB.batch([
    env.DB.prepare(`UPDATE profiles SET ${col}=${col}-? WHERE id=? AND ${col}>=? AND is_banned=0`).bind(q.amount, user.id, q.amount),
    env.DB.prepare("INSERT INTO withdrawals(id,user_id,wallet,amount,fee,net,bank_code,bank_name,account_number,account_name,status,reference) SELECT ?,?,?,?,?,?,?,?,?,?,'pending',? WHERE changes() > 0").bind(id, user.id, q.wallet, q.amount, q.fee, q.net, bank.bank_code, bank.bank_name, bank.account_number, bank.account_name, reference),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,wallet,metadata) SELECT ?,?,'withdrawal',?,?,'out','pending',?,?,? WHERE changes() > 0").bind(id, user.id, `Withdrawal to ${bank.bank_name} ${maskAcct(bank.account_number)}`, q.amount, reference, q.wallet, JSON.stringify({ fee: q.fee, net: q.net })),
    ledgerIfChanged(env, { userId: user.id, wallet: q.wallet, dir: 'out', amount: q.amount, ref: 'withdraw-' + id, type: 'withdrawal', note: `To ${bank.bank_name} ${maskAcct(bank.account_number)}` }),
  ]);
  if (b[0].meta.changes !== 1) return fail('Your balance changed. Please check it and try again.');
  await notify(env, user.id, 'Withdrawal submitted', `Your withdrawal of \u20a6${q.amount.toLocaleString()} is being processed.`);
  let t;
  try { t = await flw(env, 'POST', '/transfers', { account_bank: bank.bank_code, account_number: bank.account_number, amount: q.net, currency: 'NGN', reference, narration: (env.APP_NAME || 'Withdrawal').slice(0, 40), debit_currency: 'NGN' }); }
  catch (e) { console.error('transfer error', e); return json({ data: { id, status: 'pending', message: 'Your withdrawal is being processed. Check your history for the result.' } }); } // stays pending; the webhook or admin settles it
  if (!t.ok) { await reverseWithdrawal(env, id, String(t.data?.message || 'The transfer was refused').slice(0, 200)); return fail((t.data?.message || 'The transfer could not be started') + '. Your money was returned to your wallet.', 502); }
  await env.DB.prepare("UPDATE withdrawals SET status='processing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(id).run();
  return json({ data: { id, status: 'processing', message: 'Your withdrawal is on its way.' } });
};
async function reverseWithdrawal(env, id, reason) {   // gives the money back exactly once
  const wd = await env.DB.prepare("SELECT * FROM withdrawals WHERE id=? AND status IN ('pending','processing')").bind(id).first();
  if (!wd) return false;
  const col = WALLET_COL[wd.wallet];
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE withdrawals SET status='reversed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','processing')").bind(String(reason).slice(0, 200), id),
    env.DB.prepare(`UPDATE profiles SET ${col}=${col}+? WHERE id=? AND changes() > 0`).bind(wd.amount, wd.user_id),
    ledgerIfChanged(env, { userId: wd.user_id, wallet: wd.wallet, dir: 'in', amount: wd.amount, ref: 'withdraw-reversal-' + id, type: 'withdrawal-reversal', note: 'Withdrawal failed, money returned' }),
    env.DB.prepare("UPDATE transactions SET status='failed' WHERE id=?").bind(id),
  ]);
  if (r[0].meta.changes !== 1) return false;
  await notify(env, wd.user_id, 'Withdrawal failed', `Your withdrawal of \u20a6${Number(wd.amount).toLocaleString()} did not go through. The money is back in your ${WALLET_NAME[wd.wallet]}.`);
  return true;
}
FUNCTIONS['withdraw-history'] = async (x, env, user) => {
  const rows = (await env.DB.prepare('SELECT id,wallet,amount,fee,net,bank_name,account_number,account_name,status,reference,created_at FROM withdrawals WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30').bind(user.id).all()).results;
  return json({ items: rows.map((r) => ({ ...r, account_number: maskAcct(r.account_number) })) });
};

/* ----- favourite beneficiaries, kept separately for each service ----- */
const FAV_SERVICES = ['data', 'airtime', 'a2c', 'electricity', 'cable', 'sms'];
function favClean(service, d) {   // returns { data, key } or { error }
  d = d && typeof d === 'object' ? d : {};
  if (['data', 'airtime', 'a2c'].includes(service)) {
    const phone = String(d.phone || '');
    if (!validPhone(phone)) return { error: 'Enter a valid phone number.' };
    return { data: { phone, network: NETS.includes(String(d.network)) ? String(d.network) : '' }, key: normalizeNgNumber(phone) || phone };
  }
  if (service === 'electricity') {
    const disco = C.ELECTRICITY_DISCOS.find((k) => k.code === String(d.discoCode)), type = String(d.meterType || '').toLowerCase(), meter = String(d.meterNumber || '').trim();
    if (!disco || !['prepaid', 'postpaid'].includes(type) || !/^\d{6,15}$/.test(meter)) return { error: 'Choose the distribution company, meter type and a valid meter number.' };
    return { data: { discoCode: disco.code, meterType: type, meterNumber: meter }, key: `${disco.code}|${meter}` };
  }
  if (service === 'cable') {
    const prov = String(d.provider || '').toLowerCase(), card = String(d.smartcard || '').trim();
    if (!CABLE_PROVIDERS.includes(prov) || !/^\d{8,15}$/.test(card)) return { error: 'Choose the provider and enter a valid smartcard number.' };
    return { data: { provider: prov, smartcard: card }, key: `${prov}|${card}` };
  }
  if (service === 'sms') {
    const { numbers } = parseRecipients(Array.isArray(d.numbers) ? d.numbers.join(',') : '');
    if (!numbers.length) return { error: 'Add at least one valid phone number.' };
    if (numbers.length > 500) return { error: 'A saved list can hold up to 500 numbers.' };
    return { data: { numbers }, key: null };
  }
  return { error: 'Unknown service.' };
}
FUNCTIONS['fav-list'] = async (x, env, user) => {
  const service = String(x.service || '');
  if (!FAV_SERVICES.includes(service)) return fail('Unknown service.');
  const rows = (await env.DB.prepare('SELECT id,name,data FROM beneficiaries WHERE user_id=? AND service=? ORDER BY name COLLATE NOCASE').bind(user.id, service).all()).results;
  return json({ items: rows.map((r) => ({ id: r.id, name: r.name, data: JSON.parse(r.data) })) });
};
FUNCTIONS['fav-save'] = async (x, env, user) => {
  const service = String(x.service || ''), name = String(x.name || '').trim().slice(0, 30);
  if (!FAV_SERVICES.includes(service)) return fail('Unknown service.');
  if (!name) return fail('Give this saved item a name, for example "Mum" or "Home Meter".');
  const c = favClean(service, x.data); if (c.error) return fail(c.error);
  if ((await env.DB.prepare('SELECT COUNT(*) n FROM beneficiaries WHERE user_id=? AND service=?').bind(user.id, service).first()).n >= 30) return fail('You can save up to 30 items here. Remove one first.');
  const id = uid(), key = c.key ?? ('list:' + name.toLowerCase());
  try { await env.DB.prepare('INSERT INTO beneficiaries(id,user_id,service,name,data,dedupe_key) VALUES(?,?,?,?,?,?)').bind(id, user.id, service, name, JSON.stringify(c.data), key).run(); }
  catch (e) { return fail(String(e.message).includes('UNIQUE') ? 'This is already saved.' : 'Could not save.', 409); }
  return json({ item: { id, name, data: c.data } });
};
FUNCTIONS['fav-update'] = async (x, env, user) => {
  const name = String(x.name || '').trim().slice(0, 30);
  if (!name) return fail('Enter a name.');
  const c = await env.DB.prepare('UPDATE beneficiaries SET name=? WHERE id=? AND user_id=?').bind(name, String(x.id || ''), user.id).run();
  return c.meta.changes === 1 ? json({ ok: true }) : fail('Not found.', 404);
};
FUNCTIONS['fav-delete'] = async (x, env, user) => {
  const c = await env.DB.prepare('DELETE FROM beneficiaries WHERE id=? AND user_id=?').bind(String(x.id || ''), user.id).run();
  return c.meta.changes === 1 ? json({ ok: true }) : fail('Not found.', 404);
};

/* ----- referral dashboard ----- */
const firstName = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] ? p[0] + (p[1] ? ' ' + p[1][0] + '.' : '') : 'User'; };
FUNCTIONS['referral-summary'] = async (x, env, user, req) => {
  const p = await env.DB.prepare('SELECT referral_code FROM profiles WHERE id=?').bind(user.id).first();
  const s = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN status='earned' THEN reward_amount END),0) earned, COALESCE(SUM(CASE WHEN status='pending' THEN reward_amount END),0) pending, COALESCE(SUM(CASE WHEN status='earned' AND date(earned_at)=date('now') THEN reward_amount END),0) today FROM referrals WHERE referrer_id=?").bind(user.id).first();
  const rows = (await env.DB.prepare("SELECT r.status, r.reward_amount, r.created_at, p.full_name FROM referrals r JOIN profiles p ON p.id=r.referee_id WHERE r.referrer_id=? AND r.status IN ('pending','earned') ORDER BY r.created_at DESC LIMIT 100").bind(user.id).all()).results;
  const code = p?.referral_code || '';
  return json({ enabled: env.REFERRAL_ENABLED !== '0', reward: cfgNum(env, 'REFERRAL_REWARD', 500), code, link: `${appBase(env, req)}/r/${code}`, total_earned: money(s.earned), pending: money(s.pending), today: money(s.today),
    items: rows.map((r) => ({ name: firstName(r.full_name), joined: r.created_at, status: r.status, reward: r.reward_amount })) });
};

/* ----- support ----- */
FUNCTIONS['support-ticket-create'] = async (x, env, user) => {
  const message = String(x.message || '').trim().slice(0, 1000), txId = x.txId ? String(x.txId).slice(0, 60) : null;
  if (message.length < 5) return fail('Please describe the problem (at least 5 characters).');
  if ((await env.DB.prepare("SELECT COUNT(*) n FROM support_tickets WHERE user_id=? AND created_at > datetime('now','-1 day')").bind(user.id).first()).n >= 5) return fail('You have sent many reports today. Please wait for our reply.');
  await env.DB.prepare('INSERT INTO support_tickets(id,user_id,tx_id,message) VALUES(?,?,?,?)').bind(uid(), user.id, txId, message).run();
  return json({ ok: true });
};

FUNCTIONS['send-otp'] = async (x, env, user) => {
  const phone = String(x.phone || '').trim();
  if (!validPhone(phone)) return fail('Enter a valid phone number.');
  const old = await env.DB.prepare('SELECT created_at FROM otps WHERE user_id=? AND phone=?').bind(user.id, phone).first();
  if (old && now() - old.created_at < 60) return fail('Please wait a minute before requesting another code.');
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const sms = await sendSms(env, phone, `Your ${env.APP_NAME || 'verification'} code is ${code}. It expires in 10 minutes.`);
  if (!sms.ok) return fail(sms.error || 'Could not send SMS.', 503);
  await env.DB.prepare('INSERT OR REPLACE INTO otps(user_id,phone,code_hash,expires_at,attempts,verified_until,created_at) VALUES(?,?,?,?,0,0,?)').bind(user.id, phone, await sha256(code + phone + user.id), now() + 600, now()).run();
  return json({ data: { sent: true } });
};
FUNCTIONS['verify-otp'] = async (x, env, user) => {
  const phone = String(x.phone || '').trim();
  const row = await env.DB.prepare('SELECT * FROM otps WHERE user_id=? AND phone=?').bind(user.id, phone).first();
  if (!x.finalize) {
    if (!row || row.expires_at < now()) return fail('Code expired. Request a new one.');
    if (row.attempts >= 5) return fail('Too many attempts. Request a new code.');
    if (!safeEq(await sha256(String(x.code || '') + phone + user.id), row.code_hash)) {
      await env.DB.prepare('UPDATE otps SET attempts=attempts+1 WHERE user_id=? AND phone=?').bind(user.id, phone).run();
      return fail('Wrong code.');
    }
    await env.DB.prepare('UPDATE otps SET verified_until=? WHERE user_id=? AND phone=?').bind(now() + 900, user.id, phone).run();
    return json({ data: { verified: true } });
  }
  // finalize: convert airtime to cash
  const net = String(x.network || '').toLowerCase(), amount = money(x.amount);
  if (!row || row.verified_until < now()) return fail('Phone number not verified. Start again.');
  if (!NETS.includes(net)) return fail('Select a network.');
  if (!(amount >= 500)) return fail('Minimum conversion amount is ₦500.');
  const pinErr = await verifyPin(env, user.id, x.pin);
  if (pinErr) return fail(pinErr);
  const claimed = await env.DB.prepare('UPDATE otps SET verified_until=0 WHERE user_id=? AND phone=? AND verified_until>=?').bind(user.id, phone, now()).run();
  if (claimed.meta.changes !== 1) return fail('Phone number not verified. Start again.');
  let res;
  try { res = await convertAirtimeToCash(env, { phone, network: net, amount }); } catch (e) { console.error(e); return fail('Your request is being processed. Check Transaction History.', 502); }
  if (!res.ok) return fail(res.error || 'Conversion failed.');
  const aId = uid();
  await env.DB.batch([
    env.DB.prepare('UPDATE profiles SET atc_balance=atc_balance+? WHERE id=?').bind(res.credited, user.id),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,wallet) VALUES(?,?,'airtime-to-cash',?,?,'in','successful',?,'atc')").bind(aId, user.id, `Airtime to Cash (${net.toUpperCase()} \u20a6${amount})`, res.credited, res.ref || null),
    env.DB.prepare("INSERT INTO wallet_ledger(id,user_id,wallet,direction,amount,ref,type,note) VALUES(?,?,'atc','in',?,?,'airtime-to-cash',?)").bind(uid(), user.id, res.credited, 'a2c-' + aId, `${net.toUpperCase()} airtime ${amount}`),
  ]);
  await notify(env, user.id, 'Airtime-to-Cash successful', `\u20a6${Number(res.credited).toLocaleString()} has been added to your Airtime-to-Cash Wallet.`);
  return json({ data: { credited: res.credited } });
};

/* ----------------------------------------------------------------- ADMIN */
FUNCTIONS['admin-manage-users'] = async (x, env, user) => {
  if (!user.is_admin) return fail('Admin permission required.', 403);
  const db = env.DB, target = String(x.userId || '');
  const log = (action, tgt, detail) => db.prepare('INSERT INTO admin_log(id,admin_id,action,target_id,detail) VALUES(?,?,?,?,?)').bind(uid(), user.id, action, tgt || null, detail ? String(detail).slice(0, 300) : null);
  const exists = async (id) => await db.prepare('SELECT id,is_admin FROM profiles WHERE id=?').bind(id).first();
  const page = (n) => Math.max(0, Math.floor(Number(n) || 0));
  const PAGE = 20;
  const USER_FILTER = { all: '1=1', banned: 'p.is_banned=1', admins: 'p.is_admin=1', funded: 'p.balance_ngn>0' };
  const TX_FILTER = { all: '1=1', pending: "t.status='pending'", successful: "t.status='successful'", failed: "t.status='failed'" };

  switch (x.action) {
    case 'stats': {
      const one = async (sql) => (await db.prepare(sql).first()) || {};
      const u = await one("SELECT COUNT(*) total, COALESCE(SUM(is_banned),0) banned, COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END),0) new_today, COALESCE(SUM(balance_ngn),0) wallets, COALESCE(SUM(atc_balance),0) atc, COALESCE(SUM(exchange_balance),0) ex FROM profiles");
      const f = await one("SELECT COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN amount END),0) today, COALESCE(SUM(amount),0) total FROM transactions WHERE type='fund' AND status='successful'");
      const p = await one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM transactions WHERE direction='out' AND status='successful' AND type NOT IN ('airtime-to-cash','withdrawal','adjustment') AND date(created_at)=date('now')");
      const q = await one("SELECT COUNT(*) n FROM transactions WHERE status='pending'");
      const wdp = await one("SELECT COUNT(*) n FROM withdrawals WHERE status IN ('pending','processing')");
      return json({ stats: { users: u.total, banned: u.banned, new_today: u.new_today, wallets_total: money(u.wallets), atc_total: money(u.atc), exchange_total: money(u.ex), withdrawals_pending: wdp.n, deposits_today: money(f.today), deposits_total: money(f.total), sales_today_count: p.n, sales_today_amount: money(p.amt), pending: q.n } });
    }
    case 'list_users': {
      const q = '%' + String(x.query || '').trim().toLowerCase() + '%', where = USER_FILTER[x.filter] || USER_FILTER.all;
      const cond = `(lower(p.full_name) LIKE ? OR p.username LIKE ? OR lower(u.email) LIKE ? OR p.phone LIKE ?) AND ${where}`;
      const rows = (await db.prepare(`SELECT p.id,p.full_name,p.username,u.email,p.phone,p.balance_ngn,p.atc_balance,p.is_banned,p.is_admin,p.created_at FROM profiles p JOIN users u ON u.id=p.id WHERE ${cond} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).bind(q, q, q, q, PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM profiles p JOIN users u ON u.id=p.id WHERE ${cond}`).bind(q, q, q, q).first()).n;
      return json({ users: rows, total, page_size: PAGE });
    }
    case 'search': // kept for older screens
      return FUNCTIONS['admin-manage-users']({ ...x, action: 'list_users' }, env, user);
    case 'get_user': {
      const u = await db.prepare('SELECT p.id,p.full_name,p.username,u.email,p.phone,p.balance_ngn,p.exchange_balance,p.atc_balance,p.is_banned,p.is_admin,p.referral_code,p.referral_code_used,p.pin_locked_until,p.created_at FROM profiles p JOIN users u ON u.id=p.id WHERE p.id=?').bind(target).first();
      if (!u) return fail('User not found.', 404);
      const va = await db.prepare('SELECT account_number,bank_name FROM virtual_accounts WHERE user_id=?').bind(target).first();
      const tot = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='fund' AND status='successful' THEN amount END),0) deposited, COALESCE(SUM(CASE WHEN direction='out' AND status='successful' AND type NOT IN ('airtime-to-cash','withdrawal','adjustment') THEN amount END),0) spent, COUNT(*) txs FROM transactions WHERE user_id=?").bind(target).first();
      const refs = await db.prepare('SELECT COUNT(*) n FROM referrals WHERE referrer_id=?').bind(target).first();
      const by = u.referral_code_used ? await db.prepare('SELECT username FROM profiles WHERE referral_code=?').bind(String(u.referral_code_used).toUpperCase()).first() : null;
      return json({ user: { ...u, pin_locked: u.pin_locked_until > now(), virtual_account: va || null, deposited: money(tot.deposited), spent: money(tot.spent), tx_count: tot.txs, referrals: refs.n, referred_by: by?.username || null } });
    }
    case 'update_user': {
      if (!await exists(target)) return fail('User not found.', 404);
      const name = String(x.fullName ?? '').trim(), phone = String(x.phone ?? '').trim(), username = String(x.username ?? '').trim().toLowerCase(), email = String(x.email ?? '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail('Username must be 3-20 letters, numbers or underscore.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
      try {
        await db.batch([
          db.prepare('UPDATE profiles SET full_name=?, phone=?, username=? WHERE id=?').bind(name, phone, username, target),
          db.prepare('UPDATE users SET email=? WHERE id=?').bind(email, target),
          log('update_user', target, `${name} | ${username} | ${email} | ${phone}`),
        ]);
      } catch (e) { return fail(String(e.message).includes('UNIQUE') ? 'That username or email is already used by another account.' : 'Could not update: ' + e.message, 409); }
      return json({ ok: true });
    }
    case 'adjust_balance': {
      const amount = money(x.amount), credit = x.direction === 'credit', wk = WALLET_COL[x.wallet] ? x.wallet : 'main', col = WALLET_COL[wk];
      const reason = String(x.reason || '').trim();
      if (!['credit', 'debit'].includes(x.direction)) return fail('Choose credit or debit.');
      if (!(amount > 0 && amount <= 10000000)) return fail('Enter a valid amount.');
      if (reason.length < 3) return fail('Write a reason (it is saved in the activity log).');
      if (!await exists(target)) return fail('User not found.', 404);
      const label = `Admin ${credit ? 'credit' : 'debit'}${wk !== 'main' ? ` (${WALLET_NAME[wk]})` : ''}: ${reason}`.slice(0, 120), txId = uid();
      const r = await db.batch([
        db.prepare(`UPDATE profiles SET ${col}=${col}${credit ? '+' : '-'}? WHERE id=?${credit ? '' : ` AND ${col}>=?`}`).bind(...(credit ? [amount, target] : [amount, target, amount])),
        db.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,wallet) SELECT ?,?,'adjustment',?,?,?,'successful',? WHERE changes() > 0").bind(txId, target, label, amount, credit ? 'in' : 'out', wk),
        ledgerIfChanged(env, { userId: target, wallet: wk, dir: credit ? 'in' : 'out', amount, ref: 'admin-' + txId, type: 'adjustment', note: reason }),
        log('adjust_balance', target, `${x.direction} ${amount} ${col}: ${reason}`),
      ]);
      if (r[0].meta.changes !== 1) return fail('The user does not have enough balance for this debit.');
      const nb = await db.prepare('SELECT balance_ngn, exchange_balance, atc_balance FROM profiles WHERE id=?').bind(target).first();
      return json({ ok: true, balance_ngn: nb.balance_ngn, exchange_balance: nb.exchange_balance, atc_balance: nb.atc_balance });
    }
    case 'reset_password': {
      if (String(x.newPassword || '').length < 6) return fail('Password must be at least 6 characters.');
      if (!await exists(target)) return fail('User not found.', 404);
      const salt = uid();
      await db.batch([db.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?').bind(await passwordHash(String(x.newPassword), salt), salt, target), log('reset_password', target)]);
      return json({ ok: true });
    }
    case 'reset_pin': {
      if (!/^\d{4}$/.test(String(x.newPin || ''))) return fail('PIN must be exactly 4 digits.');
      if (!await exists(target)) return fail('User not found.', 404);
      const salt = uid();
      await db.batch([db.prepare('UPDATE profiles SET transaction_pin_hash=?, transaction_pin_salt=?, pin_attempts=0, pin_locked_until=0 WHERE id=?').bind(await passwordHash(String(x.newPin), salt), salt, target), log('reset_pin', target)]);
      return json({ ok: true });
    }
    case 'ban': case 'unban': {
      const t = await exists(target);
      if (!t) return fail('User not found.', 404);
      if (x.action === 'ban' && target === user.id) return fail('You cannot ban yourself.');
      if (x.action === 'ban' && t.is_admin) return fail('Remove admin rights first, then ban.');
      await db.batch([db.prepare('UPDATE profiles SET is_banned=? WHERE id=?').bind(x.action === 'ban' ? 1 : 0, target), log(x.action, target, x.reason)]);
      return json({ ok: true });
    }
    case 'set_admin': {
      if (target === user.id) return fail('You cannot change your own admin rights.');
      if (!await exists(target)) return fail('User not found.', 404);
      await db.batch([db.prepare('UPDATE profiles SET is_admin=? WHERE id=?').bind(x.isAdmin ? 1 : 0, target), log(x.isAdmin ? 'make_admin' : 'remove_admin', target)]);
      return json({ ok: true });
    }
    case 'get_transactions': // one user's transactions
      return json({ transactions: (await db.prepare('SELECT id,type,label,amount,direction,status,created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(target).all()).results });
    case 'list_transactions': {
      const where = TX_FILTER[x.status] || TX_FILTER.all;
      const rows = (await db.prepare(`SELECT t.id,t.user_id,t.type,t.label,t.amount,t.direction,t.status,t.created_at,p.username,p.full_name FROM transactions t JOIN profiles p ON p.id=t.user_id WHERE ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).bind(PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM transactions t WHERE ${where}`).first()).n;
      return json({ transactions: rows, total, page_size: PAGE });
    }
    case 'resolve_transaction': {
      // For a transaction stuck on "pending": confirm it, or fail it (which refunds the customer).
      const t = await db.prepare("SELECT id,user_id,type,amount,direction,metadata FROM transactions WHERE id=? AND status='pending'").bind(String(x.txId || '')).first();
      if (!t) return fail('That transaction is no longer pending.', 404);
      const ok = x.resolution === 'success';
      if (!ok && x.resolution !== 'failed') return fail('Unknown resolution.');
      const guard = "EXISTS(SELECT 1 FROM transactions WHERE id=? AND status='pending')";
      const ops = [];
      if (ok && t.direction === 'in') ops.push(db.prepare(`UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND ${guard}`).bind(t.amount, t.user_id, t.id));
      if (!ok && t.direction === 'out') {
        const wallet = t.type === 'airtime-to-cash' ? 'atc_balance' : 'balance_ngn';
        const back = t.type === 'airtime-to-cash' ? (JSON.parse(t.metadata || '{}').gross ?? t.amount) : t.amount;
        ops.push(db.prepare(`UPDATE profiles SET ${wallet}=${wallet}+? WHERE id=? AND ${guard}`).bind(back, t.user_id, t.id));
      }
      ops.push(db.prepare("UPDATE transactions SET status=? WHERE id=? AND status='pending'").bind(ok ? 'successful' : 'failed', t.id));
      ops.push(log('resolve_transaction', t.user_id, `${t.id} -> ${ok ? 'successful' : 'failed (refunded)'}`));
      await db.batch(ops);
      return json({ ok: true });
    }
    case 'get_settings': {
      const map = await loadSettings(env);
      const items = Object.entries(SETTINGS).map(([key, d]) => {
        const inDb = map[key] !== undefined && map[key] !== '';
        const fromEnv = !inDb && env[d.env] !== undefined && env[d.env] !== '';
        const source = inDb ? 'database' : (fromEnv ? 'cloudflare' : 'default');
        const base = { key, label: d.label, group: d.group, type: d.type, hint: d.hint || '', source, ...(d.type === 'currencies' ? { choices: Object.entries(X_CURRENCIES).map(([code, c]) => ({ code, country: c.country })) } : {}) };
        if (d.type === 'secret') return { ...base, is_set: inDb || fromEnv };   // the key itself is never sent back
        return { ...base, value: inDb ? map[key] : (fromEnv ? String(env[d.env]) : d.def) };
      });
      return json({ items, keys_can_be_saved: authSecretOk(env) });
    }
    case 'save_settings': {
      const vals = x.values && typeof x.values === 'object' ? x.values : {};
      const updates = [], changed = [];
      for (const [k, raw] of Object.entries(vals)) {
        const def = SETTINGS[k];
        if (!def) return fail('Unknown setting: ' + k);
        if (def.type === 'secret' && String(raw ?? '').trim() === '') continue;      // empty key box = keep the current key
        const v = validateSetting(def, raw);
        if (v === null) return fail(`Invalid value for "${def.label}".`);
        if (def.type === 'secret') {
          if (!authSecretOk(env)) return fail('AUTH_SECRET must be set in Cloudflare (32+ characters) before keys can be saved here.');
          updates.push([k, await encryptSetting(env, v)]); changed.push(`${k} (key replaced)`);
        } else { updates.push([k, v]); changed.push(`${k}=${v}`); }
      }
      const valueOf = (k) => { const u = updates.find((a) => a[0] === k); return u ? u[1] : (env[SETTINGS[k].env] ?? SETTINGS[k].def); };
      if (Number(valueOf('exchange_min_amount')) > Number(valueOf('exchange_max_amount'))) return fail('The minimum amount cannot be higher than the maximum.');
      if (!updates.length) return json({ ok: true, changed: [] });
      await db.batch([
        ...updates.map(([k, v]) => db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP').bind(k, v)),
        log('save_settings', null, changed.join(', ')),
      ]);
      settingsCache.at = 0; clearProviderCaches();   // new prices and keys apply immediately
      return json({ ok: true, changed });
    }
    case 'list_remittances': {
      const f = { attention: "r.status IN ('amount_mismatch')", credited: "r.status='credited'", all: '1=1' }[x.filter] || '1=1';
      const rows = (await db.prepare(`SELECT r.id,r.currency,r.source_amount,r.receive_ngn,r.status,r.error,r.created_at,p.username FROM remittances r JOIN profiles p ON p.id=r.user_id WHERE ${f} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).bind(PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM remittances r WHERE ${f}`).first()).n;
      return json({ items: rows, total, page_size: PAGE });
    }
    case 'mark_refunded': { // a payment that did not match: after you refunded the customer in the Flutterwave dashboard
      const c = await db.prepare("UPDATE remittances SET status='refunded', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='amount_mismatch'").bind(String(x.id || '')).run();
      if (c.meta.changes !== 1) return fail('This exchange cannot be marked as refunded.');
      await db.prepare("UPDATE transactions SET status='failed' WHERE id=? AND status='pending'").bind(String(x.id)).run();
      await log('mark_refunded', null, String(x.id)).run();
      return json({ ok: true });
    }
    case 'list_withdrawals': {
      const f = { attention: "w.status IN ('pending','processing')", all: '1=1' }[x.filter] || '1=1';
      const rows = (await db.prepare(`SELECT w.id,w.wallet,w.amount,w.fee,w.net,w.bank_name,w.account_number,w.account_name,w.status,w.error,w.created_at,p.username FROM withdrawals w JOIN profiles p ON p.id=w.user_id WHERE ${f} ORDER BY w.created_at DESC LIMIT ? OFFSET ?`).bind(PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM withdrawals w WHERE ${f}`).first()).n;
      return json({ items: rows.map((r) => ({ ...r, account_number: maskAcct(r.account_number) })), total, page_size: PAGE });
    }
    case 'resolve_withdrawal': { // a withdrawal stuck on pending/processing: check Flutterwave first, then settle it here
      const id = String(x.id || '');
      if (x.resolution === 'reverse') { const ok = await reverseWithdrawal(env, id, 'Reversed by admin'); if (!ok) return fail('This withdrawal is no longer pending.', 404); await log('reverse_withdrawal', null, id).run(); return json({ ok: true }); }
      if (x.resolution !== 'success') return fail('Unknown resolution.');
      const wd = await db.prepare('SELECT user_id,net FROM withdrawals WHERE id=?').bind(id).first();
      const c = await db.prepare("UPDATE withdrawals SET status='successful', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','processing')").bind(id).run();
      if (c.meta.changes !== 1) return fail('This withdrawal is no longer pending.', 404);
      await db.prepare("UPDATE transactions SET status='successful' WHERE id=?").bind(id).run();
      await notify(env, wd.user_id, 'Withdrawal successful', `\u20a6${Number(wd.net).toLocaleString()} has been sent to your bank account.`);
      await log('confirm_withdrawal', null, id).run();
      return json({ ok: true });
    }
    case 'list_referrals': {
      const f = { pending: "r.status='pending'", earned: "r.status='earned'", void: "r.status='void'", all: '1=1' }[x.filter] || '1=1';
      const rows = (await db.prepare(`SELECT r.id,r.status,r.reward_amount,r.code,r.created_at,r.earned_at,a.username referrer,b.username referee FROM referrals r JOIN profiles a ON a.id=r.referrer_id JOIN profiles b ON b.id=r.referee_id WHERE ${f} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).bind(PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM referrals r WHERE ${f}`).first()).n;
      const s = await db.prepare("SELECT COALESCE(SUM(CASE WHEN status='earned' THEN reward_amount END),0) paid, COALESCE(SUM(CASE WHEN status='pending' THEN reward_amount END),0) waiting FROM referrals").first();
      return json({ items: rows, total, page_size: PAGE, paid: money(s.paid), waiting: money(s.waiting) });
    }
    case 'void_referral': {
      const c = await db.prepare("UPDATE referrals SET status='void' WHERE id=? AND status='pending'").bind(String(x.id || '')).run();
      if (c.meta.changes !== 1) return fail('Only a pending referral can be cancelled.');
      await log('void_referral', null, String(x.id)).run();
      return json({ ok: true });
    }
    case 'verify_receipt': { // check a receipt a customer sends: reference + hash must belong together
      const ref = String(x.ref || '').trim(), h = String(x.hash || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
      if (!ref) return fail('Enter the transaction reference.');
      const t = await db.prepare('SELECT t.*, p.username FROM transactions t JOIN profiles p ON p.id=t.user_id WHERE t.id=? OR t.provider_ref=? LIMIT 1').bind(ref, ref).first();
      if (!t) return fail('No transaction has this reference.', 404);
      const full = await txHash(env, t);
      return json({ hash_given: h.length > 0, hash_match: h.length >= 16 && full.startsWith(h), transaction: { id: t.id, type: t.type, label: t.label, amount: t.amount, direction: t.direction, status: t.status, wallet: t.wallet, created_at: t.created_at, user: t.username } });
    }
    case 'list_tickets': {
      const f = { open: "s.status='open'", closed: "s.status='closed'", all: '1=1' }[x.filter] || "s.status='open'";
      const rows = (await db.prepare(`SELECT s.id,s.tx_id,s.message,s.status,s.created_at,p.username FROM support_tickets s JOIN profiles p ON p.id=s.user_id WHERE ${f} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).bind(PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM support_tickets s WHERE ${f}`).first()).n;
      return json({ items: rows, total, page_size: PAGE });
    }
    case 'close_ticket': {
      const c = await db.prepare("UPDATE support_tickets SET status='closed' WHERE id=? AND status='open'").bind(String(x.id || '')).run();
      return c.meta.changes === 1 ? json({ ok: true }) : fail('Ticket not found.', 404);
    }
    case 'check_transaction': { // ask VTUAgent what happened to a pending purchase
      const t = await db.prepare("SELECT id,created_at FROM transactions WHERE id=? AND status='pending' AND type IN ('data','airtime','cable','electricity')").bind(String(x.txId || '')).first();
      if (!t) return fail('This transaction is not a pending VTU purchase.', 404);
      try { const state = await reconcileTx(env, t); await log('check_transaction', null, `${t.id} -> ${state}`).run(); return json({ ok: true, state }); }
      catch (e) { return fail('Could not reach VTUAgent: ' + String(e.message || e), 502); }
    }
    case 'setup_webhook': {
      const origin = String(x.origin || '');
      if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)) return fail('Open the admin panel from your https address first.');
      try { const r = await setWebhook(env, origin + '/api/webhook/vtuagent'); if (!r.ok) return fail(r.error, 502); await log('setup_webhook', null, origin).run(); return json({ ok: true }); }
      catch (e) { return fail('Could not reach VTUAgent: ' + String(e.message || e), 502); }
    }
    case 'get_log': {
      const rows = (await db.prepare('SELECT l.action,l.detail,l.created_at,a.username admin,t.username target FROM admin_log l LEFT JOIN profiles a ON a.id=l.admin_id LEFT JOIN profiles t ON t.id=l.target_id ORDER BY l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?').bind(PAGE * 2, page(x.offset)).all()).results;
      return json({ log: rows });
    }
  }
  return fail('Unknown action.');
};

async function profitSummary(env) {
  const base = "FROM transactions WHERE status='successful' AND direction='out' AND json_extract(metadata,'$.cost') IS NOT NULL";
  const p = "(amount - json_extract(metadata,'$.cost'))";
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN ${p} END),0) today,
    COALESCE(SUM(CASE WHEN date(created_at)>=date('now','-6 days','weekday 1') THEN ${p} END),0) this_week,
    COALESCE(SUM(CASE WHEN strftime('%Y-%m',created_at)=strftime('%Y-%m','now') THEN ${p} END),0) this_month,
    COALESCE(SUM(${p}),0) all_time ${base}`).first();
  return Object.entries(row).map(([period, profit]) => ({ period, profit: money(profit) }));
}

/* ------------------------------------------------------------------ SETTINGS (kept in the database) */
// Everything the owner may want to change lives in the database and is edited in Admin Panel -> Settings.
// The database is NOT touched by deploys, so these values never disappear when wrangler.toml changes.
// A value saved here wins over a Cloudflare variable; if nothing is saved here, the Cloudflare variable (or the default) is used.
const SETTINGS = {
  exchange_enabled:     { env: 'EXCHANGE_ENABLED',     type: 'bool',   group: 'Exchange', label: 'Exchange', def: '0', hint: 'Turn the Exchange feature on or off' },
  exchange_currencies:  { env: 'EXCHANGE_CURRENCIES',  type: 'currencies', group: 'Exchange', label: 'Countries / currencies customers can pay in', def: X_DEFAULT_CURRENCIES, hint: 'Open a currency only after Flutterwave confirms it on your account' },
  exchange_fee_percent: { env: 'EXCHANGE_FEE_PERCENT', type: 'number', group: 'Exchange', label: 'Total fee (%)', def: '10', min: 0, max: 50, hint: 'Default 10' },
  exchange_min_amount:  { env: 'EXCHANGE_MIN_AMOUNT',  type: 'number', group: 'Exchange', label: 'Minimum per transfer (USD, other currencies converted)', def: '5', min: 0.5, max: 1000000, hint: 'Default 5' },
  exchange_max_amount:  { env: 'EXCHANGE_MAX_AMOUNT',  type: 'number', group: 'Exchange', label: 'Maximum per transfer (USD, other currencies converted)', def: '100', min: 0.5, max: 1000000, hint: 'Default 100' },
  exchange_daily_count: { env: 'EXCHANGE_DAILY_COUNT', type: 'number', group: 'Exchange', label: 'Transfers allowed per user per day', def: '3', min: 1, max: 100, int: true, hint: 'Default 3' },
  price_markup_percent: { env: 'PRICE_MARKUP_PERCENT', type: 'number', group: 'Pricing',  label: 'Markup on data and cable (%)', def: '12', min: 0, max: 100, hint: 'Default 12' },
  sms_price_per_unit:   { env: 'SMS_PRICE_PER_UNIT',   type: 'number', group: 'Pricing',  label: 'Bulk SMS price per page (naira)', def: '', min: 0, max: 100000, allowEmpty: true, hint: 'Empty = Bulk SMS closed' },
  sms_cost_per_unit:    { env: 'SMS_COST_PER_UNIT',    type: 'number', group: 'Pricing',  label: 'Bulk SMS cost per page (naira)', def: '', min: 0, max: 100000, allowEmpty: true, hint: 'Optional, for profit' },
  withdraw_fee_flat:    { env: 'WITHDRAW_FEE_FLAT',    type: 'number', group: 'Withdrawals', label: 'Withdrawal fee (naira, taken from the amount)', def: '0', min: 0, max: 100000, hint: 'Default 0' },
  withdraw_min_amount:  { env: 'WITHDRAW_MIN_AMOUNT',  type: 'number', group: 'Withdrawals', label: 'Minimum withdrawal (naira)', def: '1000', min: 100, max: 10000000, hint: 'Default 1000' },
  referral_enabled:     { env: 'REFERRAL_ENABLED',     type: 'bool',   group: 'Referral', label: 'Referral rewards', def: '1', hint: 'When off, nobody earns new rewards (pending ones wait)' },
  referral_reward:      { env: 'REFERRAL_REWARD',      type: 'number', group: 'Referral', label: 'Reward per referral (naira, paid to the Main Wallet)', def: '500', min: 0, max: 100000, hint: 'Default 500' },
  referral_min_purchase:{ env: 'REFERRAL_MIN_PURCHASE',type: 'number', group: 'Referral', label: 'Smallest first purchase that earns the reward (naira)', def: '0', min: 0, max: 1000000, hint: 'Default 0. A small minimum such as 100 helps stop fake accounts' },
  app_url:              { env: 'APP_URL',              type: 'url',    group: 'App', label: 'Website address used in referral links', def: '', allowEmpty: true, hint: 'For example https://umarshoyi.com. Empty = this website' },
  service_notice_on:    { env: 'SERVICE_NOTICE_ON',    type: 'bool',   group: 'App', label: 'Show the "Service Update" card on Home', def: '1' },
  service_notice:       { env: 'SERVICE_NOTICE',       type: 'text',   group: 'App', label: 'Service Update message', def: 'Some services may be undergoing maintenance.', maxLen: 200 },
  support_whatsapp:     { env: 'SUPPORT_WHATSAPP',     type: 'text',   group: 'App', label: 'Support WhatsApp number (digits only)', def: '', allowEmpty: true, pattern: /^\d{8,15}$/, hint: 'For example 2348012345678' },
  support_email:        { env: 'SUPPORT_EMAIL',        type: 'text',   group: 'App', label: 'Support email address', def: '', allowEmpty: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, hint: 'For example support@yourdomain.com' },
  flw_secret_key:       { env: 'FLW_SECRET_KEY',       type: 'secret', group: 'Keys', label: 'Flutterwave secret key', minLen: 10 },
  flw_webhook_hash:     { env: 'FLW_WEBHOOK_HASH',     type: 'secret', group: 'Keys', label: 'Flutterwave webhook secret hash', minLen: 16 },
  vtuagent_api_key:     { env: 'VTUAGENT_API_KEY',     type: 'secret', group: 'Keys', label: 'VTUAgent API key', minLen: 8 },
};
const authSecretOk = (env) => String(env.AUTH_SECRET || '').length >= 32;
async function settingsKey(env) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc('settings-v1:' + env.AUTH_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function encryptSetting(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return 'enc1:' + b64(iv) + ':' + b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await settingsKey(env), enc(text)));
}
async function decryptSetting(env, value) {
  try { const [tag, iv, ct] = String(value).split(':'); if (tag !== 'enc1') return null; return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await settingsKey(env), unb64(ct))); }
  catch { return null; }   // wrong AUTH_SECRET or damaged value: treated as "not set"
}
let settingsCache = { at: 0, map: null };
async function loadSettings(env) {
  if (settingsCache.map && Date.now() - settingsCache.at < 15000) return settingsCache.map;
  const rows = (await env.DB.prepare('SELECT key,value FROM app_settings').all()).results, map = {};
  for (const r of rows) {
    const def = SETTINGS[r.key]; if (!def) continue;
    if (def.type === 'secret') { if (authSecretOk(env)) { const v = await decryptSetting(env, r.value); if (v) map[r.key] = v; } }
    else map[r.key] = r.value;
  }
  settingsCache = { at: Date.now(), map };
  return map;
}
async function withSettings(env) {   // the env the rest of the code sees: Cloudflare variables overridden by saved settings
  const map = await loadSettings(env), over = {};
  for (const [k, d] of Object.entries(SETTINGS)) if (map[k] !== undefined && map[k] !== '') over[d.env] = map[k];
  return Object.keys(over).length ? { ...env, ...over } : env;
}
function validateSetting(def, raw) {   // returns the cleaned value, or null when invalid
  const v = String(raw ?? '').trim();
  if (def.type === 'bool') return v === '1' || v === '0' ? v : null;
  if (def.type === 'text' || def.type === 'url') {
    if (v === '') return def.allowEmpty ? '' : null;
    if (v.length > (def.maxLen || 200) || /[<>]/.test(v)) return null;
    if (def.type === 'url' && !/^https:\/\/[^\s]+$/.test(v)) return null;
    if (def.pattern && !def.pattern.test(v)) return null;
    return v;
  }
  if (def.type === 'currencies') {
    const list = [...new Set(v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
    return list.length && list.every((s) => X_CURRENCIES[s]) ? list.join(',') : null;
  }
  if (def.type === 'number') {
    if (v === '') return def.allowEmpty ? '' : null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < def.min || n > def.max || (def.int && !Number.isInteger(n))) return null;
    return String(n);
  }
  return v.length >= def.minLen && v.length <= 200 && !/\s/.test(v) ? v : null;
}

/* ----------------------------------------------------------------- ROUTER */
async function route(req, env) {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (method === 'OPTIONS') return json({ ok: true });
  await ensureSchema(env);
  env = await withSettings(env);

  if (path === '/api/health') return json({ ok: true, service: env.APP_NAME || 'Worker', database: 'connected', auth: String(env.AUTH_SECRET || '').length >= 32, flutterwave: !!env.FLW_SECRET_KEY, vtuagent: !!env.VTUAGENT_API_KEY, webhook: String(env.FLW_WEBHOOK_HASH || '').length >= 16 });
  if (path === '/api/payment/return' && method === 'GET') return paymentReturn(req, env);
  if (path === '/api/webhook/flutterwave' && method === 'POST') return flutterwaveWebhook(req, env);
  if (path === '/api/webhook/vtuagent' && method === 'POST') return vtuagentWebhook(req, env);

  if (path === '/api/referral/check' && method === 'GET') {   // public: lets the sign-up form say whether a code is valid
    const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const valid = /^USS\d{4,6}$/.test(code) && !!(await env.DB.prepare('SELECT 1 FROM profiles WHERE referral_code=?').bind(code).first());
    return json({ valid, enabled: env.REFERRAL_ENABLED !== '0' });
  }

  if (path.startsWith('/api/auth/') && !env.AUTH_SECRET) return fail('AUTH_SECRET is not configured in Cloudflare Worker secrets.', 503);
  if (path.startsWith('/api/auth/') && String(env.AUTH_SECRET).length < 32) return fail('AUTH_SECRET is too weak. Use a random value of at least 32 characters.', 503);
  if (path === '/api/auth/signup' && method === 'POST') return signup(req, env);
  if (path === '/api/auth/login' && method === 'POST') return login(req, env);

  const user = await authUser(req, env);
  if (path === '/api/auth/session') return json({ session: user ? { access_token: (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), user: { id: user.id, email: user.email } } : null });
  if (path === '/api/auth/logout') return json({ ok: true });
  if (!user) return fail('Please log in again.', 401);
  if (user.is_banned) return fail('Your account has been suspended. Contact support.', 403);

  if (path === '/api/auth/password' && method === 'PATCH') {
    const x = await body(req);
    if (String(x.password || '').length < 6) return fail('Password must be at least 6 characters.');
    const salt = uid();
    await env.DB.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?').bind(await passwordHash(String(x.password), salt), salt, user.id).run();
    return json({ data: { user: { id: user.id, email: user.email } } });
  }

  if (path.startsWith('/api/table/') && method === 'POST') {
    const table = path.split('/').pop(), x = await body(req);
    if (!['profiles', 'transactions', 'notifications'].includes(table)) return fail('Table not allowed.');
    if (table === 'notifications' && x.action === 'insert') {
      if (!user.is_admin) return fail('Admin permission required.', 403);
      const v = x.values || {};
      if (!String(v.title || '').trim() || !String(v.message || '').trim()) return fail('Title and message are required.');
      await env.DB.prepare('INSERT INTO notifications(id,title,message) VALUES(?,?,?)').bind(uid(), String(v.title), String(v.message)).run();
      return json({ data: { ok: true } });
    }
    if (x.action === 'update' && table === 'profiles') {
      const v = x.values || {};
      await env.DB.prepare('UPDATE profiles SET full_name=COALESCE(?,full_name), phone=COALESCE(?,phone) WHERE id=?').bind(v.full_name ?? null, v.phone ?? null, user.id).run();
      return json({ data: { ok: true } });
    }
    if (x.action && x.action !== 'select') return fail('Not allowed.', 403);
    let rows = [];
    if (table === 'profiles') rows = [await env.DB.prepare(`SELECT ${SAFE_PROFILE} FROM profiles WHERE id=?`).bind(user.id).first()].filter(Boolean);
    if (table === 'transactions') rows = (await env.DB.prepare('SELECT id,user_id,type,label,amount,direction,status,provider_ref,created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all()).results;
    if (table === 'notifications') rows = (await env.DB.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all()).results;
    for (const [k, v] of (x.filters || [])) rows = rows.filter((r) => String(r[k]) === String(v));
    if (x.order) rows.sort((a, b) => String(a[x.order[0]] ?? '').localeCompare(String(b[x.order[0]] ?? '')) * (x.order[1] ? 1 : -1));
    if (x.limit) rows = rows.slice(0, x.limit);
    if (x.columns && x.columns !== '*') { const cols = x.columns.split(',').map((c) => c.trim()); rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))); }
    return json({ data: rows });
  }

  if (path.startsWith('/api/rpc/') && method === 'POST') {
    const name = path.split('/').pop(), x = await body(req);
    if (name === 'verify_transaction_pin') return json({ data: (await verifyPin(env, user.id, x.p_pin)) === null });
    if (name === 'update_transaction_pin') {
      if (!/^\d{4}$/.test(String(x.p_new_pin || ''))) return fail('PIN must be exactly 4 digits.');
      const err = await verifyPin(env, user.id, x.p_old_pin);
      if (err) return fail(err);
      const salt = uid();
      await env.DB.prepare('UPDATE profiles SET transaction_pin_hash=?, transaction_pin_salt=? WHERE id=?').bind(await passwordHash(String(x.p_new_pin), salt), salt, user.id).run();
      return json({ data: true });
    }
    if (name === 'get_profit_summary') return user.is_admin ? json({ data: await profitSummary(env) }) : fail('Not authorized.', 403);
    return fail('RPC not found.', 404);
  }

  if (path === '/api/profile' && method === 'GET') return json({ data: await env.DB.prepare(`SELECT ${SAFE_PROFILE} FROM profiles WHERE id=?`).bind(user.id).first() });
  if (path === '/api/functions/initiate-payment' && method === 'POST') {
    // Wallet funding is by bank transfer to the user's own account number only. Card payments belong to Exchange.
    if (env.CARD_FUNDING_ENABLED !== '1') return fail('Wallet funding is by bank transfer only. Use your account number on the Fund Wallet screen.');
    return initiatePayment(req, env, user);
  }
  if (path === '/api/functions/get-virtual-account' && method === 'POST') return virtualAccount(req, env, user);
  if (path.startsWith('/api/functions/') && method === 'POST') {
    const fn = FUNCTIONS[path.split('/').pop()];
    return fn ? fn(await body(req), env, user, req) : fail('Unknown service.', 404);
  }
  return fail('Not found', 404);
}

export default {
  async fetch(req, env) {
    try {
      const pathname = new URL(req.url).pathname, link = pathname.match(/^\/r\/([A-Za-z0-9]{3,12})\/?$/);
      if (link) return Response.redirect(new URL('/?ref=' + link[1].toUpperCase(), req.url).toString(), 302);   // referral link -> sign-up with the code filled in
      if (pathname.startsWith('/api/')) return await route(req, env);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return fail('Server error: ' + String(e?.message || e), 500);
    }
  },
  // Runs every few minutes (Cron Trigger): settles purchases that are still pending.
  async scheduled(event, env, ctx) { await ensureSchema(env); ctx.waitUntil(reconcilePending(await withSettings(env))); },
};
