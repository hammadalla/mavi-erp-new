'use strict';
/* Owner/staff development seed — realistic shape of Mavi's actual work. */
const { db, run, get } = require('./db');
const { hashPassword } = require('./auth');

const em = get('SELECT COUNT(*) n FROM users').n;
const FORCE = process.argv.includes('--force') || process.env.FORCE_SEED;
if (em > 0 && !FORCE) {
  console.log('seed: already populated, skipping');
  process.exit(0);
}

if (FORCE) {
  const tables = ['customer_notifications','stock_movements','stock_reservations','custom_order_links','item_cost_lines','order_deposits','custom_requests','events','expenses','payments','order_items','orders','stock_items','tailors',
                  'fabric','style_sizes','style_lengths','style_colours','styles',
                  'sessions','otp_codes','measurements','customers','users','settings'];
  db.pragma('foreign_keys = OFF');
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  db.pragma('foreign_keys = ON');
  console.log('seed: wiped existing data (--force)');
}
const ins = (sql, ...a) => db.prepare(sql).run(...a);

const seed = db.transaction(() => {
  /* users */
  ins(`INSERT INTO users(email,name,role,password_hash) VALUES(?,?,?,?)`,
      'owner@mavi.eg', 'إدارة Mavi', 'owner', hashPassword('mavi-owner'));
  ins(`INSERT INTO users(email,name,role,password_hash) VALUES(?,?,?,?)`,
      'staff@mavi.eg', 'مساعدة التشغيل', 'staff', hashPassword('mavi-staff'));

  /* settings */
  for (const [k, v] of Object.entries({
    brand_name: 'MAVI', slogan: 'Tailor Your Design',
    whatsapp: '201013979358', delivery_fee: '60', currency: 'EGP',
  })) ins('INSERT INTO settings(key,value) VALUES(?,?)', k, v);

  /* styles */
  const styles = [
    ['SK-01','جيبة بليسيه كلوش — اسكوبا','made',750,330,7,'تلبس لدوران وسط حتى 125 سم · متاح نص كلوش'],
    ['SK-05','جيبة نص كلوش','made',550,250,6,'تلبس لدوران وسط حتى 80 سم'],
    ['DR-04','فستان كروازيه واسع — كريب','made',1250,560,10,'قصّة واسعة وأكمام واسعة'],
    ['AB-07','عباية بتفاصيل — موديل جديد','made',1450,650,12,'قصّة واسعة + تفاصيل يد'],
    ['BL-02','بلوزة ساتان','made',620,270,5,'متاح تغيير الزرار'],
    ['DR-11','فستان سواريه','made',2100,980,14,'شغل يد — يحتاج حجز'],
    ['ST-01','دريس ستوك — Vero Moda','stock',850,400,0,'أوريجينال — كمية محدودة'],
    ['ST-02','بلوزة ستوك — H&M','stock',450,190,0,'أوريجينال — كمية محدودة'],
  ];
  for (const s of styles) ins(`INSERT INTO styles(id,name,type,price,cost,lead_days,note) VALUES(?,?,?,?,?,?,?)`, ...s);

  const colours = {
    'SK-01': [['أسود','#232323'],['أوف وايت','#f2ece0'],['بيج','#d9c4a3'],['زهري','#e7c6cf'],['نبيتي','#6d1f33'],['هافان','#b98d5e'],['بينك','#f0a9bb'],['سيمون','#d8a6a0'],['زيتي','#5f6b48']],
    'SK-05': [['بيج','#d9c4a3'],['رصاصي','#8a8f96'],['نبيتي','#6d1f33'],['بيبي بلو','#bcd4e8'],['أوف وايت','#f2ece0']],
    'DR-04': [['أسود','#232323'],['أوف وايت','#f2ece0'],['زيتي','#5f6b48'],['نبيتي','#6d1f33']],
    'AB-07': [['أسود','#232323'],['هافان','#b98d5e'],['كحلي','#1d2f6f'],['بيج','#d9c4a3']],
    'BL-02': [['زهري','#e7c6cf'],['أوف وايت','#f2ece0'],['أسود','#232323']],
    'DR-11': [['نبيتي','#6d1f33'],['أسود','#232323'],['ذهبي','#c9a86a']],
    'ST-01': [['أسود','#232323']],
    'ST-02': [['بيج','#d9c4a3'],['أسود','#232323']],
  };
  for (const [sid, list] of Object.entries(colours))
    list.forEach(([n, h], i) => ins('INSERT INTO style_colours(style_id,name,hex,sort) VALUES(?,?,?,?)', sid, n, h, i));

  const lengths = { 'SK-01':[100,105,110], 'SK-05':[100], 'DR-04':[135,140,145],
                    'AB-07':[140,145,150], 'DR-11':[140,145,150] };
  for (const [sid, list] of Object.entries(lengths))
    list.forEach(cm => ins('INSERT INTO style_lengths(style_id,cm) VALUES(?,?)', sid, cm));

  for (const sid of ['ST-01','ST-02'])
    for (const sz of ['S','M','L']) ins('INSERT INTO style_sizes(style_id,size) VALUES(?,?)', sid, sz);

  /* fabric */
  const fabrics = [
    ['كريب أسود','أسود',14.5,140,6], ['اسكوبا أوف وايت','أوف وايت',9,95,5],
    ['ساتان زهري','زهري',5.5,120,4], ['شيفون نبيتي','نبيتي',2.5,110,4],
    ['كتان بيج','بيج',11,130,4],
  ];
  for (const f of fabrics) ins('INSERT INTO fabric(name,colour,metres,cost_per_metre,reorder_level) VALUES(?,?,?,?,?)', ...f);

  /* tailors */
  for (const t of [['ورشة أم محمد','01000000001',180],['ورشة الحاج سيد','01000000002',150],['تفصيل داخلي — عائشة','01000000003',200]])
    ins('INSERT INTO tailors(name,phone,rate_per_piece) VALUES(?,?,?)', ...t);

  /* stock items */
  for (const s of [['ST-01','S','أسود',3,400,850],['ST-01','M','أسود',2,400,850],['ST-01','L','أسود',1,400,850],
                   ['ST-02','S','بيج',5,190,450],['ST-02','M','أسود',4,190,450],['ST-02','L','بيج',2,190,450]])
    ins('INSERT INTO stock_items(style_id,size,colour,qty,buy_price,sell_price) VALUES(?,?,?,?,?,?)', ...s);

  /* customers + measurements */
  const customers = [
    ['01012345678','هبة سامي','الهرم',[118,124,104,105,58,34]],
    ['01123456789','نورا عبد الله','المعادي',[92,102,96,140,60,30]],
    ['01234567890','سارة فتحي','6 أكتوبر',[104,112,100,145,58,32]],
    ['01098765432','مي إبراهيم','مدينة نصر',[84,96,90,135,56,28]],
    ['01555667788','آية شريف','فيصل — الجيزة',[110,118,102,100,57,33]],
  ];
  for (const [phone, name, area, m] of customers) {
    // demo customers all share the password "mavi1234" so the store can be tried immediately
    const r = ins('INSERT INTO customers(phone,name,area,password_hash) VALUES(?,?,?,?)',
                  phone, name, area, hashPassword('mavi1234'));
    ins('INSERT INTO measurements(customer_id,waist,hip,bust,length,sleeve,arm) VALUES(?,?,?,?,?,?,?)',
        r.lastInsertRowid, ...m);
  }


  /* ---------- historical orders so the dashboard tells a real story ---------- */
  const custIds = db.prepare('SELECT id FROM customers ORDER BY id').all().map(r => r.id);
  const fab = db.prepare('SELECT id, cost_per_metre FROM fabric ORDER BY id').all();
  const tal = db.prepare('SELECT id, rate_per_piece FROM tailors ORDER BY id').all();

  const plan = [
    // [customer, style, colour, length, qty, metres, fabricIdx, tailorIdx, status, daysAgo, delivery, paidFraction, channel]
    [0,'DR-11','نبيتي',145,1,3.5,3,2,'delivered',58,true,1,'whatsapp'],
    [1,'DR-04','أسود',140,1,3.0,0,0,'delivered',52,true,1,'facebook'],
    [2,'AB-07','هافان',145,1,3.2,4,1,'delivered',47,false,1,'whatsapp'],
    [3,'BL-02','زهري',null,1,1.6,2,2,'delivered',41,true,1,'instagram'],
    [1,'SK-01','أسود',105,2,4.4,0,1,'delivered',35,true,1,'whatsapp'],
    [4,'SK-05','بيج',100,1,2.0,4,1,'delivered',29,true,0.55,'facebook'],
    [0,'AB-07','أسود',150,1,3.4,0,1,'delivered',22,false,1,'whatsapp'],
    [2,'DR-04','زيتي',140,1,3.0,4,0,'delivered',16,true,0.6,'online'],
    [3,'DR-11','ذهبي',150,1,3.8,2,2,'ready',9,true,0.5,'instagram'],
    [4,'AB-07','كحلي',145,1,3.2,4,1,'sewing',6,true,0.35,'online'],
    [1,'SK-01','بيج',110,1,2.2,1,1,'cut',4,true,0.4,'whatsapp'],
    [2,'BL-02','أسود',null,1,1.6,0,2,'confirmed',2,true,0.0,'facebook'],
  ];

  const styleRow = id => db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
  const addOrder = (code, custIdx, styleId, colour, len, qty, metres, fIdx, tIdx, status, daysAgo, delivery, paidFrac, channel) => {
    const st = styleRow(styleId);
    const created = new Date(Date.now() - daysAgo * 864e5);
    const promise = new Date(created.getTime() + (st.lead_days || 7) * 864e5);
    const fee = delivery ? 60 : 0;
    const r = ins(`INSERT INTO orders(code,customer_id,channel,status,promise_date,delivery_fee,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?)`,
                  code, custIds[custIdx], channel, status, promise.toISOString().slice(0,10), fee,
                  created.toISOString().slice(0,19).replace('T',' '),
                  created.toISOString().slice(0,19).replace('T',' '));
    const oid = r.lastInsertRowid;
    const fabric = fab[fIdx], tailor = tal[tIdx];
    const unitCost = fabric.cost_per_metre * metres + tailor.rate_per_piece;
    ins(`INSERT INTO order_items(order_id,style_id,qty,colour,length_cm,unit_price,fabric_id,metres_used,tailor_id,unit_cost)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        oid, styleId, qty, colour, len, st.price, fabric.id, metres, tailor.id, unitCost);
    // stock item sometimes included
    if (styleId === 'AB-07' && qty === 1) {
      const stk = styleRow('ST-01');
      ins(`INSERT INTO order_items(order_id,style_id,qty,colour,size,unit_price,unit_cost) VALUES(?,?,?,?,?,?,?)`,
          oid, 'ST-01', 1, 'أسود', 'M', stk.price, stk.cost);
    }
    const total = db.prepare('SELECT COALESCE(SUM(unit_price*qty),0) t FROM order_items WHERE order_id=?').get(oid).t + fee;
    if (paidFrac > 0)
      ins(`INSERT INTO payments(order_id,amount,method,created_at) VALUES(?,?,?,?)`,
          oid, Math.round(total * paidFrac), paidFrac === 1 ? 'cash' : 'instapay',
          created.toISOString().slice(0,19).replace('T',' '));
  };

  plan.forEach((p, i) => {
    const d = new Date(Date.now() - p[9] * 864e5);
    const ym = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}`;
    addOrder(`MV-${ym}-${String(i+101).slice(-3)}`, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], p[12]);
  });

  /* expenses */
  for (const e of [['نصيب الورشة من الإيجار',3500,'2026-10-01'],['إعلانات فيسبوك',1800,'2026-10-05'],
                   ['تغليف وأكياس',550,'2026-10-12'],['نت وكهربا',450,'2026-10-15'],
                   ['توصيل وكوريير',900,'2026-10-20']])
    ins('INSERT INTO expenses(category,amount,spent_on) VALUES(?,?,?)', ...e);
});

seed();
console.log('seed: done');
console.log('  owner@mavi.eg / mavi-owner   (owner — sees money)');
console.log('  staff@mavi.eg / mavi-staff   (staff — no money)');
console.log('  customer: 01012345678 …       (OTP printed by the server)');
