'use strict';
/* Startup: create an owner only for an empty DB and only from private host settings. */
const {db,get,run}=require('./db');
const {hashPassword}=require('./auth');
const AUTO_SEED=process.env.AUTO_SEED==='1';
const email=String(process.env.INITIAL_ADMIN_EMAIL||'').trim().toLowerCase();
const password=String(process.env.INITIAL_ADMIN_PASSWORD||'');
const userCount=()=>get('SELECT COUNT(*) n FROM users').n;
if(userCount()===0){
 if(AUTO_SEED){
  if(process.env.NODE_ENV==='production'){
   console.error('[bootstrap] Demo seeding is disabled in production.');process.exit(1);
  }
  console.log('[bootstrap] Creating demo data for local testing.');require('./seed');
 }else if(email||password){
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||password.length<16||password.length>128||['mavi-owner','mavi-staff'].includes(password)){
   console.error('[bootstrap] Invalid initial owner settings; use a valid email and a private password of 16–128 characters.');process.exit(1);
  }
  db.transaction(()=>{
   if(userCount()===0){
    run("INSERT INTO users(email,name,role,password_hash) VALUES(?,?,'owner',?)",email,'إدارة Mavi',hashPassword(password));
    for(const [key,value] of Object.entries({brand_name:'MAVI',slogan:'Tailor Your Design',whatsapp:'201013979358',delivery_fee:'60',currency:'EGP'}))run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',key,value);
   }
  })();
  console.log('[bootstrap] Owner created. Remove INITIAL_ADMIN_PASSWORD from host settings.');
 }else console.log('[bootstrap] Empty database: configure INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD before signing in.');
}
// Never print or expose the secret through the running application.
delete process.env.INITIAL_ADMIN_PASSWORD;
const app=require('./server');
const PORT=process.env.PORT||3000;
app.listen(PORT,'0.0.0.0',()=>console.log(`Mavi ERP ready on port ${PORT}`));
