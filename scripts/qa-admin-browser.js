"use strict";
/* Admin mobile and desktop visual/interaction smoke with mock APIs; no production changes. */
const assert=require("node:assert/strict");
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const {chromium}=require("playwright");
const root=path.resolve(__dirname,"../public");
const types={".html":"text/html",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg"};
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
 if(pathname.startsWith("/api/")){
   const reply=data=>{res.writeHead(200,{"Content-Type":"application/json","X-Session-Remaining-Ms":"3600000"});res.end(JSON.stringify(data));};
   if(pathname==="/api/admin/me")return reply({authenticated:true,isOwner:true,username:"admin-qa",displayName:"Admin QA",role:"owner",permissions:["orders.view","orders.update","products.view","products.manage","customers.view","analytics.view","audit.view","invoices.issue"]});
   if(pathname==="/api/admin/notifications/deleted")return reply({deletedKeys:[]});
   if(pathname==="/api/admin/orders")return reply({orders:[{id:"QA-001",orderStatus:"processing",paymentStatus:"pending",createdAt:"2026-11-28T12:00:00Z",total:999,customer:{name:"Example Customer",phone:"9999999999",email:"qa@example.test"}}]});
   if(pathname==="/api/admin/inventory/alerts")return reply({alerts:[{id:"stock-1",productId:"test-product",productName:"Sample Shirt",quantity:2,color:"Black",size:"M"}]});
   if(pathname==="/api/admin/automations")return reply({alerts:[]});
   if(pathname==="/api/admin/products")return reply({products:[]});
   if(pathname==="/api/admin/inventory")return reply({products:[],inventory:[],items:[]});
   return reply({products:[],orders:[],alerts:[],data:[],items:[],banners:[],warehouses:[]});
 }
 let file=pathname==="/" ? path.join(root,"admin.html") : path.resolve(root,"."+pathname);
 if(!file.startsWith(root+path.sep)&&file!==path.join(root,"admin.html")){res.writeHead(403);res.end();return;}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){
   const name=pathname.replace(/^[/]+/, "");
   file=["assets/js","assets/css","assets/images"].map(d=>path.join(root,d,name)).find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
 }
 if(!file){res.writeHead(404);res.end();return;}
 res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream"});
 fs.createReadStream(file).pipe(res);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+server.address().port+"/admin.html";
 let browser;
 try{
   browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
   for(const width of [320,390,768,1366]){
     const mobile=width<=768;
     const context=await browser.newContext({viewport:{width,height:844},isMobile:mobile,hasTouch:mobile,reducedMotion:"reduce"});
     const page=await context.newPage(),errors=[];
     page.on("pageerror",e=>errors.push(e.message));
     await page.goto(base,{waitUntil:"domcontentloaded"});
     await page.locator("#app:not(.hidden)").waitFor({timeout:15000});
     const bell=page.locator("#adminNotificationToggle");
     await bell.click();
     await page.waitForFunction(()=>document.getElementById("adminNotificationPanel").hidden===false);
     const info=await page.evaluate(()=>{
       const panel=document.getElementById("adminNotificationPanel");
       const rect=panel.getBoundingClientRect();
       const top=Math.max(0,rect.top), bottom=Math.min(innerHeight,rect.bottom);
       const hit=document.elementFromPoint(rect.left+Math.min(rect.width/2,80),Math.min(bottom-10,top+50));
       return {width:innerWidth,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,visibleArea:bottom-top,hitInside:panel.contains(hit),expanded:document.getElementById("adminNotificationToggle").getAttribute("aria-expanded")};
     });
     assert.equal(info.expanded,"true","Bell should expand on "+width+"px");
     assert.ok(info.left>=0&&info.right<=info.width+2&&info.visibleArea>50&&info.hitInside,
       "Notification panel must be visible, in viewport and tappable: "+JSON.stringify(info));
     await page.locator("#adminNotificationItems").getByText(/Order QA-001|Payment needs attention|Low stock/).first().waitFor({timeout:12000});
     await page.locator("#adminNotificationRefresh").click();
     await page.locator("#adminNotificationItems").getByText(/Order QA-001|Payment needs attention|Low stock/).first().waitFor({timeout:12000});
     if(mobile&&width<=700){
       await page.locator("#workspaceMenu").click();
       await page.locator("#adminNavBack").waitFor({state:"visible"});
       assert.equal(await page.locator("#workspaceMenu").getAttribute("aria-label"),"Close navigation menu");
       const headings=await page.locator("#nav .nav-group h2").allTextContents();
       assert.ok(headings.includes("Commerce")&&headings.includes("Catalogue"));
       assert.ok(await page.locator('#nav button[data-section="orders"] .ico svg').isVisible());
       await page.locator('#nav button[data-section="orders"]').click();
       assert.equal((await page.locator("#pageTitle").innerText()).trim(),"Orders");
       await page.locator("#workspaceMenu").click();
       const back=page.locator("#adminNavBack");
       assert.ok(await back.isVisible());
       const geometry=await back.boundingBox();
       assert.ok(geometry && geometry.x<width/2,"Dashboard back action should be left aligned");
       await back.click();
       assert.equal((await page.locator("#pageTitle").innerText()).trim(),"Store overview");
       assert.equal(await page.locator("#workspaceMenu").getAttribute("aria-expanded"),"false");
     }
     assert.deepEqual(errors,[],"Browser runtime errors at "+width+"px");
     await context.close();
     console.log("PASS admin browser: bell, refresh, visibility, menu and dashboard navigation at "+width+"px");
   }
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error("Admin browser QA failed:",error.stack||error);process.exitCode=1;});
