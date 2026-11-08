// ============================================================================
// PROVIDER ADAPTER  (VTU provider: data, airtime, cable, electricity, exam, betting, SMS)
// ----------------------------------------------------------------------------
// This is the ONLY file you edit when we connect the real VTU API later.
// Every function returns one of:
//   { ok:true,  ref:'provider-reference', pins:[...optional] }   -> purchase worked
//   { ok:false, definite:true,  error:'message' }                -> provider said NO  (wallet is refunded)
// If a function THROWS (network timeout etc.), the transaction stays "pending"
// for manual checking, because the provider may have delivered anyway.
//
// Modes:
//   TEST_MODE = "1"  -> pretend success (for testing the app screens only!)
//   otherwise        -> returns "provider not connected yet" and the user is NOT charged
// ============================================================================

const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const NOT_CONNECTED = { ok: false, definite: true, error: 'This service is not available yet. Your wallet was not charged.' };

export async function runProvider(env, kind, p) {
  if (env.TEST_MODE === '1') {
    if (kind === 'exam' || kind === 'data-card' || kind === 'airtime-card') {
      return { ok: true, ref: 'TEST-' + rnd(8), pins: Array.from({ length: p.quantity }, () => 'TEST-' + rnd(12)) };
    }
    return { ok: true, ref: 'TEST-' + rnd(10) };
  }

  // ---- REAL PROVIDER GOES HERE (later) -------------------------------------
  // switch (kind) {
  //   case 'data':        return await callProvider(env, '/data',        { network:p.network, phone:p.phone, plan:p.planCode });
  //   case 'airtime':     return await callProvider(env, '/airtime',     { network:p.network, phone:p.phone, amount:p.amount });
  //   case 'cable':       ...   case 'electricity': ...   case 'exam': ...
  //   case 'data-card':   ...   case 'airtime-card': ...  case 'betting': ...
  // }
  // --------------------------------------------------------------------------
  return NOT_CONNECTED;
}

export async function sendSms(env, phone, text) {
  if (env.TEST_MODE === '1') return { ok: true, test: true };
  // ---- REAL SMS PROVIDER GOES HERE (later) ----
  return { ok: false, error: 'SMS service is not connected yet.' };
}

// Airtime-to-cash conversion. Returns { ok:true, credited:<naira> }
export async function convertAirtimeToCash(env, { phone, network, amount }) {
  if (env.TEST_MODE === '1') {
    const rate = Number(env.A2C_RATE || 0.7)  // the app says N30 fee per N100 -> customer gets 70%;
    return { ok: true, ref: 'TEST-' + rnd(8), credited: Math.round(amount * rate * 100) / 100 };
  }
  return NOT_CONNECTED;
}
