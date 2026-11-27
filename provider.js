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

/* ------------------------------------------------------------ providers (Admin -> Providers) */
// Each service is sold by ONE provider, chosen in Admin -> Providers. Airtime, cards and bulk SMS always use Legitdataway.
export const ROUTABLE = ['data', 'cable', 'electricity', 'exam'];
export const VP_KINDS = ['cable', 'electricity'];   // VendPower is offered for these two
export function providerFor(env, kind) {
  if (!ROUTABLE.includes(kind)) return 'legitdataway';
  const v = String((env && env['PROVIDER_' + kind.toUpperCase()]) || '');
  if (v === 'easyaccess') return 'easyaccess';
  if (v === 'vendpower' && VP_KINDS.includes(kind)) return 'vendpower';
  return 'legitdataway';
}
export const providerOn = (env, prov) => (prov === 'easyaccess' ? env.PROVIDER_EASYACCESS_ENABLED !== '0' : prov === 'vendpower' ? env.PROVIDER_VENDPOWER_ENABLED !== '0' : env.PROVIDER_LEGITDATAWAY_ENABLED !== '0');
export const providerToken = (env, prov) => !!(prov === 'easyaccess' ? env.EASYACCESS_TOKEN : prov === 'vendpower' ? env.VENDPOWER_API_KEY : env.LEGITDATAWAY_TOKEN);
// A service can be sold when its provider is switched ON in Admin and has a key.
export function providerReady(env, kind) { const pr = providerFor(env, kind); return providerOn(env, pr) && providerToken(env, pr); }

/* ---- EasyAccess (https://easyaccessapi.com.ng): plans are synced from its get-plans API into the database (Admin -> Providers -> Sync plans) */
export const EA_PRODUCTS = {
  mtn_cg: ['mtn', 'Corporate Gifting'], mtn_awoof: ['mtn', 'Awoof'], mtn_sme: ['mtn', 'SME'], mtn_gifting: ['mtn', 'Gifting'],
  glo_cg: ['glo', 'Corporate Gifting'], glo_awoof: ['glo', 'Awoof'], glo_gifting: ['glo', 'Gifting'],
  airtel_cg: ['airtel', 'Corporate Gifting'], airtel_awoof: ['airtel', 'Awoof'], airtel_gifting: ['airtel', 'Gifting'],
  '9mobile_sme': ['9mobile', 'SME'], '9mobile_gifting': ['9mobile', 'Gifting'],
};
export const EA_OTHER = ['dstv', 'gotv', 'startimes', 'waec', 'neco', 'nabteb', 'nbais'];
const EA_NET = { mtn: 1, glo: 2, airtel: 3, '9mobile': 4 };
const EA_CABLE = { dstv: 1, gotv: 2, startimes: 3 };
// EasyAccess electricity company numbers. Only the ones its docs name are listed (1=EKEDC 2=IKEDC 3=PHEDC 4=KEDCO, the rest says "etc.").
// A company that is not here is shown as unavailable while electricity is routed to EasyAccess: add its number here once you have the full list.
export const EA_DISCOS = { 'eko-electric': 1, 'ikeja-electric': 2, 'portharcourt-electric': 3, 'kano-electric': 4 };
/* ---- VendPower (https://api.vendpower.ng): cable plans and electricity companies are synced from its API into the same ea_plans table (products vp_dstv, vp_gotv, vp_startimes, vp_disco) */
export const VP_PRODUCTS = ['vp_dstv', 'vp_gotv', 'vp_startimes', 'vp_disco'];
const vpKey = (name) => String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/electricity|electric|distribution|company|plc|disco/g, '').replace(/[^a-z]/g, '');
// Our company -> VendPower's row, matched by NAME from the synced list (no hard-coded numbers). meterType 'prepaid' | 'postpaid'.
export function vpDisco(env, code, meterType) {
  const d = C.ELECTRICITY_DISCOS.find((x) => x.code === code); if (!d) return null;
  const key = vpKey(d.name); if (key.length < 3) return null;
  const rows = eaRows(env, 'vp_disco').filter((r) => vpKey(r.name).includes(key));
  if (!rows.length) return null;
  const want = String(meterType || '').toUpperCase();
  const r = rows.find((x) => String(x.validity).split('|')[1] === want) || (meterType ? null : rows[0]);
  if (!r) return null;
  const [disco_code, vend_type] = String(r.validity).split('|');
  return { disco_code, vend_type, min: Number(r.price) || 0 };
}
export const discoAvailable = (env, code) => {
  const pr = providerFor(env, 'electricity');
  return pr === 'easyaccess' ? EA_DISCOS[code] != null : pr === 'vendpower' ? !!vpDisco(env, code) : true;
};
const eaRows = (env, product) => ((env && env.__PB && env.__PB.ea) || {})[product] || [];
const eaSize = (name) => { const m = String(name || '').match(/^\s*([\d.]+)\s*(MB|GB|TB)/i); return m ? m[1] + m[2].toUpperCase() : String(name || ''); };
function eaDataBase(env) {
  const out = [];
  for (const [prod, [network, category]] of Object.entries(EA_PRODUCTS)) for (const r of eaRows(env, prod)) out.push({ network, code: 'ea' + r.plan_id, category, size: eaSize(r.name), valid: String(r.validity || ''), cost: Number(r.price) });
  return out;
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
/* ---- Price book: prices you edit in Admin -> Legitdataway. They sit ON TOP of catalog.js (stored in the database, loaded into env.__PB by the worker).
   Nothing in the database = exactly what catalog.js says. Hidden (enabled=0) plans are not sold; added plans are extra plans. ---- */
const PBK = (env, kind) => (env && env.__PB && env.__PB[kind]) || {};
/* Plan-type rules (Admin -> Legitdataway -> Plan types): switch a whole type (SME, Gifting, Corporate Gifting...) off, and/or give it its own profit.
   A rule for one network wins over the rule for "all networks" ('*'); an empty field falls back to the next one, and finally to Settings -> Profit. */
export function dataRule(env, network, category) {
  const R = (env && env.__PB && env.__PB.rules) || {}, a = R[network + '|' + category] || {}, b = R['*|' + category] || {};
  const pick = (k) => (a[k] != null ? a[k] : (b[k] != null ? b[k] : null));
  return { enabled: pick('enabled') !== 0, pct: pick('pct'), fixed: pick('fixed'), agent_pct: pick('agent_pct') };
}
// Agents (set in Admin) pay less: their own profit % per plan type, or the general "Agent data profit" setting. Never more than a normal customer pays.
export function dataPriceOf(env, network, category, cost, agent) {
  const g = profitCfg(env, 'data'), r = dataRule(env, network, category), pct = r.pct != null ? r.pct : g.pct, fixed = r.fixed != null ? r.fixed : g.fixed;
  const normal = Math.ceil(r2(Number(cost) * (100 + pct) / 100 + fixed));
  if (!agent) return normal;
  const ap = r.agent_pct != null ? r.agent_pct : num(env && env.AGENT_DATA_PERCENT);
  if (ap == null) return normal;
  return Math.min(normal, Math.ceil(r2(Number(cost) * (100 + ap) / 100)));
}
export function effDataBundles(env, withHidden) {
  const pb = PBK(env, 'data'), out = [], ea = providerFor(env, 'data') === 'easyaccess';
  for (const b of (ea ? eaDataBase(env) : C.DATA_BUNDLES)) {
    const o = pb[b.network + '|' + b.code], off = !dataRule(env, b.network, b.category).enabled;
    if ((off || (o && o.enabled === 0)) && !withHidden) continue;
    out.push({ ...b, ...(off ? { cat_off: true } : {}), ...(o && o.cost != null ? { cost: o.cost } : {}), ...(o ? { edited: o.cost != null, hidden: o.enabled === 0, file_cost: b.cost } : {}) });
  }
  for (const [k, o] of Object.entries(pb)) {
    if (!o.added || !o.meta || ea) continue;   // plans you added by hand belong to Legitdataway
    const off = !dataRule(env, String(o.meta.network), String(o.meta.category)).enabled;
    if ((off || o.enabled === 0) && !withHidden) continue;
    out.push({ network: String(o.meta.network), code: String(o.meta.code), category: String(o.meta.category), size: String(o.meta.size), valid: String(o.meta.valid), cost: Number(o.cost), added: true, ...(off ? { cat_off: true } : {}), hidden: o.enabled === 0 });
  }
  return out;
}
export function effCablePlans(env, provider, withHidden) {
  const pb = PBK(env, 'cable'), out = [], mode = providerFor(env, 'cable'), ea = mode !== 'legitdataway';
  const vpFee = 1 + (Number(env.VENDPOWER_CABLE_FEE_PCT != null && env.VENDPOWER_CABLE_FEE_PCT !== '' ? env.VENDPOWER_CABLE_FEE_PCT : 1) || 0) / 100;   // VendPower debits a little more than the listed price
  const base = mode === 'easyaccess' ? eaRows(env, provider).map((r) => ({ code: 'ea' + r.plan_id, name: String(r.name), cost: Number(r.price) }))
    : mode === 'vendpower' ? eaRows(env, 'vp_' + provider).map((r) => ({ code: 'vp' + r.plan_id, name: String(r.name), cost: Math.ceil(Number(r.price) * vpFee) }))
    : (C.CABLE_PLANS[provider] || []);
  for (const b of base) {
    const o = pb[provider + '|' + String(b.code)];
    if (o && o.enabled === 0 && !withHidden) continue;
    out.push({ code: String(b.code), name: b.name, cost: o && o.cost != null ? o.cost : b.cost, ...(o ? { edited: o.cost != null, hidden: o.enabled === 0, file_cost: b.cost } : {}) });
  }
  for (const [k, o] of Object.entries(pb)) {
    if (ea || !o.added || !o.meta || String(o.meta.provider) !== provider || (o.enabled === 0 && !withHidden)) continue;
    out.push({ code: String(o.meta.code), name: String(o.meta.name), cost: Number(o.cost), added: true, hidden: o.enabled === 0 });
  }
  return out;
}
export function effExamTypes(env) {
  const pb = PBK(env, 'exam'), out = {};
  if (providerFor(env, 'exam') === 'easyaccess') {
    for (const [id, e] of Object.entries({ ...C.EXAM_TYPES, nbais: { id: 4, name: 'NBAIS e-PIN', badge: 'NB', color: '#7a3fb0', cost: 0, available: true } })) {
      const r = eaRows(env, id)[0], o = pb[id], cost = r ? Number(r.price) : 0;
      out[id] = { ...e, cost: o && o.cost != null ? o.cost : cost, available: cost > 0 && !(o && o.enabled === 0), file_cost: cost };
    }
    return out;
  }
  for (const [id, e] of Object.entries(C.EXAM_TYPES)) {
    const o = pb[id];
    out[id] = { ...e, id: e.id, ...(o && o.cost != null ? { cost: o.cost } : {}), ...(o && o.enabled === 0 ? { available: false } : {}), file_cost: e.cost };
  }
  return out;
}
export function getDataPlans(env, agent) {
  return effDataBundles(env).map((p) => ({ ...p, price: dataPriceOf(env, p.network, p.category, p.cost, agent) }));
}
export const CABLE_PROVIDERS = ['dstv', 'gotv', 'startimes'];
export function getCablePlans(env, provider) {
  if (!CABLE_PROVIDERS.includes(provider)) throw new Error('Unknown cable provider');
  return effCablePlans(env, provider).map((p) => ({ code: String(p.code), name: p.name, cost: p.cost, price: priceOf(env, 'cable', p.cost) }));
}
export function publicCatalog(env) {
  const cards = {};
  for (const [n, cats] of Object.entries(C.DATA_CARD_PLANS)) { cards[n] = {}; for (const [cat, list] of Object.entries(cats)) cards[n][cat] = list.map((p) => ({ code: p.code, size: p.size, valid: p.valid, price: priceOf(env, 'data_card', p.cost) })); }
  const recharge = {};
  for (const [n, list] of Object.entries(C.RECHARGE_CARDS)) recharge[n] = list.map((p) => ({ amount: p.amount, price: priceOf(env, 'recharge_card', p.cost) }));
  const exam = {};
  for (const [id, e] of Object.entries(effExamTypes(env))) exam[id] = { name: e.name, badge: e.badge, color: e.color, available: !!e.available, price: e.available ? priceOf(env, 'exam', e.cost) : 0 };
  const ef = profitCfg(env, 'electricity'), af = profitCfg(env, 'airtime');
  return {
    exam, data_cards: cards, recharge_cards: recharge,
    cable_available: Object.fromEntries(CABLE_PROVIDERS.map((p) => [p, effCablePlans(env, p).length > 0])),
    airtime: { min: C.AIRTIME_MIN, max: C.AIRTIME_MAX, fee_percent: af.pct, fee_fixed: af.fixed },
    electricity: { min: C.ELECTRICITY_MIN, max: C.ELECTRICITY_MAX, fee_percent: ef.pct, fee_fixed: ef.fixed, discos: C.ELECTRICITY_DISCOS.filter((d) => discoAvailable(env, d.code)).map((d) => ({ code: d.code, name: d.name })) },
  };
}
export function clearProviderCaches() { /* the catalog is read from catalog.js on every call: nothing to clear */ }

/* ------------------------------------------------------- verification */
// Legitdataway has no smartcard check: the customer sees the number they typed.
export async function verifySmartcard(env, prov, card) {
  if (providerFor(env, 'cable') === 'vendpower') {
    const r = await vp(env, 'POST', '/cable/validate', { biller_code: String(prov).toUpperCase(), customer_id: card });
    if (r.status === 200 && r.json.success !== false && r.json.data && r.json.data.customer_name) return { ok: true, name: String(r.json.data.customer_name), status: '', due: '' };
    if (r.status >= 500 || r.status === 429) throw new Error('VendPower verify error (' + r.status + ')');
    return { ok: false, error: 'We could not verify this smartcard/IUC number. Please check it and try again.' };
  }
  if (providerFor(env, 'cable') !== 'easyaccess') return { ok: true, name: '', status: '', due: '', unverified: true };
  const r = await ea(env, 'POST', '/verify-tv', { company: EA_CABLE[prov], iucno: card }, true);
  if (r.json.status === 'success' && r.json.customer_name) return { ok: true, name: String(r.json.customer_name), status: String(r.json.customer_status || r.json.current_package || ''), due: String(r.json.due_date || '') };
  if (r.status >= 500) throw new Error('EasyAccess verify error (' + r.status + ')');
  return { ok: false, error: 'We could not verify this smartcard/IUC number. Please check it and try again.' };
}
export async function verifyMeter(env, disco, meterNumber, meterType) {
  const d = C.ELECTRICITY_DISCOS.find((x) => x.code === disco || String(x.id) === String(disco));
  if (!d) return { ok: false, error: 'Select a distribution company.' };
  if (providerFor(env, 'electricity') === 'vendpower') {
    const v = vpDisco(env, d.code, meterType); if (!v) return { ok: false, error: 'This electricity company is not available right now.' };
    const r = await vp(env, 'POST', '/electricity/validate-meter', { meter_number: meterNumber, disco_code: v.disco_code, meter_type: v.vend_type });
    if (r.status === 200 && r.json.data && r.json.data.customer_name) return { ok: true, name: String(r.json.data.customer_name), address: String(r.json.data.customer_address || '') };
    if (r.status >= 500 || r.status === 429) throw new Error('VendPower verify error (' + r.status + ')');
    return { ok: false, error: 'We could not verify this meter number. Please check it and try again.' };
  }
  if (providerFor(env, 'electricity') === 'easyaccess') {
    if (EA_DISCOS[d.code] == null) return { ok: false, error: 'This electricity company is not available right now.' };
    const r = await ea(env, 'POST', '/verify-electricity', { company: EA_DISCOS[d.code], metertype: meterType === 'postpaid' ? 2 : 1, meterno: meterNumber, amount: 1000 }, true);
    if (r.json.status === 'success' && r.json.customer_name) return { ok: true, name: String(r.json.customer_name), address: String(r.json.customer_address || '') };
    if (r.status >= 500) throw new Error('EasyAccess verify error (' + r.status + ')');
    return { ok: false, error: 'We could not verify this meter number. Please check it and try again.' };
  }
  const q = new URLSearchParams({ meter_number: meterNumber, disco: String(d.id), meter_type: meterType });
  const r = await lgw(env, 'GET', '/bill/bill-validation?' + q.toString());
  if (r.status === 200 && String(r.json.status).toLowerCase() === 'success' && r.json.name) return { ok: true, name: String(r.json.name), address: '' };
  if (r.status >= 400 && r.status < 500 && r.status !== 429) return { ok: false, error: 'We could not verify this meter number. Please check it and try again.' };
  if (r.status === 200) return { ok: false, error: 'We could not verify this meter number. Please check it and try again.' };
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
// What a customer may read when the provider refuses a purchase. Never the provider's raw text.
function safeProviderMessage(m) {
  const t = String(m || '');
  if (/invalid.*(number|phone|meter|card|smart)|wrong.*(number|phone)|not.*valid/i.test(t)) return 'We could not complete this transaction. Please check the number you entered. Your wallet was refunded.';
  if (/not available|unavailable|out of stock|maintenance|suspend|disabled|temporar/i.test(t)) return 'This service is temporarily unavailable. Your wallet was refunded. Please try again later.';
  return 'We could not complete this transaction. Your wallet was refunded. Please check its status before trying again.';
}
function interpret(r) {
  const j = r.json || {}, st = String(j.status || '').toLowerCase();
  if (r.status === 401 || r.status === 403) { console.error('Legitdataway: API token rejected (' + r.status + ')'); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
  if (st === 'success' && r.status >= 200 && r.status < 300) return { ok: true, ref: j['request-id'] || null, token: j.token || '', units: j.units || '', cost: realCost(j), raw: j };
  if (['process', 'processing', 'pending', 'queued'].includes(st)) return { pending: true };
  if (['fail', 'failed', 'error'].includes(st) && r.status < 500) {
    if (/insufficient|balance|wallet/i.test(String(j.message))) { console.error('Legitdataway wallet balance is too low:', j.message); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
    return { ok: false, definite: true, error: safeProviderMessage(j.message), detail: String(j.message || '').slice(0, 200) };   // the provider's own words stay in the error log, customers get a safe sentence
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

/* ---- EasyAccess calls */
const eaBase = (env, live) => (!live && env.EASYACCESS_TEST === '1' ? 'https://easyaccessapi.com.ng/api/test/v1' : 'https://easyaccessapi.com.ng/api/live/v1');
export async function ea(env, method, path, body, forceLive) {
  if (!env.EASYACCESS_TOKEN) throw new Error('EASYACCESS_TOKEN is not set');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 28000);
  try {
    const r = await fetch(eaBase(env, forceLive === true) + path, { method, signal: ctl.signal, headers: { authorization: 'Bearer ' + env.EASYACCESS_TOKEN, 'cache-control': 'no-cache', accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}
// Success only when EasyAccess says so (200/201 AND status success). Failed (400/401 or status failed) = nothing delivered -> refund. Anything else stays pending.
function interpretEA(r) {
  const j = r.json || {}, st = String(j.status || '').toLowerCase(), code = Number(j.code != null ? j.code : r.status);
  if (r.status === 401 || r.status === 403 || code === 401) { console.error('EasyAccess: API token rejected'); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
  if ((st === 'success' || st === 'successful') && (code === 200 || code === 201)) return { ok: true, ref: j.reference || null, token: j.token || j.meter_token || '', units: j.units || j.unit || '', cost: money(j.amount_paid), raw: j };
  if (['processing', 'pending', 'queued'].includes(st)) return { pending: true, ref: j.reference || null };
  if (st === 'failed' || code === 400 || r.status === 400) {
    if (/insufficient|low balance|wallet/i.test(String(j.true_response || j.message))) { console.error('EasyAccess wallet balance is too low:', j.true_response || j.message); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
    return { ok: false, definite: true, error: safeProviderMessage(j.true_response || j.message), detail: String(j.true_response || j.message || '').slice(0, 200) };
  }
  throw new Error(`EasyAccess unexpected response (${r.status}): ${st} ${j.message || ''}`);
}
const eaStr = (v) => String(v).replace(/^ea/, '');
async function runEasy(env, kind, p) {
  const maxPay = p.maxCost ? Math.ceil(Number(p.maxCost)) : undefined;
  let res;
  switch (kind) {
    case 'data': res = interpretEA(await ea(env, 'POST', '/purchase-data', { network: EA_NET[p.network], dataplan: Number(eaStr(p.planCode)), mobileno: localPhone(p.phone), client_reference: p.requestRef, ...(maxPay ? { max_amount_payable: maxPay } : {}) })); break;
    case 'cable': {
      let v; try { v = await ea(env, 'POST', '/verify-tv', { company: EA_CABLE[p.provider], iucno: p.smartcard }); } catch (e) { return { ok: false, definite: true, error: 'We could not verify this smartcard right now. Your wallet was refunded. Please try again.' }; }   // EasyAccess refuses a subscription for a card that was not verified first
      if (v.json.status !== 'success') return { ok: false, definite: true, error: 'We could not verify this smartcard/IUC number. Your wallet was refunded. Please check it and try again.' };
      res = interpretEA(await ea(env, 'POST', '/pay-tv', { company: EA_CABLE[p.provider], package: Number(eaStr(p.planCode)), iucno: p.smartcard, ...(maxPay ? { max_amount_payable: maxPay } : {}) })); break;
    }
    case 'electricity': {
      const company = EA_DISCOS[p.discoCode], mt = p.meterType === 'postpaid' ? 2 : 1;
      if (company == null) return { ok: false, definite: true, error: 'This electricity company is not available right now. Your wallet was refunded.' };
      let v; try { v = await ea(env, 'POST', '/verify-electricity', { company, metertype: mt, meterno: p.meterNumber, amount: Math.round(Number(p.amount)) }); } catch (e) { return { ok: false, definite: true, error: 'We could not verify this meter right now. Your wallet was refunded. Please try again.' }; }
      if (v.json.status !== 'success') return { ok: false, definite: true, error: 'We could not verify this meter number. Your wallet was refunded. Please check it and try again.' };
      res = interpretEA(await ea(env, 'POST', '/pay-electricity', { company, metertype: mt, meterno: p.meterNumber, amount: String(Math.round(Number(p.amount))) })); break;
    }
    case 'exam': res = interpretEA(await ea(env, 'POST', '/exam-pins', { exam_board: Number(p.examId), no_of_pins: Number(p.quantity), ...(maxPay ? { max_amount_payable: maxPay } : {}) })); break;
    default: return NOT_AVAILABLE;
  }
  if (res.ok && kind === 'exam') {
    const pins = (Array.isArray(res.raw.pins) ? res.raw.pins : []).map((x) => { const [pin, serial] = String(x).split('<=>'); return { pin: pin || '', serial: serial || '' }; });
    if (pins.length < Number(p.quantity || 1)) { console.error('EasyAccess: PINs missing in a successful reply', p.requestRef); res.pins = pins.length ? pins : undefined; if (!pins.length) res.ref = 'PINs were not returned. Contact support.'; } else res.pins = pins;
  }
  if (res.ok && kind === 'electricity' && !res.token) { console.error('EasyAccess: electricity token missing in a successful reply', p.requestRef); res.ref = res.ref || 'Token was not returned. Contact support.'; }
  delete res.raw;
  return res;
}
// Ask EasyAccess for the real result of a purchase (used before trusting its webhook, which carries no signature).
export async function eaQuery(env, reference) {
  const r = await ea(env, 'POST', '/query-transactions', { reference: String(reference) });
  const s = String(r.json.retrieved_status || '').toLowerCase();
  return { state: s === 'successful' || s === 'success' ? 'success' : s === 'failed' ? 'failed' : 'pending' };
}

/* ---- VendPower calls. The sandbox and the live API share one address; only the key differs (a vp_sandbox_ key = fake money). */
export async function vp(env, method, path, body) {
  if (!env.VENDPOWER_API_KEY) throw new Error('VENDPOWER_API_KEY is not set');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 28000);
  try {
    const r = await fetch('https://api.vendpower.ng/api/v1' + path, { method, signal: ctl.signal, headers: { 'x-api-key': env.VENDPOWER_API_KEY, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}
const vpBad = (m) => /insufficient|balance|wallet/i.test(String(m || ''));
// success = HTTP 200 AND data.status success. 201/202/processing/pending = keep waiting. 400/402/422/404 or failed/refunded = nothing delivered -> refund.
// 429, 5xx and anything unexpected stay pending and are settled later by asking VendPower (GET /transactions/{reference}).
function interpretVP(r) {
  const j = r.json || {}, d = j.data || {}, st = String(d.status || '').toLowerCase();
  if (r.status === 401 || r.status === 403) { console.error('VendPower: API key rejected or product not enabled for it (' + r.status + ')'); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
  if (r.status === 409) return { pending: true, ref: (j.errors && j.errors.reference) || null };
  if (r.status === 200 && st === 'success') return { ok: true, ref: d.reference || null, token: d.token || '', units: d.units || '', cost: money(d.charge != null ? d.charge : d.amount), data: d };
  if (r.status === 201 || r.status === 202 || st === 'processing' || st === 'pending') return { pending: true, ref: d.reference || null };
  if (r.status === 400 || r.status === 402 || r.status === 404 || r.status === 422 || st === 'failed' || st === 'refunded') {
    if (vpBad(j.message)) { console.error('VendPower wallet balance is too low:', j.message); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
    return { ok: false, definite: true, error: safeProviderMessage(j.message), detail: String(j.message || '').slice(0, 200) };
  }
  throw new Error(`VendPower unexpected response (${r.status}): ${st} ${String(j.message || '').slice(0, 80)}`);
}
// Ask VendPower what happened to a purchase (its reference is the idempotency key we sent = our transaction id).
export async function vpTxStatus(env, ref) {
  const r = await vp(env, 'GET', '/transactions/' + encodeURIComponent(ref));
  if (r.status === 404) return { state: 'missing' };
  const d = (r.json && r.json.data) || {}, st = String(d.status || '').toLowerCase();
  if (r.status !== 200) return { state: 'pending' };
  return { state: st === 'success' ? 'success' : (st === 'failed' || st === 'refunded') ? 'failed' : 'pending', data: d };
}
async function runVendpower(env, kind, p) {
  const key = p.requestRef;
  if (kind === 'cable') {
    const biller = String(p.provider).toUpperCase();
    let v; try { v = await vp(env, 'POST', '/cable/validate', { biller_code: biller, customer_id: p.smartcard }); } catch (e) { return { ok: false, definite: true, error: 'We could not verify this smartcard right now. Your wallet was refunded. Please try again.' }; }
    if (v.status !== 200 || !(v.json.data && v.json.data.customer_name)) return { ok: false, definite: true, error: 'We could not verify this smartcard/IUC number. Your wallet was refunded. Please check it and try again.' };
    const res = interpretVP(await vp(env, 'POST', '/cable/purchase', { biller_code: biller, plan_id: String(p.planCode).replace(/^vp/, ''), customer_id: p.smartcard, ...(p.customerPhone ? { customer_phone: p.customerPhone } : {}), idempotency_key: key }));
    delete res.data; return res;
  }
  if (kind === 'electricity') {
    const d = vpDisco(env, p.discoCode, p.meterType);
    if (!d) return { ok: false, definite: true, error: 'This electricity company is not available right now. Your wallet was refunded.' };
    let v; try { v = await vp(env, 'POST', '/electricity/validate-meter', { meter_number: p.meterNumber, disco_code: d.disco_code, meter_type: d.vend_type }); } catch (e) { return { ok: false, definite: true, error: 'We could not verify this meter right now. Your wallet was refunded. Please try again.' }; }
    if (v.status !== 200 || !(v.json.data && v.json.data.customer_name)) return { ok: false, definite: true, error: 'We could not verify this meter number. Your wallet was refunded. Please check it and try again.' };
    const res = interpretVP(await vp(env, 'POST', '/electricity/purchase', { disco_code: d.disco_code, meter_type: d.vend_type, meter_number: p.meterNumber, amount: Math.round(Number(p.amount)), customer_phone: p.customerPhone || localPhone(p.phone || '') || '', idempotency_key: key }));
    if (res.ok && !res.token) { console.error('VendPower: electricity token missing in a successful reply', key); res.ref = res.ref || 'Token was not returned. Contact support.'; }
    delete res.data; return res;
  }
  return NOT_AVAILABLE;
}

export async function runProvider(env, kind, p) {
  if (providerFor(env, kind) === 'easyaccess') return runEasy(env, kind, p);
  if (providerFor(env, kind) === 'vendpower') return runVendpower(env, kind, p);
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
