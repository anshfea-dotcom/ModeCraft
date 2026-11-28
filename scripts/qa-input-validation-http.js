"use strict";
const assert = require("node:assert/strict");
const express = require("express");
const { validateInput } = require("../services/store/validate-input");

async function main() {
  const app=express();
  app.use(express.json({limit:"100kb"}));
  app.use((err,_req,res,next)=>{
    if(err?.type==="entity.parse.failed")return res.status(400).json({error:"Malformed JSON request."});
    next(err);
  });
  app.use(validateInput);
  app.post("/api/auth/login",(req,res)=>res.json({accepted:req.body}));
  app.post("/api/auth/signup",(req,res)=>res.json({accepted:req.body}));
  app.get("/api/products",(req,res)=>res.json({ok:true}));
  app.get("/api/orders/track",(req,res)=>res.json({ok:true}));
  app.patch("/api/admin/products/:id",(req,res)=>res.json({accepted:req.body,productId:req.params.id}));
  app.use((_req,res)=>res.status(404).json({error:"Not found."}));
  const server=await new Promise(resolve=>{
    const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));
  });
  const base="http://127.0.0.1:"+server.address().port;
  async function send(method,payload,resource,headers={}) {
    const h={...headers};
    if(payload!==undefined && !("content-type" in h))h["content-type"]="application/json";
    const response=await fetch(base+resource,{
      method,headers:h,body:payload===undefined?undefined:typeof payload==="string"?payload:JSON.stringify(payload)
    });
    return {status:response.status,body:await response.json()};
  }
  try{
    let result=await send("POST",{email:"USER@example.com",password:"secret123"},"/api/auth/login");
    assert.equal(result.status,200);
    assert.equal(result.body.accepted.email,"user@example.com","Normalized email should reach handler");

    result=await send("POST",{email:"a@example.com",password:"secret123",role:"owner"},"/api/auth/login");
    assert.equal(result.status,400);
    result=await send("POST",{name:"<script>alert(1)</script>",email:"a@example.com",phone:"9876543210",password:"password123"},"/api/auth/signup");
    assert.equal(result.status,400);
    result=await send("POST",'{"email":"bad","password":',"/api/auth/login");
    assert.equal(result.status,400);
    result=await send("POST","email=a%40example.com&password=abc","/api/auth/login",{"content-type":"application/x-www-form-urlencoded"});
    assert.equal(result.status,400);
    result=await send("GET",undefined,"/api/products?isPaid=true");
    assert.equal(result.status,400);
    result=await send("GET",undefined,"/api/products");
    assert.equal(result.status,200);
    result=await send("GET",undefined,"/api/products",{cookie:"aerlon_aff=malformed<script>"});
    assert.equal(result.status,400);
    result=await send("PATCH",{name:"Premium Shirt",active:false},"/api/admin/products/mc-prod-123");
    assert.equal(result.status,200);
    result=await send("PATCH",{name:"Premium Shirt",isPaid:true},"/api/admin/products/mc-prod-123");
    assert.equal(result.status,400);
    result=await send("PATCH",{name:"Premium Shirt"},"/api/admin/products/%2e%2e%2fsecret");
    assert.equal(result.status,400);
    result=await send("GET",undefined,"/api/unknown-created-without-schema");
    assert.equal(result.status,404);
    console.log("Real Express HTTP validation checks passed: JSON, params, query, cookies, HTML, extra fields and fail-closed routes.");
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
