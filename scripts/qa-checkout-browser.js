"use strict";
/* Browser smoke runs against a local mock server. Never places real orders. */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const http=require("node:http");
const {chromium}=require("playwright");
const root=path.resolve(__dirname,"../public");
const data={signedIn:false,addresses:[],orders:[],gifts:[]};
const giftCode="AGC-"+("A".repeat(24));
async function checkSequence(page){
 const result=await page.evaluate(()=>{
  const root=document.getElementById("checkout");
  const ids=[
    root.querySelector(".checkout-order-summary"),
    document.getElementById("deliveryFields"),
    document.getElementById("couponPanel"),
    document.getElementById("paymentStep"),
    document.getElementById("placeOrder")
  ];
  const flow=ids.every((el,index)=>!!el&&(!index||!!(ids[index-1].compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)));
  const layout=getComputedStyle(root.querySelector(".checkout-layout"));
  const box=root.querySelector(".checkout-box");
  const orderSummary=ids[0].getBoundingClientRect(),address=ids[1].getBoundingClientRect();
  return {flow,display:layout.display,direction:layout.flexDirection,
   verticalSummaryBeforeAddress:orderSummary.top<address.top,
   boxWidth:box.getBoundingClientRect().width,viewport:innerWidth,
   horizontalOverflow:box.scrollWidth>box.clientWidth+2};
 });
 assert.ok(result.flow,"DOM sequence: order summary, address, coupon, payment, place order");
 assert.equal(result.display,"flex");
 assert.equal(result.direction,"column");
 assert.ok(result.verticalSummaryBeforeAddress,"Order summary must be visually before address");
 assert.ok(result.boxWidth<=result.viewport+2,"Checkout must not overflow the device: "+JSON.stringify(result));
 assert.equal(result.horizontalOverflow,false,"Checkout should scroll vertically without sideways overflow");
}
async function checkCheckoutAboveHeader(page){
 const result=await page.evaluate(()=>{
   const checkout=document.getElementById('checkout');
   const header=document.getElementById('storeHeader');
   const close=document.getElementById('closeCheckout');
   const headerRect=header.getBoundingClientRect();
   const closeRect=close.getBoundingClientRect();
   const at=(rect)=>document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
   return {
     modalTop:checkout.getBoundingClientRect().top,
     modalZ:Number(getComputedStyle(checkout).zIndex),
     headerZ:Number(getComputedStyle(header).zIndex),
     headerCovered:checkout.contains(at(headerRect)),
     closeTouchable:close===at(closeRect)||close.contains(at(closeRect)),
     pageLocked:getComputedStyle(document.body).overflow==='hidden'
   };
 });
 assert.ok(result.modalTop>=-1 && result.modalTop<=1,"Checkout must start at viewport top: "+JSON.stringify(result));
 assert.ok(result.modalZ>result.headerZ,"Checkout must layer above the sticky storefront header: "+JSON.stringify(result));
 assert.ok(result.headerCovered,"Storefront search/header must not cover checkout: "+JSON.stringify(result));
 assert.ok(result.closeTouchable,"Checkout close control must be tappable: "+JSON.stringify(result));
 assert.ok(result.pageLocked,"Background document must not scroll behind checkout");
}
const product={
 id:"qa-shirt",name:"AERLON Test Shirt",category:"Shirts",active:true,price:1000,stock:20,
 colors:["Black"],sizesByColor:{Black:["M","L"]},
 image:"/favicon.png",images:["/favicon.png"],
 inventoryVariants:[{color:"Black",size:"M",quantity:10},{color:"Black",size:"L",quantity:10}]
};
const types={".html":"text/html",".js":"application/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".webp":"image/webp",".json":"application/json",".woff2":"font/woff2"};
function reply(res,code,body){
 res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store"});
 res.end(JSON.stringify(body));
}
async function body(req){let str="";for await(const piece of req)str+=piece;if(!str)return{};try{return JSON.parse(str)}catch{return{}}}
const server=http.createServer(async(req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);
 if(pathname.startsWith("/api/")){
   const input=await body(req);
   if(pathname==="/api/products")return reply(res,200,{products:[product]});
   if(pathname==="/api/config")return reply(res,200,{razorpayEnabled:false});
   if(pathname==="/api/auth/me")return reply(res,200,{authenticated:data.signedIn,user:data.signedIn?{id:"test-customer",name:"QA Buyer",email:"buyer@example.test",phone:"9876543210"}:null});
   if(pathname==="/api/customer/addresses"&&req.method==="GET")return reply(res,data.signedIn?200:401,data.signedIn?{addresses:data.addresses}:{error:"Sign in"});
   if(pathname==="/api/customer/addresses"&&req.method==="POST"){
     if(!data.signedIn)return reply(res,401,{error:"Sign in"});
     const saved={...input,id:input.id||"123e4567-e89b-12d3-a456-426614174001"};
     data.addresses=[saved,...data.addresses.filter(a=>a.id!==saved.id)];
     return reply(res,201,{ok:true,address:saved});
   }
   if(pathname==="/api/checkout/address/pin")return reply(res,200,{city:"Varanasi",state:"Uttar Pradesh"});
   if(pathname==="/api/checkout/address/location")return reply(res,200,{pin:"221001",city:"Varanasi",state:"Uttar Pradesh",address:""});
   if(pathname==="/api/coupons/validate")return reply(res,200,{ok:true,code:input.couponCode||"SAVE10",discount:100,subtotal:1000,total:900,message:"Coupon applied"});
   if(pathname==="/api/gift-cards/check")return reply(res,200,{ok:true,balance:2000,currency:"INR",checkoutRedemptionEnabled:true});
   if(pathname==="/api/orders/cod"||pathname==="/api/orders/gift"){
     if(pathname==="/api/orders/gift")data.gifts.push(input);
     else data.orders.push(input);
     return reply(res,201,{ok:true,orderId:"TEST-"+(data.orders.length+data.gifts.length),message:"Order placed."});
   }
   return reply(res,200,{ok:true,products:[],orders:[],reviews:[],summary:{},banners:[],settings:{},items:[]});
 }
 let file=pathname==="/"?path.join(root,"index.html"):path.resolve(root,"."+pathname);
 if(!file.startsWith(root+path.sep)&&file!==path.join(root,"index.html")){res.writeHead(403);res.end();return;}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){
   const name=pathname.replace(/^\/+/,"");
   const choices=["assets/js","assets/css","assets/images"].map(d=>path.join(root,d,name));
   file=choices.find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());
 }
 if(!file){res.writeHead(404);res.end("Not found");return;}
 res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream"});
 fs.createReadStream(file).pipe(res);
});
const fill=async(page)=>{
 await page.locator("#name").fill("QA Buyer");
 await page.locator("#phone").fill("9876543210");
 await page.locator("#pin").fill("221001");
 await page.locator("#city").fill("Varanasi");
 await page.locator("#state").fill("Uttar Pradesh");
 await page.locator("#house").fill("24B");
 await page.locator("#address").fill("Station Road");
 await page.locator("#email").fill("buyer@example.test");
};
async function openCheckout(page,url){
 await page.goto(url,{waitUntil:"domcontentloaded"});
 await page.locator("#products .product-card-clickable").first().waitFor({timeout:30000});
 await page.locator("#products .product-card-clickable").first().click();
 await page.locator("#detailAdd").waitFor({state:"visible"});
 assert.equal(await page.locator("#detailSize").inputValue(),"","Size must never be preselected");
 await page.locator("#detailAdd").click();
 await page.locator("#detailSizeWarning").waitFor({state:"visible"});
 assert.match(await page.locator("#detailSizeWarning").innerText(),/select your size/i);
 const color=page.locator("#detailColourSwatches button").first();
 if(await color.count())await color.click();
 await page.locator("#detailSizeOptions .size-option").filter({hasText:"M"}).first().click();
 await page.locator("#detailBuyNow").click();
 await page.locator("#checkout").waitFor({state:"visible"});
 assert.equal(await page.locator("#checkoutNext").count(),0);
 assert.equal(await page.locator("#reviewStep").count(),0);
 assert.equal(await page.locator("[data-payment]").count(),2);
 await page.locator("#placeOrder").waitFor({state:"visible"});
}
(async()=>{
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const url="http://127.0.0.1:"+server.address().port+"/";
 let browser;
 try{
   browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
      geolocation:{latitude:25.3176,longitude:82.9739},permissions:["geolocation"],reducedMotion:"reduce"});
   const page=await context.newPage(),errors=[];
   page.on("pageerror",err=>errors.push(err.message));
   await page.addInitScript(()=>sessionStorage.setItem("aerlon-puzzle-entry-v1","1"));
   await openCheckout(page,url);
   assert.equal(await page.locator("#checkout .checkout-box").isVisible(),true);
   await checkSequence(page);
   await checkCheckoutAboveHeader(page);
   const initialAction=await page.locator("#placeOrder").evaluate(el=>{
     const r=el.getBoundingClientRect();
     return {top:r.top,bottom:r.bottom,viewport:innerHeight,position:getComputedStyle(el.closest('.checkout-action')).position};
   });
   assert.equal(initialAction.position,'static',"Mobile actions should remain docked outside the scrollable form");
   assert.ok(initialAction.top>=-1 && initialAction.bottom<=initialAction.viewport+2,"Place Order must fit above mobile browser controls: "+JSON.stringify(initialAction));
   assert.equal(await page.locator("#checkoutContinueShopping").isVisible(),true);
   // Each device receives a fresh viewport: resizing one mobile emulation
   // retains its original device screen width and yields misleading 100vw geometry.
   for(const width of [320,360,430,768]){
     const device=await browser.newContext({viewport:{width,height:760},isMobile:true,hasTouch:true,reducedMotion:"reduce"});
     const mobile=await device.newPage();
     await mobile.addInitScript(()=>sessionStorage.setItem("aerlon-puzzle-entry-v1","1"));
     await openCheckout(mobile,url);
     await checkSequence(mobile);
     await checkCheckoutAboveHeader(mobile);
     const buttonBox=await mobile.locator('#placeOrder').boundingBox();
     const backBox=await mobile.locator('#checkoutContinueShopping').boundingBox();
     assert.ok(buttonBox&&buttonBox.y>=-1&&buttonBox.y+buttonBox.height<=762,
       'Place Order must be on-screen at '+width+'px');
     assert.ok(backBox&&backBox.y>=-1&&backBox.y+backBox.height<=762,
       'Back to Shopping must be on-screen at '+width+'px');
     await device.close();
   }
   await page.locator("#checkoutContinueShopping").click();
   assert.equal(await page.locator("#checkout").isVisible(),false,"Back to Shopping must exit checkout");
   await page.locator("#bagBtn").click();
   await page.locator("#checkoutBtn").click();
   assert.equal(await page.locator("#checkout .checkout-box").isVisible(),true,"Return to shopping must preserve cart for reopening checkout");
   await page.locator('[data-checkout-quantity][data-delta="1"]').first().click();
   assert.equal((await page.locator(".checkout-quantity-value").first().innerText()).trim(),"2");
   assert.ok((await page.locator("#checkoutGrandTotal").innerText()).includes("2,000"));
   await page.locator('[data-checkout-quantity][data-delta="-1"]').first().click();
   assert.equal((await page.locator(".checkout-quantity-value").first().innerText()).trim(),"1");
   await page.evaluate(()=>{add('qa-shirt','Black','M');renderCheckoutItems();updateCheckoutSummary();});
   assert.equal(await page.locator('#checkout .checkout-line-item').count(),1,"Same product, size and colour must consolidate into one summary row");
   assert.equal((await page.locator('.checkout-quantity-value').first().innerText()).trim(),'2',"Adding same variant again must show quantity 2");
   assert.equal((await page.locator('#checkoutItemCount').innerText()).trim(),'2 items');
   assert.ok((await page.locator('#checkoutGrandTotal').innerText()).includes('2,000'));
   await page.locator('[data-checkout-quantity][data-delta="-1"]').first().click();
   assert.equal((await page.locator('.checkout-quantity-value').first().innerText()).trim(),'1');
   assert.equal(await page.locator('#checkout .checkout-address-heading').isVisible(),true);
   assert.equal(await page.locator('#checkoutAddAddress').isVisible(),true);
   await page.locator("#placeOrder").click();
   await page.locator("#checkoutError").waitFor({state:"visible"});
   assert.match(await page.locator("#checkoutError").innerText(),/address|delivery/i);
   await page.locator("#checkoutSaveAddress").click();
   assert.match(await page.locator("#checkoutAddressSaveMessage").innerText(),/sign in/i);
   await page.locator("#locateAddress").click();
   await page.locator('#addressMessage[data-state="success"]').waitFor({timeout:18000});
   assert.match(await page.locator("#addressMessage").innerText(),/fetched successfully/i);
   await fill(page);
   await page.locator("#couponPanel > summary").click();
   await page.locator("#couponInput").fill("SAVE10");
   await page.locator("#applyCouponBtn").click();
   await page.waitForFunction(()=>document.querySelector("#checkoutGrandTotal").textContent.includes("900"));
   assert.equal(await page.locator("#couponPanel").getAttribute("open"),"");
   await page.locator("#placeOrder").click();
   await page.locator("#orderSuccessModal.show").waitFor({timeout:10000});
   assert.equal(data.orders.length,1);
   assert.equal(data.orders[0].items[0].size,"M");
   assert.equal(data.orders[0].customer.postalCode,"221001");
   console.log("PASS browser/mobile: explicit size choice, invalid-address warning, geolocation success and real COD submit path");

   await openCheckout(page,url);
   await fill(page);
   await page.locator('[data-payment="GIFT"]').click();
   await page.locator("#checkoutGiftDetails").waitFor({state:"visible"});
   await page.locator("#checkoutGiftCode").fill(giftCode);
   await page.locator("#checkoutCheckGift").click();
   await page.waitForFunction(()=>document.querySelector("#checkoutGiftMessage").textContent.includes("covers the total"));
   await page.locator("#placeOrder").click();
   await page.locator("#orderSuccessModal.show").waitFor({timeout:10000});
   assert.equal(data.gifts.length,1);
   assert.equal(data.gifts[0].giftCode,giftCode);
   assert.equal(data.gifts[0].items[0].size,"M");
   console.log("PASS browser/mobile: Gift Code validation, payment selection and checkout submit path");

   data.signedIn=true;
   await openCheckout(page,url);
   await page.locator("#checkoutAddressSaveMessage").getByText(/account|address/i).waitFor({timeout:8000}).catch(()=>{});
   await fill(page);
   await page.locator("#checkoutSaveAddress").click();
   await page.waitForFunction(()=>document.querySelectorAll("#checkoutSavedAddresses .checkout-saved-address").length>0);
   assert.equal(data.addresses.length,1);
   await page.locator("#checkoutAddAddress").click();
   assert.equal(await page.locator("#checkoutAddressFields").isVisible(),true);
   assert.equal(await page.locator("#house").inputValue(),"");
   await page.locator('[data-address-type="Work"]').click();
   assert.equal(await page.locator("#addressType").inputValue(),"Work");
   assert.equal(await page.locator('[data-address-type="Work"]').getAttribute('aria-pressed'),'true');
   console.log("PASS browser/mobile: save account address and add-new-address selection");

   const desktop=await browser.newContext({viewport:{width:1366,height:820},reducedMotion:"reduce"});
   const dp=await desktop.newPage();
   await dp.addInitScript(()=>sessionStorage.setItem("aerlon-puzzle-entry-v1","1"));
   await openCheckout(dp,url);
   await checkSequence(dp);
   await checkCheckoutAboveHeader(dp);
   assert.equal(await dp.locator("#placeOrder").isVisible(),true);
   assert.equal(await dp.locator("#checkoutContinueShopping").isVisible(),true);
   assert.equal(await dp.locator('[data-checkout-quantity][data-delta="1"]').count(),1);
   assert.equal(await dp.locator("[data-payment]").count(),2);
   assert.ok(await dp.locator(".payment-icon-cod svg").isVisible());
   assert.ok(await dp.locator(".payment-icon-gift svg").isVisible());
   console.log("PASS browser/desktop: exact five-part order, genuine payment icons, accessible Place Order");
   assert.deepEqual(errors,[],"Unexpected browser runtime errors");
   await desktop.close();await context.close();
   console.log("4/4 AERLON checkout Chromium browser smoke scenarios passed.");
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error("Checkout browser QA failed:",e.stack||e);process.exitCode=1;});
