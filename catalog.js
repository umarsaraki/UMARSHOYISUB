// ============================================================================
// UMARSHOYI-SUB — CATALOG (provider: Legitdataway)
//
// This file lists WHAT the provider sells and what it COSTS YOU. Your PROFIT is NOT here:
// set it in  Admin Panel -> Settings -> Profit  (customer price = cost + your profit).
// So when Legitdataway raises a price you do not have to edit the code to stay safe:
// just raise the profit in the Admin Panel. ("My Profit" always uses the real amount the
// provider took from your wallet, so you can see at once if a price rose.)
//
// To ADD or CHANGE a plan, edit one line below. Nothing else needs to change.
// ============================================================================

// Legitdataway network ids
export const NETWORK_IDS = { mtn: 1, airtel: 2, glo: 3, '9mobile': 4 };

// ---------------------------------------------------------------- DATA BUNDLES
// [network, provider plan id, category, size, validity, YOUR COST in naira]   (VITEL is not offered: its network id was not given by the provider)   (VITEL is not offered: its network id was not given by the provider)
const DATA = [
  // MTN
  ['mtn', 36, 'SME', '500MB', '7 days', 265],
  ['mtn', 37, 'SME', '1GB', '7 days', 380],
  ['mtn', 38, 'SME', '2GB', '30 days', 800],
  ['mtn', 39, 'SME', '3GB', '1 Month', 1050],
  ['mtn', 40, 'SME', '5GB', '30 days', 1560],
  ['mtn', 46, 'Corporate Gifting', '1GB', '24 hours', 219],
  ['mtn', 262, 'Gifting', '75MB', '1 day', 73.5],
  ['mtn', 265, 'Gifting', '500MB', '1 day', 343],
  ['mtn', 266, 'Gifting', '1GB', '1 day', 490],
  ['mtn', 267, 'Gifting', '1.5GB', '2 days', 588],
  ['mtn', 268, 'Gifting', '2GB', '2 days', 735],
  ['mtn', 269, 'Gifting', '2.5GB', '2 days', 882],
  ['mtn', 270, 'Gifting', '3.2GB', '2 days', 980],
  ['mtn', 271, 'Gifting', '2GB', '30 days', 1470],
  ['mtn', 272, 'Gifting', '2.7GB', '30 days', 1960],
  ['mtn', 273, 'Gifting', '3.5GB', '30 days', 2450],
  ['mtn', 274, 'Gifting', '3.5GB', '7 days', 1470],
  ['mtn', 275, 'Gifting', '1.8GB', '30 days', 1470],
  ['mtn', 276, 'Gifting', '7GB', '30 days', 3430],
  ['mtn', 277, 'Gifting', '7GB', '2 days', 1764],
  ['mtn', 278, 'Gifting', '5.5GB', '30 days', 2940],
  ['mtn', 279, 'Gifting', '10GB', '30 days', 4410],
  ['mtn', 280, 'Gifting', '11GB', '7 days', 3430],
  ['mtn', 281, 'Gifting', '12.5GB', '30 days', 5390],
  ['mtn', 282, 'Gifting', '14.5GB', '30 days', 4900],
  ['mtn', 283, 'Gifting', '16.5GB', '30 days', 6370],
  ['mtn', 284, 'Gifting', '20GB', '30 days', 7350],
  ['mtn', 285, 'Gifting', '25GB', '30 days', 6860],
  ['mtn', 286, 'Gifting', '25GB', '30 days', 8820],
  ['mtn', 287, 'Gifting', '34GB', '30 days', 9800],
  ['mtn', 288, 'Gifting', '36GB', '30 days', 10780],
  ['mtn', 289, 'Gifting', '40GB', '60 days', 8820],
  ['mtn', 290, 'Gifting', '65GB', '30 days', 15680],
  ['mtn', 291, 'Gifting', '75GB', '30 days', 17600],
  ['mtn', 292, 'Gifting', '90GB', '60 days', 24500],
  ['mtn', 293, 'Gifting', '165GB', '30 days', 34300],
  ['mtn', 294, 'Gifting', '250GB', '30 days', 53900],
  ['mtn', 295, 'Gifting', '800GB', '1 year', 122500],
  ['mtn', 315, 'SME', '1GB', '30 days', 500],
  ['mtn', 322, 'Corporate Gifting', '1GB', '30 days', 210],
  ['mtn', 323, 'Corporate Gifting', '2GB', '30 days', 425],
  ['mtn', 324, 'Corporate Gifting', '3GB', '30 days', 630],
  ['mtn', 325, 'Corporate Gifting', '5GB', '30 days', 1025],
  ['mtn', 374, 'Gifting', '4GB', '2 days', 970],
  ['mtn', 377, 'Gifting', '5GB', '2 days', 1470],
  ['mtn', 378, 'Gifting', '6.5GB', '2 days', 1470],
  // AIRTEL
  ['airtel', 231, 'Gifting', '10GB', '30 days', 2850],
  ['airtel', 232, 'Gifting', '1GB', '7 days', 760],
  ['airtel', 233, 'Gifting', '1GB', '3 days', 285],
  ['airtel', 234, 'Gifting', '2GB', '30 days', 1425],
  ['airtel', 235, 'Gifting', '500MB', '7 days', 475],
  ['airtel', 236, 'Gifting', '3GB', '30 days', 1900],
  ['airtel', 237, 'Gifting', '3GB', '2 days', 713],
  ['airtel', 238, 'Gifting', '1.5GB', '7 days', 475],
  ['airtel', 239, 'Gifting', '1.5GB', '7 days', 950],
  ['airtel', 240, 'Gifting', '1.5GB', '1 day', 505],
  ['airtel', 241, 'Gifting', '1.5GB', '1 day', 405],
  ['airtel', 242, 'Gifting', '75MB', '1 day', 71.5],
  ['airtel', 243, 'Gifting', '110MB', '1 day', 95],
  ['airtel', 244, 'Gifting', '250MB', '1 day', 47.5],
  ['airtel', 245, 'Gifting', '2GB', '7 days', 570],
  ['airtel', 247, 'Gifting', '600MB', '2 days', 205],
  ['airtel', 248, 'Gifting', '3GB', '30 days', 1900],
  ['airtel', 249, 'Gifting', '4GB', '30 days', 2375],
  ['airtel', 250, 'Gifting', '5GB', '7 days', 1425],
  ['airtel', 251, 'Gifting', '8GB', '30 days', 2850],
  ['airtel', 252, 'Gifting', '10GB', '30 days', 3800],
  ['airtel', 253, 'Gifting', '13GB', '30 days', 4750],
  ['airtel', 254, 'Gifting', '25GB', '30 days', 7600],
  ['airtel', 255, 'Gifting', '35GB', '30 days', 9500],
  ['airtel', 256, 'Gifting', '60GB', '30 days', 14250],
  ['airtel', 257, 'Gifting', '100GB', '30 days', 19000],
  ['airtel', 258, 'Gifting', '300GB', '90 days', 47500],
  ['airtel', 259, 'Gifting', '350GB', '120 days', 57000],
  ['airtel', 260, 'Gifting', '685GB', '1 year', 95000],
  ['airtel', 296, 'Gifting', '8GB', '30 days (Ebony)', 1900],
  ['airtel', 297, 'Gifting', '60GB', '1 year (Ebony)', 9500],
  ['airtel', 326, 'Corporate Gifting', '1.2GB', '7 days', 192],
  ['airtel', 327, 'Corporate Gifting', '2GB', '7 days', 288],
  ['airtel', 328, 'Corporate Gifting', '3.2GB', '7 days', 480],
  ['airtel', 329, 'Corporate Gifting', '3.2GB', '30 days', 480],
  ['airtel', 330, 'Corporate Gifting', '6.5GB', '14 days', 960],
  ['airtel', 331, 'Corporate Gifting', '20GB', '30 days', 2880],
  ['airtel', 375, 'Gifting', '6GB', '7 days', 2425],
  ['airtel', 376, 'Gifting', '10GB', '7 days', 2910],
  // GLO
  ['glo', 70, 'Corporate Gifting', '200MB', '30 days', 85],
  ['glo', 71, 'Corporate Gifting', '500MB', '30 days', 195],
  ['glo', 72, 'Corporate Gifting', '1GB', '30 days', 390],
  ['glo', 73, 'Corporate Gifting', '2GB', '30 days', 780],
  ['glo', 74, 'Corporate Gifting', '3GB', '30 days', 1170],
  ['glo', 75, 'Corporate Gifting', '5GB', '30 days', 1950],
  ['glo', 76, 'Corporate Gifting', '10GB', '30 days', 3900],
  ['glo', 220, 'SME', '500MB', '14 days', 195],
  ['glo', 221, 'SME', '1GB', '14 days', 348],
  ['glo', 222, 'SME', '1GB', '3 days', 332],
  ['glo', 223, 'SME', '1GB', '7 days', 348],
  ['glo', 224, 'SME', '3GB', '3 days', 995],
  ['glo', 225, 'SME', '3GB', '7 days', 1044],
  ['glo', 226, 'SME', '3GB', '14 days', 1044],
  ['glo', 227, 'SME', '5GB', '3 days', 1660],
  ['glo', 228, 'SME', '5GB', '7 days', 1740],
  ['glo', 229, 'SME', '5GB', '14 days', 1740],
  ['glo', 230, 'SME', '10GB', '14 days', 3480],
  ['glo', 298, 'Gifting', '45MB', '1 day', 45],
  ['glo', 299, 'Gifting', '100MB', '1 day', 98],
  ['glo', 300, 'Gifting', '200MB', '2 days', 196],
  ['glo', 301, 'Gifting', '1.5GB', '1 day', 294],
  ['glo', 302, 'Gifting', '3GB', '2 days', 735],
  ['glo', 303, 'Gifting', '2.5GB', '2 days', 490],
  ['glo', 304, 'Gifting', '1.5GB', '7 days', 490],
  ['glo', 305, 'Gifting', '2.6GB', '30 days', 980],
  ['glo', 306, 'Gifting', '5GB', '30 days', 1470],
  ['glo', 307, 'Gifting', '6.15GB', '30 days', 1960],
  ['glo', 308, 'Gifting', '7.25GB', '30 days', 2450],
  ['glo', 309, 'Gifting', '10GB', '30 days', 2940],
  ['glo', 310, 'Gifting', '12.5GB', '30 days', 3920],
  ['glo', 311, 'Gifting', '16GB', '30 days', 4900],
  ['glo', 312, 'Gifting', '20GB', '30 days', 5880],
  ['glo', 314, 'Gifting', '28GB', '30 days', 7840],
  // 9MOBILE
  ['9mobile', 61, 'SME', '1.1GB', '30 days', 390],
  ['9mobile', 62, 'SME', '2GB', '30 days', 750],
  ['9mobile', 68, 'Gifting', '1.5GB', '30 days', 870],
  ['9mobile', 69, 'Gifting', '500MB', '30 days', 440],
  ['9mobile', 85, 'Corporate Gifting', '500MB', '30 days', 240],
  ['9mobile', 86, 'Corporate Gifting', '1GB', '30 days', 480],
  ['9mobile', 87, 'Corporate Gifting', '2GB', '30 days', 960],
  ['9mobile', 88, 'Corporate Gifting', '3GB', '30 days', 1440],
  ['9mobile', 89, 'Corporate Gifting', '4GB', '30 days', 1920],
  ['9mobile', 90, 'Corporate Gifting', '5GB', '30 days', 2400],
  ['9mobile', 91, 'Corporate Gifting', '10GB', '30 days', 4800],
];
export const DATA_BUNDLES = DATA.map(([network, code, category, size, valid, cost]) => ({ network, code: String(code), category, size, valid, cost }));

// ---------------------------------------------------------------- AIRTIME
export const AIRTIME_MIN = 50;
export const AIRTIME_MAX = 100000;
export const AIRTIME_COST_RATE = 0.97;          // estimate only (provider gave 3% discount in its example); the real cost is read from the provider's reply

// ---------------------------------------------------------------- CABLE TV
// provider = dstv | gotv | startimes.  code = Legitdataway "cableplan" (for example 'dstv-padi'). cost in naira.
// Empty list = "Coming soon" for that provider. Add rows like:  { code: 'dstv-padi', name: 'DStv Padi', cost: 2500 }
export const CABLE_PLANS = { dstv: [], gotv: [], startimes: [] };

// ---------------------------------------------------------------- ELECTRICITY
// id = Legitdataway disco id
export const ELECTRICITY_DISCOS = [
  { code: 'ikeja-electric', id: 1, name: 'Ikeja Electric (IKEDC)' },
  { code: 'eko-electric', id: 2, name: 'Eko Electric (EKEDC)' },
  { code: 'kano-electric', id: 3, name: 'Kano Electric (KEDCO)' },
  { code: 'portharcourt-electric', id: 4, name: 'Port Harcourt Electric (PHED)' },
  { code: 'jos-electric', id: 5, name: 'Jos Electric (JED)' },
  { code: 'ibadan-electric', id: 6, name: 'Ibadan Electric (IBEDC)' },
  { code: 'kaduna-electric', id: 7, name: 'Kaduna Electric (KAEDCO)' },
  { code: 'abuja-electric', id: 8, name: 'Abuja Electric (AEDC)' },
  { code: 'yola-electric', id: 9, name: 'Yola Electric (YEDC)' },
  { code: 'benin-electric', id: 10, name: 'Benin Electric (BEDC)' },
];
export const ELECTRICITY_MIN = 1000;
export const ELECTRICITY_MAX = 200000;
export const ELECTRICITY_COST_RATE = 1.07;     // estimate: provider's example charged 7% on top of the amount; the real cost is read from the provider's reply

// ---------------------------------------------------------------- EXAM PINS
// id = Legitdataway exam id. available:false shows "Coming soon". cost = your cost per PIN.
export const EXAM_TYPES = {
  waec: { id: 1, name: 'WAEC e-PIN', badge: 'W', color: '#1e35a8', cost: 5100, available: true },
  neco: { id: 2, name: 'NECO e-PIN', badge: 'N', color: '#0b8a5a', cost: 2100, available: true },
  nabteb: { id: 3, name: 'NABTEB e-PIN', badge: 'NB', color: '#b4551a', cost: 855, available: true },
  jamb: { id: 0, name: 'JAMB e-PIN', badge: 'J', color: '#22b573', cost: 0, available: false },   // not offered by the provider yet
};

// ---------------------------------------------------------------- DATA CARDS
// network -> category -> list.  code = Legitdataway data-card "plan_type". cost = your cost per card.
// From your Legitdataway dashboard (Data Card plans). More plans: add a line in the same format. Empty network = "Coming soon".
export const DATA_CARD_PLANS = {
  mtn: { SME: [{ code: '1', size: '10GB', valid: '1 Month', cost: 10000 }] },
};

// ---------------------------------------------------------------- RECHARGE CARDS
// network -> list.  code = Legitdataway recharge-card "plan_type". amount = card value. cost = your cost per card.
// From your Legitdataway dashboard (Recharge Card plans). Add more lines in the same format.
export const RECHARGE_CARDS = {
  mtn: [{ code: '1', amount: 100, cost: 100 }],
};
