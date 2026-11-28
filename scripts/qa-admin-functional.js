"use strict";
const assert=require("node:assert/strict");
const {Writable}=require("node:stream");
function appRecorder(){
 const routes=new Map();
 const app={get:(p,...handlers)=>routes.set("GET "+p,handlers.at(-1)),
            post:(p,...handlers)=>routes.set("POST "+p,handlers.at(-1)),
            patch:(p,...handlers)=>routes.set("PATCH "+p,handlers.at(-1)),
            put:(p,...handlers)=>routes.set("PUT "+p,handlers.at(-1)),
            delete:(p,...handlers)=>routes.set("DELETE "+p,handlers.at(-1))};
 return {app,routes};
}
function response(){
 return {
  statusCode:200,body:null,headers:{},
  status(n){this.statusCode=n;return this},
  json(v){this.body=v;return this},
  set(name,value){if(typeof name==="object")Object.assign(this.headers,name);else this.headers[name]=value;return this},
  send(v){this.body=v;return this}
 };
}
async function testPOS(){
  const {app,routes}=appRecorder();
  const queries=[],audit=[];
  let recordStock=5;
  const variant={id:"inv-1",color:"Black",size:"M",quantity:recordStock,product_id:"p1",data:{name:"Classic Shirt",price:900,salePrice:700,active:true}};
  const client={released:false,async query(sql,params=[]){
    queries.push(sql);
    if(sql.startsWith("SELECT v.id"))return{rows:[{...variant,quantity:recordStock}],rowCount:1};
    if(sql.startsWith("UPDATE inventory_variants")){
      if(recordStock<params[1])return{rows:[],rowCount:0};
      recordStock-=params[1];return{rows:[{quantity:recordStock}],rowCount:1};
    }
    if(sql.startsWith("INSERT INTO orders"))return{rowCount:1};
    return{rowCount:0,rows:[]};
  },release(){this.released=true;}};
  const pool={connect:async()=>client};
  require("../services/store/admin-operations")(app,{
    pool, requireAdmin:()=>{},requireOwner:()=>{},requirePermission:()=>()=>{},
    getOrder:async()=>null,getOrders:async()=>[],putOrder:async()=>{},
    cleanText:(v,max)=>String(v||"").slice(0,max).trim(),
    audit:async(...args)=>audit.push(args)
  });
  const handler=routes.get("POST /api/admin/pos/orders");
  assert.equal(typeof handler,"function");
  const good=response();
  await handler({body:{variantId:"inv-1",name:"Walk-in",quantity:2,paymentConfirmed:true},adminSession:{username:"owner"}},good,err=>{throw err});
  assert.equal(good.statusCode,201);
  assert.equal(good.body.total,1400);
  assert.equal(good.body.remainingStock,3);
  assert.equal(recordStock,3);
  assert.ok(queries.some(q=>q.includes("FOR UPDATE OF v")));
  assert.ok(queries.some(q=>q==="COMMIT"));
  assert.ok(audit.some(a=>a[1]==="pos.sale.created"));
  const orderInsertCount=queries.filter(q=>q.startsWith("INSERT INTO orders")).length;
  const failed=response();
  await handler({body:{variantId:"inv-1",name:"Walk-in",quantity:4,paymentConfirmed:true},adminSession:{username:"owner"}},failed,err=>{throw err});
  assert.equal(failed.statusCode,409);
  assert.equal(recordStock,3);
  assert.equal(queries.filter(q=>q.startsWith("INSERT INTO orders")).length,orderInsertCount);
  assert.equal(queries.at(-1),"ROLLBACK");
  console.log("PASS: POS paid cash order deducts stock once; oversell is rejected and rolled back");
}
async function testInvoicePDF(){
  const {app,routes}=appRecorder();
  const snapshot={
    invoiceNumber:"AER-2026-000001",createdAt:"2026-11-28T10:00:00.000Z",
    orderId:"POS-TEST",seller:{legalName:"AERLON TEST",address:"Sample test address",gstin:"",email:"help@example.com",phone:""},
    customer:{name:"Sample Customer",city:"Test City"},items:[{name:"Classic Shirt",unitPrice:700,quantity:2,size:"M",color:"Black"}],
    total:1400,subtotal:1400,discount:0,shipping:0,paymentMethod:"Cash",paymentStatus:"paid"
  };
  const pool={query:async sql=>{
    if(sql.startsWith("SELECT data FROM invoices WHERE id="))return{rowCount:1,rows:[{data:snapshot}]};
    throw Error("Unexpected PDF test query: "+sql);
  }};
  require("../services/store/invoices")(app,{
    pool,requireAdmin:()=>{},requireOwner:()=>{},requirePermission:()=>()=>{},cleanText:(v,max)=>String(v||"").slice(0,max).trim(),audit:async()=>{},getOrder:async()=>null
  });
  const handler=routes.get("GET /api/admin/invoices/:id/pdf");
  assert.equal(typeof handler,"function");
  const parts=[];
  const stream=new Writable({write(chunk,encoding,callback){parts.push(Buffer.from(chunk));callback();}});
  stream.headers={};stream.set=(data)=>{Object.assign(stream.headers,data);return stream;};
  stream.status=(status)=>{stream.statusCode=status;return stream;};
  stream.json=(v)=>{throw Error("PDF unexpected JSON "+JSON.stringify(v));};
  const finished=new Promise((resolve,reject)=>{stream.once("finish",resolve);stream.once("error",reject);});
  await handler({params:{id:"1"}},stream,err=>{throw err;});
  await finished;
  const pdf=Buffer.concat(parts);
  assert.match(pdf.subarray(0,8).toString("utf8"),/^%PDF-/);
  assert.ok(pdf.length>1000,"PDF should contain rendered invoice content");
  assert.ok(pdf.toString("latin1").includes("%%EOF"));
  assert.equal(stream.headers["Content-Type"],"application/pdf");
  assert.ok(stream.headers["Content-Disposition"].includes(".pdf"));
  console.log("PASS: authenticated invoice PDF handler generates a complete PDF stream");
}
async function testManualGSTInvoice(){
  const {app,routes}=appRecorder();
  const sql=[],audit=[];
  const originalOrder={id:"ORDER-MANUAL-1",orderStatus:"confirmed",total:1180,
    items:[{name:"Cotton Shirt",quantity:1,unitPrice:1180}],createdAt:"2026-11-28T08:30:00.000Z"};
  let stored=null,releaseCount=0;
  const dbClient={
    async query(query,args=[]){
      sql.push(query);
      if(query==="BEGIN"||query==="COMMIT"||query==="ROLLBACK")return{rows:[],rowCount:0};
      if(query.startsWith("SELECT pg_advisory_xact_lock"))return{rows:[],rowCount:1};
      if(query.startsWith("SELECT COUNT(*)::integer AS n"))return{rows:[{n:stored?1:0}],rowCount:1};
      if(query.startsWith("INSERT INTO invoices")){
        if(stored)return{rows:[],rowCount:0};
        stored=JSON.parse(args[1]);return{rows:[{id:21}],rowCount:1};
      }
      throw Error("Unexpected GST SQL: "+query);
    },
    release(){releaseCount++;}
  };
  const pool={
    async query(query,args=[]){
      if(query.startsWith("SELECT data FROM store_settings"))
        return{rows:[{data:{legalName:"AERLON",address:"Gorakhpur UP",gstin:"09ABCDE1234F1Z5"}}],rowCount:1};
      throw Error("Unexpected GST query: "+query);
    },
    connect:async()=>dbClient
  };
  require("../services/store/gst-invoices")(app,{
    pool,getOrder:async()=>originalOrder,requireAdmin:()=>{},requirePermission:p=>{assert.equal(p,"invoices.issue");return()=>{};},
    audit:async(...a)=>audit.push(a)
  });
  assert.equal(stored,null,"No invoice should ever be auto-created during route registration");
  assert.deepEqual(sql,[],"No database invoice writes before an explicit POST");
  const issue=routes.get("POST /api/admin/gst-invoices");
  assert.equal(typeof issue,"function");
  const request={adminSession:{username:"owner",role:"owner"},body:{
    orderId:originalOrder.id,buyerName:"Buyer",buyerAddress:"UP",buyerGstin:"",
    placeOfSupplyCode:"09",placeOfSupplyName:"Uttar Pradesh",
    lines:[{hsn:"6205",rate:18,gross:1180}]
  }};
  const issued=response();
  await issue(request,issued,e=>{throw e;});
  assert.equal(issued.statusCode,201);
  assert.match(issued.body.invoiceNumber,/^G\d{2}-\d{2}-\d{6}$/);
  assert.equal(stored.type,"gst_tax_invoice");
  assert.equal(stored.taxType,"intra");
  assert.equal(stored.taxablePaisa,100000);
  assert.equal(stored.cgstPaisa,9000);
  assert.equal(stored.sgstPaisa,9000);
  assert.equal(stored.igstPaisa,0);
  assert.equal(stored.totalPaisa,118000);
  assert.ok(sql.includes("COMMIT"));
  assert.ok(audit.some(x=>x[1]==="gst.invoice.issued"));
  const duplicate=response();
  await issue(request,duplicate,e=>{throw e;});
  assert.equal(duplicate.statusCode,409,"Issuing for a second time must be rejected");
  assert.ok(sql.includes("ROLLBACK"));
  assert.ok(releaseCount>=2);
  console.log("PASS: GST invoice requires explicit manual POST, has correct intra-state tax and prevents duplicates");
}
async function testWarehouseAllocation(){
  const {app,routes}=appRecorder(),sql=[],audits=[];
  let assigned=2,stock=3,productStock=3,productAllocated=2;
  let inserted=0,rolledBack=0;
  const client={released:0,async query(s,args=[]){
    sql.push(s);
    if(s==="BEGIN"||s==="COMMIT")return{rows:[],rowCount:0};
    if(s==="ROLLBACK"){rolledBack++;return{rows:[],rowCount:0};}
    if(s.startsWith("SELECT data FROM warehouses WHERE id="))return{rows:[{data:{active:true}}],rowCount:1};
    if(s.startsWith("SELECT quantity,product_id FROM inventory_variants"))return{rows:[{quantity:stock,product_id:"prod-1"}],rowCount:1};
    if(s.startsWith("SELECT COALESCE(SUM(quantity)"))return{rows:[{n:assigned}],rowCount:1};
    if(s.startsWith("SELECT data FROM products WHERE id="))return{rows:[{data:{stock:productStock}}],rowCount:1};
    if(s.includes("FROM warehouse_stock ws"))return{rows:[{n:productAllocated}],rowCount:1};
    if(s.startsWith("INSERT INTO warehouse_stock")){inserted++;return{rows:[],rowCount:1};}
    throw Error("Unexpected warehouse SQL: "+s);
  },release(){this.released++;}};
  const pool={connect:async()=>client};
  require("../services/store/warehouses")(app,{
    pool,requireAdmin:()=>{},requireOwner:()=>{},cleanText:(s,max)=>String(s||"").trim().slice(0,max),
    audit:async(...args)=>audits.push(args)
  });
  const assign=routes.get("PUT /api/admin/warehouses/stock");
  assert.equal(typeof assign,"function");
  const actor={username:"owner",role:"owner"};
  const req={adminSession:actor,body:{warehouseId:"wh-1",variantId:"var-1",quantity:2}};
  const excess=response();
  await assign(req,excess,e=>{throw e});
  assert.equal(excess.statusCode,409);
  assert.equal(inserted,0);
  assert.equal(rolledBack,1);
  const good=response();
  req.body.quantity=1;
  await assign(req,good,e=>{throw e});
  assert.equal(good.body.ok,true);
  assert.equal(inserted,1);
  // Even with ample stock of this size, another size or warehouse may exhaust
  // the declared product-wide quantity.
  assigned=0;stock=100;productStock=100;productAllocated=99;
  const extra=response();
  req.body.quantity=2;
  await assign(req,extra,e=>{throw e});
  assert.equal(extra.statusCode,409);
  assert.match(extra.body.error,/100 total units/);
  assert.equal(inserted,1,"Over-allocation must not write inventory");
  const available=response();
  req.body.quantity=1;
  await assign(req,available,e=>{throw e});
  assert.equal(available.body.ok,true);
  assert.equal(inserted,2);
  assert.ok(sql.some(s=>s.includes("FROM inventory_variants WHERE id=$1 FOR UPDATE")));
  assert.ok(sql.some(s=>s.includes("FROM warehouses WHERE id=$1 FOR UPDATE")));
  assert.ok(sql.some(s=>s.includes("FROM products WHERE id=$1 FOR UPDATE")));
  assert.ok(sql.includes("COMMIT"));
  assert.ok(audits.some(x=>x[1]==="warehouse.stock.assigned"));
  console.log("PASS: Warehouse stock allocation respects variant supply and product-wide total under row locks");
}

function testSEO(){
  const seo=require("../services/store/advanced-seo");
  const template='<html><head><title>Old</title><meta name="description" content="OLD"><meta property="og:title" content="Old"></head><body>Test</body></html>';
  const profile={title:'Great <script>alert("x")</script>',description:"Search & Shop",ogTitle:"AERLON Preview",ogDescription:"Styles",ogImage:""};
  const output=seo.renderSEO(template,profile);
  assert.ok(output.includes("Great &lt;script&gt;"));
  assert.ok(!output.includes("<script>alert"));
  assert.ok(output.includes("https://aerlon.in/"));
  assert.equal((output.match(/name="description"/g)||[]).length,1);
  assert.equal((output.match(/property="og:title"/g)||[]).length,1);
  assert.equal((output.match(/<title>/g)||[]).length,1);
  assert.throws(()=>seo.validateSEO({...profile,ogImage:"javascript:alert(1)"}));
  console.log("PASS: SEO escapes unsafe text and emits a single canonical title/description");
}
async function testAffiliateAttribution(){
  const {app,routes}=appRecorder();
  const pool={query:async sql=>{
    if(sql.startsWith("UPDATE affiliates SET clicks"))return{rowCount:1,rows:[{code:"PARTNER1"}]};
    if(sql.startsWith("SELECT code,commission_rate FROM affiliates"))return{rowCount:1,rows:[{code:"PARTNER1",commission_rate:"5.00"}]};
    throw Error("Unexpected affiliate SQL "+sql);
  }};
  const moduleAff=require("../services/store/advanced-affiliates");
  moduleAff(app,{pool,requireAdmin:()=>{},requireOwner:()=>{},audit:async()=>{}});
  let cookie=null,redirect="";
  const reply={cookie(name,value,options){assert.equal(name,"aerlon_aff");assert.equal(options.httpOnly,true);cookie=name+"="+value;return this;},
    redirect(status,url){assert.equal(status,302);redirect=url;return this;}};
  await routes.get("GET /r/:code")({params:{code:"partner1"}},reply,e=>{throw e});
  assert.equal(redirect,"/");
  assert.ok(cookie&&cookie.includes("."));
  const result=await moduleAff.affiliateFromRequest({headers:{cookie}},pool);
  assert.equal(result.code,"PARTNER1");
  assert.equal(result.rate,5);
  const tampered=moduleAff.readAffiliateCode({headers:{cookie:cookie.replace("PARTNER1","PARTNER2")}});
  assert.equal(tampered,null);
  console.log("PASS: Affiliate referral cookies are signed; tampering blocks attribution");
}
async function testGiftLedger(){
  const {app,routes}=appRecorder();
  let remaining=1000,insertions=0,rollbacks=0,seen=false;
  const client={released:0,async query(sql,params=[]){
    if(sql==="BEGIN"||sql==="COMMIT")return{rowCount:1,rows:[]};
    if(sql==="ROLLBACK"){rollbacks++;return{rowCount:1,rows:[]};}
    if(sql.startsWith("SELECT id,active,balance_paise"))return{rowCount:1,rows:[{id:"gift-1",active:true,balance_paise:remaining,expires_at:null}]};
    if(sql.startsWith("INSERT INTO gift_card_redemptions")){
      if(seen)return{rowCount:0,rows:[]};
      seen=true;insertions++;return{rowCount:1,rows:[{id:1}]};
    }
    if(sql.startsWith("UPDATE gift_cards SET balance_paise")){remaining=params[1];return{rowCount:1,rows:[]};}
    throw Error("Unexpected gift SQL "+sql);
  },release(){this.released++;}};
  require("../services/store/advanced-gifts")(app,{pool:{connect:async()=>client},requireAdmin:()=>{},requireOwner:()=>{},audit:async()=>{}});
  assert.equal(remaining,1000,"No card balances change at registration");
  const redeem=routes.get("POST /api/admin/gift-cards/:id/redeem");
  const request={params:{id:"gift-1"},body:{amount:"5",reference:"POS-100"},adminSession:{username:"owner"}};
  const good=response();await redeem(request,good,e=>{throw e});
  assert.equal(good.statusCode,200);
  assert.equal(good.body.remainingPaise,500);
  assert.equal(remaining,500);
  const duplicate=response();await redeem(request,duplicate,e=>{throw e});
  assert.equal(duplicate.statusCode,409);
  assert.equal(remaining,500);
  assert.equal(insertions,1);
  assert.ok(rollbacks>0);
  console.log("PASS: Gift-card balance is transactional and offline references are idempotent");
}
async function testAutomationAlerts(){
  let saved=false;
  const pool={query:async sql=>{
    if(sql.startsWith("SELECT id,type,threshold"))return{rows:[{id:"rule-1",type:"low_stock",threshold:5}]};
    if(sql.startsWith("SELECT id AS key,quantity::text"))return{rows:[{key:"var-1",detail:"2"}]};
    if(sql.startsWith("INSERT INTO automation_alerts")){if(saved)return{rowCount:0};saved=true;return{rowCount:1};}
    throw Error("Unexpected automation SQL "+sql);
  }};
  const run=require("../services/store/advanced-automations").evaluate;
  const first=await run(pool),second=await run(pool);
  assert.equal(first.checked,1);assert.equal(first.created,1);
  assert.equal(second.created,0);
  console.log("PASS: Automation alerts are backed by rules and deduplicate repeated scans");
}
function testAdvancedWiring(){
  const fs=require("node:fs");
  const html=fs.readFileSync("public/admin.html","utf8");
  const admin=fs.readFileSync("public/assets/js/admin.js","utf8");
  const frontend=fs.readFileSync("public/assets/js/admin-advanced.js","utf8");
  const server=fs.readFileSync("server.js","utf8");
  const checkout=fs.readFileSync("services/store/checkout.js","utf8");
  for(const id of ["giftcards","affiliates","automations","seo","wallet"]){
    assert.ok(html.includes('id="section-'+id+'"'),"Missing "+id+" section");
    assert.ok(admin.includes("$('#"+id+"Nav').classList.toggle"),"Missing nav permission "+id);
  }
  assert.ok(html.includes("Wallet & Rewards")&&html.includes("Coming Soon"));
  assert.ok(server.includes('registerSEO(app,context,path.join(ROOT,"public","index.html"))'));
  assert.ok(checkout.includes("affiliateFromRequest(req,pool)"));
  assert.ok(frontend.includes("window.loadAerlonV3Section"));
  console.log("PASS: Advanced modules are routed, permissioned and Wallet remains Coming Soon");
}

(async()=>{await testPOS();await testInvoicePDF();await testManualGSTInvoice();await testWarehouseAllocation();
 testSEO();await testAffiliateAttribution();await testGiftLedger();await testAutomationAlerts();testAdvancedWiring();
 console.log("9/9 AERLON Admin 3.0 transaction and advanced checks passed.");})()
.catch(err=>{console.error("Admin 3.0 transaction test failed:",err.stack||err);process.exitCode=1});
