"use strict";
const fs=require("node:fs"),assert=require("node:assert/strict"),vm=require("node:vm");
const html=fs.readFileSync("public/admin.html","utf8");
const css=fs.readFileSync("public/assets/css/admin-minor.css","utf8");
const js=fs.readFileSync("public/assets/js/admin-minor.js","utf8");
const core=fs.readFileSync("public/assets/js/admin.js","utf8");
const warehouse=fs.readFileSync("services/store/warehouses.js","utf8");
let passed=0;
function check(description,fn){fn();console.log("PASS admin UX:",description);passed++;}
check("Admin scripts are valid JavaScript",()=>{
 for(const filename of ["admin.js","admin-v3.js","admin-advanced.js","admin-minor.js"])new vm.Script(fs.readFileSync("public/assets/js/"+filename,"utf8"),{filename});
});
check("Minor UX stylesheet and script are loaded after existing Admin 3.0",()=>{
 assert.ok(html.indexOf('admin-minor.css?v=20261128-5')>html.indexOf('admin-v3.css?v=20261128-3'));
 assert.ok(html.indexOf('admin-minor.js?v=20261128-6')>html.indexOf('admin-advanced.js?v=20261128-3'));
});
check("Product cards are compact full-width rows and existing controls are preserved",()=>{
 assert.ok(css.includes("grid-template-columns:minmax(0,1fr)!important"));
 assert.ok(css.includes("#section-products .productcard"));
 assert.ok(css.includes("#section-products .productbuttons"));
 for(const control of ["moveProductUp","moveProductDown","editProduct","toggleProduct","deleteProduct","dragProductHandle"])assert.ok(core.includes(control),control);
 assert.ok(core.includes('data-product-id='), "Product row data-id missing");
});
check("Mobile brand is centred between accessible dots menu and search",()=>{
 assert.ok(html.includes('id="workspaceMenu" type="button"'));
 assert.ok(html.includes('title="Workspace menu">⋯</button>'));
 assert.ok(html.includes('id="adminSearchToggle"'));
 assert.ok(html.indexOf('id="adminSearchToggle"')<html.indexOf('id="workspaceMenu"'));
 assert.ok(html.indexOf('id="workspaceMenu"')<html.indexOf('id="nav"'));
 assert.ok(css.includes("grid-template-columns:44px minmax(0,1fr) 44px"));
 assert.ok(css.includes(".app>.sidebar>.brand"));
 assert.ok(css.includes(".app>.sidebar>#workspaceMenu"));
 assert.ok(css.includes(".app>.sidebar>#adminSearchToggle"));
 assert.ok(js.includes("menu.click()"));
});
check("Search is functional and permission-scoped",()=>{
 for(const x of ['has("products.view")','has("orders.view")','products','allOrders','navigate(item.section)','renderOrders()'])assert.ok(js.includes(x),x);
 assert.ok(js.includes("title.textContent=item.name"),"Search results must escape untrusted names");
 assert.ok(js.includes("node.classList.contains"));
 assert.ok(html.includes('id="adminMobileLogout"'));
});
check("Warehouse quick-add preserves absolute assignment API and performs additive calculation",()=>{
 for(const id of ["v3WarehouseStockForm","v3WarehouseId","v3WarehouseVariantId","v3WarehouseExtraUnits","v3WarehouseQuickAdd","v3WarehouseQuickMessage"])
   assert.ok(html.includes('id="'+id+'"'),id);
 assert.ok(js.includes("const next=current+delta"));
 assert.ok(js.includes('method:"PUT"'));
 assert.ok(js.includes('"/api/admin/warehouses/stock"'));
 assert.ok(js.includes('await Promise.all(['));
 assert.ok(warehouse.includes('assigned.rows[0].n'));
 assert.ok(warehouse.includes("cannot exceed central stock"));
 assert.ok(css.includes("#section-warehouses.active>article.card:nth-of-type(3){order:0}"));
});
check("No new endpoint, auto invoice or central stock mutation introduced",()=>{
 assert.ok(!js.includes('"/api/admin/inventory/:id"'));
 assert.ok(!js.includes("/api/admin/invoices"));
 assert.ok(html.includes("No invoice is generated when an order arrives."));
 assert.ok(html.includes("Wallet & Rewards · Coming Soon"));
});
console.log(passed+"/7 Admin 3.0 focused UX regression checks passed.");
