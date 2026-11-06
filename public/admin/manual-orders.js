async function openManualOrder(){try{
 await loadStyles();
 const options=CACHE.styles.filter(s=>s.type==='made'&&s.active&&s.id!=='CUSTOM-DESIGN').map(s=>`<option value="${safeCustom(s.id)}">${safeCustom(s.name)}</option>`).join('');
 const select=(id,label,opts)=>`<label class="inv-field">${label}<select id="${id}">${opts}</select></label>`;
 const measurements=[['bust','الصدر'],['waist','الوسط'],['hip','الهيب'],['length','الطول'],['sleeve','الكم'],['arm','الذراع']].map(([k,n])=>inputInv('mo-'+k,n+' · سم','','number','min="20" max="250" step="1"')).join('');
 showInventoryModal('إضافة أوردر خارجي','للطلبات القادمة من واتساب أو فيسبوك أو أي مصدر آخر.',
 inputInv('mo-name','اسم العميلة · مطلوب','','text','required maxlength="100"')+inputInv('mo-phone','رقم موبايل العميلة · مطلوب','','tel','required maxlength="11" inputmode="numeric"')+
 inputInv('mo-gov','المحافظة · اختياري','','text','maxlength="80"')+inputInv('mo-area','المنطقة والعنوان · اختياري','','text','maxlength="200"')+
 select('mo-channel','مصدر الطلب','<option value="whatsapp">واتساب</option><option value="facebook">فيسبوك</option><option value="instagram">إنستغرام</option><option value="walkin">من المكان</option><option value="other">أخرى</option>')+
 select('mo-style','الموديل من الكتالوج','<option value="">تصميم خاص خارج الكتالوج</option>'+options)+
 inputInv('mo-custom','وصف التصميم الخاص إذا لم تختاري موديلًا','','text','maxlength="100"',true)+
 inputInv('mo-colour','اللون · اختياري')+inputInv('mo-fabric','الخامة أو قماش العميلة · اختياري')+
 inputInv('mo-qty','عدد القطع · مطلوب','1','number','required min="1" max="20" step="1"')+inputInv('mo-price','سعر القطعة · مطلوب','','number','required min="0" step="0.01"')+
 inputInv('mo-shipping','الشحن · اختياري','','number','min="0" step="0.01"')+inputInv('mo-paid','المبلغ المستلم فعليًا · اختياري','','number','min="0" step="0.01"')+
 select('mo-method','طريقة الدفع','<option value="cash">نقدًا</option><option value="instapay">إنستاباي</option><option value="wallet">محفظة موبايل</option><option value="other">أخرى</option>')+
 select('mo-status','الحالة حسب متابعتك','<option value="new">جديد</option><option value="confirmed">مؤكد</option><option value="cut">قص القماش</option><option value="sewing">في الخياطة</option><option value="ready">جاهز</option><option value="delivered">تم التسليم</option>')+
 inputInv('mo-date','موعد التسليم المتوقع · اختياري','','date')+inputInv('mo-note','تفاصيل وملاحظات · اختياري','','text','maxlength="1000"',true)+
 `<div class="inv-form-note">المقاسات اختيارية، وتُحفظ في ملف العميلة الجديدة فقط. إذا كان رقمها مسجلًا سيُطلب تأكيد اسمها وتُستخدم بياناتها ومقاساتها الحالية دون تغيير. العميلة الجديدة تحتاج تعيين كلمة مرور قبل دخول حسابها. يمكنكِ اختيار الورشة والخامة من تفاصيل الأوردر بعد الحفظ. الحالة والمدفوع يحددان يدويًا؛ لا يُثبت البرنامج استلام الأموال تلقائيًا.</div>`+measurements,
 `<button class="btn primary" id="manual-save" onclick="saveManualOrder()">حفظ الأوردر الخارجي</button>`);
 }catch(e){toast(e.message)}}
async function saveManualOrder(){const btn=$('manual-save');btn.disabled=true;try{
 const val=id=>$(id).value, measurements={};for(const k of ['bust','waist','hip','length','sleeve','arm'])measurements[k]=val('mo-'+k);
 const body={customer_name:val('mo-name'),customer_phone:val('mo-phone'),governorate:val('mo-gov'),area:val('mo-area'),channel:val('mo-channel'),style_id:val('mo-style'),custom_name:val('mo-custom'),colour:val('mo-colour'),fabric_choice:val('mo-fabric'),qty:val('mo-qty'),unit_price:val('mo-price'),shipping_fee:val('mo-shipping'),paid:val('mo-paid'),payment_method:val('mo-method'),status:val('mo-status'),promise_date:val('mo-date'),note:val('mo-note'),measurements};
 let result;try{result=await api('/manual-orders',{method:'POST',body})}catch(e){if(e.data?.error!=='customer_exists')throw e;if(!confirm('الرقم مسجل باسم '+e.data.existing_name+'؛ هل هذه نفس العميلة؟ سيتم استخدام بياناتها ومقاساتها الحالية.')){btn.disabled=false;return}result=await api('/manual-orders',{method:'POST',body:{...body,confirm_existing:true}})}closeModal();toast(result.customer_created?'تم حفظ الأوردر وملف عميلة جديدة':'تم حفظ الأوردر للعميلة المسجلة: '+result.existing_name);openOrder(result.code);
 }catch(e){invError(e);btn.disabled=false}}

async function saveManualShipping(code){try{await api('/manual-orders/'+encodeURIComponent(code)+'/shipping',{method:'PATCH',body:{shipping_fee:$('manual-shipping').value,governorate:$('manual-gov').value}});toast('تم تحديث الشحن');render()}catch(e){toast(e.message)}}
