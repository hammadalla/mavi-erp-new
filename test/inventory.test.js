'use strict';
// Tailoring-only inventory: retain historical stock records, never expose them in the catalogue.
const {spawn,spawnSync}=require('child_process'),path=require('path'),fs=require('fs'),assert=require('assert');
const root=path.join(__dirname,'..'),db=path.join(root,'data','inventory-test.db'),port=3322;
for(const s of ['','-wal','-shm'])fs.rmSync(db+s,{force:true});
let seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env:{...process.env,DB_PATH:db},encoding:'utf8'});if(seed.status)throw Error(seed.stderr);
const server=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,DB_PATH:db,PORT:String(port),SHOW_OTP:'0'}});const base=`http://127.0.0.1:${port}`;
async function req(method,url,body,token){let r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};}
(async()=>{try{for(let i=0;i<30;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 let owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token,staff=(await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const fabric={name:'ساتان اختبار',colour:'أسود',metres:8,cost_per_metre:55,reorder_level:3};assert.equal((await req('POST','/api/admin/inventory/fabric',fabric,staff)).status,403);let f=await req('POST','/api/admin/inventory/fabric',fabric,owner);assert.equal(f.status,201);assert.equal((await req('PATCH','/api/admin/inventory/fabric/'+f.json.id,{...fabric,metres:12},owner)).status,200);assert.equal((await req('GET','/api/admin/fabric',null,owner)).json.fabric.find(x=>x.id===f.json.id).metres,12);
 let catalog=await req('GET','/api/store/catalogue');assert(catalog.json.styles.length>0);assert(catalog.json.styles.every(x=>x.type==='made'));assert(!JSON.stringify(catalog.json).includes('buy_price'));assert(!('delivery_fee' in catalog.json));console.log('Tailoring catalogue and fabric inventory permissions passed.');
 }catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(db+s,{force:true})}})();
