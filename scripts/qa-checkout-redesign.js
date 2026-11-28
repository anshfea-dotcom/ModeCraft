"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const html=fs.readFileSync("public/index.html","utf8");
const css=fs.readFileSync("public/assets/css/checkout.css","utf8");
const client=fs.readFileSync("public/assets/js/checkout.js","utf8");
const store=fs.readFileSync("public/assets/js/storefront.js","utf8");
const start=html.indexOf('<div class="modal checkout-modal"');
const end=html.indexOf('<div class="modal" id="accountModal"');
assert.ok(start>=0&&end>start,"Checkout modal must remain intact");
const checkout=html.slice(start,end);
function check(name,run){run();console.log("PASS checkout: "+name);}
check("existing delivery, payment, coupon and order IDs are preserved",()=>{
 const originalIds=["checkout","orderForm","deliveryFields","name","phone","pin","city","state","house","address","landmark","addressType","email","locateAddress","enterPin","addressMessage","paymentStep","couponPanel","couponInput","applyCouponBtn","removeCoupon","payment","reviewStep","addressReview","paymentReview","checkoutSubtotal","checkoutGrandTotal","checkoutItems","checkoutNext","checkoutBack","placeOrder"];
 for(const id of originalIds){
  const regex=new RegExp('\\bid="'+id+'"','g');
  assert.equal((checkout.match(regex)||[]).length,1,"Missing or duplicate #"+id);
 }
 assert.ok(checkout.includes('form="orderForm" type="submit" id="placeOrder"'));
 assert.ok(checkout.includes('name="paymentChoice" value="COD" checked'));
 assert.ok(checkout.includes('name="paymentChoice" value="ONLINE"'));
});
check("three accessible stages and edit controls",()=>{
 assert.equal((checkout.match(/class="checkout-step-num"/g)||[]).length,3);
 for(const id of ["checkoutStageHeading","checkoutStageDetail","checkoutDockTotal","editCheckoutAddress","editCheckoutPayment","checkoutGrandLabel"]){
  assert.equal((checkout.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
 }
 assert.ok(checkout.includes('aria-current="step"'));
 assert.ok(client.includes("field('editCheckoutAddress').onclick"));
 assert.ok(client.includes("field('editCheckoutPayment').onclick"));
 assert.ok(client.includes("dialog.querySelector('.checkout-order-summary').hidden = false"));
});
check("desktop/mobile/dark layouts and keyboard focus",()=>{
 for(const token of ['checkout-shell-top','checkout-lead','checkout-action-total','checkout-step-num','checkout-order-summary']){
  assert.ok(css.includes(token),"Missing "+token+" style");
 }
 assert.ok(css.includes('@media(max-width:700px)')&&css.includes('@media(max-width:430px)'));
 assert.ok(css.includes('body.dark #checkout'));
 assert.ok(css.includes('prefers-reduced-motion'));
 assert.ok(css.includes(':focus-visible'));
});
check("checkout API and retry protections remain wired",()=>{
 for(const token of ['/api/orders/cod','/api/payments/razorpay/order','/api/payments/razorpay/verify','checkoutAttempt(method, body)','body.expectedTotal','button.disabled = true']){
  assert.ok(client.includes(token),"Missing "+token);
 }
 assert.ok(store.includes('function payload()'));
 assert.ok(store.includes('function updateCheckoutSummary()'));
 assert.ok(store.includes('dock.textContent=money(finalTotal)'));
 assert.ok(client.includes("dialog.querySelector('.checkout-order-summary').hidden = false"));
 new vm.Script(client,{filename:"public/assets/js/checkout.js"});
 new vm.Script(store,{filename:"public/assets/js/storefront.js"});
});
console.log("4/4 AERLON checkout redesign regression checks passed.");
