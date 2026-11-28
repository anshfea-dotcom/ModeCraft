"use strict";
const crypto=require("node:crypto");
const {remainingSession}=require("./session-policy");
module.exports=function registerCustomerAddresses(app,{pool,cleanText}){
  async function requireCustomer(req,res,next){
    try{
      res.set("Cache-Control","no-store");
      const remaining=await remainingSession(pool,req,"customer",true);
      if(!remaining||!req.session?.customer?.id)return res.status(401).json({error:"Sign in to save addresses to your account."});
      res.set("X-Customer-Remaining-Ms",String(remaining));
      next();
    }catch(error){next(error);}
  }
  const fields={name:100,phone:10,email:180,postalCode:6,city:100,state:100,house:100,address:180,landmark:100,addressType:12};
  function normalize(raw){
    const result={};
    for(const [key,max] of Object.entries(fields))result[key]=cleanText(raw?.[key],max);
    if(!result.name||!/^[6-9]\d{9}$/.test(result.phone)||
       !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)||
       !/^[1-9]\d{5}$/.test(result.postalCode)||
       !result.city||!result.state||!result.house||!result.address||
       !["Home","Work","Other"].includes(result.addressType)){
      const err=new Error("Complete your delivery address, valid email, 10-digit phone and 6-digit PIN before saving.");err.status=400;throw err;
    }
    return result;
  }
  app.get("/api/customer/addresses",requireCustomer,async(req,res,next)=>{
    try{
      const rows=await pool.query(
        "SELECT id,data FROM customer_addresses WHERE customer_id=$1 ORDER BY updated_at DESC LIMIT 10",
        [req.session.customer.id]
      );
      res.json({addresses:rows.rows.map(r=>({id:r.id,...r.data}))});
    }catch(e){next(e);}
  });
  app.post("/api/customer/addresses",requireCustomer,async(req,res,next)=>{
    try{
      const data=normalize(req.body);
      const id=typeof req.body?.id==="string"&&/^[0-9a-f-]{36}$/i.test(req.body.id)?req.body.id:null;
      const user=req.session.customer.id;
      let saved;
      if(id){
        saved=await pool.query(
          `UPDATE customer_addresses SET data=$3::jsonb,updated_at=NOW()
           WHERE id=$1 AND customer_id=$2 RETURNING id,data`,
          [id,user,JSON.stringify(data)]
        );
        if(!saved.rowCount)return res.status(404).json({error:"Saved address not found in your account."});
      }else{
        const count=await pool.query("SELECT COUNT(*)::integer AS n FROM customer_addresses WHERE customer_id=$1",[user]);
        if(Number(count.rows[0]?.n)>=10)return res.status(409).json({error:"You can keep up to 10 saved addresses. Delete one to add another."});
        saved=await pool.query(
          `INSERT INTO customer_addresses(id,customer_id,data)
           VALUES($1,$2,$3::jsonb) RETURNING id,data`,
          [crypto.randomUUID(),user,JSON.stringify(data)]
        );
      }
      res.status(id?200:201).json({ok:true,address:{id:saved.rows[0].id,...saved.rows[0].data}});
    }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.delete("/api/customer/addresses/:id",requireCustomer,async(req,res,next)=>{
    try{
      if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:"Invalid saved address."});
      const result=await pool.query("DELETE FROM customer_addresses WHERE id=$1 AND customer_id=$2 RETURNING id",
        [req.params.id,req.session.customer.id]);
      if(!result.rowCount)return res.status(404).json({error:"Saved address not found."});
      res.json({ok:true});
    }catch(e){next(e);}
  });
};
