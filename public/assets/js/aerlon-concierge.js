(()=>{'use strict';
if(document.getElementById('aerlon-concierge'))return;
const launch=document.createElement('button');launch.id='ac-launch';launch.type='button';launch.setAttribute('aria-label','Open AERLON customer support');launch.textContent='✧';
const panel=document.createElement('section');panel.id='aerlon-concierge';panel.setAttribute('aria-label','AERLON customer support chatbot');
panel.innerHTML='<div class="ac-head"><div><strong>✧ AERLON Concierge</strong><small>Virtual assistance · Customer care</small></div><button type="button" id="ac-close" aria-label="Close chat">×</button></div><div class="ac-messages" id="ac-messages" role="log" aria-live="polite"></div><div class="ac-quick" id="ac-quick"></div><form class="ac-compose" id="ac-form"><input id="ac-input" maxlength="300" autocomplete="off" aria-label="Your message" placeholder="Ask us anything..."><button aria-label="Send message" type="submit">↑</button></form><div class="ac-foot">AERLON · Elevated Customer Care</div>';
document.body.append(launch,panel);
const messages=panel.querySelector('#ac-messages'),quick=panel.querySelector('#ac-quick'),input=panel.querySelector('#ac-input');
const topics={
'Returns & Refunds':'We understand that plans can change. Return or refund requests must be raised within 3 days of delivery and are subject to AERLON’s return policy and eligibility checks. For an existing request or a specific concern, our support team can assist you.',
'Delivery & Shipping':'You can check the latest recorded shipping status by selecting Track Order. Delivery dates depend on the destination and carrier; we will not promise an arrival date without confirmed tracking information.',
'Cancel an Order':'To request cancellation, please contact our customer care team with your order reference. Cancellation depends on the order’s current processing and shipping status. A request does not guarantee cancellation.',
'Payment Assistance':'If your payment failed or is pending, please check the payment status in Track Order before trying again. Avoid paying twice while an earlier transaction is being verified. Never share your card number, PIN or OTP here.',
'Product & Size Help':'For sizing, please open the product page and select Size Guide. Check the product description, colour, and available sizes before ordering. For specific stock questions, our agent can assist.',
'Account & Login':'To access your account, select the account or sign-in option on the storefront. If you cannot sign in, use the available password recovery option. Never share your password or OTP in chat.',
'Offers & Promotions':'Current prices and eligible promotions are shown on the AERLON storefront and at checkout. Please verify any offer before placing an order.',
'Contact Customer Agent':'If you need personalised assistance, we can direct you to the AERLON customer care team on WhatsApp.'
};
let state='menu',orderId='',waiting=false,requestSerial=0;
const phonePattern=/^\d{10}$/;
function bubble(message,user=false,agent=false){
 const el=document.createElement('div');el.className='ac-msg '+(user?'ac-user':'ac-bot');el.textContent=message;
 if(agent){const a=document.createElement('a');a.className='ac-agent-link';a.href='https://wa.me/919648629929?text='+encodeURIComponent('Hello AERLON Customer Care, I need assistance'+(orderId?' with order '+orderId:'')+'.');a.target='_blank';a.rel='noopener noreferrer';a.textContent='Continue with Customer Care ↗';el.appendChild(a)}
 messages.appendChild(el);messages.scrollTop=messages.scrollHeight;return el
}
function buttons(labels){quick.replaceChildren();labels.forEach(label=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',()=>send(label));quick.appendChild(b)})}
function menu(){state='menu';buttons(['Track Order','Delivery & Shipping','Returns & Refunds','Cancel an Order','Payment Assistance','Product & Size Help','Account & Login','Offers & Promotions','Step-by-Step Guide','Contact Customer Agent'])}
function followup(){state='followup';buttons(['Need More Help','Contact Customer Agent','Track Another Order','Main Menu'])}
function guide(){state='guide';bubble('HOW TO TRACK YOUR ORDER\n\n1. Select “Track Order” below.\n2. Enter the order ID from your order confirmation.\n3. Verify using the 10-digit phone number entered at checkout.\n4. Review the latest recorded order status, payment details and products.\n5. If you still need assistance, select “Need More Help” or “Contact Customer Agent”.\n\nFor your security, never share passwords, card details or OTPs.');buttons(['Track Order','Need More Help','Contact Customer Agent','Main Menu'])}
function agent(){state='agent';bubble('Our customer care team will be happy to assist you. Select the option below to continue the conversation on WhatsApp.',false,true);buttons(['Main Menu','Track Order','Step-by-Step Guide'])}
async function lookup(phone){
 waiting=true;buttons([]);const token=++requestSerial;const typing=bubble('We are securely checking your order details…');typing.classList.add('ac-typing');
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),25000);
 try{
  const response=await fetch('/api/orders/track?orderId='+encodeURIComponent(orderId)+'&phone='+encodeURIComponent(phone),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  const result=await response.json();if(!response.ok)throw Error(result.error||'We could not retrieve your order right now.');
  if(token!==requestSerial)return;
  const o=result.order||{},items=Array.isArray(o.items)?o.items:[],lines=['YOUR ORDER SUMMARY','Order reference: '+String(o.id||orderId),'Current status: '+String(o.orderStatus||'Not available').replaceAll('_',' '),'Payment status: '+String(o.paymentStatus||'Not available').replaceAll('_',' '),'Payment method: '+String(o.paymentMethod||'Not available'),'Order placed: '+(o.createdAt?new Date(o.createdAt).toLocaleString('en-IN'):'Not available')];
  if(items.length)lines.push('Products: '+items.map(item=>String(item.name||item.productName||'Product')+' × '+String(item.quantity||1)+([item.color,item.size].filter(Boolean).length?' — '+[item.color,item.size].filter(Boolean).join(' / '):'')).join('; '));
  if(Array.isArray(o.statusHistory)&&o.statusHistory.length)lines.push('Recent updates: '+o.statusHistory.slice(-4).map(h=>String(h.status||h.orderStatus||'Update')+(h.at||h.createdAt?' — '+new Date(h.at||h.createdAt).toLocaleDateString('en-IN'):'')).join('; '));
  typing.remove();bubble(lines.join('\n')+'\n\nIs there anything else we can help you with?');followup();
 }catch(error){if(token!==requestSerial)return;typing.remove();bubble(controller.signal.aborted?'Order tracking took too long. Please try again or contact customer care.':'We could not verify an order with those details. Please check your order reference and the phone number used at checkout. If the issue continues, our customer care team can help.');state='phone';buttons(['Try Again','Track Another Order','Step-by-Step Guide','Contact Customer Agent','Main Menu'])}
 finally{clearTimeout(timeout);if(token===requestSerial)waiting=false}
}
function send(value){
 const question=String(value||'').trim();if(!question||waiting)return;input.value='';bubble(question,true);const q=question.toLowerCase();
 if(q==='main menu'){menu();bubble('Of course. Please select how we can assist you.');return}
 if(q==='contact customer agent'||q==='agent support'||/^(human|agent|whatsapp|talk to (an? )?(human|agent))$/.test(q)){agent();return}
 if(q==='step-by-step guide'||q==='guide'){guide();return}
 if(q==='need more help'){state='help';bubble('We are here to help. You can review the step-by-step guide, choose another support topic, or contact our customer care team for personal assistance.');buttons(['Step-by-Step Guide','Contact Customer Agent','Main Menu']);return}
 if(q==='track order'||q==='track another order'||(state==='menu'&&/track (my |the )?order|where is my order/.test(q))){state='order';orderId='';bubble('Certainly. Please enter your AERLON order ID or order number, as shown in your confirmation message.');buttons(['Step-by-Step Guide','Contact Customer Agent','Main Menu']);return}
 if(q==='try again'){state='phone';bubble('Please re-enter the 10-digit mobile number used at checkout.');buttons(['Track Another Order','Contact Customer Agent','Main Menu']);return}
 if(Object.prototype.hasOwnProperty.call(topics,question)){bubble(topics[question]+'\n\nWould you like any further assistance?');followup();return}
 if(state==='order'){if(question.length>100){bubble('That order reference is too long. Please enter the reference shown in your order confirmation.');return}orderId=question;state='phone';bubble('Thank you. To protect your order information, please enter the 10-digit mobile number used when placing this order.');buttons(['Step-by-Step Guide','Contact Customer Agent','Main Menu']);return}
 if(state==='phone'){if(!phonePattern.test(question)){bubble('Please enter a valid 10-digit mobile number without spaces or the country code.');return}lookup(question);return}
 if(/refund|return|exchange/i.test(question)){bubble(topics['Returns & Refunds']);followup();return}
 if(/cancel/i.test(question)){bubble(topics['Cancel an Order']);followup();return}
 if(/payment|upi|transaction|charged/i.test(question)){bubble(topics['Payment Assistance']);followup();return}
 if(/size|fit|stock|product/i.test(question)){bubble(topics['Product & Size Help']);followup();return}
 if(/deliver|ship/i.test(question)){bubble(topics['Delivery & Shipping']);followup();return}
 if(/account|login|password/i.test(question)){bubble(topics['Account & Login']);followup();return}
 bubble('Thank you for reaching out. Please choose a support topic below so we can guide you to the right next step. For individual assistance, select “Contact Customer Agent”.');menu()
}
panel.querySelector('#ac-form').addEventListener('submit',e=>{e.preventDefault();send(input.value)});
launch.addEventListener('click',()=>{const open=panel.classList.toggle('ac-open');launch.setAttribute('aria-expanded',String(open));if(open)input.focus()});
panel.querySelector('#ac-close').addEventListener('click',()=>{panel.classList.remove('ac-open');launch.setAttribute('aria-expanded','false');launch.focus()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel.classList.contains('ac-open')){panel.classList.remove('ac-open');launch.focus()}});
bubble('Welcome to AERLON Customer Care. ✨\nWe are delighted to assist you. Please select an option below to get started.');
menu();
})();