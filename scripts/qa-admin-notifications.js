"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const routes=new Map(),records=new Map(),audits=[];
const app={
  get:(path,...handlers)=>routes.set("GET "+path,handlers.at(-1)),
  post:(path,...handlers)=>routes.set("POST "+path,handlers.at(-1))
};
const pool={async query(sql,values){
  if(sql.startsWith("SELECT notification_key FROM admin_notification_deletions")){
    const user=values[0];
    return{rows:[...(records.get(user)||[])].map(notification_key=>({notification_key}))};
  }
  if(sql.startsWith("INSERT INTO admin_notification_deletions")){
    const user=values[0],keys=values[1],set=records.get(user)||new Set();
    keys.forEach(key=>set.add(key));records.set(user,set);
    return{rowCount:keys.length};
  }
  throw Error("Unexpected or destructive SQL: "+sql);
}};
require("../services/store/admin-notifications")(app,{
  pool,requireAdmin:(_req,_res,next)=>next(),
  audit:async(...args)=>audits.push(args)
});
function makeResponse(){
  return {
    code:200,body:null,headers:{},
    status(c){this.code=c;return this},
    json(data){this.body=data;return this},
    set(key,value){this.headers[key]=value;return this}
  };
}
async function call(method,path,username,body){
  const req={adminSession:{username},body};
  const res=makeResponse();
  await routes.get(method+" "+path)(req,res,err=>{throw err});
  return res;
}
(async()=>{
  const deleteRoute="/api/admin/notifications/delete",listRoute="/api/admin/notifications/deleted";
  assert.equal((await call("GET",listRoute,"owner")).body.deletedKeys.length,0);
  const keys=["order:AER-200:processing","stock:inv_1:0","payment:AER-200:pending"];
  assert.equal((await call("POST",deleteRoute,"owner",{keys})).body.deleted,3);
  assert.deepEqual(new Set((await call("GET",listRoute,"owner")).body.deletedKeys),new Set(keys));
  assert.equal((await call("GET",listRoute,"staff")).body.deletedKeys.length,0,"Staff must not see owner's deleted-notification state");
  assert.equal((await call("POST",deleteRoute,"owner",{keys:[keys[0],keys[0]]})).body.deleted,1,"Repeated deletions are idempotent");
  const forbidden=await call("POST",deleteRoute,"owner",{keys:["../../orders/123"]});
  assert.equal(forbidden.code,400);
  const tooMany=await call("POST",deleteRoute,"owner",{keys:Array.from({length:101},(_,i)=>"order:x"+i)});
  assert.equal(tooMany.code,400);
  const noActor=await call("POST",deleteRoute,"",{keys:[keys[0]]});
  assert.equal(noActor.code,401);
  const schema=fs.readFileSync("services/store/schema.js","utf8");
  assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS admin_notification_deletions"));
  assert.ok(audits.some(a=>a[1]==="admin.notification.deleted"));
  console.log("PASS: authenticated notification deletion persists per administrator without altering source records");
})().catch(e=>{console.error(e);process.exitCode=1;});
