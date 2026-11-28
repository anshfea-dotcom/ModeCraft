"use strict";
const assert=require("node:assert/strict");
const {Writable}=require("node:stream");
function appRecorder(){
 const routes=new Map();
 const app={get:(p,...handlers)=>routes.set("GET "+p,handlers.at(-1)),
            post:(p,...handlers)=>routes.set("POST "+p,handlers.at(-1)),
            patch:(p,...handlers)=>routes.set("PATCH "+p,handlers.at(-1)),
            put:(p,...handlers)=>routes.set("PUT "+p,handlers.at(-1))};
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

function testGST(){
 const {buildGstSnapshot}=require("../services/store/gst-invoice");
 const seller={gstin:"09AAAAA0000A1Z5"};
 const order={id:"TEST",items:[{name:"Kurti",quantity:2,unitPrice:590}],subtotal:1180,discount:180,total:1000,shipping:0};
 const request={buyerAddress:"1 Test Road, Uttar Pradesh",signatory:"Owner",
   placeOfSupplyStateCode:"09",lines:[{hsn:"6206",gstRate:18}]};
 const intra=buildGstSnapshot(order,seller,request);
 assert.equal(intra.type,"gst_tax_invoice");
 assert.equal(intra.gst.lines[0].amount,1000);
 assert.equal(intra.gst.cgst+intra.gst.sgst,152.54);
 assert.equal(intra.gst.igst,0);
 const inter=buildGstSnapshot(order,seller,{...request,placeOfSupplyStateCode:"27"});
 assert.equal(inter.gst.igst,152.54);
 assert.equal(inter.gst.cgst,0);
 assert.throws(()=>buildGstSnapshot(order,seller,{...request,lines:[{hsn:"6206",gstRate:undefined}]}));
 assert.throws(()=>buildGstSnapshot({...order,total:1500},seller,request));
 console.log("PASS: manually selected GST HSN, inclusive CGST/SGST or IGST and reconciliation checks");
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
    pool,requireAdmin:()=>{},requireOwner:()=>{},cleanText:(v,max)=>String(v||"").slice(0,max).trim(),audit:async()=>{},getOrder:async()=>null
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
(async()=>{await testPOS();await testInvoicePDF();testGST();console.log("3/3 AERLON Admin 3.0 transaction checks passed.")})()
.catch(err=>{console.error("Admin 3.0 transaction test failed:",err.stack||err);process.exitCode=1});
