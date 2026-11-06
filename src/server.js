'use strict';
const express = require('express');
const path = require('path');
const { get, all, run, db, audit, setting } = require('./db');
const A = require('./auth');
const D = require('./domain');
const Notifications = require('./notifications');
const inventory = require('./inventory');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DEV_SHOW_OTP = process.env.SHOW_OTP !== '0';
if (process.env.NODE_ENV === 'production' && DEV_SHOW_OTP) {
  console.warn('[WARN] SHOW_OTP is enabled in production — login codes will be returned in the API.');
}

// Large image uploads are accepted one at a time to limit peak memory on small hosts.
let imageUploadBusy = false;
function limitLargeUpload(req,res,next){
  if (!['POST','PUT'].includes(req.method)) return next();
  const length=Number(req.headers['content-length']||0);
  if (length && length <= 200000) return next();
  if (imageUploadBusy) return res.status(429).json({message:'يوجد رفع صورة جارٍ؛ انتظري قليلًا ثم حاولي مرة أخرى'});
  imageUploadBusy=true; let done=false;
  const release=()=>{if(!done){done=true;imageUploadBusy=false}};
  res.once('finish',release);res.once('close',release);next();
}
for (const p of ['/api/store/custom-requests','/api/admin/catalogue','/api/store/order-deposits']) app.use(p,limitLargeUpload);
app.use('/api/store/custom-requests', express.json({limit:'3mb'}));
app.use('/api/admin/catalogue', express.json({limit:'3mb'}));
app.use('/api/store/order-deposits', express.json({limit:'3mb'}));
app.use(express.json({ limit: '200kb' }));
app.use(A.attachUser);

/* never let a proxy/browser cache an authenticated response */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

const list = (rows, fn) => rows.map(fn);
const bad = (res, code, error, message) => res.status(code).json({ error, message });
const toInt = (v, d = null) => (v === undefined || v === null || v === '' ? d : parseInt(v, 10));

/* ============================================================
   STORE API  — customer realm. NEVER returns cost/profit/workshop.
   ============================================================ */
app.use('/api/admin/inventory', require('./inventory-admin'));
app.use('/api/admin/deletions', require('./deletions'));
app.use('/api/admin/manual-orders', require('./manual-orders'));
const reviews=require('./reviews');app.use('/api/store/reviews',reviews.store);app.use('/api/admin/reviews',reviews.admin); 
const customRequests = require('./custom-requests');
const orderDeposits = require('./order-deposits');
app.use('/api/store/order-deposits', orderDeposits.customer);
app.use('/api/admin/order-deposits', orderDeposits.admin);
app.use('/api/store/custom-requests', customRequests.store);
app.use('/api/admin/custom-requests', customRequests.admin);
const catalogue = require('./tailoring-catalogue');
app.use('/api/catalogue', catalogue.pub);
app.use('/api/admin/catalogue', express.json({limit:'3mb'}), catalogue.admin);
const store = express.Router();

/* ---- public catalogue (no auth) ---- */
store.get('/catalogue', (_req, res) => {
  const styles = all(`SELECT id, name, type, price, sale_price, lead_days, note FROM styles
                      WHERE active = 1 AND type = 'made' ORDER BY id`);
  const out = list(styles, s => ({
    ...catalogue.info(s.id), id: s.id, name: s.name, type: s.type, price: s.sale_price ?? s.price, original_price: s.sale_price !== null ? s.price : null,
    lead_days: s.lead_days, note: s.note,
    colours: all('SELECT name, hex FROM style_colours WHERE style_id = ? ORDER BY sort', s.id),
    lengths: all('SELECT cm FROM style_lengths WHERE style_id = ? ORDER BY cm', s.id).map(r => r.cm),
    sizes:   all('SELECT size FROM style_sizes WHERE style_id = ? ORDER BY size', s.id).map(r => r.size),
    variants: s.type === 'stock' ? all('SELECT size,colour,qty FROM stock_items WHERE style_id=? ORDER BY size,colour',s.id) : [],
    in_stock: s.type === 'stock'
      ? get('SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE style_id = ?', s.id).q
      : null,
  }));
  res.json({ styles: out });
});

/* ---- migration: add customer passwords to older databases ---- */
try { run('ALTER TABLE customers ADD COLUMN password_hash TEXT'); } catch (e) { /* already there */ }

/* ---- customer auth: phone + password (no SMS needed) ---- */
store.post('/auth/register', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  if (!/^01[0-9]{9}$/.test(phone))
    return bad(res, 400, 'bad_phone', 'رقم الموبايل لازم يبدأ بـ 01 ويكون 11 رقم');
  if (password.length < 6)
    return bad(res, 400, 'weak_password', 'الباسورد لازم ٦ حروف أو أرقام على الأقل');
  if (name.length < 2)
    return bad(res, 400, 'bad_name', 'اكتبي اسمك');
  if (get('SELECT id FROM customers WHERE phone = ?', phone))
    return bad(res, 409, 'phone_taken', 'الرقم ده متسجل قبل كده — ادخلي بالباسورد');
  const ins = run('INSERT INTO customers(phone,name,password_hash) VALUES(?,?,?)',
                  phone, name, A.hashPassword(password));
  const c = get('SELECT * FROM customers WHERE id = ?', ins.lastInsertRowid);
  const { token, expires } = A.createSession('store', c.id, 'customer', 180);
  A.setSessionCookie(res, token, 180);
  res.json({ token, expires, profile: profileOf(c) });
});

store.post('/auth/login', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const password = String(req.body.password || '');
  if (A.throttled(phone))
    return bad(res, 429, 'too_many_attempts', 'محاولات كتيرة — استني ١٠ دقايق');
  const c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (c && !c.password_hash)
    return bad(res, 409, 'needs_password',
      'الرقم مسجل بالفعل — تواصلي مع MAVI لمساعدتك في استعادة حسابك');
  if (!c) {
    A.noteFailure(phone);
    return bad(res, 401, 'bad_login', 'الرقم أو الباسورد غلط');
  }
  if (!A.verifyPassword(password, c.password_hash)) {
    A.noteFailure(phone);
    return bad(res, 401, 'bad_login', 'الرقم أو الباسورد غلط');
  }
  A.clearFailures(phone);
  const { token, expires } = A.createSession('store', c.id, 'customer', 180);
  A.setSessionCookie(res, token, 180);
  res.json({ token, expires, profile: profileOf(c) });
});

/* ---- fallback: codes the brand sends herself over WhatsApp ---- */
function await_notify(phone, code) {
  try { return require('./notify').sendCode(phone, code); }
  catch (e) { return { sent: false, channel: 'brand' }; }
}

store.post('/auth/request-code', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  if (!/^01[0-9]{9}$/.test(phone))
    return bad(res, 400, 'bad_phone', 'رقم الموبايل لازم يبدأ بـ 01 ويكون 11 رقم');
  try {
    const code = A.issueOtp(phone);
    if (DEV_SHOW_OTP && process.env.NODE_ENV !== 'production') console.log('[OTP] development code generated');
    const r = await_notify(phone, code);
    res.json({ ok: true, expires_in_minutes: 5,
               channel: r.channel,                 // 'whatsapp' = automatic, 'brand' = we'll send it
               dev_code: DEV_SHOW_OTP ? code : undefined });
  } catch (e) {
    if (e.status === 429) return bad(res, 429, 'too_many_requests', 'بعتنالك أكواد كتير — استني شوية');
    throw e;
  }
});

store.post('/auth/verify', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const code = String(req.body.code || '').trim();
  const r = A.consumeOtp(phone, code);
  if (!r.ok) {
    const msg = { no_code: 'اطلبي كود جديد', expired: 'الكود انتهى — اعملي كود جديد',
                  wrong_code: 'الكود غلط', too_many_attempts: 'محاولات كتيرة — اعملي كود جديد' }[r.reason];
    return bad(res, 401, r.reason, msg);
  }
  let c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (!c) {
    const ins = run('INSERT INTO customers(phone,name) VALUES(?,?)', phone, 'عميلة جديدة');
    c = get('SELECT * FROM customers WHERE id = ?', ins.lastInsertRowid);
  }
  const { token, expires } = A.createSession('store', c.id, 'customer', 180);
  A.setSessionCookie(res, token, 180);
  res.json({ token, expires, profile: profileOf(c) });
});

function profileOf(c) {
  const m = get('SELECT * FROM measurements WHERE customer_id = ?', c.id);
  return { id: c.id, name: c.name, phone: c.phone, area: c.area,
           has_password: !!c.password_hash, measurements: m || null };
}

store.post('/auth/set-password', A.requireCustomer, (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6)
    return bad(res, 400, 'weak_password', 'الباسورد لازم ٦ حروف أو أرقام على الأقل');
  run('UPDATE customers SET password_hash = ? WHERE id = ?',
      A.hashPassword(password), req.user.id);
  audit('customer', req.user.id, 'password_set', `customer:${req.user.id}`);
  res.json({ ok: true, profile: profileOf(get('SELECT * FROM customers WHERE id = ?', req.user.id)) });
});

store.get('/me', A.requireCustomer, (req, res) => res.json({ profile: profileOf(req.user) }));

store.patch('/me', A.requireCustomer, (req, res) => {
  const name = String(req.body.name || '').trim();
  const area = String(req.body.area || '').trim();
  if (name.length < 3) return bad(res, 400, 'bad_name', 'اكتبي اسمك بالكامل');
  run('UPDATE customers SET name = ?, area = ? WHERE id = ?', name, area || null, req.user.id);
  res.json({ profile: profileOf(get('SELECT * FROM customers WHERE id = ?', req.user.id)) });
});

store.put('/me/measurements', A.requireCustomer, (req, res) => {
  const keys = ['waist','hip','bust','length','sleeve','arm'];
  const vals = keys.map(k => toInt(req.body[k]));
  for (const v of vals) if (v !== null && (v < 20 || v > 250))
    return bad(res, 400, 'bad_measurement', 'القياسات لازم تكون بين 20 و 250 سم');
  run(`INSERT INTO measurements(customer_id,waist,hip,bust,length,sleeve,arm,updated_at)
       VALUES(?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(customer_id) DO UPDATE SET
         waist=excluded.waist, hip=excluded.hip, bust=excluded.bust,
         length=excluded.length, sleeve=excluded.sleeve, arm=excluded.arm,
         updated_at=datetime('now')`, req.user.id, ...vals);
  res.json({ measurements: get('SELECT * FROM measurements WHERE customer_id = ?', req.user.id) });
});

store.post('/auth/change-password', A.requireCustomer, (req,res)=>{
 const current=String(req.body.current||''), next=String(req.body.next||'');
 const customer=get('SELECT password_hash FROM customers WHERE id=?',req.user.id);
 if(!customer||!customer.password_hash||!A.verifyPassword(current,customer.password_hash))return bad(res,400,'wrong_password','كلمة المرور الحالية غير صحيحة');
 if(next.length<10||next.length>128)return bad(res,400,'weak_password','كلمة المرور الجديدة يجب أن تكون من 10 إلى 128 حرفًا');
 db.transaction(()=>{run('UPDATE customers SET password_hash=? WHERE id=?',A.hashPassword(next),req.user.id);run("DELETE FROM sessions WHERE realm='store' AND subject_id=? AND token_hash<>?",req.user.id,require('crypto').createHash('sha256').update(req.token).digest('hex'));audit('customer',req.user.id,'password_changed',`customer:${req.user.id}`)})();
 res.json({ok:true});
});

store.post('/auth/logout', A.requireCustomer, (req, res) => {
  A.destroySession(req.token);
  res.json({ ok: true });
});

/* ---- her own orders only ---- */
store.get('/orders', A.requireCustomer, (req, res) => {
  const rows = all('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC', req.user.id);
  res.json({ orders: rows.map(r => D.customerOrderView(r.id, req.user.id)) });
});

store.get('/orders/:code', A.requireCustomer, (req, res) => {
  const o = get('SELECT id FROM orders WHERE code = ? AND customer_id = ?', req.params.code, req.user.id);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  res.json({ order: D.customerOrderView(o.id, req.user.id) });
});

/* ---- place an order request ---- */
store.post('/orders', A.requireCustomer, (req, res) => {
  const { style_id, colour, length_cm, size, qty, delivery, note, governorate, fabric_choice } = req.body || {};
  const style = get('SELECT * FROM styles WHERE id = ? AND active = 1', String(style_id || ''));
  if (!style || style.type !== 'made') return bad(res, 400, 'bad_style', 'الموديل مش متاح');
  const gov=String(governorate||'').trim(), fabric=String(fabric_choice||'').trim();
  if (delivery && (gov.length<2 || gov.length>80 || /[<>&"'`\\]/.test(gov))) return bad(res,400,'governorate_required','اكتبي المحافظة للتوصيل');
  const allowed=catalogue.info(style.id).fabrics;
  if (fabric!=='قماش العميلة' && !allowed.includes(fabric)) return bad(res,400,'fabric_required','اختاري الخامة المتاحة أو قماشك الخاص');
  const q = Math.min(5, Math.max(1, toInt(qty, 1)));
  if (!Number.isInteger(q)) return bad(res,400,'bad_qty','العدد غير صالح');
  const colourOk = all('SELECT name FROM style_colours WHERE style_id = ?', style.id).map(r => r.name);
  if (colourOk.length && !colourOk.includes(colour))
    return bad(res, 400, 'bad_colour', 'اختاري لون من المتاح');
  const lens = all('SELECT cm FROM style_lengths WHERE style_id = ?', style.id).map(r => r.cm);
  const len = lens.length ? toInt(length_cm, lens[0]) : null;
  if (lens.length && !lens.includes(len))
    return bad(res, 400, 'bad_length', 'اختاري طول من المتاح');
  const sz = style.type === 'stock' ? String(size || '') : null;
  let stockVariant=null;
  if(style.type==='stock'){
    const variant=get('SELECT qty,buy_price FROM stock_items WHERE style_id=? AND size=? AND colour=?',style.id,sz,colour||'');
    if(!variant||variant.qty<q)return bad(res,409,'out_of_stock','المقاس أو اللون غير متاح بالكمية المطلوبة. لا يُحجز المخزون إلا عند تأكيد العربون.');
    stockVariant=variant;
  }

  if (style.type === 'made') {
    const m = get('SELECT * FROM measurements WHERE customer_id = ?', req.user.id);
    const filled = m && ['waist','hip','bust','length'].every(k => m[k] > 0);
    if (!filled) return bad(res, 422, 'measurements_required', 'التفصيل محتاج مقاساتك الأول');
  }

  const fee = 0; // Shipping is quoted by the owner, never guessed.
  const created = db.transaction(() => {
    const code = D.nextOrderCode();
    const promise = new Date(Date.now() + (style.lead_days || 7) * 864e5).toISOString().slice(0, 10);
    const r = run(`INSERT INTO orders(code,customer_id,channel,status,promise_date,delivery_fee,note,governorate,delivery_requested,shipping_quoted,fabric_choice)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                  code, req.user.id, 'online', 'new', promise, fee, note || null, delivery?gov:null, delivery?1:0, delivery?0:1, fabric);
    const oid = r.lastInsertRowid;
    run('INSERT INTO order_deposits(order_id) VALUES(?)', oid);
    run(`INSERT INTO order_items(order_id,style_id,qty,colour,length_cm,size,unit_price,unit_cost)
         VALUES(?,?,?,?,?,?,?,?)`, oid, style.id, q, colour || null, len, sz, style.sale_price ?? style.price,stockVariant?stockVariant.buy_price:0);
    audit('order', code, 'created_online', `customer:${req.user.id}`, { style: style.id, qty: q, fee });
    return code;
  })();
  res.status(201).json({ order: D.customerOrderView(
    get('SELECT id FROM orders WHERE code = ?', created).id, req.user.id) });
});

store.get('/notifications', A.requireCustomer, (req,res)=>{
 const notifications=all(`SELECT n.id,n.message,n.status,n.created_at,n.read_at,o.code FROM customer_notifications n JOIN orders o ON o.id=n.order_id WHERE n.customer_id=? ORDER BY n.id DESC LIMIT 50`,req.user.id);
 const unread=get('SELECT COUNT(*) n FROM customer_notifications WHERE customer_id=? AND read_at IS NULL',req.user.id).n;
 res.json({notifications,unread});
});
store.post('/notifications/read-all', A.requireCustomer, (req,res)=>{
 run("UPDATE customer_notifications SET read_at=datetime('now') WHERE customer_id=? AND read_at IS NULL",req.user.id);res.json({ok:true});
});
store.post('/notifications/:id/read', A.requireCustomer, (req,res)=>{
 const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<=0)return bad(res,400,'bad_id','الإشعار غير صالح');
 const result=run("UPDATE customer_notifications SET read_at=COALESCE(read_at,datetime('now')) WHERE id=? AND customer_id=?",id,req.user.id);
 if(!result.changes)return bad(res,404,'not_found','الإشعار غير موجود');
 res.json({ok:true});
});

app.use('/api/store', store);

/* ============================================================
   ADMIN API — staff + owner. Costs are nested under /money (owner only).
   ============================================================ */
const admin = express.Router();

/* ---- auth ---- */
admin.post('/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (A.adminThrottled(email))
    return bad(res, 429, 'too_many_attempts', 'محاولات كتيرة — استني ١٥ دقيقة');
  const u = get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!u || !A.verifyPassword(password, u.password_hash)) {
    A.adminFailure(email);
    return bad(res, 401, 'bad_credentials', 'الإيميل أو الباسورد غلط');
  }
  A.adminClear(email);
  const days = req.body.remember === false ? 1 : 90;      // phone stays signed in
  const { token, expires } = A.createSession('admin', u.id, u.role, days);
  A.setSessionCookie(res, token, days);
  res.json({ token, expires, user: { id: u.id, name: u.name, email: u.email, role: u.role } });
});
admin.post('/auth/logout', A.requireStaff, (req, res) => {
  A.destroySession(req.token); A.clearSessionCookie(res); res.json({ ok: true });
});
admin.get('/me', A.requireStaff, (req, res) => res.json({ user: req.user }));

/* ---- styles: selling price is fine for staff, cost is not ---- */
admin.get('/styles', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const rows = all("SELECT * FROM styles WHERE id <> 'MANUAL-CUSTOM' ORDER BY type DESC, id");
  res.json({ styles: list(rows, s => {
    const base = {
      ...catalogue.info(s.id), id: s.id, name: s.name, type: s.type, price: s.price, sale_price: s.sale_price, lead_days: s.lead_days,
      note: s.note, active: !!s.active,
      colours: all('SELECT name, hex FROM style_colours WHERE style_id = ? ORDER BY sort', s.id),
      lengths: all('SELECT cm FROM style_lengths WHERE style_id = ? ORDER BY cm', s.id).map(r => r.cm),
      sizes: all('SELECT size FROM style_sizes WHERE style_id = ?', s.id).map(r => r.size),
    };
    if (isOwner) base.cost = s.cost;          // ← only the owner ever sees this field
    return base;
  }) });
});

/* ---- reference data staff needs to run production ---- */
admin.get('/fabric', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  res.json({ fabric: all('SELECT * FROM fabric ORDER BY name').map(f => ({
    id: f.id, name: f.name, colour: f.colour, metres: f.metres,
    reorder_level: f.reorder_level, low: f.metres <= f.reorder_level,
    ...(isOwner ? { cost_per_metre: f.cost_per_metre, shipping_per_metre:f.shipping_per_metre } : {}),
  })) });
});
// Use the same fabric creation validation as the inventory section.
admin.post('/fabric', A.requireOwner, (req, res, next) => { req.url='/fabric'; require('./inventory-admin')(req,res,next); });

admin.get('/tailors', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  res.json({ tailors: all('SELECT * FROM tailors WHERE active = 1').map(t => ({
    id: t.id, name: t.name, phone: t.phone, address:t.address, notes:t.notes,
    ...(isOwner ? { rate_per_piece: t.rate_per_piece } : {}),
  })) });
});

admin.post('/tailors', A.requireOwner, (req,res)=>{
 const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').trim(),address=String(req.body.address||'').trim(),notes=String(req.body.notes||'').trim();
 const raw=req.body.rate_per_piece,rate=(raw===undefined||raw===null||String(raw).trim()==='')?0:Number(raw);
 if(name.length<2||name.length>80||phone.length>30||address.length>200||notes.length>500||/[<>&"'`\\]/.test(name+phone+address+notes)||!Number.isFinite(rate)||rate<0||rate>1e7)return bad(res,400,'bad_workshop','أدخلي اسم الورشة وراجعي البيانات الأخرى');
 const item=run('INSERT INTO tailors(name,phone,address,notes,rate_per_piece) VALUES(?,?,?,?,?)',name,phone||null,address||null,notes||null,rate);
 audit('tailor',item.lastInsertRowid,'created',`user:${req.user.id}`);res.status(201).json({id:Number(item.lastInsertRowid)});
});

admin.get('/stock', A.requireStaff, (req, res) => {
  const rows=all(`SELECT si.id,si.style_id,si.size,si.colour,si.qty,si.buy_price,s.name AS style_name,s.price AS sale_price FROM stock_items si JOIN styles s ON s.id=si.style_id ORDER BY s.name,si.size`);
  if(req.user.role!=='owner')rows.forEach(x=>delete x.buy_price);
  res.json({stock:rows});
});

/* ---- customers (staff can see contact details + measurements, per the matrix) ---- */
/* Owner help: hand a customer a login code (when they forgot their password
   and WhatsApp automation isn't connected). Owner only — never staff. */
admin.get('/customers/:id/login-code', A.requireOwner, (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', Number(req.params.id));
  if (!c) return bad(res, 404, 'not_found', 'العميلة مش موجودة');
  const row = A.latestCodeFor(c.phone);
  if (!row) return bad(res, 404, 'no_code', 'مفيش كود صالح — خليها تضغط «نسيت الپاسورد» الأول');
  audit('customer', c.id, 'login_code_viewed', `user:${req.user.id}`);
  res.json({ phone: c.phone, expires_at: row.expires_at });
});

// Only the owner may reset a customer's password after checking identity offline.
admin.post('/customers/:id/reset-password', A.requireOwner, (req, res) => {
  const id = Number(req.params.id), password = String(req.body?.password || '');
  if (!Number.isSafeInteger(id) || id < 1) return bad(res,400,'bad_customer','العميلة غير صالحة');
  if (password.length < 10 || password.length > 128) return bad(res,400,'weak_password','كلمة المرور يجب أن تكون من 10 إلى 128 حرفًا');
  if (!get('SELECT id FROM customers WHERE id=?', id)) return bad(res,404,'not_found','العميلة غير موجودة');
  db.transaction(() => {
    run('UPDATE customers SET password_hash=? WHERE id=?', A.hashPassword(password), id);
    run("DELETE FROM sessions WHERE realm='store' AND subject_id=?", id);
    audit('customer', id, 'password_reset_by_owner', `user:${req.user.id}`);
  })();
  res.json({ok:true});
});

admin.get('/customers', A.requireStaff, (req, res) => {
  res.json({ customers: all(`
    SELECT c.id,c.name,c.phone,c.area,c.created_at, m.waist, m.hip, m.bust, m.length, m.sleeve, m.arm,
           (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count
    FROM customers c LEFT JOIN measurements m ON m.customer_id = c.id
    ORDER BY c.id DESC`) });
});

/* ---- orders ---- */
function adminOrderRow(o) {
  const items = all(`SELECT oi.*, COALESCE(NULLIF(oi.description,''),s.name) AS style_name, s.type AS style_type
                     FROM order_items oi JOIN styles s ON s.id = oi.style_id
                     WHERE oi.order_id = ?`, o.id);
  const c = get('SELECT id,name,phone,area FROM customers WHERE id = ?', o.customer_id);
  const t = D.orderTotals(o.id);
  return {
    id: o.id, code: o.code, channel: o.channel, status: o.status,
    promise_date: o.promise_date, created_at: o.created_at, note: o.note,
    delivery_fee: o.delivery_fee, governorate:o.governorate, delivery_requested:!!o.delivery_requested, shipping_quoted:!!o.shipping_quoted, fabric_choice:o.fabric_choice, manual_entry:!!o.manual_entry, discount: o.discount,
    customer: c,
    measurements: get('SELECT * FROM measurements WHERE customer_id = ?', o.customer_id),
    items: items.map(i => ({
      id: i.id, style_id: i.style_id, style_name: i.style_name, style_type: i.style_type,
      qty: i.qty, colour: i.colour, length_cm: i.length_cm, size: i.size,
      unit_price: i.unit_price, fabric_id: i.fabric_id, metres_used: i.metres_used,
      tailor_id: i.tailor_id,
    })),
    totals: t,   // staff get totals; the field NAME 'cost/profit' inside is stripped below
    late: o.status !== 'delivered' && o.status !== 'cancelled' &&
          o.promise_date && new Date(o.promise_date) < new Date(new Date().toDateString()),
  };
}

admin.get('/orders', A.requireStaff, (req, res) => {
  const status = req.query.status;
  const rows = status && status !== 'all'
    ? all('SELECT * FROM orders WHERE status = ? ORDER BY id DESC', status)
    : all('SELECT * FROM orders ORDER BY id DESC');
  const isOwner = req.user.role === 'owner';
  const orders = rows.map(o => {
    const r = adminOrderRow(o);
    if (!isOwner) { delete r.totals.cost; delete r.totals.profit; delete r.totals.margin; }
    return r;
  });
  res.json({ orders, counts: statusCounts() });
});

function statusCounts() {
  const rows = all('SELECT status, COUNT(*) n FROM orders GROUP BY status');
  const out = { all: 0 };
  for (const s of D.INTERNAL_STATUSES) out[s] = 0;
  rows.forEach(r => { out[r.status] = r.n; out.all += r.n; });
  return out;
}

admin.get('/orders/:code', A.requireStaff, (req, res) => {
  const o = get('SELECT * FROM orders WHERE code = ?', req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  const r = adminOrderRow(o);
  const isOwner = req.user.role === 'owner';
  if (!isOwner) { delete r.totals.cost; delete r.totals.profit; delete r.totals.margin; }
  else {
    r.payments=all('SELECT id,amount,method,created_at,note FROM payments WHERE order_id=? ORDER BY id DESC',o.id);
    r.items.forEach(i => i.unit_cost = get('SELECT unit_cost FROM order_items WHERE id=?',i.id).unit_cost);
    const custom=get(`SELECT c.id,c.details,c.measurements,c.date_needed FROM custom_order_links l JOIN custom_requests c ON c.id=l.request_id WHERE l.order_id=?`,o.id);
    if(custom)r.custom_request={...custom,measurements:JSON.parse(custom.measurements)};
  }
  res.json({ order: r, message: D.buildMessage(o.id), role: req.user.role });
});

/* status change — staff allowed; money fields are NOT touched here */
admin.patch('/orders/:code/status', A.requireStaff, (req, res) => {
  const { status } = req.body || {};
  if (!D.INTERNAL_STATUSES.includes(status)) return bad(res, 400, 'bad_status', 'حالة غير معروفة');
  const o = get('SELECT * FROM orders WHERE code = ?', req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  const deposit = get('SELECT status FROM order_deposits WHERE order_id=?', o.id);
  if (deposit && deposit.status !== 'approved' && !['new','cancelled'].includes(status)) return bad(res,409,'deposit_required','لا يمكن بدء الطلب قبل تأكيد استلام العربون');
  if(o.status==='cancelled' && status!=='cancelled')return bad(res,409,'cancelled_order','الطلب الملغي لا يُعاد تشغيله؛ أنشئي طلبًا جديدًا');
  if(o.status==='delivered' && status==='cancelled' && get('SELECT COUNT(*) n FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0',o.id).n) return bad(res,409,'delivered_order','لا يمكن إلغاء طلب تم تسليمه تلقائيًا؛ راجعي المرتجع والمخزون يدويًا');
  db.transaction(()=>{if(status==='cancelled' && o.status!=='cancelled')inventory.release(o.id,`user:${req.user.id}`);if(status!==o.status){run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, o.id);Notifications.statusChanged(o,status);audit('order', o.code, 'status:' + status, `user:${req.user.id}`, { from: o.status });}})();
  const updated=adminOrderRow(get('SELECT * FROM orders WHERE id = ?', o.id));
  if(req.user.role!=='owner'){delete updated.totals.cost;delete updated.totals.profit;delete updated.totals.margin;}
  res.json({ order: updated, message: D.buildMessage(o.id) });
});

/* production details on an item: fabric, metres, tailor → this changes COST.
   Owner only, because it writes money. Staff can still move status. */
admin.patch('/order-items/:id/production', A.requireOwner, (req, res) => {
  const item = get('SELECT * FROM order_items WHERE id = ?', toInt(req.params.id));
  if (!item) return bad(res, 404, 'not_found', 'القطعة مش موجودة');
  if (get('SELECT COUNT(*) n FROM item_cost_lines WHERE item_id=?',item.id).n) return bad(res,409,'cost_lines_exist','احذفي بنود التكلفة اليدوية أولًا قبل استخدام حساب الخامة والورشة');
  const fabricId = toInt(req.body.fabric_id, null);
  const metres = req.body.metres_used === undefined ? item.metres_used : Number(req.body.metres_used || 0);
  const tailorId = toInt(req.body.tailor_id, null);
  if(!Number.isFinite(metres)||metres<0||metres>100000)return bad(res,400,'bad_metres','كمية الخامة غير صالحة');

  try { db.transaction(() => {
    // Manual quantities reserve metres per piece for every piece.
    const multiplier = get('SELECT manual_entry FROM orders WHERE id=?',item.order_id).manual_entry ? item.qty : 1;
    if (item.fabric_id && item.fabric_id !== fabricId) D.adjustFabric(item.fabric_id, -item.metres_used * multiplier);
    if (fabricId) {
      const delta = fabricId === item.fabric_id ? metres - item.metres_used : metres;
      D.adjustFabric(fabricId, delta * multiplier);
    }
    const unitCost = D.computeUnitCost({ styleId: item.style_id, fabricId, metres, tailorId });
    run(`UPDATE order_items SET fabric_id=?, metres_used=?, tailor_id=?, unit_cost=? WHERE id=?`,
        fabricId, metres, tailorId, unitCost, item.id);
    audit('order_item', item.id, 'production', `user:${req.user.id}`,
          { fabricId, metres, tailorId, unitCost });
  })(); } catch(e) { return bad(res,409,'fabric_unavailable',e.message); }

  const o = get('SELECT * FROM orders WHERE id = ?', item.order_id);
  res.json({ order: adminOrderRow(o) });
});


/* Flexible per-piece cost breakdown, visible and editable by the owner only. */
admin.get('/order-items/:id/cost-lines', A.requireOwner, (req,res) => {
 const i=get('SELECT id,unit_cost FROM order_items WHERE id=?',toInt(req.params.id));
 if(!i)return bad(res,404,'not_found','القطعة غير موجودة');
 res.json({unit_cost:i.unit_cost,lines:all('SELECT label,quantity,unit_cost FROM item_cost_lines WHERE item_id=? ORDER BY id',i.id)});
});
admin.put('/order-items/:id/cost-lines', A.requireOwner, (req,res) => {
 const i=get('SELECT * FROM order_items WHERE id=?',toInt(req.params.id));if(!i)return bad(res,404,'not_found','القطعة غير موجودة');
 const lines=req.body.lines;if(!Array.isArray(lines)||lines.length>30)return bad(res,400,'bad_lines','راجعي بنود التكلفة');
 const clean=[];for(const line of lines){const label=String(line.label||'').trim(),quantity=Number(line.quantity),unit=Number(line.unit_cost);if(!label||label.length>100||!Number.isFinite(quantity)||quantity<=0||quantity>100000||!Number.isFinite(unit)||unit<0||unit>10000000)return bad(res,400,'bad_line','راجعي اسم البند والكمية والتكلفة');clean.push({label,quantity,unit});}
 const sum=Math.round(clean.reduce((a,x)=>a+x.quantity*x.unit,0)*100)/100;
 db.transaction(()=>{run('DELETE FROM item_cost_lines WHERE item_id=?',i.id);for(const x of clean)run('INSERT INTO item_cost_lines(item_id,label,quantity,unit_cost) VALUES(?,?,?,?)',i.id,x.label,x.quantity,x.unit);run('UPDATE order_items SET unit_cost=? WHERE id=?',sum,i.id);audit('order_item',i.id,'cost_lines',`user:${req.user.id}`,{total:sum})})();res.json({unit_cost:sum});
});

/* ---- payments: money out/in is owner-only ---- */
admin.post('/orders/:code/payments', A.requireOwner, (req, res) => {
  const o = get('SELECT * FROM orders WHERE code = ?', req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  const amount = Number(req.body.amount);
  if (!(amount > 0)) return bad(res, 400, 'bad_amount', 'المبلغ لازم يكون أكبر من صفر');
  const method = String(req.body.method || 'cash');
  run('INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)',
      o.id, amount, method, req.body.note || null);
  audit('order', o.code, 'payment', `user:${req.user.id}`, { amount, method });
  res.status(201).json({ totals: D.orderTotals(o.id) });
});

/* ---- money zone: owner only, one prefix, one guard ---- */
admin.get('/money/summary', A.requireOwner, (_req, res) => {
  const orders = all("SELECT * FROM orders WHERE status != 'cancelled'");
  let revenue = 0, cost = 0;
  for (const o of orders) {
    const t = D.orderTotals(o.id);
    revenue += t.total; cost += t.cost;
  }
  const expenses = get('SELECT COALESCE(SUM(amount),0) t FROM expenses').t;
  const paid = get("SELECT COALESCE(SUM(amount),0) t FROM payments").t;
  const cancelledPaid = get("SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.status='cancelled'").t;
  res.json({
    revenue, cost, gross_profit: revenue - cost, expenses,
    net_profit: revenue - cost - expenses, collected: paid, cancelled_paid: cancelledPaid,
    outstanding: revenue - (paid - cancelledPaid), orders: orders.length,
  });
});

admin.get('/money/period', A.requireOwner, (req,res) => {
 const from=String(req.query.from||''),to=String(req.query.to||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return bad(res,400,'bad_dates','اختاري فترة صحيحة');
 const orders=all("SELECT * FROM orders WHERE status != 'cancelled' AND date(created_at) BETWEEN ? AND ?",from,to);
 let sales=0,cost=0,paidAgainstOrders=0;for(const o of orders){const t=D.orderTotals(o.id);sales+=t.total;cost+=t.cost;paidAgainstOrders+=t.paid;}
 const expenses=get('SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE date(spent_on) BETWEEN ? AND ?',from,to).total;
 const cash=get("SELECT COALESCE(SUM(p.amount),0) total FROM payments p JOIN orders o ON o.id=p.order_id WHERE date(p.created_at) BETWEEN ? AND ?",from,to).total;
 res.json({from,to,orders:orders.length,sales,cost,expenses,profit:sales-cost-expenses,collected_in_period:cash,outstanding_for_period_orders:sales-paidAgainstOrders});
});

admin.get('/money/outstanding', A.requireOwner, (_req, res) => {
  res.json({ rows: all(`SELECT * FROM orders WHERE status NOT IN ('cancelled')`).map(o => {
    const t = D.orderTotals(o.id);
    return { code: o.code, customer: get('SELECT name FROM customers WHERE id = ?', o.customer_id)?.name,
             total: t.total, paid: t.paid, due: t.due };
  }).filter(r => r.due > 0) });
});

admin.get('/money/reports', A.requireOwner, (_req, res) => {
  const byStyle = {};
  for (const o of all("SELECT id FROM orders WHERE status != 'cancelled'")) {
    for (const i of all('SELECT * FROM order_items WHERE order_id = ?', o.id)) {
      byStyle[i.style_id] = byStyle[i.style_id] || { style_id: i.style_id, qty: 0, revenue: 0, cost: 0 };
      byStyle[i.style_id].qty += i.qty;
      byStyle[i.style_id].revenue += i.unit_price * i.qty;
      byStyle[i.style_id].cost += i.unit_cost * i.qty;
    }
  }
  const colours = {};
  for (const i of all('SELECT colour, qty FROM order_items WHERE colour IS NOT NULL'))
    colours[i.colour] = (colours[i.colour] || 0) + i.qty;
  res.json({
    by_style: Object.values(byStyle).map(r => ({
      ...r, name: get('SELECT name FROM styles WHERE id = ?', r.style_id)?.name,
      profit: r.revenue - r.cost,
      margin: r.revenue ? Math.round((r.revenue - r.cost) / r.revenue * 100) : 0,
    })).sort((a, b) => b.revenue - a.revenue),
    colours: Object.entries(colours).sort((a, b) => b[1] - a[1]).map(([colour, qty]) => ({ colour, qty })),
    expenses: all('SELECT * FROM expenses ORDER BY spent_on DESC'),
  });
});

admin.get('/money/expenses', A.requireOwner, (_req, res) =>
  res.json({ expenses: all('SELECT * FROM expenses ORDER BY spent_on DESC') }));
admin.post('/money/expenses', A.requireOwner, (req, res) => {
  const { category, amount, spent_on, note } = req.body || {};
  if (!category || !(Number(amount) > 0)) return bad(res, 400, 'bad_input', 'البند والمبلغ مطلوبين');
  const r = run('INSERT INTO expenses(category,amount,spent_on,note) VALUES(?,?,?,?)',
                category, Number(amount), spent_on || new Date().toISOString().slice(0, 10), note || null);
  res.status(201).json({ id: r.lastInsertRowid });
});

/* ---- dashboard: shared shape, money fields stripped for staff ---- */
admin.get('/dashboard', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const open = all("SELECT * FROM orders WHERE status NOT IN ('delivered','cancelled')");
  const late = open.filter(o => o.promise_date && new Date(o.promise_date) < new Date(new Date().toDateString()));
  const out = {
    counts: statusCounts(),
    open_orders: open.length,
    late_orders: late.length,
    ready: get("SELECT COUNT(*) n FROM orders WHERE status='ready'").n,
    low_fabric: get('SELECT COUNT(*) n FROM fabric WHERE metres <= reorder_level').n,
    today: new Date().toISOString().slice(0, 10),
  };
  if (isOwner) {
    const s = all("SELECT * FROM orders WHERE status != 'cancelled'").reduce((acc, o) => {
      const t = D.orderTotals(o.id); acc.rev += t.total; acc.cost += t.cost; acc.due += t.due; return acc;
    }, { rev: 0, cost: 0, due: 0 });
    out.money = { revenue: s.rev, cost: s.cost, gross_profit: s.rev - s.cost, outstanding: s.due };
  }
  res.json(out);
});

/* ---- backups + account safety: owner only ---- */
admin.get('/system/backup', A.requireOwner, async (req, res) => {
  // SQLite's backup API captures committed WAL changes in a consistent snapshot.
  const fs = require('fs');
  const os = require('os');
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-backup-'));
    const file = path.join(dir, 'snapshot.db');
    audit('system', 'backup', 'download', `user:${req.user.id}`, {});
    await db.backup(file);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.download(file, `mavi-backup-${stamp}.db`, err => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err && !res.headersSent) res.status(500).json({ error: 'backup_failed' });
    });
  } catch (err) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: 'backup_failed' });
  }
});

admin.post('/system/public-url', A.requireOwner, (req, res) => {
  const url = String(req.body.url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s]+$/.test(url))
    return bad(res, 400, 'bad_url', 'لازم يبدأ بـ https://');
  run("INSERT INTO settings(key,value) VALUES('public_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", url);
  audit('system', 'public_url', 'updated', `user:${req.user.id}`, { url });
  res.json({ ok: true, public_url: url });
});

/* Owner-only QR + printable share card so customers can reach the shop. */
/* Owner-only QR + share card. Accepts the session cookie as well as the bearer
   token, so a plain <img>/<a> in the dashboard works without JS header tricks. */
const ownerByCookie = (req, res, next) => {
  if (!req.user && A.readToken(req)) {
    const row = A.resolve(A.readToken(req));
    if (row && row.realm === 'admin' && row.role === 'owner') { req.user = row; return next(); }
  }
  if (req.user && req.user.role === 'owner') return next();
  return bad(res, 401, 'unauthorized', 'محتاج تسجيل دخول المالكة');
};

admin.get('/system/qr', ownerByCookie, (req, res) => {
  const base = (setting('public_url', '') || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  const shopUrl = `${base}/store/`;
  const size = Math.min(Math.max(Number(req.query.size) || 8, 3), 20);
  const px = size * 40;
  try {
    require('qrcode').toBuffer(shopUrl, {
      type: 'png', width: px, margin: 2,
      color: { dark: '#121E48FF', light: '#FFFFFFFF' },
    }).then((buf) => { res.type('image/png').send(buf); })
      .catch(() => res.status(500).json({ error: 'qr_failed' }));
  } catch (e) {
    res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=${px}x${px}&data=${encodeURIComponent(shopUrl)}`);
  }
});

admin.get('/system/share-card', ownerByCookie, (req, res) => {
  const base = (setting('public_url', '') || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  const shop = `${base}/store/`;
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>MAVI — كارت المتجر</title>
<style>
  body{margin:0;font-family:"Segoe UI",Tahoma,sans-serif;background:#F6F0EA;display:grid;place-items:center;min-height:100vh}
  .card{width:340px;background:#fff;border-radius:20px;padding:26px 22px;text-align:center;
        box-shadow:0 14px 34px rgba(18,30,72,.16);border:1px solid #EADFD2}
  h1{font-size:24px;letter-spacing:.16em;color:#121E48;margin:12px 0 2px}
  .tag{font-size:9.5px;letter-spacing:.32em;color:#B08D57;font-weight:600}
  .ar{font-size:12.5px;color:#1D2F6F;margin:10px 0 16px;font-weight:700}
  img.qr{width:190px;height:190px}
  .link{font-size:10.5px;color:#7A8299;direction:ltr;margin-top:8px;word-break:break-all}
  .wa{display:inline-block;margin-top:14px;background:#121E48;color:#fff;border-radius:11px;
      padding:9px 16px;font-size:12px;font-weight:700;text-decoration:none}
  @media print{body{background:#fff} .card{box-shadow:none}}
</style></head><body>
  <div class="card">
    <img src="/brand/emblem.png" style="width:74px;height:74px;border-radius:50%">
    <h1>MAVI</h1><div class="tag">TAILOR YOUR DESIGN</div>
    <div class="ar">فصّلي على مقاسك — امسحي الكود واطلبي من موبايلك</div>
    <img class="qr" src="/api/admin/system/qr?size=10" alt="QR">
    <div class="link">${shop}</div>
    <a class="wa" href="https://wa.me/201013979358?text=${encodeURIComponent('أهلاً Mavi 🤍 عايزة أطلب — ' + shop)}">ابعتيها على واتساب</a>
  </div>
  <script>if(location.search.includes('print'))window.print();</script>
</body></html>`);
});

admin.get('/system/info/status', A.requireOwner, (_req, res) => {
  res.json({
    database: (process.env.DB_PATH || 'data/mavi.db').split(/[\\/]/).pop(),
    persistent_disk: /^\/data\//.test(process.env.DB_PATH || '') || !!process.env.DB_PATH,
    orders: get('SELECT COUNT(*) n FROM orders').n,
    customers: get('SELECT COUNT(*) n FROM customers').n,
    public_url: (setting('public_url', '') || '').replace(/\/+$/, ''),
    last_backup: get("SELECT created_at FROM events WHERE action='download' AND entity='system' ORDER BY id DESC LIMIT 1")?.created_at || null,
  });
});

admin.post('/system/change-password', A.requireOwner, (req, res) => {
  const { current, next } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!A.verifyPassword(String(current || ''), u.password_hash))
    return bad(res, 401, 'bad_password', 'الباسورد الحالي غلط');
  if (String(next || '').length < 8)
    return bad(res, 400, 'weak_password', 'الباسورد الجديد لازم ٨ حروف على الأقل');
  run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(String(next)), req.user.id);
  audit('user', u.id, 'password_changed', `user:${req.user.id}`);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

/* ============================================================
   static faces
   ============================================================ */
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
/* ---- installable app (PWA): manifest + service worker ----
   Gives an app icon on the phone home screen without any app store. */
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: 'MAVI — فصّلي على مقاسك',
    short_name: 'MAVI',
    description: 'عبايات وفساتين بمقاسك · طلباتك ومتابعتها',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F6F0EA',
    theme_color: '#121E48',
    lang: 'ar',
    dir: 'rtl',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

app.get('/sw.js', (_req, res) => {
  res.type('application/javascript').send(`
    const CACHE = 'mavi-v1';
    self.addEventListener('install', e => { self.skipWaiting(); });
    self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
    // network-first: never serve stale prices or stale order status
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET') return;
      e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
      );
    });
  `);
});

/* Landing page: two doors. Served at '/' so a beginner who opens the site
   without a path can reach BOTH the shop and the admin panel.
   Works from the filesystem root too (GitHub Pages, shared hosting). */
const LANDING = path.join(__dirname, '..', 'public', 'index.html');
app.get('/', (_req, res) => res.sendFile(LANDING));

/* health check for free hosts (Northflank / Render / Koyma probes) */
app.get('/healthz', (_req, res) => {
  try { get('SELECT 1'); res.json({ ok: true, uptime: Math.round(process.uptime()) }); }
  catch (e) { res.status(503).json({ ok: false }); }
});
app.get('/store/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store', 'index.html')));
/* the page route must never be handled by the static mount above */
app.get('/admin/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.get('/admin', (_req, res) => res.redirect('/admin/'));

/* error handler */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: 'حصل خطأ غير متوقع' });
});

/* housekeeping once an hour */
setInterval(() => { try { A.pruneExpired(); } catch (e) { console.error('prune', e); } }, 3600e3);

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mavi ERP  →  http://localhost:${PORT}/store/   (customer)`);
    console.log(`            →  http://localhost:${PORT}/admin/   (staff & owner)`);
  });
}

module.exports = app;
