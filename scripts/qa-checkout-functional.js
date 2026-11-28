"use strict";
const assert=require("node:assert/strict");
const crypto=require("node:crypto");

const cleanText=(s,n)=>typeof s==="string"?s.trim().slice(0,n):"";
const product={id:"test-shirt",name:"AERLON Classic Shirt",category:"Shirts",price:1000,
  stock:10,active:true,colors:["Black"],sizesByColor:{Black:["M"]}};
const customer={name:"Test Customer",email:"customer@example.test",phone:"9876543210",
  address:"Main Road",house:"24",state:"Uttar Pradesh",landmark:"",addressType:"Home",
  city:"Varanasi",postalCode:"221001"};
const giftCode="AGC-"+("A".repeat(24));
function reply(){
  return {statusCode:200,body:null,headers:{},
    status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;},
    set(k,v){this.headers[k]=v;return this;},sendStatus(n){this.statusCode=n;return this;}};
}
function recorder(){
  const routes=new Map();
  const register=(kind)=>(path,...handlers)=>routes.set(kind+" "+path,handlers.at(-1));
  return {routes,app:{get:register("GET"),post:register("POST"),put:register("PUT"),
    patch:register("PATCH"),delete:register("DELETE"),use:()=>{}}};
}
async function checkoutTest(){
  const {app,routes}=recorder(),attempts=new Map(),orders=new Map(),ledger=[];
  let balance=100000,updates=0,commits=0,rollbacks=0,available=5,stockDebits=0;
  const pool={
    async query(sql,args=[]){
      if(sql.startsWith("SELECT a.fingerprint, o.data FROM checkout_attempts")){
        const a=attempts.get(args[0]);
        return{rowCount:a?1:0,rows:a?[{fingerprint:a.fingerprint,data:orders.get(a.id)||null}]:[]};
      }
      if(sql.startsWith("SELECT color, size, quantity FROM inventory_variants"))
        return{rows:[{color:"Black",size:"M",quantity:5}],rowCount:1};
      throw Error("Unexpected global checkout query: "+sql.slice(0,150));
    },
    async connect(){
      const changes={claim:null,order:null,debit:0,ledger:null,stockDebit:0};
      return {
        async query(sql,args=[]){
          if(sql==="BEGIN")return{rows:[],rowCount:0};
          if(sql==="ROLLBACK"){rollbacks++;return{rows:[],rowCount:0};}
          if(sql==="COMMIT"){
            commits++;
            if(changes.claim)attempts.set(changes.claim.attemptId,{fingerprint:changes.claim.fp,id:changes.claim.id});
            if(changes.debit)balance-=changes.debit;
            if(changes.stockDebit){available-=changes.stockDebit;stockDebits++;}
            if(changes.ledger)ledger.push(changes.ledger);
            if(changes.order)orders.set(changes.order.id,changes.order);
            return{rows:[],rowCount:0};
          }
          if(sql.startsWith("INSERT INTO checkout_attempts")){
            if(attempts.has(args[0]))return{rowCount:0};
            changes.claim={attemptId:args[0],fp:args[1],id:args[2]};return{rowCount:1};
          }
          if(sql.startsWith("SELECT id,balance_paise,active,expires_at FROM gift_cards WHERE code=")){
            return args[0]===giftCode?{rowCount:1,rows:[{id:"card1",balance_paise:balance,active:true,expires_at:null}]}:{rowCount:0,rows:[]};
          }
          if(sql.startsWith("UPDATE gift_cards SET balance_paise=balance_paise-$2")){
            changes.debit+=args[1];updates++;return{rowCount:1};
          }
          if(sql.startsWith("INSERT INTO gift_card_redemptions")){
            changes.ledger={id:args[0],orderId:args[1],paise:args[2],actor:args[3]};
            return{rowCount:1};
          }
          if(sql.startsWith("SELECT id FROM inventory_variants WHERE product_id"))return{rowCount:1,rows:[{id:"inv-test"}]};
          if(sql.startsWith("UPDATE inventory_variants SET quantity=quantity-$4")){
            const qty=Number(args[3]);
            if(available-changes.stockDebit<qty)return{rowCount:0,rows:[]};
            changes.stockDebit+=qty;return{rowCount:1,rows:[{id:"inv-test"}]};
          }
          if(sql.startsWith("INSERT INTO orders(id,data)")){
            changes.order=JSON.parse(args[1]);return{rowCount:1};
          }
          throw Error("Unexpected transactional checkout query: "+sql.slice(0,100));
        },
        release(){}
      };
    }
  };
  require("../services/store/checkout")(app,{
    pool,cleanText,requireAdmin:()=>{},requireOwner:()=>{},audit:async()=>{},
    getProducts:async()=>[product],ensureCustomerRecord:async()=>{},
    safeEqual:(a,b)=>a===b
  });
  async function send(method,attemptId,extra={}){
    const body={attemptId,customer,items:[{id:product.id,color:"Black",size:"M",quantity:1}],
      expectedTotal:1000,...extra};
    const res=reply(),route=routes.get("POST "+(method==="GIFT"?"/api/orders/gift":"/api/orders/cod"));
    assert.equal(typeof route,"function");
    await route({body,headers:{},ip:"127.0.0.1"},res,e=>{throw e;});
    return res;
  }
  const first=await send("GIFT",crypto.randomUUID(),{giftCode});
  assert.equal(first.statusCode,201,JSON.stringify(first.body));
  assert.equal(first.body.ok,true);
  assert.equal(balance,0);
  assert.equal(ledger.length,1);
  assert.equal(ledger[0].paise,100000);
  const order=orders.get(first.body.orderId);
  assert.equal(order.paymentStatus,"paid");
  assert.equal(order.paymentMethod,"GIFT");
  assert.equal(order.orderStatus,"received");
  assert.equal(order.giftCardLast4,"AAAA");
  assert.ok(!JSON.stringify(order).includes(giftCode),"Raw gift code must not be stored in the order");

  // Same id and matching body must replay the existing order without another debit.
  const attempt=[...attempts.keys()][0];
  const repeated=await send("GIFT",attempt,{giftCode});
  assert.equal(repeated.body.orderId,first.body.orderId);
  assert.equal(balance,0);
  assert.equal(updates,1);
  assert.equal(ledger.length,1);

  const insufficient=await send("GIFT",crypto.randomUUID(),{giftCode});
  assert.equal(insufficient.statusCode,409);
  assert.match(insufficient.body.error,/insufficient/i);
  assert.equal(balance,0);assert.equal(orders.size,1);
  assert.ok(rollbacks>0);

  const invalid=await send("GIFT",crypto.randomUUID(),{giftCode:"not-valid"});
  assert.equal(invalid.statusCode,400);
  assert.equal(orders.size,1);

  const cod=await send("COD",crypto.randomUUID());
  assert.equal(cod.statusCode,201,JSON.stringify(cod.body));
  assert.equal(orders.get(cod.body.orderId).paymentStatus,"pending");
  assert.equal(balance,0);
  assert.equal(ledger.length,1);
  assert.ok(commits>=2);
  assert.equal(available,3,'One GIFT and one COD order must reserve one unit each');
  assert.equal(stockDebits,2,'Checkout idempotency must not double-debit stock');
  console.log("PASS checkout: funded gift-only orders debit once and rollback insufficient/invalid codes; COD still works");
}
async function addressesTest(){
  const {app,routes}=recorder(),records=new Map();
  const pool={async query(sql,args=[]){
    if(sql.startsWith("SELECT id,data FROM customer_addresses")){
      const rows=[...records.values()].filter(x=>x.user===args[0]).map(x=>({id:x.id,data:x.data}));
      return{rows,rowCount:rows.length};
    }
    if(sql.startsWith("SELECT COUNT(*)::integer AS n FROM customer_addresses")){
      return{rows:[{n:[...records.values()].filter(x=>x.user===args[0]).length}],rowCount:1};
    }
    if(sql.startsWith("INSERT INTO customer_addresses")){
      const [id,user,json]=args;const data=JSON.parse(json);
      records.set(id,{id,user,data});return{rows:[{id,data}],rowCount:1};
    }
    if(sql.startsWith("UPDATE customer_addresses")){
      const [id,user,json]=args,found=records.get(id);
      if(!found||found.user!==user)return{rows:[],rowCount:0};
      found.data=JSON.parse(json);return{rows:[{id,data:found.data}],rowCount:1};
    }
    if(sql.startsWith("DELETE FROM customer_addresses")){
      const [id,user]=args,found=records.get(id);
      if(!found||found.user!==user)return{rows:[],rowCount:0};
      records.delete(id);return{rows:[{id}],rowCount:1};
    }
    throw Error("Unexpected address DB query: "+sql);
  }};
  require("../services/store/customer-addresses")(app,{pool,cleanText});
  const call=async(method,path,user,body,params={})=>{
    const res=reply(),fn=routes.get(method+" "+path);
    await fn({session:{customer:{id:user}},body,params},res,e=>{throw e;});
    return res;
  };
  const first=await call("POST","/api/customer/addresses","cust-a",customer);
  assert.equal(first.statusCode,201,JSON.stringify(first.body));
  const id=first.body.address.id;
  assert.equal((await call("GET","/api/customer/addresses","cust-a")).body.addresses.length,1);
  assert.equal((await call("GET","/api/customer/addresses","cust-b")).body.addresses.length,0);
  const forbidden=await call("POST","/api/customer/addresses","cust-b",{...customer,id,city:"Other"});
  assert.equal(forbidden.statusCode,404);
  const leak=await call("DELETE","/api/customer/addresses/:id","cust-b",null,{id});
  assert.equal(leak.statusCode,404);
  const update=await call("POST","/api/customer/addresses","cust-a",{...customer,id,landmark:"Near Gate"});
  assert.equal(update.statusCode,200);
  assert.equal(update.body.address.landmark,"Near Gate");
  const invalid=await call("POST","/api/customer/addresses","cust-a",{...customer,postalCode:"abc"});
  assert.equal(invalid.statusCode,400);
  const removed=await call("DELETE","/api/customer/addresses/:id","cust-a",null,{id});
  assert.equal(removed.body.ok,true);
  assert.equal((await call("GET","/api/customer/addresses","cust-a")).body.addresses.length,0);
  console.log("PASS checkout: saved customer addresses are account-isolated, validated, editable and deletable");
}
(async()=>{await checkoutTest();await addressesTest();console.log("2/2 functional customer checkout API suites passed.");})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
