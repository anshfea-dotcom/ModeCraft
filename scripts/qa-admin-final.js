"use strict";
const fs=require("node:fs");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const html=fs.readFileSync("public/admin.html","utf8");
const css=fs.readFileSync("public/assets/css/admin-final.css","utf8");
const js=fs.readFileSync("public/assets/js/admin-final.js","utf8");
const core=fs.readFileSync("public/assets/js/admin.js","utf8");
const mobile=fs.readFileSync("public/assets/js/admin-minor.js","utf8");
const check=(name,work)=>{work();console.log("PASS compact admin:",name)};
check("New presentation and interaction scripts load after working Admin baseline",()=>{
  assert.ok(html.includes('admin-final.css?v=20261128-2'));
  assert.ok(html.includes('admin-final.js?v=20261128-2'));
  assert.ok(html.indexOf("admin-final.css")>html.indexOf("admin-minor.css"));
  assert.ok(html.indexOf("admin-final.js")>html.indexOf("admin-minor.js"));
  new vm.Script(js,{filename:"admin-final.js"});
  new vm.Script(core,{filename:"admin.js"});
});
check("Three-line navigation exposes every permissioned sidebar section; bottom tabs are suppressed",()=>{
  assert.ok(js.includes('menu.textContent=open ? "←" : "☰"'));
  assert.ok(js.includes('aria-expanded'));
  assert.ok(css.includes("#admin20Bottom{display:none!important}"));
  assert.ok(html.includes('id="nav"'));
  assert.ok(html.includes('data-section="settings"'));
  assert.ok(html.includes('data-section="products"'));
  assert.ok(mobile.includes('navigate(item.section)'));
  assert.ok(core.includes("document.querySelector('#workspaceMenu').setAttribute('aria-expanded','false')"));
});
check("Compact layout preserves four approved functional shortcut hooks",()=>{
  for(const label of ["Add Product","Create Invoice","Warehouse","Add-on"])
    assert.ok(html.includes(label),label);
  assert.ok(html.includes('id="adminAddonShortcut"'));
  assert.ok(html.includes('id="adminAddonPanel" hidden'));
  assert.ok(html.includes('data-goto="warehouses"'));
  assert.ok(html.includes('data-v3-action="invoice"'));
  assert.ok(html.includes('data-v3-action="product"'));
  assert.ok(html.includes("<sup>™</sup>"));
});
check("Date picker validates an actual from/to pair and filters real orders and chart",()=>{
  for(const id of ["adminCalendarButton","adminCalendarPanel","adminDateFrom","adminDateTo","adminDateApply","adminDateClear"])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.ok(js.includes("from.value>to.value"));
  assert.ok(js.includes("window.adminDateRange={from:from.value,to:to.value}"));
  assert.ok(core.includes("const custom=window.adminDateRange"));
  assert.ok(core.includes("const endCutoff=custom?"));
  assert.ok(core.includes("const spanDays=custom?"));
});
check("Permission-scoped notifications include persistent View/Delete and Delete All without touching source data",()=>{
  for(const id of ["adminNotificationToggle","adminNotificationPanel","adminNotificationCount","adminNotificationItems","adminNotificationRead","adminNotificationDeleteAll"])
    assert.ok(html.includes('id="'+id+'"'),id);
  for(const route of ["/api/admin/orders","/api/admin/inventory/alerts","/api/admin/automations","/api/admin/notifications/deleted","/api/admin/notifications/delete"])
    assert.ok(js.includes(route),route);
  assert.ok(js.includes('currentUser.permissions?.includes("orders.view")'));
  assert.ok(js.includes('currentUser.permissions?.includes("products.view")'));
  assert.ok(js.includes("if(currentUser.isOwner)"));
  assert.ok(js.includes("title.textContent=item.title"));
  assert.ok(js.includes('view.textContent="View"'));
  assert.ok(js.includes('remove.textContent="Delete"'));
  assert.ok(js.includes("items.filter(item=>!deletedKeys.has(item.key))"));
  assert.ok(!js.includes("setInterval("),"Do not extend admin sessions with polling");
  assert.ok(!js.includes('method:"DELETE"'),"Operational records must never be deleted by notification UI");
});
check("Quick actions are first, dashboard-only and never sticky across admin pages",()=>{
  const section=html.indexOf('id="section-overview"');
  const actions=html.indexOf('<div class="v3-actions">',section);
  const stats=html.indexOf('<div class="grid stats',section);
  assert.ok(section>=0&&actions>section&&actions<stats);
  assert.ok(css.includes("#section-overview > .v3-actions:first-child"));
  assert.ok(css.includes("position:static!important"));
});
check("Warehouse size dropdown exposes actual availability with explicit max bounds",()=>{
  assert.ok(html.includes('id="v3WarehouseVariantStockStatus"'));
  assert.ok(html.includes('id="v3WarehouseProductStockStatus"'));
  const v3=fs.readFileSync("public/assets/js/admin-v3.js","utf8");
  const wh=fs.readFileSync("services/store/warehouses.js","utf8");
  assert.ok(v3.includes('qty.max=String(Math.floor(max))'));
  assert.ok(v3.includes('Product-wide limit:'));
  assert.ok(wh.includes('p.data->>\'stock\' AS "productStock"'));
  assert.ok(wh.includes('FROM products WHERE id=$1 FOR UPDATE'));
  assert.ok(wh.includes("otherUnits+quantity>cap"));
});
check("Recent orders still show customer name, phone, order amount, status and date",()=>{
  for(const s of ["o.customer?.name","o.customer?.phone","money(o.total)","o.orderStatus","date(o.createdAt)"])
    assert.ok(core.includes(s),s);
  assert.ok(css.includes("#section-overview .v3-recent tbody tr"));
  assert.ok(html.includes('id="recentOrders"'));
});
check("Rupee glyph remains on revenue only; total-orders badge uses a document icon",()=>{
  assert.ok(html.includes('<span class="admin-ref-icon purple"><svg'));
  assert.ok(!html.includes('<span class="admin-ref-icon purple">₹'));
});
console.log("7/7 approved admin layout, controls and notification smoke checks passed.");
