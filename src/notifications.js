'use strict';
const {run}=require('./db');
const descriptions={new:'وصلنا طلبك',confirmed:'تم تأكيد طلبك',cut:'بدأ قص القماش',sewing:'قطعتك في مرحلة الخياطة',ready:'قطعتك جاهزة',delivered:'تم تسليم طلبك',cancelled:'تم إلغاء طلبك'};
function statusChanged(order,status){
  const message=`طلبك ${order.code}: ${descriptions[status]||'تم تحديث الحالة'}.`;
  run('INSERT INTO customer_notifications(customer_id,order_id,status,message) VALUES(?,?,?,?)',order.customer_id,order.id,status,message);
}
module.exports={statusChanged};
