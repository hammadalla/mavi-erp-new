'use strict';
const express=require('express'),{db,get,run,audit}=require('./db'),A=require('./auth'),D=require('./domain'),N=require('./notifications');
const router=express.Router();router.use(A.requireOwner);
const bad=(r,s,m)=>r.status(s).json({message:m});
const clean=(v,max)=>{let s=String(v||'').trim();return s.length<=max&&!/[<>&"'`\\]/.test(s)?s:null};
const number=(v,max)=>{if(v===undefined||v===null||String(v).trim()==='')return null;let n=Number(v);return Number.isFinite(n)&&n>=0&&n<=max?n:null};
router.post('/',(q,r)=>{
 const b=q.body||{},name=clean(b.customer_name,100),phone=clean(b.customer_phone,20),area=clean(b.area,200),gov=clean(b.governorate,80),colour=clean(b.colour,80),fabric=clean(b.fabric_choice,120),note=clean(b.note,1000),custom=clean(b.custom_name,100);
 const price=number(b.unit_price,1e8),qty=number(b.qty,20),ship=b.shipping_fee===''||b.shipping_fee==null?null:number(b.shipping_fee,1e8),paid=b.paid===''||b.paid==null?0:number(b.paid,1e8);
 const statuses=['new','confirmed','cut','sewing','ready','delivered'];const channels=['whatsapp','facebook','instagram','walkin','other'];let status=String(b.status||'new'),channel=String(b.channel||'other'),date=String(b.promise_date||'').trim();
 if(!name||name.length<3||!/^01[0-9]{9}$/.test(phone||'')||[area,gov,colour,fabric,note,custom].some(x=>x===null)||price===null||qty===null||!Number.isInteger(qty)||qty<1||paid===null||(!['',null,undefined].includes(b.shipping_fee)&&ship===null)||paid>price*qty+(ship||0)||(ship!==null&&ship>0&&!gov)||!statuses.includes(status)||!channels.includes(channel)||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return bad(r,400,'راجعي اسم العميلة ورقمها وبيانات القطعة والسعر والمدفوع');
 let id=String(b.style_id||'').trim();if(id){const s=get("SELECT id,type FROM styles WHERE id=? AND active=1",id);if(!s||s.type!=='made'||id==='MANUAL-CUSTOM')return bad(r,400,'الموديل غير متاح');}else if(!custom)return bad(r,400,'اختاري موديلًا أو اكتبي وصف التصميم');
 let m={};for(const k of ['bust','waist','hip','length','sleeve','arm']){let v=b.measurements?.[k];if(v!==undefined&&v!==null&&String(v).trim()!==''){let n=number(v,250);if(n===null||n<20||!Number.isInteger(n))return bad(r,400,'المقاسات يجب أن تكون بين 20 و250 سم');m[k]=n}}
 const existing=get('SELECT id,name FROM customers WHERE phone=?',phone);
 if(existing&&!b.confirm_existing)return r.status(409).json({error:'customer_exists',message:'الرقم مسجل لعميلة موجودة. أكدي الاسم قبل إضافة الأوردر.',existing_name:existing.name});
 let result;
 try{result=db.transaction(()=>{
  let c=get('SELECT id,name FROM customers WHERE phone=?',phone),fresh=!c;
  if(c&&!b.confirm_existing){const e=Error('customer_exists');e.code='CUSTOMER_EXISTS';e.existing_name=c.name;throw e;}
  if(!c){const x=run('INSERT INTO customers(phone,name,area) VALUES(?,?,?)',phone,name,area||null);c={id:x.lastInsertRowid,name};}
  // Never silently overwrite the measurements of an existing account.
  if(fresh&&Object.keys(m).length)run('INSERT INTO measurements(customer_id,waist,hip,bust,length,sleeve,arm) VALUES(?,?,?,?,?,?,?)',c.id,m.waist||null,m.hip||null,m.bust||null,m.length||null,m.sleeve||null,m.arm||null);
  if(!id){id='MANUAL-CUSTOM';run("INSERT OR IGNORE INTO styles(id,name,type,price,cost,active) VALUES('MANUAL-CUSTOM','تصميم من خارج الكتالوج','made',0,0,0)");}
  const code=D.nextOrderCode();const o=run('INSERT INTO orders(code,customer_id,channel,status,promise_date,delivery_fee,note,governorate,delivery_requested,shipping_quoted,fabric_choice,manual_entry) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',code,c.id,channel,status,date||null,ship||0,note||null,gov||null,gov?1:0,ship!==null?1:0,fabric||null);
  run('INSERT INTO order_items(order_id,style_id,description,qty,colour,unit_price) VALUES(?,?,?,?,?,?)',o.lastInsertRowid,id,id==='MANUAL-CUSTOM'?custom:null,qty,colour||null,price);
  if(paid>0)run('INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)',o.lastInsertRowid,paid,(['cash','instapay','wallet','other'].includes(b.payment_method)?b.payment_method:'cash'),'دفعة مسجلة لطلب خارجي');
  N.statusChanged({id:o.lastInsertRowid,customer_id:c.id,code},status);
  audit('order',code,'manual_created',`user:${q.user.id}`,{customer:c.id,channel,status});return {code,customer_created:fresh,existing_name:c.name};
 })()}catch(e){if(e.code==='CUSTOMER_EXISTS')return r.status(409).json({error:'customer_exists',message:'الرقم مسجل بالفعل؛ أكدي الاسم.',existing_name:e.existing_name});console.error('[manual order]',e.message);return bad(r,500,'لم يُحفظ الطلب؛ راجعي البيانات وحاولي مرة أخرى')}
 r.status(201).json(result);
});
router.patch('/:code/shipping',(q,r)=>{
 const o=get('SELECT id,code,manual_entry,status,governorate FROM orders WHERE code=?',q.params.code);
 if(!o||!o.manual_entry)return bad(r,404,'الأوردر الخارجي غير موجود');
 if(o.status==='cancelled')return bad(r,409,'لا يمكن تعديل شحن أوردر ملغي');
 const shipping=number(q.body.shipping_fee,1e8),gov=clean(q.body.governorate,80);
 if(shipping===null||gov===null||(!gov&&shipping>0))return bad(r,400,'حددي قيمة الشحن والمحافظة عند التوصيل');
 db.transaction(()=>{run('UPDATE orders SET delivery_fee=?,governorate=?,delivery_requested=?,shipping_quoted=1 WHERE id=?',shipping,gov||null,gov?1:0,o.id);audit('order',o.code,'manual_shipping_updated',`user:${q.user.id}`,{shipping})})();r.json({ok:true});
});
module.exports=router;
