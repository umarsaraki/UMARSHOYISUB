// UMARSHOYI-SUB — Cloudflare Worker (D1 database)
// Auth, wallet, Flutterwave funding (+webhook, virtual account), purchases, OTP,
// airtime-to-cash withdrawals and admin tools. The VTU provider lives in provider.js.
import { runProvider, sendSms, convertAirtimeToCash, getDataPlans, getCablePlans, CABLE_PROVIDERS, verifySmartcard, verifyMeter, checkStatus, setWebhook, webhookHashOk } from './provider.js';
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
  `CREATE TABLE IF NOT EXISTS admin_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];
// For databases created by the older worker: add columns that are missing.
const MIGRATIONS = [
  `ALTER TABLE profiles ADD COLUMN atc_balance REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE profiles ADD COLUMN pin_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE profiles ADD COLUMN pin_locked_until INTEGER NOT NULL DEFAULT 0`,
];
const SAFE_PROFILE = 'id,full_name,username,phone,referral_code,referral_code_used,balance_ngn,atc_balance,is_admin,is_banned,created_at';

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
  schemaReady = true;
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
  try {
    const hash = await passwordHash(password, salt), pinHash = await passwordHash(pin, pinSalt);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)').bind(id, email, hash, salt),
      env.DB.prepare('INSERT INTO profiles(id,full_name,username,phone,referral_code_used,referral_code,transaction_pin_hash,transaction_pin_salt,is_admin) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(id, String(meta.full_name || '').trim(), username, String(meta.phone || '').trim(), String(meta.referral_code_used || '').trim(), 'UMS' + crypto.randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase(), pinHash, pinSalt, isAdminEmail(env, email) ? 1 : 0),
    ]);
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

// Refer & Earn: when a referred user makes their FIRST deposit, the referrer gets N10 per N1,000 deposited.
async function referralBonus(env, userId, amount) {
  const bonus = Math.floor(amount / 1000) * 10;
  if (bonus <= 0) return;
  const me = await env.DB.prepare('SELECT referral_code_used c FROM profiles WHERE id=?').bind(userId).first();
  if (!me?.c) return;
  const first = await env.DB.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id=? AND type='fund' AND status='successful'").bind(userId).first();
  if (first.n !== 1) return;                                   // only the first deposit counts
  const ref = await env.DB.prepare('SELECT id FROM profiles WHERE referral_code=?').bind(String(me.c).trim().toUpperCase()).first();
  if (!ref || ref.id === userId) return;
  const key = 'refbonus-' + userId;
  await env.DB.batch([
    env.DB.prepare('UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND NOT EXISTS(SELECT 1 FROM transactions WHERE provider_ref=?)').bind(bonus, ref.id, key),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref) SELECT ?,?,'referral-bonus','Referral bonus',?,'in','successful',? WHERE NOT EXISTS(SELECT 1 FROM transactions WHERE provider_ref=?)").bind(uid(), ref.id, bonus, key, key),
  ]);
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
    const credited = r[1].meta.changes === 1;
    if (credited) await referralBonus(env, pending.user_id, pending.amount);
    return { ok: true, credited };
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
  const credited = r[0].meta.changes === 1;
  if (credited) await referralBonus(env, userId, paid);
  return { ok: true, credited };
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
    await env.DB.prepare("UPDATE remittances SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE tx_ref=? AND status='awaiting_payment'").bind(txRef).run();
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

async function settlePurchase(env, txId, outcome, extra = {}) {
  const t = await env.DB.prepare("SELECT id,user_id,amount FROM transactions WHERE id=? AND status='pending'").bind(txId).first();
  if (!t) return false;                                   // already settled: nothing to do (safe to call twice)
  if (outcome === 'success') {
    const r = await env.DB.prepare("UPDATE transactions SET status='successful', provider_ref=COALESCE(?,provider_ref) WHERE id=? AND status='pending'").bind(extra.ref ?? null, txId).run();
    return r.meta.changes === 1;
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
async function settleTransfer(env, reference, status) {
  if (reference.startsWith('UMSXP-')) return settleRemittanceTransfer(env, reference, status);
  const t = await env.DB.prepare("SELECT id,user_id,amount,metadata FROM transactions WHERE provider_ref=? AND status='pending'").bind(reference).first();
  if (!t) return;
  if (status === 'SUCCESSFUL') { await env.DB.prepare("UPDATE transactions SET status='successful' WHERE id=? AND status='pending'").bind(t.id).run(); return; }
  if (status === 'FAILED') {
    const gross = JSON.parse(t.metadata || '{}').gross ?? t.amount;
    await env.DB.batch([
      env.DB.prepare("UPDATE profiles SET atc_balance=atc_balance+? WHERE id=? AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status='pending')").bind(gross, t.user_id, t.id),
      env.DB.prepare("UPDATE transactions SET status='failed' WHERE id=? AND status='pending'").bind(t.id),
    ]);
  }
}
FUNCTIONS['atc-withdraw'] = async (x, env, user) => {
  if (x.action === 'get_banks') {
    if (!bankCache) {
      if (!env.FLW_SECRET_KEY) return fail('Bank list is not available yet.', 503);
      const r = await flw(env, 'GET', '/banks/NG');
      if (!r.ok) return fail('Could not load banks.', 502);
      bankCache = r.data.data.map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name));
    }
    return json({ banks: bankCache });
  }
  const p = await env.DB.prepare('SELECT atc_balance FROM profiles WHERE id=?').bind(user.id).first();
  const amount = money(p?.atc_balance || 0);
  if (amount <= 0) return fail('No Airtime-to-Cash balance to withdraw.');

  if (x.action === 'to_wallet') {
    const r = await env.DB.batch([
      env.DB.prepare('UPDATE profiles SET atc_balance=atc_balance-?, balance_ngn=balance_ngn+? WHERE id=? AND atc_balance>=?').bind(amount, amount, user.id, amount),
      env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status) SELECT ?,?,'airtime-to-cash','Airtime-to-Cash moved to wallet',?,'in','successful' WHERE changes() > 0").bind(uid(), user.id, amount),
    ]);
    if (r[0].meta.changes !== 1) return fail('Balance changed. Please try again.');
    return json({ data: { amount } });
  }
  if (x.action === 'to_bank') {
    const bankCode = String(x.bankCode || ''), acct = String(x.accountNumber || '');
    const fee = money(env.ATC_BANK_FEE || 0), net = money(amount - fee);
    if (!bankCode || !/^\d{10}$/.test(acct)) return fail('Select a bank and enter a valid 10-digit account number.');
    if (net <= 0) return fail('Balance is too small to withdraw.');
    if (!env.FLW_SECRET_KEY) return fail('Bank withdrawals are not set up yet.', 503);
    const ref = 'UMSW-' + uid(), txId = uid();
    const r = await env.DB.batch([
      env.DB.prepare('UPDATE profiles SET atc_balance=atc_balance-? WHERE id=? AND atc_balance>=?').bind(amount, user.id, amount),
      env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,metadata) SELECT ?,?,'airtime-to-cash',?,?,'out','pending',?,? WHERE changes() > 0").bind(txId, user.id, `Withdrawal to bank ${acct}`, net, ref, JSON.stringify({ gross: amount, fee })),
    ]);
    if (r[0].meta.changes !== 1) return fail('Balance changed. Please try again.');
    const t = await flw(env, 'POST', '/transfers', { account_bank: bankCode, account_number: acct, amount: net, currency: 'NGN', reference: ref, narration: (env.APP_NAME || 'Withdrawal') + ' withdrawal', debit_currency: 'NGN' });
    if (!t.ok) { await settleTransfer(env, ref, 'FAILED'); return fail(t.data.message || 'Transfer failed. Your balance was restored.', 502); }
    return json({ data: { amount: net } }); // final status arrives by webhook (transfer.completed)
  }
  return fail('Unknown action.');
};


/* ------------------------------------------------------------------ EXCHANGE (send money to Nigeria) */
// Customer pays by card in USD/GBP/EUR (Flutterwave checkout). After Flutterwave confirms the payment,
// the naira is paid straight to the recipient's bank account (Flutterwave Transfers). No wallet balance is held.
// Turned OFF by default. Turn on with EXCHANGE_ENABLED = "1" only after Flutterwave has approved this on your account.
const XCUR = ['USD', 'GBP', 'EUR'];
const xCfg = (env) => ({
  enabled: env.EXCHANGE_ENABLED === '1',
  feePct: Number(env.EXCHANGE_FEE_PERCENT ?? 10),
  min: Number(env.EXCHANGE_MIN_AMOUNT ?? 5),
  max: Number(env.EXCHANGE_MAX_AMOUNT ?? 100),
  dailyCount: Number(env.EXCHANGE_DAILY_COUNT ?? 3),
});
const rateCache = {};
async function fxRate(env, currency) { // NGN per 1 unit of `currency`, from Flutterwave's transfer-rate estimate (cached 5 minutes)
  const hit = rateCache[currency];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.rate;
  const r = await flw(env, 'GET', `/transfers/rates?amount=100000&destination_currency=NGN&source_currency=${currency}`);
  const rate = Number(r.data?.data?.rate);
  if (!r.ok || !(rate > 1)) { if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.rate; throw new Error('Rate unavailable'); }
  rateCache[currency] = { at: Date.now(), rate };
  return rate;
}
async function xQuote(env, currency, amount) {
  const c = xCfg(env), rate = await fxRate(env, currency);
  const fee = money(amount * c.feePct / 100), net = money(amount - fee);
  return { currency, amount, rate, fee_percent: c.feePct, fee_amount: fee, net_amount: net, receive_ngn: Math.floor(net * rate) };
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
  const amount = money(x.amount);
  if (!XCUR.includes(String(x.currency))) return 'Choose USD, GBP or EUR.';
  if (!(amount >= c.min && amount <= c.max)) return `Amount must be between ${c.min} and ${c.max} ${x.currency}.`;
  return null;
};

// Card payment confirmed -> mark as paid ONCE -> send the naira.
async function settleRemittance(env, d) {
  const r = await env.DB.prepare('SELECT * FROM remittances WHERE tx_ref=?').bind(d.tx_ref).first();
  if (!r) return { ok: false, reason: 'unknown exchange' };
  if (money(d.amount) < r.source_amount || d.currency !== r.currency) {
    await env.DB.prepare("UPDATE remittances SET status='amount_mismatch', flw_tx_id=?, error=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_payment'").bind(String(d.id), `Paid ${d.amount} ${d.currency}, expected ${r.source_amount} ${r.currency}`, r.id).run();
    return { ok: false, reason: 'amount mismatch' };
  }
  const c = await env.DB.prepare("UPDATE remittances SET status='paid', flw_tx_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_payment'").bind(String(d.id), r.id).run();
  if (c.meta.changes !== 1) return { ok: true, credited: false };   // already processed (webhook replay / page reload)
  await payoutRemittance(env, r.id);
  return { ok: true, credited: true };
}
async function payoutRemittance(env, id) {
  const r = await env.DB.prepare('SELECT * FROM remittances WHERE id=?').bind(id).first();
  if (!r) return { ok: false, error: 'Not found' };
  const ref = `UMSXP-${r.id}-${r.payout_attempts + 1}`;
  // Only one caller can move paid / payout_failed -> payout_pending, so a payout can never be sent twice at the same time.
  const g = await env.DB.prepare("UPDATE remittances SET status='payout_pending', payout_ref=?, payout_attempts=payout_attempts+1, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('paid','payout_failed')").bind(ref, r.id).run();
  if (g.meta.changes !== 1) return { ok: false, error: 'This exchange is not ready for payout.' };
  try {
    const t = await flw(env, 'POST', '/transfers', { account_bank: r.bank_code, account_number: r.account_number, amount: r.receive_ngn, currency: 'NGN', reference: ref, narration: (env.APP_NAME || 'Money transfer').slice(0, 40), debit_currency: 'NGN' });
    if (!t.ok) {
      await env.DB.prepare("UPDATE remittances SET status='payout_failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='payout_pending'").bind(String(t.data?.message || 'Transfer request failed').slice(0, 200), r.id).run();
      return { ok: false, error: t.data?.message || 'Transfer request failed' };
    }
    return { ok: true };   // final result arrives by webhook (transfer.completed)
  } catch (e) {
    console.error('payout error', e);
    return { ok: false, error: 'No answer from Flutterwave. Check the transfer in your Flutterwave dashboard before retrying.' }; // stays payout_pending
  }
}
async function settleRemittanceTransfer(env, reference, status) {
  const r = await env.DB.prepare('SELECT id FROM remittances WHERE payout_ref=?').bind(reference).first();
  if (!r) return;
  if (status === 'SUCCESSFUL') await env.DB.prepare("UPDATE remittances SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('payout_pending','payout_failed')").bind(r.id).run();
  else if (status === 'FAILED') await env.DB.prepare("UPDATE remittances SET status='payout_failed', error='Flutterwave could not complete the transfer', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='payout_pending'").bind(r.id).run();
}

FUNCTIONS['exchange-info'] = async (x, env) => {
  const c = xCfg(env);
  return json({ enabled: c.enabled, currencies: XCUR, min: c.min, max: c.max, fee_percent: c.feePct });
};
FUNCTIONS['get-banks'] = async (x, env) => {
  try { return json({ banks: await loadBanks(env) }); } catch (e) { return fail(String(e.message || 'Could not load banks.'), 503); }
};
FUNCTIONS['exchange-resolve'] = async (x, env) => {
  const bank = String(x.bankCode || ''), acct = String(x.accountNumber || '');
  if (!bank || !/^\d{10}$/.test(acct)) return fail('Select a bank and enter a 10-digit account number.');
  if (!env.FLW_SECRET_KEY) return fail('This service is not available yet.', 503);
  const name = await xResolveAccount(env, bank, acct);
  return name ? json({ account_name: name }) : fail('Could not find this account. Please check the bank and account number.');
};
FUNCTIONS['exchange-quote'] = async (x, env) => {
  const c = xCfg(env);
  if (!c.enabled) return fail('This service is not available yet.');
  const bad = xValid(x, c); if (bad) return fail(bad);
  try { return json({ quote: await xQuote(env, String(x.currency), money(x.amount)) }); }
  catch (e) { console.error('quote error', e); return fail('Rates are temporarily unavailable. Please try again shortly.', 503); }
};
FUNCTIONS['exchange-create'] = async (x, env, user, req) => {
  const c = xCfg(env);
  if (!c.enabled) return fail('This service is not available yet.');
  if (!env.FLW_SECRET_KEY) return fail('This service is not available yet.', 503);
  const bad = xValid(x, c); if (bad) return fail(bad);
  const bank = String(x.bankCode || ''), acct = String(x.accountNumber || '');
  if (!bank || !/^\d{10}$/.test(acct)) return fail('Select a bank and enter a 10-digit account number.');
  const pinErr = await verifyPin(env, user.id, x.pin); if (pinErr) return fail(pinErr);
  const today = await env.DB.prepare("SELECT COUNT(*) n FROM remittances WHERE user_id=? AND status NOT IN ('cancelled','awaiting_payment') AND created_at > datetime('now','-1 day')").bind(user.id).first();
  if (today.n >= c.dailyCount) return fail(`You can make at most ${c.dailyCount} transfers per day.`);
  const name = await xResolveAccount(env, bank, acct);
  if (!name) return fail('Could not find this account. Please check the bank and account number.');
  let q; try { q = await xQuote(env, String(x.currency), money(x.amount)); } catch (e) { console.error(e); return fail('Rates are temporarily unavailable. Please try again shortly.', 503); }
  if (q.receive_ngn < 1000) return fail('The amount is too small after fees.');
  const id = uid(), txRef = 'UMSX-' + id;
  const prof = await env.DB.prepare('SELECT full_name, phone FROM profiles WHERE id=?').bind(user.id).first();
  const bankName = (bankCache || []).find((b) => b.code === bank)?.name || null;
  const p = await flw(env, 'POST', '/payments', { tx_ref: txRef, amount: q.amount, currency: q.currency, payment_options: 'card', redirect_url: env.FLW_REDIRECT_URL || new URL('/api/payment/return', req.url).toString(),
    customer: { email: user.email, name: prof?.full_name || user.email, phonenumber: prof?.phone || '' }, customizations: { title: env.APP_NAME || 'Money transfer', description: `Send money to ${name}` }, meta: { remittance_id: id } });
  if (!p.ok) return fail(p.data?.message || 'Could not start the payment.', 502);
  await env.DB.prepare('INSERT INTO remittances(id,user_id,tx_ref,currency,source_amount,rate,fee_percent,fee_amount,receive_ngn,bank_code,bank_name,account_number,account_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, user.id, txRef, q.currency, q.amount, q.rate, q.fee_percent, q.fee_amount, q.receive_ngn, bank, bankName, acct, name).run();
  return json({ data: { link: p.data.data.link, id, account_name: name, receive_ngn: q.receive_ngn } });
};
FUNCTIONS['exchange-history'] = async (x, env, user) => {
  const rows = (await env.DB.prepare('SELECT id,currency,source_amount,rate,fee_percent,fee_amount,receive_ngn,bank_name,account_number,account_name,status,created_at FROM remittances WHERE user_id=? ORDER BY created_at DESC LIMIT 20').bind(user.id).all()).results;
  return json({ items: rows.map((r) => ({ ...r, account_number: '******' + String(r.account_number).slice(-4) })) });
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
  await env.DB.batch([
    env.DB.prepare('UPDATE profiles SET atc_balance=atc_balance+? WHERE id=?').bind(res.credited, user.id),
    env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref) VALUES(?,?,'airtime-to-cash',?,?,'in','successful',?)").bind(uid(), user.id, `Airtime to Cash (${net.toUpperCase()} ₦${amount})`, res.credited, res.ref || null),
  ]);
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
      const u = await one("SELECT COUNT(*) total, COALESCE(SUM(is_banned),0) banned, COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END),0) new_today, COALESCE(SUM(balance_ngn),0) wallets, COALESCE(SUM(atc_balance),0) atc FROM profiles");
      const f = await one("SELECT COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN amount END),0) today, COALESCE(SUM(amount),0) total FROM transactions WHERE type='fund' AND status='successful'");
      const p = await one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM transactions WHERE direction='out' AND status='successful' AND type!='airtime-to-cash' AND date(created_at)=date('now')");
      const q = await one("SELECT COUNT(*) n FROM transactions WHERE status='pending'");
      return json({ stats: { users: u.total, banned: u.banned, new_today: u.new_today, wallets_total: money(u.wallets), atc_total: money(u.atc), deposits_today: money(f.today), deposits_total: money(f.total), sales_today_count: p.n, sales_today_amount: money(p.amt), pending: q.n } });
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
      const u = await db.prepare('SELECT p.id,p.full_name,p.username,u.email,p.phone,p.balance_ngn,p.atc_balance,p.is_banned,p.is_admin,p.referral_code,p.referral_code_used,p.pin_locked_until,p.created_at FROM profiles p JOIN users u ON u.id=p.id WHERE p.id=?').bind(target).first();
      if (!u) return fail('User not found.', 404);
      const va = await db.prepare('SELECT account_number,bank_name FROM virtual_accounts WHERE user_id=?').bind(target).first();
      const tot = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='fund' AND status='successful' THEN amount END),0) deposited, COALESCE(SUM(CASE WHEN direction='out' AND status='successful' AND type!='airtime-to-cash' THEN amount END),0) spent, COUNT(*) txs FROM transactions WHERE user_id=?").bind(target).first();
      const refs = await db.prepare('SELECT COUNT(*) n FROM profiles WHERE referral_code_used=? AND ?!=\'\'').bind(u.referral_code || '', u.referral_code || '').first();
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
      const amount = money(x.amount), credit = x.direction === 'credit', wallet = x.wallet === 'atc' ? 'atc_balance' : 'balance_ngn';
      const reason = String(x.reason || '').trim();
      if (!['credit', 'debit'].includes(x.direction)) return fail('Choose credit or debit.');
      if (!(amount > 0 && amount <= 10000000)) return fail('Enter a valid amount.');
      if (reason.length < 3) return fail('Write a reason (it is saved in the activity log).');
      if (!await exists(target)) return fail('User not found.', 404);
      const label = `Admin ${credit ? 'credit' : 'debit'}${wallet === 'atc_balance' ? ' (Airtime-to-Cash wallet)' : ''}: ${reason}`.slice(0, 120);
      const r = await db.batch([
        db.prepare(`UPDATE profiles SET ${wallet}=${wallet}${credit ? '+' : '-'}? WHERE id=?${credit ? '' : ` AND ${wallet}>=?`}`).bind(...(credit ? [amount, target] : [amount, target, amount])),
        db.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status) SELECT ?,?,'adjustment',?,?,?,'successful' WHERE changes() > 0").bind(uid(), target, label, amount, credit ? 'in' : 'out'),
        log('adjust_balance', target, `${x.direction} ${amount} ${wallet}: ${reason}`),
      ]);
      if (r[0].meta.changes !== 1) return fail('The user does not have enough balance for this debit.');
      const nb = await db.prepare('SELECT balance_ngn, atc_balance FROM profiles WHERE id=?').bind(target).first();
      return json({ ok: true, balance_ngn: nb.balance_ngn, atc_balance: nb.atc_balance });
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
    case 'list_remittances': {
      const f = { attention: "r.status IN ('payout_failed','amount_mismatch','paid','payout_pending')", completed: "r.status='completed'", all: '1=1' }[x.filter] || '1=1';
      const rows = (await db.prepare(`SELECT r.id,r.currency,r.source_amount,r.receive_ngn,r.bank_name,r.account_number,r.account_name,r.status,r.error,r.payout_attempts,r.created_at,p.username FROM remittances r JOIN profiles p ON p.id=r.user_id WHERE ${f} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).bind(PAGE, page(x.offset)).all()).results;
      const total = (await db.prepare(`SELECT COUNT(*) n FROM remittances r WHERE ${f}`).first()).n;
      return json({ items: rows, total, page_size: PAGE });
    }
    case 'retry_payout': {
      const r = await payoutRemittance(env, String(x.id || ''));
      await log('retry_payout', null, `${x.id} -> ${r.ok ? 'sent' : r.error}`).run();
      return r.ok ? json({ ok: true }) : fail(r.error || 'Could not retry.', 400);
    }
    case 'mark_refunded': { // after you refunded the customer yourself in the Flutterwave dashboard
      const c = await db.prepare("UPDATE remittances SET status='refunded', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('payout_failed','amount_mismatch','paid')").bind(String(x.id || '')).run();
      if (c.meta.changes !== 1) return fail('This exchange cannot be marked as refunded.');
      await log('mark_refunded', null, String(x.id)).run();
      return json({ ok: true });
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

/* ----------------------------------------------------------------- ROUTER */
async function route(req, env) {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (method === 'OPTIONS') return json({ ok: true });
  await ensureSchema(env);

  if (path === '/api/health') return json({ ok: true, service: env.APP_NAME || 'Worker', database: 'connected', auth: String(env.AUTH_SECRET || '').length >= 32, flutterwave: !!env.FLW_SECRET_KEY, vtuagent: !!env.VTUAGENT_API_KEY, webhook: String(env.FLW_WEBHOOK_HASH || '').length >= 16 });
  if (path === '/api/payment/return' && method === 'GET') return paymentReturn(req, env);
  if (path === '/api/webhook/flutterwave' && method === 'POST') return flutterwaveWebhook(req, env);
  if (path === '/api/webhook/vtuagent' && method === 'POST') return vtuagentWebhook(req, env);

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
  if (path === '/api/functions/initiate-payment' && method === 'POST') return initiatePayment(req, env, user);
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
      if (new URL(req.url).pathname.startsWith('/api/')) return await route(req, env);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return fail('Server error: ' + String(e?.message || e), 500);
    }
  },
  // Runs every few minutes (Cron Trigger): settles purchases that are still pending.
  async scheduled(event, env, ctx) { ctx.waitUntil(reconcilePending(env)); },
};
