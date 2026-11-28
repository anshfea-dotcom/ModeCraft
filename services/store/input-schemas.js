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

// Explicit owner-managed storefront settings and footer nested link allowlists.
const footerLink = obj({label:text(60,1),url:safeLink.optional(),action:z.literal("track").optional()})
  .refine(v => v.action === "track" || Boolean(v.url), "Footer link requires a destination");
const footerColumn = obj({id:optionalText(30),title:text(50,1),
  links:z.array(footerLink).max(12)});
const footer = obj({
  enabled:flag.optional(),brandText:optionalText(60),tagline:optionalText(120),
  intro:optionalText(240),logoUrl:https().optional(),showBrand:flag.optional(),
  showTagline:flag.optional(),showIntro:flag.optional(),newsletterEnabled:flag.optional(),
  newsletterKicker:optionalText(60),newsletterTitle:optionalText(100),
  newsletterDescription:optionalText(240),newsletterButtonText:optionalText(20),
  newsletterConsentText:optionalText(180),trustEnabled:flag.optional(),
  trustItems:z.array(text(60)).max(3).optional(),copyrightText:optionalText(100),
  backToTopEnabled:flag.optional(),
  socials:obj({
    instagram:https(1200).optional(),facebook:https(1200).optional(),
    youtube:https(1200).optional(),pinterest:https(1200).optional(),
    x:https(1200).optional(),whatsapp:https(1200).optional()
  }).optional(),
  columns:z.array(footerColumn).max(4).optional()
});
define("PUT","/api/admin/storefront/footer",footer);
define("PUT","/api/admin/storefront/header",obj({
  announcement:optionalText(180),brandText:optionalText(60),tagline:optionalText(100),
  logoUrl:https().optional(),showAnnouncement:flag.optional(),showTagline:flag.optional()
}));
const banner = {
  title:text(100,1),subtitle:optionalText(220),imageUrl:https(1800).optional(),
  buttonText:optionalText(40),buttonUrl:safeLink.optional(),
  sortOrder:count(0,10000).optional(),active:flag.optional()
};
define("POST","/api/admin/banners",obj(banner));
define("PATCH","/api/admin/banners/:id",obj(Object.fromEntries(
  Object.entries(banner).map(([k,v])=>[k,v.optional()]))),empty,
  obj({id:z.string().regex(/^banner_[a-f0-9]{18}$/)}));
define("DELETE","/api/admin/banners/:id",empty,empty,
  obj({id:z.string().regex(/^banner_[a-f0-9]{18}$/)}));

define("PATCH","/api/admin/orders/:id/archive",obj({restore:flag.optional()}),empty,paramsId);
define("PATCH","/api/admin/orders/:id",obj({
  orderStatus:z.enum(["received","confirmed","processing","shipped","delivered","cancelled","awaiting_payment"]),
  cancellationReason:optionalText(300)
}),empty,paramsId);
define("PATCH","/api/admin/orders/:id/payment",obj({note:optionalText(250)}),empty,paramsId);
define("PATCH","/api/admin/orders/:id/shipping",obj({
  carrier:text(80,1),trackingNumber:z.string().regex(/^[A-Za-z0-9./_-]{4,100}$/)
}),empty,paramsId);

const gstin = z.string().regex(/^(?:[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])?$/i);
define("PUT","/api/admin/invoices/profile",obj({
  legalName:text(120,1),address:text(450,1),gstin:gstin.optional(),
  email:z.union([email,z.literal("")]).optional(),phone:optionalText(30),
  note:optionalText(300)
}));
define("POST","/api/admin/invoices",obj({orderId:id()}));
define("DELETE","/api/admin/invoices/:id",obj({
  confirmInvoiceNumber:text(80,1)
}),empty,obj({id:z.string().regex(/^[0-9]{1,16}$/)}));
define("GET","/api/admin/invoices/:id/pdf",empty,empty,
  obj({id:z.string().regex(/^[0-9]{1,16}$/)}));
const gstLine = obj({hsn:z.string().regex(/^[0-9]{4,8}$/),
  rate:money(0,100),gross:money(0.01,999999999)});
define("POST","/api/admin/gst-invoices",obj({
  orderId:id(),buyerName:text(120,1),buyerAddress:text(450,1),
  buyerGstin:gstin.optional(),placeOfSupplyName:text(80,1),
  placeOfSupplyCode:z.string().regex(/^(?:0[1-9]|[12][0-9]|3[0-8])$/),
  lines:z.array(gstLine).min(1).max(30)
}));
define("GET","/api/admin/gst-invoices/:id/pdf",empty,empty,
  obj({id:z.string().regex(/^[0-9]{1,16}$/)}));

const invVariant = {productId:id(120),color:text(50,1),size:text(30,1),
  sku:optionalText(80),quantity:count(0,1000000)};
define("POST","/api/admin/inventory",obj(invVariant));
define("PATCH","/api/admin/inventory/:id",obj(invVariant),empty,paramsId);
define("DELETE","/api/admin/inventory/:id",empty,empty,paramsId);
define("POST","/api/admin/inventory/bulk",obj({
  productId:id(100),color:text(50,1),
  variants:z.array(obj({size:text(30,1),quantity:count(0,1000000),
    sku:optionalText(80)})).min(1).max(20)
}));
define("POST","/api/admin/pos/orders",obj({
  variantId:id(120),quantity:count(1,25),name:text(120,1),
  phone:optionalText(30),paymentConfirmed:z.literal(true)
}));

const warehouse = {name:text(100,2),city:optionalText(80),state:optionalText(80),
  address:optionalText(350)};
define("POST","/api/admin/warehouses",obj({
  ...warehouse,code:z.string().regex(/^[A-Za-z0-9_-]{2,24}$/)
}));
define("PATCH","/api/admin/warehouses/:id",obj({
  name:optionalText(100,2),city:optionalText(80),state:optionalText(80),
  address:optionalText(350),active:flag.optional()
}),empty,paramsUuid);
define("PUT","/api/admin/warehouses/stock",obj({
  warehouseId:uuid,variantId:id(120),quantity:count(0,1000000)
}));
define("PATCH","/api/admin/catalogue/categories",obj({from:text(80,1),to:text(80,1)}));
define("PATCH","/api/admin/catalogue/brands",obj({productId:id(),brand:text(80,1)}));

define("POST","/api/admin/affiliates",obj({
  name:text(100,2),code:z.string().regex(/^[A-Za-z0-9_-]{4,24}$/),
  commissionRate:money(0,30)
}));
define("PATCH","/api/admin/affiliates/:id",obj({
  name:optionalText(100,2),commissionRate:money(0,30).optional(),active:flag.optional()
}),empty,paramsUuid);
define("POST","/api/admin/automations",obj({
  name:text(100,3),type:z.enum(["low_stock","unpaid_orders","unfulfilled_orders"]),
  threshold:count(0,10000).optional()
}));
define("PATCH","/api/admin/automations/:id",obj({active:flag}),empty,paramsUuid);
define("PATCH","/api/admin/automations/alerts/:id",empty,empty,paramsUuid);

define("POST","/api/admin/gift-cards",obj({
  label:text(100,2),amount:money(50,100000),
  expiresAt:z.union([z.string().datetime({offset:true}),z.literal("")]).optional()
}));
define("PATCH","/api/admin/gift-cards/:id",obj({
  fundingReference:optionalText(100),active:flag
}),empty,paramsUuid);
define("POST","/api/admin/gift-cards/:id/redeem",obj({
  amount:money(0.01,100000),reference:text(100,4)
}),empty,paramsUuid);

define("PUT","/api/admin/seo",obj({
  title:text(75,4),description:text(180,4),ogTitle:text(95,4),
  ogDescription:text(200,4),ogImage:https(1200).optional()
}));
define("POST","/api/admin/notifications/delete",obj({
  keys:z.array(z.string().regex(/^(?:order|payment|stock|automation):[A-Za-z0-9:_-]{1,210}$/)).min(1).max(100)
}));

define("GET","/r/:code",empty,empty,obj({code:z.string().regex(/^[A-Za-z0-9_-]{4,24}$/)}));
const imageSlot = obj({slot:z.string().regex(/^[a-z0-9_-]{1,70}$/)});
define("GET","/storefront-images/:slot",empty,empty,imageSlot);
define("PUT","/api/admin/storefront/images/:slot",empty,empty,imageSlot);
define("DELETE","/api/admin/storefront/images/:slot",empty,empty,imageSlot);

// Signed Razorpay requests contain extensive provider-owned metadata.
// Whitelist + strip the unused provider keys, including nested payment entity.
// The only data passed to confirmCapturedPayment is the validated projection.
const capturedPayment = z.object({
  id:z.string().regex(/^pay_[A-Za-z0-9]{6,64}$/),
  order_id:z.string().regex(/^order_[A-Za-z0-9]{6,64}$/),
  status:z.enum(["captured","authorized","failed","created","refunded"]),
  currency:z.literal("INR"),
  amount:count(1,1000000000)
}).strip();
const webhook = z.object({
  event:z.string().regex(/^[a-z][a-z_.]{2,100}$/),
  account_id:z.string().max(100).optional(),
  contains:z.array(z.string().max(100)).max(20).optional(),
  created_at:count(0,9999999999).optional(),
  payload:z.object({
    payment:z.object({entity:capturedPayment}).strip().optional()
  }).strip()
}).strip().superRefine((v,ctx)=>{
  if(v.event==="payment.captured" && !v.payload.payment){
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"Captured payment entity is required",path:["payload","payment"]});
  }
});

module.exports = { z, entries, matchRoute, webhook, empty, imageSlot };

