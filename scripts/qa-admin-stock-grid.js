/* AERLON stock controls: four independent regression checks, no production database writes. */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {execFileSync}=require("node:child_process");
const base=require("node:path").join(__dirname,"..");
const source=file=>fs.readFileSync(require("node:path").join(base,file),"utf8");
const routes=()=>{const handlers={};const app={};for(const method of ["get","post","patch","delete","put"])app[method]=(path,...fns)=>handlers[method.toUpperCase()+" "+path]=fns.at(-1);return {app,handlers};};
const response=()=>({statusCode:200,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this},set(){return this}});
const cleanText=(value,max)=>String(value??"").trim().slice(0,max);
async function main(){
 // Round 1: every edited JS file parses, and the product editor is wired to its server contract.
 for(const file of ["services/store/products.js","services/store/repository.js","services/store/checkout.js","services/store/orders.js","public/assets/js/admin.js","public/assets/js/admin-stock-grid.js"])
   execFileSync(process.execPath,["--check",require("node:path").join(base,file)]);
 const html=source("public/admin.html"),js=source("public/assets/js/admin.js");
 assert.match(html,/admin-stock-grid\.js/);assert.match(html,/admin-stock-grid\.css/);
 assert.match(js,/AerlonStockGrid\.read\(body\.colorVariants\)/);
 assert.match(js,/data-stock-units/);
 console.log("PASS Round 1: Product editor, CSS/JS assets and syntax");
 // Round 2: create product with exact per-size units, committed in one transaction.
 let ops=[];
 const client={
   async query(sql,args=[]){ops.push([sql,args]);if(sql.startsWith("SELECT id,color,size,quantity FROM inventory_variants"))return {rows:[],rowCount:0};return {rows:[],rowCount:1};},
   release(){ops.push(["RELEASE"]);}
 };
 const {app,handlers}=routes();
 const pool={connect:async()=>client};
 require("../services/store/products")(app,{requireAdmin:()=>{},requirePermission:()=>()=>{},getProducts:async()=>[],normalizeProductFamilyValue:x=>x,cleanText,putProduct:async(product,db)=>db.query("PUT_PRODUCT",[product]),audit:async()=>{},getProduct:async()=>null,pool});
 const body={name:"Test Shirt",category:"Shirts",price:990,stock:0,colors:["Black"],sizesByColor:{Black:["XS","M"]},stockGrid:[{color:"Black",size:"XS",quantity:3,expectedQuantity:null},{color:"Black",size:"M",quantity:8,expectedQuantity:null}]};
 const ok=response();let problem=null;
 await handlers["POST /api/admin/products"]({body,adminSession:{username:"owner"}},ok,e=>{problem=e});
 assert.equal(problem,null);assert.equal(ok.statusCode,201);assert.equal(ok.body.product.stock,11);
 assert.equal(ops.filter(([sql])=>sql.startsWith("INSERT INTO inventory_variants")).length,2);
 assert.ok(ops.find(([sql])=>sql==="COMMIT"));
 console.log("PASS Round 2: 3 XS + 8 M units atomically committed");
 // Round 3: stale admin stock cannot overwrite an intervening order; changes roll back.
 ops=[];
 const original={...ok.body.product,id:"p_existing",stock:8,createdAt:"2026-11-28T00:00:00Z"};
 client.query=async(sql,args=[])=>{
   ops.push([sql,args]);
   if(sql.startsWith("SELECT id,color,size,quantity FROM inventory_variants"))return {rows:[{id:"inv_one",color:"Black",size:"XS",quantity:1},{id:"inv_two",color:"Black",size:"M",quantity:7}],rowCount:2};
   return {rows:[],rowCount:1};
 };
 const f=routes();
 require("../services/store/products")(f.app,{requireAdmin:()=>{},requirePermission:()=>()=>{},getProducts:async()=>[],normalizeProductFamilyValue:x=>x,cleanText,putProduct:async(p,db)=>db.query("PUT_PRODUCT",[p]),audit:async()=>{},getProduct:async()=>({...original}),pool});
 problem=null;
 await f.handlers["PATCH /api/admin/products/:id"]({params:{id:"p_existing"},body:{stockGrid:[{color:"Black",size:"XS",quantity:5,expectedQuantity:2},{color:"Black",size:"M",quantity:7,expectedQuantity:7}]},adminSession:{username:"owner"}},response(),e=>{problem=e});
 assert.equal(problem?.status,409);assert.ok(ops.find(([sql])=>sql==="ROLLBACK"));assert.ok(!ops.find(([sql])=>sql==="COMMIT"));
 console.log("PASS Round 3: stale quantity rejected with rollback");
 // Round 4: cancellation restores a recorded reservation only once, including on repeated status clicks.
 let row={id:"order_demo",orderStatus:"received",paymentStatus:"pending",statusHistory:[],stockReservations:[{kind:"variant",id:"inv_one",quantity:2}]},returns=0;
 const orderClient={
   async query(sql,args=[]){
     if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return {rows:[],rowCount:0};
     if(sql.startsWith("SELECT data FROM orders WHERE id=$1 FOR UPDATE"))return {rows:[{data:{...row}}],rowCount:1};
     if(sql.startsWith("UPDATE inventory_variants SET quantity=quantity+$2")){returns++;return {rowCount:1,rows:[{id:"inv_one"}]}};
     if(sql.startsWith("UPDATE orders SET data=$2::jsonb")){row=JSON.parse(args[1]);return {rowCount:1}};
     throw Error("Unexpected SQL in order test: "+sql);
   },release(){}
 };
 const o=routes();
 require("../services/store/orders")(o.app,{requireAdmin:()=>{},requirePermission:()=>()=>{},requireOwner:()=>{},getOrders:async()=>[],pool:{connect:async()=>orderClient},ensureCustomerRecord:async()=>{},getOrder:async()=>row,putOrder:async()=>{},audit:async()=>{},cleanText,can:()=>true});
 const patch=o.handlers["PATCH /api/admin/orders/:id"];
 for(let n=0;n<2;n++){
   let err=null;
   const res=response();
   await patch({params:{id:"order_demo"},body:{orderStatus:"cancelled",cancellationReason:"Customer request"},adminSession:{username:"owner",role:"owner"}},res,e=>{err=e});
   assert.equal(err,null);assert.equal(res.statusCode,200);
 }
 assert.equal(returns,1);assert.equal(row.stockReleased,true);
 const checkout=source("services/store/checkout.js");
 assert.match(checkout,/order\.stockReservations = \[\]/);
 assert.match(checkout,/quantity >= \$4 RETURNING id/);
 console.log("PASS Round 4: safe one-time cancellation return and oversell guard");
}
main().catch(err=>{console.error(err);process.exitCode=1});