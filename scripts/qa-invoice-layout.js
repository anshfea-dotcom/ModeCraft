"use strict";
const assert=require("node:assert/strict");
const {PassThrough}=require("node:stream");
const render=require("../services/store/invoice-pdf");
const register=require("../services/store/invoices");

const seller={legalName:"AERLON Sample Company",address:"Sample Registered Address, India",email:"billing@example.invalid",note:"Thank you for your purchase."};
const items=[{name:"AERLON Printed Short Kurti",quantity:1,unitPrice:1299,color:"White / Black",size:"M"},{name:"AERLON Relaxed Shirt",quantity:1,unitPrice:1599,color:"Black",size:"L"}];
const commercial={invoiceNumber:"AER-2026-000001",orderId:"ORDER-001",createdAt:"2026-11-28T12:00:00Z",seller,customer:{name:"Sample Customer",address:"Sample House",city:"Sample City"},items,subtotal:2898,discount:0,shipping:0,total:2898,paymentMethod:"UPI",paymentStatus:"paid"};
const gst={type:"gst_tax_invoice",invoiceNumber:"G26-27-000001",createdAt:"2026-11-28T12:00:00Z",orderId:"ORDER-002",seller:{...seller,gstin:"09ABCDE1234F1Z5"},buyer:{name:"Sample Customer",address:"Sample Buyer Address"},placeOfSupplyName:"Uttar Pradesh",placeOfSupplyCode:"09",taxType:"intra",items:[{name:"AERLON Short Kurti",quantity:1,gstRate:5,hsn:"6104",taxablePaisa:120000,cgstPaisa:3000,sgstPaisa:3000,igstPaisa:0,taxPaisa:6000,grossPaisa:126000}],taxablePaisa:120000,cgstPaisa:3000,sgstPaisa:3000,igstPaisa:0,totalPaisa:126000};
function pdfSnapshot(fn,snapshot){
  return new Promise((resolve,reject)=>{
    const res=new PassThrough();res.headers={};
    res.set=function(k,v){if(typeof k==="string")this.headers[k]=v;else Object.assign(this.headers,k);return this};
    res.status=function(code){this.statusCode=code;return this};
    const chunks=[];res.on("data",c=>chunks.push(c));res.on("error",reject);
    res.on("end",()=>resolve({headers:res.headers,bytes:Buffer.concat(chunks)}));
    fn(snapshot,res);
  });
}
async function checkRendering(){
  for(const [fn,snapshot] of [[render.renderCommercial,commercial],[render.renderGST,gst]]){
    const {bytes,headers}=await pdfSnapshot(fn,snapshot);
    assert.equal(bytes.subarray(0,5).toString(),"%PDF-");
    assert.match(bytes.subarray(-100).toString(),/%%EOF/);
    assert.ok(bytes.length>2500,"PDF should contain substantial content");
    assert.match(headers["Content-Disposition"],/AERLON/);
    assert.equal(headers["Cache-Control"],"no-store");
  }
  const many={...commercial,items:Array.from({length:22},(_,i)=>({...items[0],name:"AERLON Garment "+i}))};
  const result=await pdfSnapshot(render.renderCommercial,many);
  assert.ok(result.bytes.length>4000,"Long invoice should create a valid PDF");
}
function createRoute(row){
  let deleted=false,audits=[],transaction=[];
  const routes=new Map();
  const app={get:(url,...handlers)=>routes.set("GET "+url,handlers),post:(url,...handlers)=>routes.set("POST "+url,handlers),put:(url,...handlers)=>routes.set("PUT "+url,handlers),delete:(url,...handlers)=>routes.set("DELETE "+url,handlers)};
  const client={
    async query(sql){
      transaction.push(sql);
      if(sql.includes("SELECT id,order_id,data"))return {rowCount:row?1:0,rows:row?[row]:[]};
      if(sql.startsWith("DELETE FROM invoices"))deleted=true;
      return {rowCount:1,rows:[]};
    },release(){}
  };
  const pool={connect:async()=>client};
  const requireAdmin=()=>{},requireOwner=()=>{},requirePermission=()=>()=>{};
  const audit=async(_session,event,meta)=>audits.push({event,meta});
  register(app,{pool,getOrder:async()=>null,requireAdmin,requireOwner,requirePermission,cleanText:v=>String(v||""),audit});
  const handlers=routes.get("DELETE /api/admin/invoices/:id");
  assert.equal(handlers[0],requireAdmin);
  assert.equal(handlers[1],requireOwner);
  return {deleted:()=>deleted,audits,transaction,handler:handlers.at(-1)};
}
async function callDelete(route,invoiceNumber){
  let code=200,payload,reported;
  const req={params:{id:"1"},body:{confirmInvoiceNumber:invoiceNumber},adminSession:{role:"owner"}};
  const res={status(n){code=n;return this},set(){return this},json(x){payload=x;return this}};
  await route.handler(req,res,e=>{reported=e});
  if(reported)throw reported;
  return {code,payload};
}
async function checkDeleteGuard(){
  const record={id:1,order_id:"ORDER-001",data:commercial};
  const wrong=createRoute(record),mismatch=await callDelete(wrong,"WRONG");
  assert.equal(mismatch.code,400);assert.equal(wrong.deleted(),false);
  const gstr=createRoute({...record,data:gst}),denied=await callDelete(gstr,gst.invoiceNumber);
  assert.equal(denied.code,409);assert.equal(gstr.deleted(),false);
  const gstSeller=createRoute({...record,data:{...commercial,seller:{...seller,gstin:"09ABCDE1234F1Z5"}}});
  assert.equal((await callDelete(gstSeller,commercial.invoiceNumber)).code,409);
  assert.equal(gstSeller.deleted(),false);
  const ok=createRoute(record),success=await callDelete(ok,commercial.invoiceNumber);
  assert.equal(success.code,200);assert.equal(success.payload.ok,true);
  assert.equal(ok.deleted(),true);
  assert.equal(ok.audits[0].event,"invoice.deleted");
  assert.ok(!ok.transaction.some(x=>x.includes("DELETE FROM orders")),"Must never delete orders");
}
(async()=>{await checkRendering();await checkDeleteGuard();console.log("AERLON champagne invoice PDF and deletion guard QA passed");})().catch(e=>{console.error(e);process.exitCode=1});
