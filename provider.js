// ============================================================================
// Legitdataway connection  (https://legitdataway.com/api)
// Supports: data, airtime, cable TV, electricity, exam PINs, data cards, recharge cards, bulk SMS.
// NOT offered by this provider: airtime-to-cash, and smartcard verification.
//
// The API token is saved in  Admin Panel -> Settings -> Keys -> "Legitdataway API token"
// (kept encrypted in the database). NEVER write it in this file or in wrangler.toml.
//
// Prices: the catalog (catalog.js) holds YOUR COST. The customer price = cost + profit, where the
// profit is set per service in  Admin Panel -> Settings -> Profit.
//
// runProvider() returns one of:
//   { ok:true,  ref?, token?, units?, pins?, cost? }   delivered (cost = what the provider really took from your wallet)
//   { pending:true }                                   provider is still processing (resolved by its webhook, or by you in the Admin Panel)
//   { ok:false, definite:true, error }                 provider said NO and nothing was delivered -> customer is refunded
// If it THROWS (timeout, provider error), the transaction stays "pending" and is resolved later.
// ============================================================================
import * as C from './catalog.js';

const NOT_AVAILABLE = { ok: false, definite: true, error: 'This service is not available yet. Your wallet was not charged.' };
const baseUrl = (env) => String(env.LEGITDATAWAY_BASE_URL || 'https://legitdataway.com/api').replace(/\/+$/, '');

async function lgw(env, method, path, body) {
  if (!env.LEGITDATAWAY_TOKEN) throw new Error('LEGITDATAWAY_TOKEN is not set');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 28000);
  try {
    const r = await fetch(baseUrl(env) + path, { method, signal: ctl.signal, headers: { authorization: 'Token ' + env.LEGITDATAWAY_TOKEN, accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------ prices & profit */
// Profit settings (Admin Panel -> Settings -> Profit). Empty = the default below.
export const PROFIT_DEFAULTS = { data: 12, airtime: 0, cable: 12, electricity: 10, exam: 5, data_card: 5, recharge_card: 0 };
const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
export function profitCfg(env, svc) {
  const K = svc.toUpperCase();
  let pct = num(env['PROFIT_' + K + '_PERCENT']);
  if (pct === null && (svc === 'data' || svc === 'cable')) pct = num(env.PRICE_MARKUP_PERCENT);   // the older single markup keeps working until you set the new field
  if (pct === null) pct = PROFIT_DEFAULTS[svc] ?? 0;
  return { pct, fixed: num(env['PROFIT_' + K + '_FIXED']) ?? 0 };
}
const r2 = (n) => Math.round(n * 100) / 100;
// What the customer pays for something that costs you `cost`: cost + percent + fixed naira, rounded UP to a whole naira.
export function priceOf(env, svc, cost) { const { pct, fixed } = profitCfg(env, svc); return Math.ceil(r2(Number(cost) * (100 + pct) / 100 + fixed)); }
// Service fee added on top of an amount the customer chooses (airtime, electricity).
export function feeOf(env, svc, amount) { const { pct, fixed } = profitCfg(env, svc); return Math.ceil(r2(Number(amount) * pct / 100 + fixed)); }

/* ------------------------------------------------------------ catalog views (cost never leaves the server) */
export function getDataPlans(env) {
  return C.DATA_BUNDLES.map((p) => ({ ...p, price: priceOf(env, 'data', p.cost) }));
}
export const CABLE_PROVIDERS = ['dstv', 'gotv', 'startimes'];
export function getCablePlans(env, provider) {
  if (!CABLE_PROVIDERS.includes(provider)) throw new Error('Unknown cable provider');
  return (C.CABLE_PLANS[provider] || []).map((p) => ({ code: String(p.code), name: p.name, cost: p.cost, price: priceOf(env, 'cable', p.cost) }));
}
export function publicCatalog(env) {
  const cards = {};
  for (const [n, cats] of Object.entries(C.DATA_CARD_PLANS)) { cards[n] = {}; for (const [cat, list] of Object.entries(cats)) cards[n][cat] = list.map((p) => ({ code: p.code, size: p.size, valid: p.valid, price: priceOf(env, 'data_card', p.cost) })); }
  const recharge = {};
  for (const [n, list] of Object.entries(C.RECHARGE_CARDS)) recharge[n] = list.map((p) => ({ amount: p.amount, price: priceOf(env, 'recharge_card', p.cost) }));
  const exam = {};
  for (const [id, e] of Object.entries(C.EXAM_TYPES)) exam[id] = { name: e.name, badge: e.badge, color: e.color, available: !!e.available, price: e.available ? priceOf(env, 'exam', e.cost) : 0 };
  const ef = profitCfg(env, 'electricity'), af = profitCfg(env, 'airtime');
  return {
    exam, data_cards: cards, recharge_cards: recharge,
    cable_available: Object.fromEntries(CABLE_PROVIDERS.map((p) => [p, (C.CABLE_PLANS[p] || []).length > 0])),
    airtime: { min: C.AIRTIME_MIN, max: C.AIRTIME_MAX, fee_percent: af.pct, fee_fixed: af.fixed },
    electricity: { min: C.ELECTRICITY_MIN, max: C.ELECTRICITY_MAX, fee_percent: ef.pct, fee_fixed: ef.fixed, discos: C.ELECTRICITY_DISCOS.map((d) => ({ code: d.code, name: d.name })) },
  };
}
export function clearProviderCaches() { /* the catalog is read from catalog.js on every call: nothing to clear */ }

/* ------------------------------------------------------- verification */
// Legitdataway has no smartcard check: the customer sees the number they typed.
export async function verifySmartcard() { return { ok: true, name: '', status: '', due: '', unverified: true }; }
export async function verifyMeter(env, disco, meterNumber, meterType) {
  const d = C.ELECTRICITY_DISCOS.find((x) => x.code === disco || String(x.id) === String(disco));
  if (!d) return { ok: false, error: 'Select a distribution company.' };
  const q = new URLSearchParams({ meter_number: meterNumber, disco: String(d.id), meter_type: meterType });
  const r = await lgw(env, 'GET', '/bill/bill-validation?' + q.toString());
  if (r.status === 200 && String(r.json.status).toLowerCase() === 'success' && r.json.name) return { ok: true, name: String(r.json.name), address: '' };
  if (r.status >= 400 && r.status < 500 && r.status !== 429) return { ok: false, error: r.json.message || 'Could not verify this meter number.' };
  if (r.status === 200) return { ok: false, error: r.json.message || 'Could not verify this meter number.' };
  throw new Error(r.json.message || `Legitdataway verify error (${r.status})`);
}

/* ----------------------------------------------------------- purchases */
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
// What the provider really took from your wallet = old balance - new balance (fallback: the amount it reports).
function realCost(j) {
  const spent = Number(j.oldbal) - Number(j.newbal);
  if (Number.isFinite(spent) && spent > 0) return Math.round(spent * 100) / 100;
  return money(j.amount);
}
function interpret(r) {
  const j = r.json || {}, st = String(j.status || '').toLowerCase();
  if (r.status === 401 || r.status === 403) { console.error('Legitdataway: API token rejected (' + r.status + ')'); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
  if (st === 'success' && r.status >= 200 && r.status < 300) return { ok: true, ref: j['request-id'] || null, token: j.token || '', units: j.units || '', cost: realCost(j), raw: j };
  if (['process', 'processing', 'pending', 'queued'].includes(st)) return { pending: true };
  if (['fail', 'failed', 'error'].includes(st) && r.status < 500) {
    if (/insufficient|balance|wallet/i.test(String(j.message))) { console.error('Legitdataway wallet balance is too low:', j.message); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
    return { ok: false, definite: true, error: j.message || 'The provider could not complete this purchase. You were refunded.' };
  }
  throw new Error(`Legitdataway unexpected response (${r.status}): ${st} ${j.message || ''}`);   // unknown -> stays pending, never refunded or confirmed by guesswork
}
const localPhone = (p) => { const d = String(p).replace(/\D/g, ''); return d.startsWith('234') ? '0' + d.slice(3) : d; };

// "pin1<=>serial1,pin2<=>serial2"  or  pin:"p1,p2" + serial:"s1,s2"
function parsePins(j, kind) {
  const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (kind === 'exam') return split(j.pin).map((x) => { const [pin, serial] = x.split('<=>'); return { pin: pin || '', serial: serial || '' }; });
  const pins = split(j.pin), serials = split(j.serial);
  return pins.map((pin, i) => ({ pin, serial: serials[i] || '', load: j.load_pin || '' }));
}

export async function runProvider(env, kind, p) {
  const id = p.requestRef, net = C.NETWORK_IDS[p.network];
  let res;
  switch (kind) {
    case 'data': res = interpret(await lgw(env, 'POST', '/data', { network: net, phone: localPhone(p.phone), data_plan: Number(p.planCode), bypass: false, 'request-id': id })); break;
    case 'airtime': res = interpret(await lgw(env, 'POST', '/topup', { network: net, phone: localPhone(p.phone), plan_type: 'VTU', amount: p.amount, bypass: false, 'request-id': id })); break;
    case 'cable': res = interpret(await lgw(env, 'POST', '/cable', { cablename: p.provider, cableplan: p.planCode, smart_card_number: p.smartcard, 'request-id': id })); break;
    case 'electricity': res = interpret(await lgw(env, 'POST', '/bill', { disco: p.disco, meter_type: p.meterType, meter_number: p.meterNumber, amount: p.amount, bypass: false, 'request-id': id })); break;
    case 'exam': res = interpret(await lgw(env, 'POST', '/exam', { exam: p.examId, quantity: p.quantity, 'request-id': id })); break;
    case 'data-card': res = interpret(await lgw(env, 'POST', '/data_card', { network: net, plan_type: Number(p.planCode), quantity: p.quantity, card_name: String(env.APP_NAME || 'UMARSHOYI').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 20), 'request-id': id })); break;
    case 'airtime-card': res = interpret(await lgw(env, 'POST', '/recharge_card', { network: net, plan_type: Number(p.planCode), quantity: p.quantity, card_name: String(env.APP_NAME || 'UMARSHOYI').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 20), 'request-id': id })); break;
    case 'bulk-sms': return sendBulkSms(env, p);
    default: return NOT_AVAILABLE;
  }
  if (res.ok && ['exam', 'data-card', 'airtime-card'].includes(kind)) {
    const pins = parsePins(res.raw || {}, kind);
    if (!pins.length || pins.length < Number(p.quantity || 1)) { console.error('Legitdataway: PINs missing in a successful reply', id); res.pins = pins.length ? pins : undefined; if (!pins.length) res.ref = 'PINs were not returned. Contact support.'; }
    else res.pins = pins;
  }
  delete res.raw;
  return res;
}

// Legitdataway has NO transaction-status endpoint. Pending purchases are settled by its webhook (see worker.js)
// or by you in the Admin Panel (Confirm / Fail & refund after checking the Legitdataway dashboard).
export async function checkStatus() { return { state: 'pending' }; }

/* ------------------------------------------------------------- SMS */
// p = { sender, message, numbers:[ '2348012345678', ... ], requestRef }
export async function sendBulkSms(env, p) {
  const r = interpret(await lgw(env, 'POST', '/bulksms', { sender: p.sender, number: p.numbers.map(localPhone).join(','), message: p.message, 'request-id': p.requestRef }));
  delete r.raw; return r;
}
// Verification codes by SMS are not connected (they would spend your money without a setting). Airtime-to-cash, the only user, is not offered.
export async function sendSms(env, phone, text) { return { ok: false, error: 'SMS service is not connected yet.' }; }
export async function convertAirtimeToCash(env, { phone, network, amount }) { return NOT_AVAILABLE; }
