const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, email_confirmed INTEGER NOT NULL DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, full_name TEXT, username TEXT UNIQUE, phone TEXT, referral_code TEXT UNIQUE, referral_code_used TEXT, balance_ngn REAL NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, is_banned INTEGER NOT NULL DEFAULT 0, transaction_pin_hash TEXT, transaction_pin_salt TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT, label TEXT, amount REAL NOT NULL DEFAULT 0, direction TEXT, status TEXT NOT NULL DEFAULT 'pending', provider_ref TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT UNIQUE, tx_ref TEXT, amount REAL, currency TEXT, status TEXT, payload TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
];

const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-headers':'content-type,authorization,verif-hash','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS'}});
const uid = () => crypto.randomUUID();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
async function digest(text){ return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
async function passwordHash(password, salt){ const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']); return b64(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:210000,hash:'SHA-256'},key,256)); }
async function tokenFor(user, secret){ const payload=b64(new TextEncoder().encode(JSON.stringify({sub:user.id,email:user.email,exp:Math.floor(Date.now()/1000)+60*60*24*7}))); const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); const sig=b64(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(payload))); return payload+'.'+sig; }
async function verifyToken(token, secret){ try {const [p,s]=token.split('.');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);const sig=Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(!await crypto.subtle.verify('HMAC',key,sig,new TextEncoder().encode(p)))return null;const v=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));return v.exp>Date.now()/1000?v:null;}catch{return null;} }
async function authUser(req, env){const h=req.headers.get('authorization')||'';const token=h.replace(/^Bearer\s+/i,'');const v=await verifyToken(token,env.AUTH_SECRET||'SET_A_LONG_RANDOM_AUTH_SECRET');if(!v)return null;return await env.DB.prepare('SELECT id,email FROM users WHERE id=?').bind(v.sub).first();}
async function ensureSchema(env){for(const sql of SCHEMA) await env.DB.prepare(sql).run();}
async function body(req){try{return await req.json()}catch{return {}}}
async function flutterwave(req, env, user){
 const {amount}=await body(req); const n=Number(amount); if(!Number.isFinite(n)||n<100) return json({error:'Enter a valid amount (minimum ₦100).'},400);
 if(!env.FLW_SECRET_KEY) return json({error:'Flutterwave is not configured yet. Add FLW_SECRET_KEY as a Worker secret.'},503);
 const profile=await env.DB.prepare('SELECT full_name,phone FROM profiles WHERE id=?').bind(user.id).first();
 const txRef='UMS-'+uid();
 const payload={tx_ref:txRef,amount:n,currency:'NGN',redirect_url:env.FLW_REDIRECT_URL||new URL('/payment-return',req.url).toString(),customer:{email:user.email,name:profile?.full_name||user.email,phonenumber:profile?.phone||''},customizations:{title:'UMARSHOYI-SUB Wallet Funding',description:'Wallet funding'}};
 const r=await fetch('https://api.flutterwave.com/v3/payments',{method:'POST',headers:{authorization:`Bearer ${env.FLW_SECRET_KEY}`,'content-type':'application/json'},body:JSON.stringify(payload)});const data=await r.json();if(!r.ok||data.status!=='success')return json({error:data.message||'Flutterwave could not start payment.'},502);
 await env.DB.prepare("INSERT INTO transactions(id,user_id,type,label,amount,direction,status,provider_ref,metadata) VALUES(?,?,?,?,?,'in','pending',?,?)").bind(uid(),user.id,'fund','Wallet funding',n,txRef,JSON.stringify({provider:'flutterwave'})).run();
 return json({status:'success',data:{link:data.data.link,tx_ref:txRef}});
}
async function route(req, env){
 const url=new URL(req.url), path=url.pathname; if(req.method==='OPTIONS')return json({ok:true});
 await ensureSchema(env);
 if(path==='/api/health')return json({ok:true,service:'UMARSHOYI-SUB Worker',database:'connected'});
 if(path==='/api/auth/signup'&&req.method==='POST'){
  const x=await body(req), email=String(x.email||'').trim().toLowerCase(), password=String(x.password||''), meta=x.options?.data||{};
  if(!email||password.length<6)return json({error:'Valid email and password (minimum 6 characters) are required.'},400);
  const id=uid(), salt=uid(), hash=await passwordHash(password,salt), pin=String(meta.raw_pin||'');const ps=uid(), ph=pin?await passwordHash(pin,ps):null;
  try{await env.DB.batch([env.DB.prepare('INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)').bind(id,email,hash,salt),env.DB.prepare('INSERT INTO profiles(id,full_name,username,phone,referral_code_used,referral_code,transaction_pin_hash,transaction_pin_salt) VALUES(?,?,?,?,?,?,?,?)').bind(id,meta.full_name||'',meta.username||null,meta.phone||'',meta.referral_code_used||'',('UMS'+crypto.randomUUID().replaceAll('-','').slice(0,7).toUpperCase()),ph,ph?ps:null)]);}catch(e){return json({error:e.message.includes('UNIQUE')?'Email or username already exists.':'Could not create account.'},409)}
  const user={id,email}, token=await tokenFor(user,env.AUTH_SECRET||'SET_A_LONG_RANDOM_AUTH_SECRET');return json({user,session:{access_token:token,token_type:'bearer',user}});
 }
 if(path==='/api/auth/login'&&req.method==='POST'){
  const x=await body(req),email=String(x.email||'').trim().toLowerCase(),u=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();if(!u||await passwordHash(String(x.password||''),u.password_salt)!==u.password_hash)return json({error:'Invalid email or password.'},401);const user={id:u.id,email:u.email},token=await tokenFor(user,env.AUTH_SECRET||'SET_A_LONG_RANDOM_AUTH_SECRET');return json({user,session:{access_token:token,token_type:'bearer',user}});
 }
 const user=await authUser(req,env);
 if(path==='/api/auth/session')return json({session:user?{access_token:(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,''),user}:null});
 if(path==='/api/auth/logout')return json({ok:true});
 if(!user)return json({error:'Please log in again.'},401);
 if(path==='/api/profile'&&req.method==='GET')return json({data:await env.DB.prepare('SELECT * FROM profiles WHERE id=?').bind(user.id).first()});
 if(path==='/api/profile'&&req.method==='PATCH'){const x=await body(req);await env.DB.prepare('UPDATE profiles SET full_name=?,phone=? WHERE id=?').bind(x.full_name||'',x.phone||'',user.id).run();return json({data:{ok:true}})}
 if(path==='/api/transactions')return json({data:(await env.DB.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(user.id).all()).results});
 if(path==='/api/notifications')return json({data:(await env.DB.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all()).results});
 if(path==='/api/functions/initiate-payment'&&req.method==='POST')return flutterwave(req,env,user);
 if(path==='/api/functions/get-virtual-account')return json({error:'Virtual account creation needs the existing Flutterwave virtual-account configuration and verified customer KYC flow.'},501);
 if(path.startsWith('/api/functions/'))return json({error:`${path.split('/').pop()} is not migrated yet. The original Supabase Edge Function source/provider API details were not included in the HTML file.`},501);
 return json({error:'Not found'},404);
}
export default {async fetch(req,env){try{if(new URL(req.url).pathname.startsWith('/api/'))return await route(req,env);return env.ASSETS.fetch(req);}catch(e){return json({error:'Server error',detail:env.ENVIRONMENT==='development'?e.message:undefined},500);}}};
