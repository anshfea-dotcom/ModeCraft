"use strict";
const crypto=require("node:crypto");
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const clean=(value,max=100)=>String(value||"").trim().slice(0,max);
const key=()=>process.env.SESSION_SECRET||process.env.ADMIN_PASSWORD;
function signature(code){return crypto.createHmac("sha256",key()).update("aerlon_aff_v1:"+code).digest("hex");}
function readCode(req){
  const cookies=String(req.headers?.cookie||"").split(";").map(v=>v.trim());
  const data=cookies.find(c=>c.startsWith("aerlon_aff="))?.slice(11)||"";
  const dot=data.indexOf(".");
  if(dot<1)return null;
  const code=data.slice(0,dot),mac=data.slice(dot+1);
  if(!/^[A-Z0-9_-]{4,24}$/.test(code)||! /^[a-f0-9]{64}$/.test(mac))return null;
  const expected=signature(code);
  return crypto.timingSafeEqual(Buffer.from(mac,"hex"),Buffer.from(expected,"hex"))?code:null;
}
async function affiliateFromRequest(req,pool){
  const code=readCode(req);
  if(!code)return null;
  const r=await pool.query("SELECT code,commission_rate FROM affiliates WHERE code=$1 AND active=TRUE",[code]);
  if(!r.rowCount)return null;
  return {code:r.rows[0].code,rate:Number(r.rows[0].commission_rate)};
}
module.exports=function registerAffiliates(app,{pool,requireAdmin,requireOwner,audit}){
  app.get("/r/:code",async(req,res,next)=>{
    try{
      const code=clean(req.params.code,24).toUpperCase();
      if(!/^[A-Z0-9_-]{4,24}$/.test(code))return res.redirect(302,"/");
      const r=await pool.query("UPDATE affiliates SET clicks=clicks+1 WHERE code=$1 AND active=TRUE RETURNING code",[code]);
      if(r.rowCount)res.cookie("aerlon_aff",code+"."+signature(code),{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",maxAge:30*24*60*60*1000,path:"/"});
      res.redirect(302,"/");
    }catch(e){next(e);}
  });
  app.get("/api/admin/affiliates",requireAdmin,requireOwner,async(_req,res,next)=>{
    try{
      const [r,orders]=await Promise.all([
        pool.query("SELECT id,code,name,commission_rate,active,clicks,created_at FROM affiliates ORDER BY created_at DESC LIMIT 500"),
        pool.query("SELECT data FROM orders WHERE data->>'affiliateCode' IS NOT NULL")
      ]);
      const affiliates=r.rows.map(a=>{
        const paid=orders.rows.map(x=>x.data).filter(o=>o.affiliateCode===a.code&&o.paymentStatus==="paid"&&o.orderStatus!=="cancelled");
        const paidTotal=paid.reduce((sum,o)=>sum+Number(o.total||0),0);
        const earned=paid.reduce((sum,o)=>sum+Math.round(Number(o.total||0)*Number(o.affiliateRate||0))/100,0);
        return {...a,paidOrders:paid.length,paidSales:Math.round(paidTotal*100)/100,earned:Math.round(earned*100)/100,link:"https://aerlon.in/r/"+a.code};
      });
      res.set("Cache-Control","no-store").json({affiliates,payoutsAutomated:false});
    }catch(e){next(e);}
  });
  app.post("/api/admin/affiliates",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const name=clean(req.body?.name,100),code=clean(req.body?.code,24).toUpperCase(),rate=Number(req.body?.commissionRate);
      if(name.length<2||!/^[A-Z0-9_-]{4,24}$/.test(code)||!Number.isFinite(rate)||rate<0||rate>30||Math.abs(rate*100-Math.round(rate*100))>1e-6)
        throw fail("Enter a name, 4–24 character code and commission from 0–30%.");
      const id=crypto.randomUUID();
      await pool.query("INSERT INTO affiliates(id,code,name,commission_rate,active) VALUES($1,$2,$3,$4,TRUE)",[id,code,name,rate]);
      await audit(req.adminSession,"affiliate.created",{id,code});
      res.status(201).json({ok:true,id,code,link:"https://aerlon.in/r/"+code});
    }catch(e){if(e.code==="23505")return res.status(409).json({error:"Affiliate code already exists."});if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.patch("/api/admin/affiliates/:id",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const r=await pool.query("SELECT id,name,active,commission_rate FROM affiliates WHERE id=$1",[req.params.id]);
      if(!r.rowCount)return res.status(404).json({error:"Affiliate not found."});
      const old=r.rows[0];
      const name=req.body?.name===undefined?old.name:clean(req.body.name,100);
      const rate=req.body?.commissionRate===undefined?Number(old.commission_rate):Number(req.body.commissionRate);
      const active=req.body?.active===undefined?old.active:req.body.active===true;
      if(name.length<2||!Number.isFinite(rate)||rate<0||rate>30||Math.abs(rate*100-Math.round(rate*100))>1e-6)throw fail("Invalid name or commission rate.");
      await pool.query("UPDATE affiliates SET name=$2,commission_rate=$3,active=$4,updated_at=NOW() WHERE id=$1",[req.params.id,name,rate,active]);
      await audit(req.adminSession,"affiliate.updated",{id:req.params.id,active});
      res.json({ok:true});
    }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
};
module.exports.affiliateFromRequest=affiliateFromRequest;
module.exports.readAffiliateCode=readCode;