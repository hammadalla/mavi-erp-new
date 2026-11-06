'use strict';
/* Domain rules shared by both faces.
   The mapping between INTERNAL status and CUSTOMER status lives here, in one place. */
const { get, all, run } = require('./db');

/* internal pipeline → what the customer is allowed to know */
const CUSTOMER_STATUS = {
  new:       { key: 'received', label: 'وصلنا طلبك',  step: 1 },
  confirmed: { key: 'confirmed', label: 'اتأكد',      step: 2 },
  cut:       { key: 'progress',  label: 'قص القماش', step: 3 },
  sewing:    { key: 'progress',  label: 'في الخياطة', step: 3 },
  ready:     { key: 'ready',     label: 'جاهز',       step: 4 },
  delivered: { key: 'done',      label: 'اتسلّم',     step: 5 },
  cancelled: { key: 'cancelled', label: 'ملغي',       step: 0 },
};
const INTERNAL_STATUSES = ['new','confirmed','cut','sewing','ready','delivered','cancelled'];

const customerStatus = (s) => CUSTOMER_STATUS[s] || { key: 'received', label: 'قيد المراجعة', step: 1 };

/* ---------- order numbering: MV-YYMM-NNN ---------- */
function rememberOrderCode(code) {
  const m=/^MV-(\d{4})-(\d+)$/.exec(String(code||'')); if(!m)return;
  const key='order_counter:'+m[1], n=Number(m[2]);
  const prev=Number(get('SELECT value FROM settings WHERE key=?',key)?.value||0);
  if(n>prev)run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(n));
}
function nextOrderCode(now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2), mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `MV-${yy}${mm}-`, key='order_counter:'+yy+mm;
  const row=get('SELECT MAX(CAST(SUBSTR(code,9) AS INTEGER)) n FROM orders WHERE code LIKE ?',prefix+'%');
  const counter=Number(get('SELECT value FROM settings WHERE key=?',key)?.value||0);
  const n=Math.max(Number(row.n||0),counter)+1;
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(n));
  return prefix+String(n).padStart(3,'0');
}

/* ---------- money ---------- */
function orderTotals(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  const items = all('SELECT * FROM order_items WHERE order_id = ?', orderId);
  const paid = get('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE order_id = ?', orderId).t;
  const subtotal = items.reduce((s, i) => s + i.unit_price * i.qty, 0);
  const total = subtotal - o.discount + o.delivery_fee;
  const cost = items.reduce((s, i) => s + i.unit_cost * i.qty, 0);
  return {
    subtotal, discount: o.discount, delivery_fee: o.delivery_fee,
    total, paid, due: total - paid, cost, profit: total - cost,
    margin: total > 0 ? Math.round(((total - cost) / total) * 100) : 0,
  };
}

/* unit cost = fabric metres × cost/m + tailor rate (+ style fallback for stock items) */
function computeUnitCost({ styleId, fabricId, metres, tailorId, qty = 1 }) {
  const style = get('SELECT * FROM styles WHERE id = ?', styleId);
  let cost = 0;
  if (fabricId) {
    const f = get('SELECT * FROM fabric WHERE id = ?', fabricId);
    if (f) cost += (f.cost_per_metre + (f.shipping_per_metre || 0)) * (metres || 0);
  } else if (style && style.type === 'stock') {
    cost += style.cost;                 // stock item: known purchase cost
  }
  if (tailorId) {
    const t = get('SELECT * FROM tailors WHERE id = ?', tailorId);
    if (t) cost += t.rate_per_piece;
  }
  return cost;
}

/* deduct / return fabric when an item's fabric is set or changed */
function adjustFabric(fabricId, deltaMetres) {
  if (!fabricId || !deltaMetres) return;
  const f=get('SELECT metres FROM fabric WHERE id=?',fabricId);
  if(!f)throw new Error('الخامة غير موجودة');
  if(deltaMetres>0 && f.metres + 1e-9 < deltaMetres)throw new Error('كمية الخامة المتاحة غير كافية');
  run('UPDATE fabric SET metres = metres - ? WHERE id = ?', deltaMetres, fabricId);
}

/* ---------- Arabic WhatsApp templates (owner-facing, one per stage) ---------- */
function buildMessage(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  const c = get('SELECT * FROM customers WHERE id = ?', o.customer_id);
  const items = all(`SELECT oi.*, COALESCE(NULLIF(oi.description,''),s.name) AS style_name FROM order_items oi
                     JOIN styles s ON s.id = oi.style_id WHERE oi.order_id = ?`, orderId);
  const t = orderTotals(orderId);
  const first = (c?.name || '').split(' ')[0] || 'حبيبتي';
  const list = items.map(i =>
    `• ${i.style_name} — ${i.colour || ''}${i.length_cm ? ` — طول ${i.length_cm} سم` : ''}${i.qty > 1 ? ` ×${i.qty}` : ''}`
  ).join('\n');
  const fmt = n => new Intl.NumberFormat('en-EG').format(Math.round(n));
  const date = o.promise_date
    ? new Date(o.promise_date).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long' })
    : 'قريباً';

  const T = {
    new: `أهلاً ${first} 🤍\nوصلني طلبك وبنتأكد منه دلوقتي.\n\n${list}\n\nكود الأوردر: ${o.code}\n\nأول ما نتأكد المقاسات والخامة هبلغك 🙏`,
    confirmed: `تأكيد أوردر ${o.code} ✅\n\nأهلاً ${first}، أوردرك اتأكد:\n${list}\n\nالإجمالي: ${fmt(t.total)} ج.م\nالمدفوع: ${fmt(t.paid)} ج.م\nالباقي: ${fmt(t.due)} ج.م\n\nموعد التسليم المتوقع: ${date} 🤍`,
    cut: `${first} حبيبتي 🤍\nبدأنا قص القماش لأوردر ${o.code}.\n\n${list}\n\nهيبدأ التفصيل بكرة إن شاء الله وهبلغك أول ما يخلص.`,
    sewing: `${first}، أوردرك ${o.code} في التفصيل دلوقتي ✂️\n\n${list}\n\nموعدنا ${date} — لو في أي تعديل في الطول قوليلي قبل ما نخلّص.`,
    ready: `${first} حبيبتي، أوردرك جاهز 🎉\n\n${list}\n\nالباقي: ${fmt(t.due)} ج.م\n\nتحبي نبعته بكوريير ولا تستلميه من عندنا؟ 🤍`,
    delivered: `${first}، شكراً إنك اخترتي Mavi 🤍\n\n${list}\n\nلو حبيتي، ابعتيلنا صورة وأنتي لابسة القطعة — بننشرها في #جمهورية_Mavi (بإذنك طبعاً).\nوأي حاجة محتاجاها، مقاساتك محفوظة عندنا فالأوردر الجاي هياخد دقيقة 💙`,
    cancelled: `${first}، تم إلغاء أوردر ${o.code}.\nلو حبيتي نعمله تاني في أي وقت، إحنا موجودين 🤍`,
  };
  return { status: o.status, text: T[o.status] || T.new };
}

/* ---------- customer-safe projection of an order ---------- */
function customerOrderView(orderId, customerId) {
  const o = get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', orderId, customerId);
  if (!o) return null;
  const items = all(`SELECT oi.qty, oi.colour, oi.length_cm, oi.size, oi.unit_price, COALESCE(NULLIF(oi.description,''),s.name) AS style_name
                     FROM order_items oi JOIN styles s ON s.id = oi.style_id WHERE oi.order_id = ?`, orderId);
  const t = orderTotals(orderId);
  const cs = customerStatus(o.status);
  return {
    code: o.code,
    status: cs.key,
    statusLabel: cs.label,
    step: cs.step,
    created_at: o.created_at,
    promise_date: o.promise_date,
    delivery_fee: o.delivery_fee, governorate:o.governorate, delivery_requested:!!o.delivery_requested, shipping_quoted:!!o.shipping_quoted, fabric_choice:o.fabric_choice,
    total: t.total,          // her total — no cost, no profit
    paid: t.paid,
    due: t.due,
    deposit: (() => { const d=get('SELECT percent,payment_details,status FROM order_deposits WHERE order_id=?',orderId); return d ? {...d, amount:d.percent == null ? null : Math.round(t.total*d.percent)/100} : null; })(),
    items: items.map(i => ({
      name: i.style_name, colour: i.colour, length_cm: i.length_cm,
      size: i.size, qty: i.qty, price: i.unit_price,
    })),
  };
}

module.exports = {
  CUSTOMER_STATUS, INTERNAL_STATUSES, customerStatus,
  nextOrderCode, rememberOrderCode, orderTotals, computeUnitCost, adjustFabric,
  buildMessage, customerOrderView,
};
