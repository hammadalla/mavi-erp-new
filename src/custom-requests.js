'use strict';
/* Custom-design workflow. Photos live in SQLite, so normal database backup includes them. */
const express = require('express');
const {db,get,all,run,audit}=require('./db');
const A=require('./auth');
const D=require('./domain');
const N=require('./notifications');

const fail=(r,status,msg)=>r.status(status).json({message:msg});
function photo(data){
 if(typeof data!=='string'||data.length>2800000)return null;
 const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);if(!m)return null;
 const b=Buffer.from(m[2],'base64');if(!b.length||b.length>2*1024*1024)return null;
 let type=m[1];if(type==='jpeg' && !(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff))return null;
 if(type==='png' && b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return null;
 if(type==='webp' && !(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'))return null;
 return {data:b,type:'image/'+type};
}
function publicRow(r){return {id:r.id,date_needed:r.date_needed,details:r.details,created_at:r.created_at,status:r.status,price:r.price,deposit_percent:r.deposit_percent,shipping_fee:r.shipping_fee,governorate:r.governorate,fabric_choice:r.fabric_choice,requested_colour:r.requested_colour,requested_fabric:r.requested_fabric,deposit:r.price==null?null:Math.round((r.price+Number(r.shipping_fee||0))*r.deposit_percent)/100,advice:r.advice,payment_details:r.payment_details,payment_method:r.payment_method,has_receipt:!!r.has_receipt};}
const cols=`id,customer_id,date_needed,details,created_at,status,price,deposit_percent,advice,payment_details,payment_method,governorate,fabric_choice,shipping_fee,requested_colour,requested_fabric,(receipt IS NOT NULL) has_receipt`;
const store=express.Router(),admin=express.Router();
store.use(A.requireCustomer);
store.get('/',(q,r)=>r.json({requests:all(`SELECT ${cols} FROM custom_requests WHERE customer_id=? ORDER BY id DESC`,q.user.id).map(publicRow)}));
store.post('/',(q,r)=>{
 const pic=photo(q.body.image), details=String(q.body.details||'').trim(),date=String(q.body.date_needed||'').trim(), governorate=String(q.body.governorate||'').trim(), fabric=String(q.body.fabric_choice||'').trim(), colour=String(q.body.requested_colour||'').trim(), requestedFabric=String(q.body.requested_fabric||'').trim();
 if(colour.length>80||requestedFabric.length>80)return fail(r,400,'راجعي اللون ونوع الخامة');
 if(governorate.length<2||governorate.length>80||!['قماش العميلة','قماش MAVI'].includes(fabric))return fail(r,400,'حددي المحافظة ومصدر القماش');
 if(!pic)return fail(r,400,'اختاري صورة تصميم JPG أو PNG أو WebP لا تزيد عن ٢ ميجابايت');
 if(details.length>1000||date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))return fail(r,400,'راجعي التاريخ والتفاصيل');
 const m=get('SELECT waist,hip,bust,length,sleeve,arm FROM measurements WHERE customer_id=?',q.user.id)||{};
 const customer=get('SELECT name FROM customers WHERE id=?',q.user.id);
 if(!customer || !customer.name || customer.name.trim().length<3 || customer.name.trim()==='عميلة جديدة' || !['waist','hip','bust','length'].every(k=>Number(m[k])>=20 && Number(m[k])<=250)) return r.status(422).json({error:'measurements_required',message:'قبل إرسال التصميم، أكملي اسمك ومقاسات الصدر والوسط والهيب والطول في بياناتي.'});
 const x=run('INSERT INTO custom_requests(customer_id,date_needed,details,measurements,image,image_type,governorate,fabric_choice,requested_colour,requested_fabric) VALUES(?,?,?,?,?,?,?,?,?,?)',q.user.id,date||null,details,JSON.stringify(m),pic.data,pic.type,governorate,fabric,colour||null,requestedFabric||null);
 audit('custom_request',x.lastInsertRowid,'created',`customer:${q.user.id}`);
 r.status(201).json({id:Number(x.lastInsertRowid)});
});
store.post('/:id/images',(q,r)=>{
 const request=get('SELECT id,status FROM custom_requests WHERE id=? AND customer_id=?',q.params.id,q.user.id);
 if(!request)return fail(r,404,'الطلب غير موجود');
 if(request.status!=='review')return fail(r,409,'لا يمكن إضافة الصور بعد مراجعة الطلب');
 if(get('SELECT COUNT(*) n FROM custom_request_images WHERE request_id=?',request.id).n>=9)return fail(r,400,'الحد الأقصى عشر صور');
 const pic=photo(q.body.image);if(!pic)return fail(r,400,'اختاري صورة صحيحة حتى ٢ ميجابايت');
 const x=run('INSERT INTO custom_request_images(request_id,image,image_type) VALUES(?,?,?)',request.id,pic.data,pic.type);
 r.status(201).json({id:Number(x.lastInsertRowid)});
});
store.post('/:id/receipt',(q,r)=>{
 const item=get('SELECT id,status FROM custom_requests WHERE id=? AND customer_id=?',q.params.id,q.user.id);if(!item)return fail(r,404,'الطلب غير موجود');
 if(!['quoted','receipt_rejected'].includes(item.status))return fail(r,409,'الإيصال غير متاح في المرحلة الحالية');
 const pic=photo(q.body.image),method=String(q.body.method||'');if(!pic)return fail(r,400,'اختاري صورة إيصال واضحة لا تزيد عن ٢ ميجابايت');
 if(!['instapay','wallet'].includes(method))return fail(r,400,'اختاري طريقة الدفع');
 run("UPDATE custom_requests SET receipt=?,receipt_type=?,payment_method=?,status='receipt_pending' WHERE id=?",pic.data,pic.type,method,item.id);
 audit('custom_request',item.id,'receipt_submitted',`customer:${q.user.id}`);r.json({ok:true});
});
admin.use(A.requireOwner);
admin.get('/',(q,r)=>r.json({requests:all(`SELECT ${cols}, measurements FROM custom_requests ORDER BY id DESC`).map(x=>({...publicRow(x),image_ids:all('SELECT id FROM custom_request_images WHERE request_id=? ORDER BY id',x.id).map(i=>i.id),measurements:JSON.parse(x.measurements),customer:get('SELECT name,phone FROM customers WHERE id=?',x.customer_id)}))}));
admin.get('/:id/images/:image',(q,r)=>{const x=get('SELECT image,image_type FROM custom_request_images WHERE id=? AND request_id=?',q.params.image,q.params.id);if(!x)return r.sendStatus(404);r.set({'Content-Type':x.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(x.image)});
admin.get('/:id/:kind(design|receipt)',(q,r)=>{let x=get('SELECT image,image_type,receipt,receipt_type FROM custom_requests WHERE id=?',q.params.id);if(!x)return r.sendStatus(404);let data=q.params.kind==='design'?x.image:x.receipt, type=q.params.kind==='design'?x.image_type:x.receipt_type;if(!data)return r.sendStatus(404);r.set({'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(data)});
admin.post('/:id/quote',(q,r)=>{
 const x=get('SELECT id,customer_id,date_needed,status,price,deposit_percent,payment_method,shipping_fee,governorate,fabric_choice FROM custom_requests WHERE id=?',q.params.id);if(!x)return fail(r,404,'الطلب غير موجود');if(!['review','quoted','receipt_rejected'].includes(x.status))return fail(r,409,'لا يمكن تغيير العرض بعد رفع الإيصال');
 const price=Number(q.body.price),percent=Number(q.body.percent),shipping=Number(q.body.shipping_fee),advice=String(q.body.advice||'').trim(),payment=String(q.body.payment_details||'').trim();
 if(q.body.shipping_fee===''||q.body.shipping_fee==null||!Number.isFinite(shipping)||shipping<0||shipping>1e8||!Number.isFinite(price)||price<=0||price>1e8||!Number.isFinite(percent)||percent<=0||percent>100||advice.length>1000||payment.length<3||payment.length>500)return fail(r,400,'أدخلي السعر ونسبة العربون وبيانات الدفع');
 run("UPDATE custom_requests SET price=?,deposit_percent=?,advice=?,payment_details=?,shipping_fee=?,status='quoted',receipt=NULL,receipt_type=NULL,payment_method=NULL WHERE id=?",price,percent,advice,payment,shipping,x.id);
 audit('custom_request',x.id,'quoted',`user:${q.user.id}`,{price,percent});r.json({ok:true});
});
admin.post('/:id/decision',(q,r)=>{let x=get('SELECT id,customer_id,date_needed,status,price,deposit_percent,payment_method,shipping_fee,governorate,fabric_choice FROM custom_requests WHERE id=?',q.params.id);if(!x)return fail(r,404,'الطلب غير موجود');if(x.status!=='receipt_pending')return fail(r,409,'لا يوجد إيصال ينتظر المراجعة');if(!['approve','reject'].includes(q.body.decision))return fail(r,400,'اختاري التأكيد أو الرفض');let state=q.body.decision==='approve'?'approved':'receipt_rejected';
 db.transaction(()=>{
   if(state==='approved') {
     run("INSERT OR IGNORE INTO styles(id,name,type,price,cost,active) VALUES('CUSTOM-DESIGN','تصميم خاص','made',0,0,0)");
     const code=D.nextOrderCode();
     const o=run("INSERT INTO orders(code,customer_id,channel,status,promise_date,note,governorate,delivery_requested,shipping_quoted,delivery_fee,fabric_choice) VALUES(?,?,?,'confirmed',?,?,?,?,1,?,?)",code,x.customer_id,'online',x.date_needed,'طلب خاص رقم '+x.id,x.governorate,1,x.shipping_fee||0,x.fabric_choice);
     run("INSERT INTO order_items(order_id,style_id,qty,unit_price) VALUES(?,'CUSTOM-DESIGN',1,?)",o.lastInsertRowid,x.price);
     const amount=Math.round((x.price+Number(x.shipping_fee||0))*x.deposit_percent)/100;
     run("INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)",o.lastInsertRowid,amount,x.payment_method,'عربون طلب خاص مؤكد');
     run("INSERT INTO custom_order_links(request_id,order_id) VALUES(?,?)",x.id,o.lastInsertRowid);
     N.statusChanged({id:o.lastInsertRowid,customer_id:x.customer_id,code},'confirmed');
   }
   run("UPDATE custom_requests SET status=?, confirmed_at=CASE WHEN ?='approved' THEN datetime('now') ELSE NULL END WHERE id=?",state,state,x.id);
   audit('custom_request',x.id,state,`user:${q.user.id}`);
 })(); r.json({ok:true});});
module.exports={store,admin,photo};
