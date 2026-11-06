'use strict';
// Explicit destructive operations; owner password, impact preview, one transaction.
const express=require('express'), {db,get,all,run,audit}=require('./db'), A=require('./auth');
const router=express.Router();router.use(A.requireOwner);
const fail=(r,n,m)=>r.status(n).json({message:m});
function orderImpact(id){let o=get('SELECT id,code FROM orders WHERE id=?',id);if(!o)return null;return {name:o.code,orders:1,payments:get('SELECT count(*) n FROM payments WHERE order_id=?',id).n,custom:get('SELECT count(*) n FROM custom_order_links WHERE order_id=?',id).n};}
function impact(type,id){
 if(type==='order')return orderImpact(id);
 if(type==='customer'){let c=get('SELECT id,name FROM customers WHERE id=?',id);if(!c)return null;return {name:c.name,orders:get('SELECT count(*) n FROM orders WHERE customer_id=?',id).n,custom:get('SELECT count(*) n FROM custom_requests WHERE customer_id=?',id).n,payments:get('SELECT count(*) n FROM payments p JOIN orders o ON p.order_id=o.id WHERE o.customer_id=?',id).n};}
 if(type==='custom'){let x=get('SELECT id FROM custom_requests WHERE id=?',id);if(!x)return null;let o=get('SELECT order_id FROM custom_order_links WHERE request_id=?',id);return {name:'طلب تصميم خاص #'+id,orders:o?1:0,custom:1,payments:o?get('SELECT count(*) n FROM payments WHERE order_id=?',o.order_id).n:0};}
 if(type==='style'){let x=get('SELECT id,name FROM styles WHERE id=?',id);if(!x||id==='CUSTOM-DESIGN')return null;let links=get('SELECT count(DISTINCT order_id) n FROM order_items WHERE style_id=?',id).n;let stock=get('SELECT count(*) n FROM stock_items WHERE style_id=?',id).n;return {name:x.name,blocked:links||stock,reason:'الموديل مرتبط بطلبات أو سجلات مخزون قديمة؛ احذفي السجلات المرتبطة أولًا أو اخفي الموديل بدلًا من حذفه.',orders:links};}
 if(type==='fabric'||type==='tailor'){const table=type==='fabric'?'fabric':'tailors',col=type==='fabric'?'fabric_id':'tailor_id',x=get(`SELECT id,name FROM ${table} WHERE id=?`,id);if(!x)return null;let n=get(`SELECT count(DISTINCT order_id) n FROM order_items WHERE ${col}=?`,id).n;return {name:x.name,blocked:n,reason:'الخامة أو الورشة مرتبطة بطلبات؛ احذفي الطلبات المرتبطة أولًا.',orders:n};}
 if(type==='expense'){let x=get('SELECT id,category FROM expenses WHERE id=?',id);return x?{name:x.category}:null;}
 if(type==='payment'){let x=get('SELECT p.id,p.note,o.code FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=?',id);return x?{name:'دفعة الطلب '+x.code,payments:1,blocked:['عربون مؤكد','عربون طلب خاص مؤكد'].includes(x.note),reason:'دفعة العربون مرتبطة بتأكيد الطلب ولا يمكن حذفها منفردة. احذفي الطلب كاملًا إن لزم، بعد مراجعة الدفعات.'}:null;}
 return null;
}
function deleteOrder(id){const code=get('SELECT code FROM orders WHERE id=?',id)?.code;require('./domain').rememberOrderCode(code);const linked=all('SELECT request_id FROM custom_order_links WHERE order_id=?',id);run('DELETE FROM stock_reservations WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?)',id);run('DELETE FROM custom_order_links WHERE order_id=?',id);for(const x of linked)run('DELETE FROM custom_requests WHERE id=?',x.request_id);run('DELETE FROM orders WHERE id=?',id);}
function remove(type,id){
 if(type==='order')return deleteOrder(id);
 if(type==='custom'){let link=get('SELECT order_id FROM custom_order_links WHERE request_id=?',id);if(link)deleteOrder(link.order_id);else run('DELETE FROM custom_requests WHERE id=?',id);return;}
 if(type==='customer'){let c=get('SELECT phone FROM customers WHERE id=?',id);for(const o of all('SELECT id FROM orders WHERE customer_id=?',id))deleteOrder(o.id);run('DELETE FROM custom_requests WHERE customer_id=?',id);run("DELETE FROM sessions WHERE realm='store' AND subject_id=?",id);run('DELETE FROM otp_codes WHERE phone=?',c.phone);run('DELETE FROM customers WHERE id=?',id);return;}
 if(type==='style')return run('DELETE FROM styles WHERE id=?',id);
 if(type==='fabric')return run('DELETE FROM fabric WHERE id=?',id);
 if(type==='tailor')return run('DELETE FROM tailors WHERE id=?',id);
 if(type==='expense')return run('DELETE FROM expenses WHERE id=?',id);
 if(type==='payment')return run('DELETE FROM payments WHERE id=?',id);
}
router.get('/:type/:id',(q,r)=>{const x=impact(q.params.type,q.params.id);if(!x)return fail(r,404,'السجل غير موجود أو لا يمكن حذفه');r.json(x)});
router.post('/:type/:id',(q,r)=>{
 const email=q.user.email,pass=String(q.body.password||'');if(A.adminThrottled(email))return fail(r,429,'محاولات كثيرة، انتظري قبل إعادة المحاولة');
 const u=get('SELECT password_hash FROM users WHERE id=? AND active=1',q.user.id);if(!u||!A.verifyPassword(pass,u.password_hash)){A.adminFailure(email);return fail(r,403,'كلمة مرور المالكة غير صحيحة')}A.adminClear(email);
 if(q.body.confirmation!=='حذف نهائي')return fail(r,400,'اكتبي حذف نهائي للتأكيد');
 try{let result;db.transaction(()=>{result=impact(q.params.type,q.params.id);if(!result){const e=Error('السجل غير موجود');e.status=404;throw e}if(result.blocked){const e=Error(result.reason);e.status=409;throw e}remove(q.params.type,q.params.id);audit('deletion',q.params.type,'permanent_delete',`user:${q.user.id}`,{id:q.params.id,orders:result.orders||0,payments:result.payments||0,custom:result.custom||0})})();r.json({ok:true})}catch(e){return fail(r,e.status||500,e.status?e.message:'تعذر الحذف؛ راجعي السجلات المرتبطة')}
});
module.exports=router;
