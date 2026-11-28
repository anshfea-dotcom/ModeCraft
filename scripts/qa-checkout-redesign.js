"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const html=fs.readFileSync("public/index.html","utf8");
const baseCss=fs.readFileSync("public/assets/css/checkout.css","utf8");
const css=fs.readFileSync("public/assets/css/checkout-onepage.css","utf8");
const client=fs.readFileSync("public/assets/js/checkout.js","utf8");
const store=fs.readFileSync("public/assets/js/storefront.js","utf8");
const start=html.indexOf('<div class="modal checkout-modal"');
const end=html.indexOf('<div class="modal" id="accountModal"',start);
assert.ok(start>=0&&end>start,"Checkout modal must remain intact");
const checkout=html.slice(start,end);
const check=(title,fn)=>{fn();console.log("PASS checkout:",title);};
check("one-page order form has exactly one real Place Order button and no three-stage blockers",()=>{
  for(const id of ["checkout","orderForm","deliveryFields","paymentStep","name","phone","pin","city","state","house","address","landmark","addressType","email","checkoutGiftDetails","checkoutGiftCode","checkoutCheckGift","checkoutGiftMessage","couponPanel","couponInput","applyCouponBtn","removeCoupon","checkoutItems","checkoutSubtotal","checkoutGrandTotal","placeOrder","checkoutError"]){
    assert.equal((checkout.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1,"Missing/duplicate "+id);
  }
  assert.equal((checkout.match(/id="placeOrder"/g)||[]).length,1);
  assert.ok(checkout.includes('type="submit" class="btn" form="orderForm" id="placeOrder"'));
  for(const id of ["checkoutNext","checkoutBack","reviewStep","checkoutStageHeading","editCheckoutPayment","editCheckoutAddress"]){
    assert.ok(!checkout.includes('id="'+id+'"'),"Remove legacy step "+id);
  }
  assert.ok(!checkout.includes("checkout-steps")&&!checkout.includes("STEP 01"));
  const positions=['checkout-order-summary','id="deliveryFields"','id="couponPanel"','id="paymentStep"','id="placeOrder"'].map(marker=>checkout.indexOf(marker));
  assert.ok(positions.every((value,index)=>value>=0 && (!index || value>positions[index-1])),"Checkout must follow Summary > Address > Coupon > Payment > Place Order in the DOM");
  assert.ok(checkout.indexOf('class="checkout-layout"')<checkout.indexOf('checkout-order-summary'));
  assert.ok(checkout.indexOf('checkout-order-summary')<checkout.indexOf('class="checkout-main"'));
  assert.ok(!checkout.slice(checkout.indexOf('id="paymentStep"'),checkout.indexOf('id="checkoutGiftDetails"')).includes('id="couponPanel"'));

});
check("only Cash on Delivery and fully-funded Gift Code appear to new customers",()=>{
  for(const marker of ['id="checkoutContinueShopping"','id="checkoutAddressFields"','id="addressType"','data-address-type="Home"','data-address-type="Work"','data-address-type="Other"']){
    assert.ok(checkout.includes(marker),"Missing checkout control "+marker);
  }
  assert.ok(checkout.includes('AERLON<sup>™</sup>'));
  assert.ok(checkout.includes('name="paymentChoice" value="COD" checked'));
  assert.ok(checkout.includes('name="paymentChoice" value="GIFT"'));
  assert.ok(!checkout.includes('value="ONLINE"'));
  assert.ok(!checkout.includes('data-payment="ONLINE"'));
  assert.ok(checkout.includes('class="payment-icon payment-icon-cod"'));
  assert.ok(checkout.includes('class="payment-icon payment-icon-gift"'));
  assert.ok(checkout.includes('<svg viewBox="0 0 32 32"'));
  assert.ok(css.includes('#checkout .payment-icon-cod{background:#E9F9EF'));
  assert.ok(css.includes('#checkout .payment-icon-gift{background:#FFF3E7'));

  assert.ok(client.includes('"/api/orders/gift"')||client.includes("'/api/orders/gift'"));
  assert.ok(client.includes('"/api/orders/cod"')||client.includes("'/api/orders/cod'"));
  assert.ok(client.includes("aerlonCheckoutValidate"));
});
check("saved addresses are account-backed and editable with new-address and save controls",()=>{
  for(const id of ["checkoutAddAddress","checkoutSaveAddress","checkoutSavedAddresses","checkoutAddressSaveMessage"]){
    assert.ok(checkout.includes('id="'+id+'"'),id);
  }
  for(const token of ["/api/customer/addresses","/api/auth/me","addressData()","loadAddresses()","persistAddress(","account?.id"]){
    assert.ok(client.includes(token),token);
  }
  assert.ok(!client.includes('localStorage.setItem("checkout'));
  const backend=fs.readFileSync("services/store/customer-addresses.js","utf8");
  assert.ok(backend.includes('WHERE customer_id=$1'));
  assert.ok(backend.includes('AND customer_id=$2'));
});
check("location lookup surfaces loading, success and errors without revealing provider/geo-sequence details",()=>{
  for(const token of ['locationStatus(\'loading\'','locationStatus(\'success\'','locationStatus(\'error\'',"'locateAddress'","'enterPin'"]){
    assert.ok(client.includes(token),token);
  }
  assert.ok(!checkout.includes("bharatlas"));
  assert.ok(!checkout.includes("GeoNames"));
  assert.ok(!checkout.includes("LGD"));
  assert.ok(css.includes("#checkout #addressMessage[data-state=\"loading\"]"));
  assert.ok(css.includes("#checkout #addressMessage[data-state=\"success\"]"));
  assert.ok(css.includes("#checkout #addressMessage[data-state=\"error\"]"));
});
check("coupon is compact, real amount and live gift verification are wired",()=>{
  assert.ok(checkout.includes('class="checkout-compact-coupon"'));
  assert.ok(checkout.includes('class="coupon-entry"'));
  assert.ok(client.includes("'/api/gift-cards/check'"));
  assert.ok(store.includes('function updateCheckoutSummary()'));
  assert.ok(store.includes("$('#checkoutGrandTotal')")||store.includes('$("#checkoutGrandTotal")'));
});
check("size selection is mandatory and gives visible red warning",()=>{
  assert.ok(html.includes('id="detailSizeWarning" role="alert"'));
  assert.ok(store.includes('function requireProductSize()'));
  assert.ok(!store.includes('if(firstAvailable){const button='));
  assert.ok(store.includes('checkout-item-warning'));
  assert.ok(store.includes('fix.dataset.fixVariant')||client.includes('button.dataset.fixVariant'));
  assert.ok(css.includes("#detailSizeOptions.needs-size-selection"));
  assert.ok(css.includes("#detailSizeWarning"));
});
check("responsive themes, syntax and retry/idempotency safeguards remain valid",()=>{
  assert.ok(html.includes('checkout-onepage.css?v=20261128-6'));
  assert.ok(html.includes('checkout.js?v=20261128-3'));
  assert.ok(css.includes('flex-direction:column!important'));
  assert.ok(css.includes('position:static!important'));
  assert.ok(css.includes('@media(max-width:540px)'));
  assert.ok(css.includes('#checkout .checkout-location-message[data-state="loading"]::before'));

  assert.ok(css.includes("@media(max-width:430px)"));
  assert.ok(css.includes("position:sticky!important;bottom:0!important"));
  assert.ok(css.includes("z-index:1200!important"),"Checkout must eclipse storefront header");
  assert.ok(css.includes("body:has(#checkout.show){overflow:hidden;}"),"Background must lock during checkout");
  assert.ok(css.includes("env(safe-area-inset-bottom)"));
  assert.ok(css.includes(".checkout-quantity"));
  assert.ok(store.includes("function renderCheckoutItems()"));
  assert.ok(store.includes("minus.dataset.checkoutQuantity"));
  assert.ok(store.includes("plus.dataset.checkoutQuantity"));
  assert.ok(client.includes("by('checkoutContinueShopping')"));
  assert.ok(checkout.includes('class="checkout-address-heading"'),"Approved delivery address heading must remain");
  assert.ok(checkout.includes('id="checkoutSaveAddress"'),"Save Address must remain reachable");
  assert.ok(checkout.indexOf('id="checkoutAddressFields"')<checkout.indexOf('id="locateAddress"'),"Address and type choices must come before location controls");
  assert.ok(checkout.includes('checkout-back-icon'),"Premium return-to-shopping icon must remain");
  assert.ok(css.includes('Approved AERLON third checkout concept'),"Restored card styling must remain");
  assert.ok(css.includes('#checkout .checkout-address-radio'),"Saved address radio selection must remain");
  assert.ok(css.includes('#checkout .checkout-place-arrow'),"Checkout CTA arrow must remain");
  assert.ok(store.includes('if(i)i.quantity++'),"Two identical variants must aggregate quantities");
  assert.ok(client.includes("setAddressFieldsOpen(edit)"));
  assert.ok(css.includes("body.dark #checkout"));
  assert.ok(css.includes("prefers-reduced-motion"));
  assert.ok(baseCss.includes("#checkout .checkout-action"));
  for(const token of ["checkoutAttempt(method,body)","body.expectedTotal","button.disabled=true","endCheckoutAttempt()"]){
    assert.ok(client.includes(token),token);
  }
  new vm.Script(client,{filename:"checkout.js"});
  new vm.Script(store,{filename:"storefront.js"});
});
console.log("7/7 AERLON single-page checkout regression checks passed.");
