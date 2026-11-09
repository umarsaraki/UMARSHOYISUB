// ============================================================================
// VTUAgent connection  (https://docs.vtuagent.com)
// Supports: airtime, data, cable TV, electricity.
// NOT supported by VTUAgent (stay "not available"): exam PINs, betting, data cards, recharge cards.
//
// Secret to set in Cloudflare:  VTUAGENT_API_KEY
// Optional variables:           VTUAGENT_BASE_URL (default https://api.vtuagent.com)
//                               PRICE_MARKUP_PERCENT (default 12; applied to data and cable)
//
// runProvider() returns one of:
//   { ok:true,  ref, token?, units? }          delivered
//   { pending:true }                           provider is still processing (resolved later by webhook / cron)
//   { ok:false, definite:true, error }         provider said NO and nothing was delivered -> customer is refunded
// If it THROWS (timeout, provider error), the transaction stays "pending" and is resolved later.
// ============================================================================

const NOT_AVAILABLE = { ok: false, definite: true, error: 'This service is not available yet. Your wallet was not charged.' };
const baseUrl = (env) => String(env.VTUAGENT_BASE_URL || 'https://api.vtuagent.com').replace(/\/+$/, '');

async function vtu(env, method, path, body) {
  if (!env.VTUAGENT_API_KEY) throw new Error('VTUAGENT_API_KEY is not set');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 28000);
  try {
    const r = await fetch(baseUrl(env) + path, { method, signal: ctl.signal, headers: { authorization: 'Bearer ' + env.VTUAGENT_API_KEY, accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------ prices */
export function markup(env, cost) {
  const pct = Number(env.PRICE_MARKUP_PERCENT ?? 12);
  return Math.ceil(Math.round(Number(cost) * (100 + pct) * 100) / 10000); // rounded UP to a whole naira
}
async function cachedList(cache, key, loader) {
  const hit = cache[key], age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < 5 * 60 * 1000) return hit.list;
  try { const list = await loader(); cache[key] = { at: Date.now(), list }; return list; }
  catch (e) { if (hit && age < 60 * 60 * 1000) return hit.list; throw e; }
}

// Live data plans: VTUAgent returns OUR cost; the customer price = cost + markup.
const planCache = {};
export async function getDataPlans(env) {
  return cachedList(planCache, 'data', async () => {
    const r = await vtu(env, 'GET', '/v1/data/plans');
    if (r.status !== 200 || r.json.status !== 'success') throw new Error(r.json.message || `VTUAgent plans error (${r.status})`);
    return (Array.isArray(r.json.data) ? r.json.data : []).filter((p) => p.is_active && p.plan_id && Number(p.price) > 0).map((p) => {
      const cost = Number(p.price), cat = String(p.plan_name || '').match(/\(([^)]+)\)/);
      return { code: String(p.plan_id), network: String(p.network || '').toLowerCase(), category: cat ? cat[1].trim() : 'Data', size: String(p.name || p.plan_name || ''), valid: String(p.validity || ''), cost, price: markup(env, cost) };
    });
  });
}

// Live cable bouquets for dstv / gotv / startimes.
const cableCache = {};
export const CABLE_PROVIDERS = ['dstv', 'gotv', 'startimes'];
export async function getCablePlans(env, provider) {
  if (!CABLE_PROVIDERS.includes(provider)) throw new Error('Unknown cable provider');
  return cachedList(cableCache, provider, async () => {
    const r = await vtu(env, 'POST', '/v1/cabletv/variations', { product_type: provider });
    if (r.status !== 200 || r.json.status !== 'successful') throw new Error(r.json.message || `VTUAgent cable error (${r.status})`);
    return (r.json.data?.packages || []).filter((p) => p.package_code && Number(p.price) > 0).map((p) => ({ code: String(p.package_code), name: String(p.package_name || p.package_code), cost: Number(p.price), price: markup(env, p.price) }));
  });
}

/* ------------------------------------------------------- verification */
export async function verifySmartcard(env, provider, smartcard) {
  const r = await vtu(env, 'POST', '/v1/cabletv/verify', { product_type: provider, smartcard_number: smartcard });
  if (r.status === 200 && r.json.status === 'successful') return { ok: true, name: r.json.data?.customer_name || '', status: r.json.data?.status || '', due: r.json.data?.due_date || '' };
  if (r.status === 424 || r.status === 400) return { ok: false, error: r.json.message || 'Could not verify this smartcard number.' };
  throw new Error(r.json.message || `VTUAgent verify error (${r.status})`);
}
export async function verifyMeter(env, disco, meterNumber, meterType) {
  const r = await vtu(env, 'POST', '/v1/electricity/verify', { disco, meter_number: meterNumber, meter_type: meterType });
  if (r.status === 200 && r.json.status === 'successful') return { ok: true, name: r.json.data?.customer_name || '', address: r.json.data?.address || '' };
  if (r.status === 424 || r.status === 400) return { ok: false, error: r.json.message || 'Could not verify this meter number.' };
  throw new Error(r.json.message || `VTUAgent verify error (${r.status})`);
}

/* ----------------------------------------------------------- purchases */
function interpret(r) {
  const j = r.json || {};
  if (r.status === 200 && j.status === 'successful') {
    const d = j.data || {};
    return { ok: true, ref: j.reference || null, token: d.token || '', units: d.units || '' };
  }
  if (r.status === 202) return { pending: true };
  if (r.status === 424) return { ok: false, definite: true, error: j.message || 'The provider could not complete this purchase. You were refunded.' };
  if (r.status === 401) { console.error('VTUAgent: API key rejected (401)'); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
  if (r.status === 400) {
    if (/insufficient|balance|wallet/i.test(String(j.message))) { console.error('VTUAgent wallet balance is too low:', j.message); return { ok: false, definite: true, error: 'This service is temporarily unavailable. Please try again later.' }; }
    return { ok: false, definite: true, error: j.message || 'The request was rejected. Please check the details and try again.' };
  }
  throw new Error(`VTUAgent unexpected response (${r.status}): ${j.message || ''}`); // unknown -> stays pending
}

export async function runProvider(env, kind, p) {
  const ref = p.requestRef;
  switch (kind) {
    case 'data': return interpret(await vtu(env, 'POST', '/v1/data/purchase', { plan_id: p.planCode, phone: p.phone, request_ref: ref }));
    case 'airtime': return interpret(await vtu(env, 'POST', '/v1/airtime/purchase', { network: p.network === '9mobile' ? 'etisalat' : p.network, phone: p.phone, amount: p.amount, request_ref: ref }));
    case 'cable': return interpret(await vtu(env, 'POST', '/v1/cabletv/purchase', { product_type: p.provider, smartcard_number: p.smartcard, package_code: p.planCode, amount: p.amount, phone: p.phone, subscription_type: 'renew', request_ref: ref }));
    case 'electricity': return interpret(await vtu(env, 'POST', '/v1/electricity/purchase', { disco: p.disco, meter_number: p.meterNumber, meter_type: p.meterType, amount: p.amount, phone: p.phone, request_ref: ref }));
    default: return NOT_AVAILABLE; // exam, betting, data-card, airtime-card: VTUAgent does not offer these
  }
}

// Ask VTUAgent what happened to a transaction. state: success | pending | failed | missing
export async function checkStatus(env, requestRef) {
  const r = await vtu(env, 'POST', '/v1/transaction/status', { request_ref: requestRef });
  if (r.status === 200) {
    const d = r.json.data || {}, spent = Number(d.previous_balance) - Number(d.new_balance);
    return { state: 'success', cost: Number.isFinite(spent) && spent > 0 ? Math.round(spent * 100) / 100 : null, message: r.json.message };
  }
  if (r.status === 202) return { state: 'pending' };
  if (r.status === 424) return { state: 'failed', message: r.json.message };
  if (r.status === 404 || r.status === 403) return { state: 'missing' };
  throw new Error(`VTUAgent status error (${r.status})`);
}

/* ------------------------------------------------------------- webhook */
export async function setWebhook(env, url) {
  const r = await vtu(env, 'POST', '/v1/webhook/set', { webhook_url: url });
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { ok: false, error: r.json.message || `VTUAgent webhook error (${r.status})` };
}
export async function webhookHashOk(env, reference, hash) {
  if (!env.VTUAGENT_API_KEY || !reference || !hash) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.VTUAGENT_API_KEY}:${reference}`));
  const expected = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''), got = String(hash).toLowerCase();
  if (expected.length !== got.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------- not offered by VTUAgent (yet) */
export async function sendSms(env, phone, text) { return { ok: false, error: 'SMS service is not connected yet.' }; }
export async function convertAirtimeToCash(env, { phone, network, amount }) { return NOT_AVAILABLE; }
