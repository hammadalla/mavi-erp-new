'use strict';
const {spawn,spawnSync}=require('child_process'),path=require('path'),fs=require('fs'),assert=require('assert');
const root=path.join(__dirname,'..'),db=path.join(root,'data','tailoring-test.db'),port=3338;
for(const x of ['','-wal','-shm'])fs.rmSync(db+x,{force:true});
let seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env:{...process.env,DB_PATH:db},encoding:'utf8'});if(seed.status)throw Error(seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env:{...process.env,DB_PATH:db,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'}});const base=`http://127.0.0.1:${port}`;
async function req(method,url,body,token){let r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let text=await r.text(),json;try{json=JSON.parse(text)}catch{}return {status:r.status,json,bytes:Buffer.from(text)}}
(async()=>{try{
 for(let i=0;i<30;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const o=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token,t=(await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token,c=(await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 const style={id:'DRESS-NEW',name:'فستان اختبار',price:1200,lead_days:10,note:'تفصيل',colours:['أسود','أبيض'],fabrics:['ساتان','شيفون'],active:true};
 assert.equal((await req('POST','/api/admin/catalogue/styles',style,t)).status,403);assert.equal((await req('POST','/api/admin/catalogue/styles',style,o)).status,200);
 const img='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/brand/icon-192.png')).toString('base64');
 for(let i=0;i<2;i++)assert.equal((await req('POST','/api/admin/catalogue/styles/DRESS-NEW/images',{image:img},o)).status,200);
 const cat=await req('GET','/api/store/catalogue'),p=cat.json.styles.find(x=>x.id===style.id);assert.equal(p.images.length,2);assert.deepEqual(p.fabrics,['ساتان','شيفون']);assert(cat.json.styles.every(x=>x.type==='made'));assert(!('delivery_fee' in cat.json));assert.equal((await req('GET','/api/catalogue/images/'+p.images[0])).status,200);
 let order=await req('POST','/api/store/orders',{style_id:style.id,colour:'أسود',fabric_choice:'قماش العميلة',qty:1,delivery:true,governorate:'الجيزة'},c);assert.equal(order.status,201);assert.equal(order.json.order.shipping_quoted,false);assert.equal(order.json.order.delivery_fee,0);let code=order.json.order.code;
 assert.equal((await req('POST',`/api/admin/order-deposits/${code}/quote`,{percent:50,payment_details:'Instapay test'},o)).status,400);
 assert.equal((await req('POST',`/api/admin/order-deposits/${code}/quote`,{percent:50,payment_details:'Instapay test',shipping_fee:125},o)).status,200);
 let detail=(await req('GET',`/api/store/orders/${code}`,null,c)).json.order;assert.equal(detail.total,1325);assert.equal(detail.deposit.amount,662.5);assert.equal(detail.governorate,'الجيزة');
 let custom=await req('POST','/api/store/custom-requests',{image:img,governorate:'الجيزة',fabric_choice:'قماش العميلة'},c);assert.equal(custom.status,201);let id=custom.json.id;
 assert.equal((await req('POST',`/api/admin/custom-requests/${id}/quote`,{price:2000,percent:40,shipping_fee:100,payment_details:'Instapay test'},o)).status,200);let row=(await req('GET','/api/store/custom-requests',null,c)).json.requests[0];assert.equal(row.deposit,840);
 assert.equal((await req('POST',`/api/store/custom-requests/${id}/receipt`,{image:img,method:'wallet'},c)).status,200);assert.equal((await req('POST',`/api/admin/custom-requests/${id}/decision`,{decision:'approve'},o)).status,200);
 let my=(await req('GET','/api/store/orders',null,c)).json.orders.find(x=>x.items.some(i=>i.name==='تصميم خاص'));assert.equal(my.total,2100);assert.equal(my.paid,840);
 let customers=(await req('GET','/api/admin/customers',null,o)).json.customers,customer=customers.find(x=>x.phone==='01012345678');assert(!customer.password_hash);
 assert.equal((await req('POST',`/api/admin/customers/${customer.id}/reset-password`,{password:'newpassword123'},t)).status,403);assert.equal((await req('POST',`/api/admin/customers/${customer.id}/reset-password`,{password:'newpassword123'},o)).status,200);assert.equal((await req('GET','/api/store/me',null,c)).status,401);
 let login=await req('POST','/api/store/auth/login',{phone:'01012345678',password:'newpassword123'});assert.equal(login.status,200);assert.equal((await req('POST','/api/store/auth/change-password',{current:'newpassword123',next:'anotherstrongpass'},login.json.token)).status,200);
 console.log('Tailoring photos, fabric, shipping quotes, custom order and secure password reset passed.');
 }catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const x of ['','-wal','-shm'])fs.rmSync(db+x,{force:true})}})();
