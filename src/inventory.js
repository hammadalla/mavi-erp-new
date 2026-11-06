'use strict';
const {get,all,run,audit}=require('./db');
function reserve(orderId,actor){
 const items=all(`SELECT i.* FROM order_items i JOIN styles s ON s.id=i.style_id WHERE i.order_id=? AND s.type='stock'`,orderId);
 for(const i of items){
  if(get('SELECT 1 yes FROM stock_reservations WHERE order_item_id=?',i.id))throw new Error('تمت معالجة مخزون هذا الطلب من قبل');
  const variants=all('SELECT * FROM stock_items WHERE style_id=? AND size=? AND colour=?',i.style_id,i.size,i.colour);
  if(variants.length!==1)throw new Error('المقاس واللون غير متاحين في المخزون؛ راجعي الطلب قبل تأكيد العربون');
  const v=variants[0];const upd=run('UPDATE stock_items SET qty=qty-? WHERE id=? AND qty>=?',i.qty,v.id,i.qty);
  if(!upd.changes)throw new Error('الكمية المتاحة لا تكفي؛ لم يتم تأكيد العربون أو خصم المخزون');
  run('INSERT INTO stock_reservations(order_item_id,stock_id,qty) VALUES(?,?,?)',i.id,v.id,i.qty);
  run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',v.id,-i.qty,'تأكيد عربون الطلب',actor);
  audit('stock',v.id,'reserved',actor,{orderId,qty:i.qty});
 }
}
function release(orderId,actor){
 const rows=all(`SELECT r.* FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0`,orderId);
 for(const r of rows){run('UPDATE stock_items SET qty=qty+? WHERE id=?',r.qty,r.stock_id);run('UPDATE stock_reservations SET released=1 WHERE order_item_id=?',r.order_item_id);run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',r.stock_id,r.qty,'إلغاء الطلب قبل التسليم',actor);audit('stock',r.stock_id,'released',actor,{orderId,qty:r.qty})}
}
module.exports={reserve,release};
