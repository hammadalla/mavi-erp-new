'use strict';
const {spawn,spawnSync}=require('child_process'),path=require('path'),fs=require('fs'),assert=require('assert');
const root=path.join(__dirname,'..'),db=path.join(root,'data','custom-test.db'),port=3317;
for(const s of ['','-wal','-shm'])fs.rmSync(db+s,{force:true});
let seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env:{...process.env,DB_PATH:db},encoding:'utf8'});if(seed.status)throw Error(seed.stderr);
const server=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,DB_PATH:db,PORT:String(port),SHOW_OTP:'0'}});
const base=`http://127.0.0.1:${port}`;
async function req(method,url,body,token){let r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let t=await r.text(),json;try{json=JSON.parse(t)}catch{}return {status:r.status,json,headers:r.headers};}
(async()=>{try{
 for(let i=0;i<30;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 let owner=await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'}),staff=await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'}),customer=await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'});
 assert.equal(owner.status,200);assert.equal(staff.status,200);assert.equal(customer.status,200);let o=owner.json.token,c=customer.json.token,t=staff.json.token;
 let png='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/brand/icon-192.png')).toString('base64');
 assert.equal((await req('POST','/api/store/custom-requests',{details:'test'},c)).status,400);
 let made=await req('POST','/api/store/custom-requests',{image:png,details:'<script>test</script>',date_needed:'2027-02-12',governorate:'الجيزة',fabric_choice:'قماش العميلة'},c);assert.equal(made.status,201);let id=made.json.id;
 assert.equal((await req('GET','/api/admin/custom-requests',null,c)).status,401);assert.equal((await req('GET','/api/admin/custom-requests',null,t)).status,403);
 let list=await req('GET','/api/admin/custom-requests',null,o);assert(list.json.requests.some(x=>x.id===id));
 assert.equal((await req('POST',`/api/store/custom-requests/${id}/receipt`,{image:png,method:'wallet'},c)).status,409);
 assert.equal((await req('POST',`/api/admin/custom-requests/${id}/quote`,{price:2000,percent:40,shipping_fee:0,payment_details:'Instapay 01000000000',advice:'test'},o)).status,200);
 let my=await req('GET','/api/store/custom-requests',null,c);assert.equal(my.json.requests[0].deposit,800);assert(!JSON.stringify(my.json).includes('measurements'));
 assert.equal((await req('POST',`/api/store/custom-requests/${id}/receipt`,{image:png,method:'wallet'},c)).status,200);
 assert.equal((await req('POST',`/api/admin/custom-requests/${id}/decision`,{decision:'approve'},t)).status,403);
 assert.equal((await req('POST',`/api/admin/custom-requests/${id}/decision`,{decision:'approve'},o)).status,200);
 assert.equal((await req('POST',`/api/admin/custom-requests/${id}/decision`,{decision:'approve'},o)).status,409);
 assert.equal((await req('GET','/api/store/custom-requests',null,c)).json.requests[0].status,'approved');
 let orders=await req('GET','/api/store/orders',null,c);let converted=orders.json.orders.find(x=>x.items.some(i=>i.name==='تصميم خاص'));assert(converted);assert.equal(converted.total,2000);assert.equal(converted.paid,800);assert.equal(converted.due,1200);
 let period=await req('GET','/api/admin/money/period?from=2020-01-01&to=2099-12-31',null,o);assert.equal(period.status,200);assert(period.json.sales>=2000);assert.equal((await req('GET','/api/admin/money/period?from=2020-01-01&to=2099-12-31',null,c)).status,401);
 assert.equal((await req('GET',`/api/admin/custom-requests/${id}/design`,null,t)).status,403);
 let other=await req('POST','/api/store/auth/register',{name:'تجربة',phone:'01099999999',password:'1234567'});assert.equal(other.status,200);let otherToken=other.json.token;
 assert(!(await req('GET','/api/store/custom-requests',null,otherToken)).json.requests.some(r=>r.id===id));assert.equal((await req('POST',`/api/store/custom-requests/${id}/receipt`,{image:png,method:'wallet'},otherToken)).status,404);

 console.log('Custom request workflow and access checks passed.');
 }catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(db+s,{force:true})}})();
