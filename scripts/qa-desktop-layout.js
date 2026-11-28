"use strict";
const fs=require("node:fs"),assert=require("node:assert/strict");
const files={
  admin:fs.readFileSync("public/assets/css/admin-v3.css","utf8"),
  adminBase:fs.readFileSync("public/assets/css/admin-workspace.css","utf8"),
  store:fs.readFileSync("public/assets/css/storefront.css","utf8"),
  adminHTML:fs.readFileSync("public/admin.html","utf8"),
  storeHTML:fs.readFileSync("public/index.html","utf8")
};
const check=(label,fn)=>{fn();console.log("PASS desktop: "+label);};
check("admin workspace respects fixed desktop sidebar width",()=>{
  assert.ok(files.adminBase.includes(".main {width:auto;min-width:0}"));
  assert.ok(files.admin.includes(".app > .main"));
  assert.ok(files.admin.includes("max-width: none"));
  assert.ok(files.admin.includes("overflow-x: auto"));
});
check("admin laptop title/actions and long partner links cannot force overflow",()=>{
  assert.ok(files.admin.includes("(max-width: 1240px)"));
  assert.ok(files.admin.includes(".main .topbar { flex-wrap: wrap"));
  assert.ok(files.admin.includes(".v3-taxonomy-list small { overflow-wrap: anywhere"));
  for(const id of ["pageTitle","nav","section-orders","section-products","section-giftcards","section-affiliates","section-seo"]){
    assert.ok(files.adminHTML.includes('id="'+id+'"'),"Missing admin UI "+id);
  }
});
check("desktop storefront search and actions have shrink-safe grid rules",()=>{
  assert.ok(files.store.includes("(min-width: 721px)"));
  assert.ok(files.store.includes("(max-width: 1100px)"));
  assert.ok(files.store.includes(".nav .aerlon-header-search-field { min-width: 0; }"));
  assert.ok(files.store.includes(".nav .navactions { display: flex; align-items: center; flex-wrap: nowrap"));
  assert.ok(files.storeHTML.includes('id="checkout"'));
  assert.ok(files.storeHTML.includes('id="shop"'));
});
console.log("3/3 AERLON desktop layout source regression checks passed.");
