'use strict';
/* Permission regression tests — the wall around money.
   Run: node test/api.test.js   (server must not be required to be running; uses supertest-less http) */
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || 3311;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0, passes = 0;

function check(name, cond, extra) {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${extra ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}
async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, json };
}
const containsKey = (obj, key) => JSON.stringify(obj).toLowerCase().includes(`"${key}"`);

(async () => {
  const TEST_DB = path.join(__dirname, '..', 'data', 'test.db');
  // fresh, seeded database for the run
  require('fs').rmSync(TEST_DB, { force: true });
  require('fs').rmSync(TEST_DB + '-wal', { force: true });
  require('fs').rmSync(TEST_DB + '-shm', { force: true });
  await new Promise((resolve, reject) => {
    const s = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'seed.js')], {
      env: { ...process.env, DB_PATH: TEST_DB }, stdio: 'ignore',
    });
    s.on('exit', code => code === 0 ? resolve() : reject(new Error('seed failed')));
  });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SHOW_OTP: '1', DB_PATH: TEST_DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d.toString(); });
  server.stderr.on('data', d => { log += d.toString(); });
  await new Promise(r => setTimeout(r, 1200));

  try {
    console.log('\n── 1. Public catalogue ──────────────────────────────');
    const cat = await api('GET', '/api/store/catalogue');
    check('catalogue is public (200)', cat.status === 200);
    check('catalogue has styles', (cat.json?.styles || []).length > 0);
    check('NO cost field in public catalogue', !containsKey(cat.json, 'cost'), cat.json?.styles?.[0]);
    check('NO profit/margin fields', !containsKey(cat.json, 'profit') && !containsKey(cat.json, 'margin'));

    console.log('\n── 2. Customer realm auth ───────────────────────────');
    const randPhone = '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const reqCode = await api('POST', '/api/store/auth/request-code', { phone: randPhone });
    check('OTP requested', reqCode.status === 200 && !!reqCode.json?.dev_code);
    const badVerify = await api('POST', '/api/store/auth/verify', { phone: randPhone, code: '000000' });
    check('wrong OTP rejected (401)', badVerify.status === 401);
    const verify = await api('POST', '/api/store/auth/verify', { phone: randPhone, code: reqCode.json.dev_code });
    check('correct OTP logs in', verify.status === 200 && !!verify.json?.token);
    const custToken = verify.json.token;

    console.log('\n── 3. A customer cannot reach admin endpoints ───────');
    for (const p of ['/api/admin/orders', '/api/admin/money/summary', '/api/admin/customers',
                     '/api/admin/styles', '/api/admin/money/reports']) {
      const r = await api('GET', p, null, custToken);
      check(`customer token blocked on ${p} (401)`, r.status === 401, r.status);
    }

    console.log('\n── 4. Admin login + role separation ─────────────────');
    const staffLogin = await api('POST', '/api/admin/auth/login', { email: 'staff@mavi.eg', password: 'mavi-staff' });
    check('staff can log in', staffLogin.status === 200 && staffLogin.json.user.role === 'staff');
    const ownerLogin = await api('POST', '/api/admin/auth/login', { email: 'owner@mavi.eg', password: 'mavi-owner' });
    check('owner can log in', ownerLogin.status === 200 && ownerLogin.json.user.role === 'owner');
    const badLogin = await api('POST', '/api/admin/auth/login', { email: 'owner@mavi.eg', password: 'wrong' });
    check('wrong password rejected', badLogin.status === 401);
    const staffToken = staffLogin.json.token, ownerToken = ownerLogin.json.token;

    console.log('\n── 5. Staff must NOT see money ──────────────────────');
    const staffOrders = await api('GET', '/api/admin/orders', null, staffToken);
    check('staff can read orders', staffOrders.status === 200);
    check('staff orders carry NO cost', !containsKey(staffOrders.json, 'cost'));
    check('staff orders carry NO profit', !containsKey(staffOrders.json, 'profit'));
    const staffStyles = await api('GET', '/api/admin/styles', null, staffToken);
    check('staff styles have NO cost field', !containsKey(staffStyles.json, 'cost'));
    const staffFabric = await api('GET', '/api/admin/fabric', null, staffToken);
    check('staff fabric has NO cost_per_metre', !containsKey(staffFabric.json, 'cost_per_metre'));
    const staffTailors = await api('GET', '/api/admin/tailors', null, staffToken);
    check('staff tailors have NO rate_per_piece', !containsKey(staffTailors.json, 'rate_per_piece'));
    for (const p of ['/api/admin/money/summary', '/api/admin/money/reports',
                     '/api/admin/money/outstanding', '/api/admin/money/expenses']) {
      const r = await api('GET', p, null, staffToken);
      check(`staff blocked on ${p} (403)`, r.status === 403, r.status);
    }
    const staffPay = await api('POST', '/api/admin/orders/MV-000000-001/payments', { amount: 100 }, staffToken);
    check('staff cannot record payments (403)', staffPay.status === 403);

    console.log('\n── 6. Owner sees money ──────────────────────────────');
    const ownerStyles = await api('GET', '/api/admin/styles', null, ownerToken);
    check('owner styles DO include cost', containsKey(ownerStyles.json, 'cost'));
    const summary = await api('GET', '/api/admin/money/summary', null, ownerToken);
    check('owner money summary works', summary.status === 200 && typeof summary.json.revenue === 'number');
    check('summary exposes profit', typeof summary.json.net_profit === 'number');

    console.log('\n── 7. Customer data isolation ───────────────────────');
    // log a second, fresh customer in and make sure they cannot see the first one's orders
    const p2 = '011' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const c2 = await api('POST', '/api/store/auth/request-code', { phone: p2 });
    const v2 = await api('POST', '/api/store/auth/verify', { phone: p2, code: c2.json.dev_code });
    const t2 = v2.json.token;

    // customer 1 places an order (needs measurements first)
    await api('PUT', '/api/store/me/measurements', { waist: 100, hip: 110, bust: 96, length: 140, sleeve: 58, arm: 30 }, custToken);
    const noMeas = await api('POST', '/api/store/orders', { style_id: 'AB-07', colour: 'أسود', length_cm: 145, qty: 1, delivery: true,governorate:'الجيزة',fabric_choice:'قماش العميلة' }, t2);
    check('order blocked without measurements (422)', noMeas.status === 422, noMeas.json);
    const order = await api('POST', '/api/store/orders', { style_id: 'AB-07', colour: 'أسود', length_cm: 145, qty: 1, delivery: true, governorate:'الجيزة',fabric_choice:'قماش العميلة',note: 'test' }, custToken);
    check('customer can place an order', order.status === 201 && !!order.json.order.code, order.json);
    const code = order.json.order?.code;
    check('customer order view has NO cost', !containsKey(order.json, 'cost'));
    const other = await api('GET', `/api/store/orders/${code}`, null, t2);
    check("another customer CANNOT read the order (404)", other.status === 404, other.status);
    const mine = await api('GET', `/api/store/orders/${code}`, null, custToken);
    check('owner of the order can read it', mine.status === 200);
    check('customer status is simplified', ['received','confirmed','progress','ready','done'].includes(mine.json?.order?.status), mine.json?.order?.status);

    console.log('\n── 8. Production pipeline ───────────────────────────');
    const detail = await api('GET', `/api/admin/orders/${code}`, null, staffToken);
    check('staff can open the order', detail.status === 200);
    check('staff sees a WhatsApp message', typeof detail.json.message?.text === 'string' && detail.json.message.text.length > 20);
    const itemId = detail.json.order.items[0].id;
    const staffProd = await api('PATCH', `/api/admin/order-items/${itemId}/production`, { fabric_id: 1, metres_used: 3, tailor_id: 1 }, staffToken);
    check('staff CANNOT set production costs (403)', staffProd.status === 403);
    const ownerProd = await api('PATCH', `/api/admin/order-items/${itemId}/production`, { fabric_id: 1, metres_used: 3, tailor_id: 1 }, ownerToken);
    check('owner CAN set fabric/tailor', ownerProd.status === 200);
    const fabricAfter = await api('GET', '/api/admin/fabric', null, ownerToken);
    const f1 = fabricAfter.json.fabric.find(f => f.id === 1);
    check('fabric metres were deducted', f1 && f1.metres < 14.5, f1?.metres);
    const pre = await api('PATCH', `/api/admin/orders/${code}/status`, {status:'sewing'}, staffToken);
    check('production blocked until deposit approved', pre.status===409);
    const qdep=await api('POST',`/api/admin/order-deposits/${code}/quote`,{percent:40,payment_details:'Instapay 01000000000',shipping_fee:120},ownerToken);
    check('owner can quote deposit',qdep.status===200);
    const pic='data:image/png;base64,'+require('fs').readFileSync(path.join(__dirname,'..','public','brand','icon-192.png')).toString('base64');
    const receipt=await api('POST',`/api/store/order-deposits/${code}/receipt`,{image:pic,method:'wallet'},custToken);
    check('customer can submit receipt',receipt.status===200);
    const decision=await api('POST',`/api/admin/order-deposits/${code}/decision`,{decision:'approve'},ownerToken);
    check('owner can approve deposit',decision.status===200);
    const second=await api('POST',`/api/admin/order-deposits/${code}/decision`,{decision:'approve'},ownerToken);
    check('deposit confirmation cannot double-count',second.status===409);
    const costSave=await api('PUT',`/api/admin/order-items/${itemId}/cost-lines`,{lines:[{label:'قماش',quantity:2,unit_cost:100},{label:'خياطة',quantity:1,unit_cost:150}]},ownerToken);
    check('owner can save detailed costs',costSave.status===200 && costSave.json.unit_cost===350);
    const costStaff=await api('GET',`/api/admin/order-items/${itemId}/cost-lines`,null,staffToken);
    check('staff cannot read detailed costs',costStaff.status===403);
    const st1 = await api('PATCH', `/api/admin/orders/${code}/status`, { status: 'sewing' }, staffToken);
    check('staff can advance status', st1.status === 200 && st1.json.order.status === 'sewing');
    check('staff status response contains no cost or profit', !containsKey(st1.json.order.totals,'cost') && !containsKey(st1.json.order.totals,'profit'));
    check('message changed for the new stage', st1.json.message.text.includes('التفصيل'), st1.json.message.text.slice(0, 40));
    const custAfter = await api('GET', `/api/store/orders/${code}`, null, custToken);
    check('customer sees sewing stage in Arabic', custAfter.json.order.statusLabel === 'في الخياطة', custAfter.json.order);

    console.log('\n── 9. Input validation ──────────────────────────────');
    const badColour = await api('POST', '/api/store/orders', { style_id: 'AB-07', colour: 'بنفسجي', fabric_choice:'قماش العميلة',length_cm: 145 }, custToken);
    check('invalid colour rejected (400)', badColour.status === 400);
    const badLength = await api('POST', '/api/store/orders', { style_id: 'AB-07', colour: 'أسود', fabric_choice:'قماش العميلة',length_cm: 999 }, custToken);
    check('invalid length rejected (400)', badLength.status === 400);
    const badMeas = await api('PUT', '/api/store/me/measurements', { waist: 9999 }, custToken);
    check('absurd measurement rejected (400)', badMeas.status === 400);
    const noAuth = await api('GET', '/api/store/orders');
    check('unauthenticated order list blocked (401)', noAuth.status === 401);

    console.log('\n── 10. Session teardown ─────────────────────────────');
    await api('POST', '/api/store/auth/logout', null, custToken);
    const afterLogout = await api('GET', '/api/store/orders', null, custToken);
    check('token invalid after logout (401)', afterLogout.status === 401);
    const forged = await api('GET', '/api/admin/orders', null, 'deadbeef');
    check('forged token rejected (401)', forged.status === 401);

  } catch (e) {
    failures++; console.log('  ✗ harness error:', e.message);
  } finally {
    server.kill();
    console.log(`\n${'─'.repeat(52)}\n  ${passes} passed, ${failures} failed\n`);
    if (failures) { console.log('server log tail:\n' + log.split('\n').slice(-15).join('\n')); process.exit(1); }
    process.exit(0);
  }
})();
