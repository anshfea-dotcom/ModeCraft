"use strict";
const { z } = require("zod");

// This storefront has plain-text reviews, descriptions and SEO fields, not a
// rich-text editor. Reject HTML, markup and control characters at the boundary.
// Continue escaping text in all HTML sinks.
const text = (max, min = 0) => z.string().trim().min(min).max(max)
  .refine(v => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), "HTML/markup or control characters are not allowed");
const id = (max = 150) => z.string().min(1).max(max).regex(/^[A-Za-z0-9._:-]+$/);
const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(180);
const phone = z.string().regex(/^[6-9][0-9]{9}$/);
const pin = z.string().regex(/^[1-9][0-9]{5}$/);
const code = z.string().trim().regex(/^[A-Za-z0-9_-]{3,60}$/);
const money = (min = 0, max = 100000000) => z.union([
  z.number().finite(), z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
]).transform(Number).pipe(z.number().finite().min(min).max(max));
const count = (min = 0, max = 1000000) => z.union([
  z.number().int(), z.string().regex(/^(?:0|[1-9]\d*)$/)
]).transform(Number).pipe(z.number().int().min(min).max(max));
const flag = z.boolean();
const obj = shape => z.object(shape).strict();
const optionalText = (max, min = 0) => text(max, min).optional();
const optionalDate = z.union([z.string().datetime({offset:true}), z.literal(""), z.null()]).optional();
const https = (max = 1500) => z.string().max(max).refine(v => !v || (
  /^https:\/\//i.test(v) && (() => {try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }})()
), "Must be a valid HTTPS URL");
const safeLink = z.string().max(1200).refine(v =>
  !v || /^https:\/\/[^\s<>"']+$/i.test(v) ||
  /^\/(?!\/)[^\s<>"']*$/.test(v) || /^#[A-Za-z0-9_-]+$/.test(v) ||
  /^mailto:[^\s<>"']+$/i.test(v) || /^tel:[+0-9()-]+$/.test(v),
  "Only HTTPS URLs, local paths, anchors, mailto or tel links are allowed");
const imageUrl = z.string().max(1800).refine(v => !v || /^https:\/\/[^\s<>"']+$/i.test(v) || /^\/(?!\/)[^\s<>"']+$/.test(v), "Only HTTPS image URLs or absolute local paths are allowed");

const empty = obj({});
const paramsId = obj({id});
const paramsUuid = obj({id:uuid});
const paramsProduct = obj({productId:id()});
const entries = [];
function define(method, route, body = empty, query = empty, params) {
  const segments = route.split("/").filter(Boolean);
  const pattern = new RegExp("^/" + segments.map(s => s.startsWith(":") ? "([^/]+)" : s.replace(/\./g,"\\.")).join("/") + "/?$","i");
  const names = segments.filter(s => s.startsWith(":")).map(s=>s.slice(1));
  entries.push({method,route,body,query,params:params || obj(Object.fromEntries(names.map(k=>[k,id()]))),pattern,names});
}
function many(method, paths, body = empty) {
  for (const route of paths.trim().split(/\s+/)) define(method,route,body);
}
function matchRoute(method,pathname) {
  const exact = entries.find(e=>e.method===method && !e.names.length && e.pattern.test(pathname));
  if (exact) return { entry: exact, params: {} };
  for (const e of entries) {
    if(e.method!==method)continue;
    const m = pathname.match(e.pattern);
    if(!m)continue;
    const params={};
    for(let i=0;i<e.names.length;i++){
      try{ params[e.names[i]]=decodeURIComponent(m[i+1]); }
      catch{return { malformed:true,entry:e }; }
    }
    return {entry:e,params};
  }
  return null;
}

// Bodyless routes still have strict empty query/body/param schemas.
many("GET", "/health /api/products /api/config /api/auth/me /api/orders/my /api/wishlist /api/storefront/header /api/storefront/footer /api/storefront/banners /api/admin/staff /api/admin/audit /api/admin/newsletter/subscribers /api/admin/storefront/header /api/admin/storefront/footer /api/admin/banners /api/admin/offers /api/admin/customers /api/admin/analytics /api/admin/products /api/admin/invoices/profile /api/admin/invoices /api/admin/pos/variants /api/admin/warehouses /api/admin/warehouses/variants /api/admin/catalogue/taxonomy /api/admin/backups/operational.json /api/admin/inventory /api/admin/affiliates /api/admin/automations /api/admin/gift-cards /api/admin/seo /api/admin/notifications/deleted /api/customer/addresses");
many("POST", "/api/admin/login-challenge /api/admin/logout /api/admin/session/activity /api/auth/logout /api/auth/activity /api/admin/automations/run");

define("GET","/api/admin/orders",empty,obj({includeArchived:z.enum(["true","false"]).optional()}));
define("GET","/api/admin/inventory/alerts",empty,obj({threshold:z.string().regex(/^(?:0|[1-9]\d{0,5})$/).optional()}));
define("GET","/api/orders/track",empty,obj({orderId:id(100),phone}));
define("GET","/api/coupons/validate",empty,obj({code,subtotal:z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)}));

define("POST","/api/auth/login",obj({email,password:z.string().min(1).max(200)}));
define("POST","/api/admin/login",obj({username:text(100,1),password:z.string().min(1).max(200)}));
define("POST","/api/auth/signup",obj({name:text(100,1),email,phone,password:z.string().min(8).max(200)}));
define("POST","/api/auth/forgot-password",obj({email}));
define("POST","/api/auth/reset-password",obj({token:z.string().regex(/^[0-9a-f]{64}$/i),password:z.string().min(8).max(200)}));
define("POST","/api/storefront/newsletter",obj({email,consent:z.literal(true)}));

const address = {
  name:text(100,1),email,phone,postalCode:pin,city:text(100,1),
  state:text(100,1),house:text(100,1),address:text(180,1),
  landmark:optionalText(100),addressType:z.enum(["Home","Work","Other"])
};
define("POST","/api/customer/addresses",obj({...address,id:uuid.optional()}));
define("DELETE","/api/customer/addresses/:id",empty,empty,paramsUuid);
const cartItem = obj({id:id(),quantity:count(1,10),color:optionalText(40),size:optionalText(30)});
const cart = {items:z.array(cartItem).min(1).max(30),couponCode:optionalText(50)};
const customer = obj(address);
define("POST","/api/coupons/validate",obj(cart));
const checkout = obj({...cart,customer,attemptId:uuid,expectedTotal:money(0).optional(),
  giftCode: z.string().regex(/^AGC-[A-Fa-f0-9]{24}$/).optional()});
for(const p of ["/api/orders/cod","/api/orders/gift","/api/payments/razorpay/order"])define("POST",p,checkout);
define("POST","/api/payments/razorpay/verify",obj({
  razorpay_order_id:z.string().regex(/^order_[A-Za-z0-9]{6,64}$/),
  razorpay_payment_id:z.string().regex(/^pay_[A-Za-z0-9]{6,64}$/),
  razorpay_signature:z.string().regex(/^[a-f0-9]{64}$/i)
}));
define("POST","/api/checkout/address/:kind",z.union([
  obj({pin}),
  obj({lat:z.number().finite().min(-90).max(90),lon:z.number().finite().min(-180).max(180)})
]),empty,obj({kind:z.enum(["pin","location"])}));
define("POST","/api/gift-cards/check",obj({code:z.string().regex(/^AGC-[a-fA-F0-9]{24}$/)}));

define("GET","/api/products/:id/reviews",empty,empty,paramsId);
define("POST","/api/products/:id/reviews",obj({rating:count(1,5),title:text(120,1),comment:text(1500,1)}),empty,paramsId);
define("POST","/api/products/:id/stock-notifications",obj({color:text(50,1),size:text(30,1)}),empty,paramsId);
define("POST","/api/wishlist/:productId",empty,empty,paramsProduct);
define("DELETE","/api/wishlist/:productId",empty,empty,paramsProduct);

const permissions = z.array(z.enum([
  "dashboard.view","orders.view","invoices.issue","orders.update","orders.cancel",
  "orders.payment.receive","products.view","products.manage","customers.view",
  "analytics.view","audit.view"
])).max(20);
const staffRole = z.enum(["manager","staff"]);
define("POST","/api/admin/staff",obj({
  username:z.string().regex(/^[A-Za-z0-9._-]{3,60}$/),displayName:text(100,2),
  password:z.string().min(10).max(200),role:staffRole,permissions:permissions.optional()
}));
define("PATCH","/api/admin/staff/:id",obj({
  role:staffRole.optional(),permissions:permissions.optional(),
  active:flag.optional(),password:z.string().min(10).max(200).optional()
}),empty,paramsUuid);
define("DELETE","/api/admin/staff/:id",empty,empty,paramsUuid);

const offer = {title:text(100,2),discountType:z.enum(["percent","fixed"]),
  discountValue:money(0.01,1000000),minimumSubtotal:money(0).optional(),
  startsAt:optionalDate,expiresAt:optionalDate,active:flag.optional()};
define("POST","/api/admin/offers",obj({...offer,code:z.string().regex(/^[A-Z0-9_-]{3,32}$/i)}));
define("PATCH","/api/admin/offers/:id",obj(Object.fromEntries(Object.entries(offer).map(([k,v])=>[k,v.optional()]))),empty,paramsUuid);
define("DELETE","/api/admin/offers/:id",empty,empty,paramsUuid);

const productFields = {
  name:text(120,1),category:text(80,1),audience:optionalText(30),
  productType:optionalText(80),sortOrder:count(0,9999999999999).optional(),
  price:money(0.01,100000000),salePrice:money(0.01,100000000).nullable().optional(),
  stock:count(0,1000000).optional(),active:flag.optional(),
  image:imageUrl.optional(),images:z.array(imageUrl).max(12).optional(),
  description:optionalText(500), colors:z.array(text(40,1)).max(30).optional(),
  sizesByColor:z.record(text(40,1),z.array(text(30,1)).max(20)).refine(o=>Object.keys(o).length<=30 && !Object.keys(o).some(k=>["__proto__","constructor","prototype"].includes(k))).optional(),
  colorVariants:z.record(text(40,1),id()).refine(o=>Object.keys(o).length<=30 && !Object.keys(o).some(k=>["__proto__","constructor","prototype"].includes(k))).optional(),
  stockGrid:z.array(obj({color:text(40,1),size:text(30,1),
    quantity:count(0,1000000),expectedQuantity:count(0,1000000).nullable().optional()})).max(300).optional()
};
define("POST","/api/admin/products",obj(productFields));
define("PATCH","/api/admin/products/:id",obj(Object.fromEntries(Object.entries(productFields).map(([k,v])=>[k,v.optional()]))),empty,paramsId);
define("DELETE","/api/admin/products/:id",empty,empty,paramsId);
define("POST","/api/admin/products/reorder",obj({ids:z.array(id()).min(1).max(10000)}));

// Additional administration and webhook schemas follow.
