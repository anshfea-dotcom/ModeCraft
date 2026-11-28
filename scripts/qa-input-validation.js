"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { entries, matchRoute, webhook } = require("../services/store/input-schemas");
const { validateInput, validateCookies } = require("../services/store/validate-input");

// Fail CI when a route is registered without an explicit schema. No fallback
// "catch-all valid object" schema is permitted.
function routesIn(file) {
  const source = fs.readFileSync(path.join(__dirname,"..",file),"utf8");
  const found=[];
  const expression=/\bapp\.(get|post|patch|put|delete|head)\s*\(\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(expression)) {
    if (m[2].startsWith("/api/") || m[2].startsWith("/r/") ||
        m[2].startsWith("/storefront-images/") || m[2]==="/health") {
      found.push([m[1].toUpperCase(),m[2]]);
    }
  }
  return found;
}
function inventory() {
  const root = path.join(__dirname,"../services/store");
  const sources = ["server.js","services/media/routes.js","services/media/server.js",
    "services/catalogue/server.js",
    ...fs.readdirSync(root).filter(f=>f.endsWith(".js"))
      .map(f=>"services/store/"+f)];
  let total=0;
  for(const source of sources)for(const [method,route] of routesIn(source)){
    const illustrative = route.replace(/:[A-Za-z_]+/g,"42");
    assert.ok(matchRoute(method,illustrative),source+" lacks schema for "+method+" "+route);
    total++;
  }
  // Two routes in media/routes.js are declared with a variable adminPath;
  // static source matching alone would miss these.
  assert.ok(matchRoute("PUT","/api/admin/storefront/images/hero"));
  assert.ok(matchRoute("DELETE","/api/admin/storefront/images/hero"));
  assert.ok(total >= 112,"Endpoint inventory unexpectedly reduced: "+total);
  const keys=entries.map(x=>x.method+" "+x.route);
  assert.equal(new Set(keys).size,keys.length,"Duplicate route schemas are not permitted");
  return total+2;
}
function request(method,route,body={},query={},cookie="") {
  const headers = { "content-type":"application/json" };
  if(body!==undefined && !["GET","HEAD"].includes(method))headers["content-length"]="100";
  if(cookie)headers.cookie=cookie;
  return {
    method,path:route,query,body,headers,
    get(name){return headers[name.toLowerCase()];},
    is(type){return type==="application/json" && headers["content-type"]==="application/json";}
  };
}
function validate(req) {
  let passed=false;let result;
  const res = {
    statusCode:200,headers:{},
    set(k,v){this.headers[k.toLowerCase()]=v;return this;},
    status(v){this.statusCode=v;return this;},
    json(v){result={status:this.statusCode,body:v,headers:this.headers};return this;}
  };
  validateInput(req,res,()=>{passed=true;});
  return {passed,...result,body:req.body};
}
function allowed(req) {
  const result=validate(req);
  assert.equal(result.passed,true,"Unexpected error: "+JSON.stringify(result));
}
function denied(req) {
  const result=validate(req);
  assert.equal(result.passed,false,"Invalid request unexpectedly allowed: "+req.path);
  assert.equal(result.status,400,"Invalid data did not yield HTTP 400");
  assert.equal(result.headers["cache-control"],"no-store");
}
const total=inventory();
assert.equal(matchRoute("GET","/api/admin/orders").entry.query.safeParse({includeArchived:"true"}).success,true);
assert.equal(matchRoute("GET","/api/admin/orders").entry.query.safeParse({unapproved:"x"}).success,false);
assert.equal(matchRoute("POST","/API/AUTH/LOGIN/").entry.body.safeParse({email:"abc@example.com",password:"a"}).success,true);
assert.equal(matchRoute("POST","/api/admin/products/reorder").entry.route,"/api/admin/products/reorder");

allowed(request("POST","/api/auth/login",{email:"person@example.com",password:"SecurePassword"}));
denied(request("POST","/api/auth/login",{email:"person@example.com",password:"x",role:"admin"}));
denied(request("POST","/api/auth/login",{email:"bad",password:"x"}));
denied(request("POST","/api/auth/signup",{name:"New Customer",email:"a@example.com",phone:"9876543210",password:"password12",isPaid:true}));
denied(request("POST","/api/auth/reset-password",{token:"x",password:"password12"}));
denied(request("POST","/api/auth/forgot-password",{email:"bad-email"}));
allowed(request("POST","/api/auth/activity",{}));
allowed(request("GET","/api/admin/orders",{}, {includeArchived:"false"}));
denied(request("GET","/api/orders/track",{}, {orderId:"MC-123",phone:"123",isOwner:"true"}));
denied(request("GET","/api/products",{}, {debug:"true"}));

const item={id:"mc-prod-123",quantity:1,color:"Blue",size:"M"};
const customer={name:"Customer",email:"a@example.com",phone:"9876543210",
  postalCode:"221001",city:"Varanasi",state:"Uttar Pradesh",house:"22",
  address:"Main Road",landmark:"",addressType:"Home"};
const order={items:[item],couponCode:"",customer,
  attemptId:"81d2b997-e552-4434-952f-2383e7eb4060",expectedTotal:999};
allowed(request("POST","/api/orders/cod",order));
denied(request("POST","/api/orders/cod",{...order,isPaid:true}));
denied(request("POST","/api/orders/cod",{...order,items:[{...item,price:1}]}));
denied(request("POST","/api/orders/cod",{...order,customer:{...customer,role:"admin"}}));
denied(request("POST","/api/orders/cod",{...order,customer:{...customer,name:"<img src=x onerror=alert(1)>"}}));

allowed(request("POST","/api/admin/products",{
  name:"Check Shirt",category:"Shirts",price:999,stock:10,colors:["Navy"],
  sizesByColor:{Navy:["M","L"]},stockGrid:[{color:"Navy",size:"M",quantity:10,expectedQuantity:null}]
}));
denied(request("POST","/api/admin/products",{
  name:"Shirt",category:"Shirts",price:999,description:"<script>alert(1)</script>"
}));
denied(request("POST","/api/admin/products",{
  name:"Shirt",category:"Shirts",price:999,sizesByColor:{Navy:["M",{price:0}]}
}));
denied(request("PATCH","/api/admin/products/mc-prod-123",{active:"false"}));
denied(request("PUT","/api/admin/storefront/footer",{
  columns:[{id:"shop",title:"Shop",links:[{label:"Bad",url:"javascript:alert(1)"}]}]
}));
denied(request("POST","/api/products/mc-prod-123/reviews",{
  rating:5,title:"Great",comment:'<svg/onload=alert(1)>'
}));
denied(request("POST","/api/admin/gst-invoices",{
  orderId:"MC-123",buyerName:"Buyer",buyerAddress:"A",placeOfSupplyName:"UP",
  placeOfSupplyCode:"09",lines:[{hsn:"610910",rate:"5",gross:"105",isPaid:true}]
}));
denied(request("POST","/api/admin/pos/orders",{
  variantId:"inv_test",quantity:1,name:"Customer",paymentConfirmed:true,price:1
}));
denied(request("POST","/api/checkout/address/location",{lat:200,lon:83}));
denied(request("POST","/api/admin/notifications/delete",{keys:["order:x"],isAdmin:true}));

assert.equal(validateCookies("mc_admin_session=s%3Aabcdef.signature"),true);
assert.equal(validateCookies("aerlon_aff=TEST.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),true);
assert.equal(validateCookies("aerlon_aff=bad<script>"),false);
assert.equal(validateCookies("aerlon_aff=TEST.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; aerlon_aff=TEST.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),false);
denied(request("GET","/api/products",{}, {}, "aerlon_aff=bad<script>"));

const signed = {
  event:"payment.captured",account_id:"acc_test",
  created_at:1795000000,contains:["payment"],
  payload:{payment:{entity:{id:"pay_123456ABC",order_id:"order_123456ABC",status:"captured",
    amount:99900,currency:"INR",extra:"provider metadata"}}},
  createdAt:"ignore provider metadata"
};
const verified=webhook.safeParse(signed);
assert.equal(verified.success,true,JSON.stringify(verified.error?.issues));
assert.equal(Object.hasOwn(verified.data,"createdAt"),false);
assert.equal(Object.hasOwn(verified.data.payload.payment.entity,"extra"),false);
assert.equal(webhook.safeParse({event:"payment.captured",payload:{}}).success,false);

console.log("Zod strict validation, mass-assignment/XSS, cookies, webhook and "+total+" HTTP route schema checks passed.");
