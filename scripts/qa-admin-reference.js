"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const html=fs.readFileSync("public/admin.html","utf8");
const js=fs.readFileSync("public/assets/js/admin-reference.js","utf8");
const css=fs.readFileSync("public/assets/css/admin-reference.css","utf8");
const old=fs.readFileSync("public/assets/js/admin.js","utf8");
const orders=fs.readFileSync("services/store/orders.js","utf8");
const inventory=fs.readFileSync("services/store/inventory.js","utf8");
const automation=fs.readFileSync("services/store/advanced-automations.js","utf8");
let passed=0;
function test(label,fn){fn();passed++;console.log("PASS reference "+passed+": "+label);}
test("AERLON admin classic scripts parse",()=>{
 for(const name of ["admin","admin-v3","admin-advanced","admin-reference"]){
  const content=fs.readFileSync("public/assets/js/"+name+".js","utf8");
  new vm.Script(content,{filename:name+".js"});
 }
});
test("Reference assets load exactly once",()=>{
 assert.equal((html.match(/href="\/admin-reference\.css\?v=20261128-4"/g)||[]).length,1);
 assert.equal((html.match(/src="\/admin-reference\.js\?v=20261128-4"/g)||[]).length,1);
 assert.ok(html.indexOf("/admin-reference.js")>html.indexOf("/admin-advanced.js"));
});
test("Original functional dashboard and admin IDs remain intact",()=>{
 for(const id of ["app","nav","workspaceMenu","loginForm","logout","pageTitle","ordersBody","productsGrid","recentOrders","chart","v3LowStock","v3PendingOrders","v3UnpaidOrders","v3IssueInvoiceForm","v3POSForm","section-giftcards","section-seo"]){
  assert.equal((html.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1,id);
 }
});
test("Live API-backed search with permission checks",()=>{
 for(const path of ["/api/admin/orders","/api/admin/products","/api/admin/customers"])
   assert.ok(js.includes(path));
 assert.ok(js.includes('hasAccess("customers.view")'));
 assert.ok(js.includes('hasAccess("products.view")'));
 assert.ok(js.includes('hasAccess("orders.view")'));
 assert.ok(js.includes('CSS.escape('));
});
test("Notification data and persisted acknowledgment use real APIs",()=>{
 for(const path of ["/api/admin/inventory/alerts","/api/admin/automations","/api/admin/automations/alerts/"])
   assert.ok(js.includes(path));
 assert.ok(inventory.includes('app.get("/api/admin/inventory/alerts"'));
 assert.ok(automation.includes('app.patch("/api/admin/automations/alerts/:id"'));
 assert.ok(orders.includes('"/api/admin/orders"'));
 assert.ok(js.includes("Promise.allSettled(jobs)"));
 assert.ok(!js.includes("₹12,48,320"),"Do not inject reference demo numbers");
});
test("Dashboard analytics derive from actual paid orders",()=>{
 assert.ok(js.includes('order.paymentStatus!=="paid"'));
 assert.ok(js.includes("new Set(selected.map("));
 assert.ok(js.includes("Top Selling Products"));
 assert.ok(js.includes("No paid product sales"));
});
test("Desktop, laptop and mobile designs have explicit breakpoints",()=>{
 assert.ok(css.includes("max-width:1040px"));
 assert.ok(css.includes("max-width:700px"));
 assert.ok(css.includes("max-width:385px"));
 for(const x of [".ae-commandbar",".ae-notifications",".ae-bottom-grid",".ae-sidebar-collapsed",".ae-search-results"])
  assert.ok(css.includes(x));
});
test("Light/dark theme and clean mobile menu",()=>{
 assert.ok(css.includes(':root[data-theme="dark"]'));
 assert.ok(old.includes("||'light';document.documentElement.dataset.theme=storedTheme"));
 assert.ok(js.includes('el("workspaceMenu")'));
});
test("Manual invoice and Wallet coming-soon rules unchanged",()=>{
 assert.ok(html.includes("Issue invoice manually"));
 assert.ok(html.includes("Wallet & Rewards · Coming Soon"));
 const core=fs.readFileSync("services/store/invoices.js","utf8");
 assert.ok(core.includes("/api/admin/invoices"));
});
test("User-generated data is inserted using textContent instead of HTML",()=>{
 for(const x of ['title.textContent=item.title','desc.textContent=notification.body','name.textContent=product?.name||item.name'])
  assert.ok(js.includes(x));
});
console.log(passed+"/10 reference command centre checks passed.");
