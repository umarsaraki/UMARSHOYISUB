// UMARSHOYI-SUB — Cloudflare Worker (D1 database)
// Auth, wallet, Flutterwave funding (+webhook, virtual account), purchases, OTP,
// airtime-to-cash withdrawals and admin tools. The VTU provider lives in provider.js.
import { runProvider, sendSms, convertAirtimeToCash } from './provider.js';
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
  return json({ status: 'success', data: { link: r.data.data.link, tx_ref: txRef } });
}

// Verify a Flutterwave transaction with Flutterwave itself (never trust the browser/webhook body alone), then credit once.
async function settleFlutterwave(env, flwId) {
  if (!env.FLW_SECRET_KEY) return { ok: false, reason: 'no key' };
  const v = await flw(env, 'GET', `/transactions/${encodeURIComponent(flwId)}/verify`);
  const d = v.data?.data;
  if (!v.ok || !d || d.status !== 'successful' || d.currency !== 'NGN') return { ok: false, reason: 'not successful' };
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
  if (status === 'successful' || status === 'completed') {
    const r = id ? await settleFlutterwave(env, id) : { ok: false };
    outcome = r.ok ? 'success' : 'pending';
  } else if (txRef) {
    await env.DB.prepare("UPDATE transactions SET status='failed' WHERE provider_ref=? AND type='fund' AND status='pending'").bind(txRef).run();
  }
  return new Response(null, { status: 302, headers: { location: `/?funded=${outcome}` } });
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
  try { res = await runProvider(env, kind, { ...params, quantity, amount: price }); }
  catch (e) {
    console.error('provider error', e);
    return fail('Your request is being processed. Check Transaction History before trying again.', 502); // stays pending for manual check
  }
  if (res.ok) {
    const ref = res.pins ? JSON.stringify(res.pins) : (res.ref || null);
    await env.DB.prepare("UPDATE transactions SET status='successful', provider_ref=? WHERE id=? AND status='pending'").bind(ref, txId).run();
    return json({ data: { ok: true, id: txId, ref: res.ref || null } });
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET balance_ngn=balance_ngn+? WHERE id=? AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status='pending')").bind(price, user.id, txId),
    env.DB.prepare("UPDATE transactions SET status='failed' WHERE id=? AND status='pending'").bind(txId),
  ]);
  return fail(res.error || 'Purchase failed. Your wallet was refunded.');
}

const NETS = ['mtn', 'glo', 'airtel', '9mobile'];
const validPhone = (p) => /^(0\d{10}|234\d{10})$/.test(String(p || ''));
function findDataPlan(network, code) {
  for (const cat of Object.keys(C.DATA_PLANS[network] || {})) { const p = C.DATA_PLANS[network][cat].find((x) => String(x.code) === String(code)); if (p) return { ...p, category: cat }; }
  return null;
}
const qtyOf = (x, max) => { const q = Math.floor(Number(x)); return Number.isFinite(q) && q >= 1 && q <= max ? q : null; };

const FUNCTIONS = {
  async 'get-sabildata-plans'() { // plan list for the Buy Data screen (static price list for now; provider list can replace it later)
    const plans = [];
    for (const [net, cats] of Object.entries(C.DATA_PLANS)) for (const [cat, list] of Object.entries(cats)) for (const p of list) plans.push({ network: net.toUpperCase(), data_id: p.code, plan: cat, size: p.size, validity: p.valid, price: p.price });
    return json({ plans });
  },
  async 'buy-data'(x, env, user) {
    const net = String(x.network || '').toLowerCase(), plan = findDataPlan(net, x.planCode);
    if (!plan) return fail('That data plan is not available.');
    if (!validPhone(x.phone)) return fail('Enter a valid phone number.');
    return purchase(env, user, { pin: x.pin, type: 'data', label: `${plan.size} ${net.toUpperCase()} data → ${x.phone}`, price: plan.price, cost: plan.cost, kind: 'data', params: { network: net, phone: x.phone, planCode: plan.code } });
  },
  async 'buy-airtime'(x, env, user) {
    const net = String(x.network || '').toLowerCase(), amt = money(x.amount);
    if (!NETS.includes(net)) return fail('Select a network.');
    if (!validPhone(x.phone)) return fail('Enter a valid phone number.');
    if (!(amt >= 50 && amt <= 100000)) return fail('Airtime amount must be between ₦50 and ₦100,000.');
    return purchase(env, user, { pin: x.pin, type: 'airtime', label: `${net.toUpperCase()} airtime → ${x.phone}`, price: amt, cost: amt * 0.97, kind: 'airtime', params: { network: net, phone: x.phone } });
  },
  async 'buy-cable'(x, env, user) {
    const plan = (C.CABLE_PLANS[String(x.provider || '').toLowerCase()] || []).find((p) => String(p.code) === String(x.planCode));
    if (!plan) return fail('That cable package is not available.');
    if (!/^\d{6,15}$/.test(String(x.smartcard || ''))) return fail('Enter a valid smartcard/IUC number.');
    return purchase(env, user, { pin: x.pin, type: 'cable', label: `${plan.name} → ${x.smartcard}`, price: plan.price, cost: plan.cost, kind: 'cable', params: { provider: x.provider, planCode: plan.code, smartcard: x.smartcard } });
  },
  async 'buy-electricity'(x, env, user) {
    const amt = money(x.unitsAmount), disco = C.ELECTRICITY_DISCOS.find((d) => d.code === String(x.discoCode));
    if (!disco) return fail('Select a distribution company.');
    if (!['prepaid', 'postpaid'].includes(String(x.meterType || '').toLowerCase())) return fail('Select prepaid or postpaid.');
    if (!/^\d{6,15}$/.test(String(x.meterNumber || ''))) return fail('Enter a valid meter number.');
    if (!(amt >= C.ELECTRICITY_MIN && amt <= C.ELECTRICITY_MAX)) return fail(`Amount must be between ₦${C.ELECTRICITY_MIN} and ₦${C.ELECTRICITY_MAX}.`);
    const fee = Math.floor(amt / 1000) * 100; // same formula as the app screen
    return purchase(env, user, { pin: x.pin, type: 'electricity', label: `${disco.name} ${x.meterType} → ${x.meterNumber}`, price: amt + fee, cost: amt * C.ELECTRICITY_COST_RATE, kind: 'electricity', params: { discoCode: disco.code, meterType: x.meterType, meterNumber: x.meterNumber, amount: amt } });
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
  async 'buy-betting'(x, env, user) {
    const plat = C.BETTING_PLATFORMS.find((p) => p.code === String(x.platformCode)), amt = money(x.amount);
    if (!plat) return fail('Select a betting platform.');
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(String(x.accountId || ''))) return fail('Enter a valid betting account ID.');
    if (!(amt >= 100 && amt <= 500000)) return fail('Amount must be between ₦100 and ₦500,000.');
    return purchase(env, user, { pin: x.pin, type: 'betting', label: `${plat.name} → ${x.accountId}`, price: amt, cost: amt, kind: 'betting', params: { platformCode: plat.code, accountId: x.accountId } });
  },
};

/* ---------------------------------------------- AIRTIME-TO-CASH, OTP, WITHDRAW */
let bankCache = null;
async function settleTransfer(env, reference, status) {
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
    if (!env.FLW_SECRET_KEY && env.TEST_MODE !== '1') return fail('Bank withdrawals are not set up yet.', 503);
    const ref = 'UMSW-' + uid(), txId = uid();
    const r = await env.DB.batch([
      env.DB.prepare('UPDATE profiles SET atc_balance=atc_balance-? WHERE id=? AND atc_balance>=?').bind(amount, user.id, amount),
      env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,metadata) SELECT ?,?,'airtime-to-cash',?,?,'out','pending',?,? WHERE changes() > 0").bind(txId, user.id, `Withdrawal to bank ${acct}`, net, ref, JSON.stringify({ gross: amount, fee })),
    ]);
    if (r[0].meta.changes !== 1) return fail('Balance changed. Please try again.');
    if (env.TEST_MODE === '1') { await settleTransfer(env, ref, 'SUCCESSFUL'); return json({ data: { amount: net } }); }
    const t = await flw(env, 'POST', '/transfers', { account_bank: bankCode, account_number: acct, amount: net, currency: 'NGN', reference: ref, narration: (env.APP_NAME || 'Withdrawal') + ' withdrawal', debit_currency: 'NGN' });
    if (!t.ok) { await settleTransfer(env, ref, 'FAILED'); return fail(t.data.message || 'Transfer failed. Your balance was restored.', 502); }
    return json({ data: { amount: net } }); // final status arrives by webhook (transfer.completed)
  }
  return fail('Unknown action.');
};

FUNCTIONS['send-otp'] = async (x, env, user) => {
  const phone = String(x.phone || '').trim();
  if (!validPhone(phone)) return fail('Enter a valid phone number.');
  const old = await env.DB.prepare('SELECT created_at FROM otps WHERE user_id=? AND phone=?').bind(user.id, phone).first();
  if (old && now() - old.created_at < 60) return fail('Please wait a minute before requesting another code.');
  const code = env.TEST_MODE === '1' ? '123456' : String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
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
  const log = (action, target, detail) => env.DB.prepare('INSERT INTO admin_log(id,admin_id,action,target_id,detail) VALUES(?,?,?,?,?)').bind(uid(), user.id, action, target || null, detail || null).run();
  const target = String(x.userId || '');
  switch (x.action) {
    case 'search': {
      const q = '%' + String(x.query || '').trim().toLowerCase() + '%';
      const rows = (await env.DB.prepare('SELECT p.id,p.full_name,p.username,u.email,p.phone,p.balance_ngn,p.is_banned FROM profiles p JOIN users u ON u.id=p.id WHERE lower(p.full_name) LIKE ? OR p.username LIKE ? OR lower(u.email) LIKE ? OR p.phone LIKE ? ORDER BY p.created_at DESC LIMIT 20').bind(q, q, q, q).all()).results;
      return json({ users: rows });
    }
    case 'get_transactions':
      return json({ transactions: (await env.DB.prepare('SELECT id,type,label,amount,direction,status,created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(target).all()).results });
    case 'set_balance': {
      const b = money(x.newBalance);
      if (!Number.isFinite(b) || b < 0) return fail('Enter a valid balance.');
      const old = await env.DB.prepare('SELECT balance_ngn FROM profiles WHERE id=?').bind(target).first();
      if (!old) return fail('User not found.', 404);
      await env.DB.prepare('UPDATE profiles SET balance_ngn=? WHERE id=?').bind(b, target).run();
      await log('set_balance', target, `${old.balance_ngn} -> ${b}`);
      return json({ ok: true });
    }
    case 'reset_password': {
      if (String(x.newPassword || '').length < 6) return fail('Password must be at least 6 characters.');
      const salt = uid();
      await env.DB.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?').bind(await passwordHash(String(x.newPassword), salt), salt, target).run();
      await log('reset_password', target);
      return json({ ok: true });
    }
    case 'ban': case 'unban': {
      await env.DB.prepare('UPDATE profiles SET is_banned=? WHERE id=?').bind(x.action === 'ban' ? 1 : 0, target).run();
      await log(x.action, target);
      return json({ ok: true });
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

  if (path === '/api/health') return json({ ok: true, service: env.APP_NAME || 'Worker', database: 'connected', auth: String(env.AUTH_SECRET || '').length >= 32, flutterwave: !!env.FLW_SECRET_KEY, webhook: String(env.FLW_WEBHOOK_HASH || '').length >= 16, test_mode: env.TEST_MODE === '1' });
  if (path === '/api/payment/return' && method === 'GET') return paymentReturn(req, env);
  if (path === '/api/webhook/flutterwave' && method === 'POST') return flutterwaveWebhook(req, env);

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
    return fn ? fn(await body(req), env, user) : fail('Unknown service.', 404);
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
};
