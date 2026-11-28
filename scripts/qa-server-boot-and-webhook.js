"use strict";
// Launch real gateway against disposable CI Postgres; detect runtime boot bugs.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");
const database=process.env.RATE_LIMIT_TEST_DATABASE_URL;
if (!database || !/localhost|127\.0\.0\.1/.test(database))
  throw new Error("Startup smoke requires a disposable local CI database");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function reservePort(){
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  return port;
}
async function run(){
  const port=await reservePort(), logs=[];
  const secret="ci-only-razorpay-webhook-test-secret";
  const child=spawn(process.execPath,["server.js"],{
    env:{...process.env,PORT:String(port),NODE_ENV:"test",DATABASE_URL:database,
      ADMIN_USERNAME:"ci-admin",ADMIN_PASSWORD:"ci-only-admin-password",
      SESSION_SECRET:"ci-only-secure-session-secret-12345",
      RATE_LIMIT_KEY_SECRET:"ci-only-rate-limit-secret-12345",
      RAZORPAY_WEBHOOK_SECRET:secret,TRUSTED_PROXY_CIDRS:"",
      RAZORPAY_KEY_ID:"",RAZORPAY_KEY_SECRET:"",RESEND_API_KEY:""},
    stdio:["ignore","pipe","pipe"]
  });
  for(const stream of [child.stdout,child.stderr])
    stream.on("data",buf=>{logs.push(buf.toString().slice(0,1500));if(logs.length>100)logs.shift();});
  const base="http://127.0.0.1:"+port;
  try {
    let ready=false;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw Error("Gateway crashed before ready: "+logs.join("").slice(-3000));
      try{const response=await fetch(base+"/health",{signal:AbortSignal.timeout(1000)});
        if(response.status===200){ready=true;break;}
      }catch{}
      await delay(150);
    }
    if(!ready)throw Error("Gateway boot timeout: "+logs.join("").slice(-3000));
    let res=await fetch(base+"/api/auth/login",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({email:"ci@example.com",password:"test",role:"admin"})});
    assert.equal(res.status,400,"Mass assignment accepted");
    res=await fetch(base+"/api/products?isPaid=true");
    assert.equal(res.status,400,"Unlisted query accepted");
    const body=JSON.stringify({event:"payment.failed",payload:{}});
    const signature=crypto.createHmac("sha256",secret).update(body).digest("hex");
    res=await fetch(base+"/api/razorpay/webhook",{
      method:"POST",headers:{"content-type":"application/json","x-razorpay-signature":signature},body});
    assert.equal(res.status,200,"Signed webhook rejected");
    res=await fetch(base+"/api/razorpay/webhook",{
      method:"POST",headers:{"content-type":"application/json","x-razorpay-signature":"000000"},body});
    assert.equal(res.status,400,"Forged webhook accepted");
    for(let i=0;i<6;i++){
      res=await fetch(base+"/api/auth/login",{
        method:"POST",headers:{"content-type":"application/json","x-forwarded-for":"203.0.113."+(i+1)},
        body:JSON.stringify({email:"ci-"+i+"@example.test",password:"wrong"})});
      assert.equal(res.status,i<5?401:429,"Spoofed client IP evaded quota on request "+(i+1));
      if(i===5)assert.ok(Number(res.headers.get("retry-after"))>=1);
    }
    console.log("PASS: full startup, DB health, Zod rejection, signed/forged webhook and XFF-spoof quota");
  } finally {
    child.kill("SIGTERM");
    for(let i=0;i<30&&child.exitCode===null;i++)await delay(100);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
}
run().catch(error=>{console.error(error);process.exitCode=1});
