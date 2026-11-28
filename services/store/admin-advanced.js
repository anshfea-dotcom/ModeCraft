"use strict";
const crypto=require("node:crypto");
const {rateLimit}=require("express-rate-limit");
const KINDS=new Set(["warehouse","affiliate","collection","automation"]);
const EVENTS=new Set(["product.created","product.updated","order.status.updated","inventory.variant.saved","pos.sale.created","invoice.issued","staff.created"]);
const fail=(status,message)=>Object.assign(new Error(message),{status});
module.exports=function registerAdvancedManagement(app,{pool,requireAdmin,requireOwner,cleanText,audit}){
 const clean=(v,n=180)=>cleanText(v,n);
 function validate(kind,input={}){
   if(kind==="warehouse"){
     const name=clean(input.name,100),address=clean(input.address,250),city=clean(input.city,80),state=clean(input.state,70),pincode=clean(input.pincode,6);
     if(name.length<2||address.length<5||!city||!state||!/^[1-9][0-9]{5}$/.test(pincode))throw fail(400,"Warehouse needs name, address, city, state and six-digit PIN.");
     return{name,address,city,state,pincode,phone:clean(input.phone,30)};
   }
   if(kind==="affiliate"){
     const name=clean(input.name,100),code=clean(input.code,32).toUpperCase(),rate=Number(input.commissionPercent);
     if(name.length<2||!/^[A-Z0-9_-]{4,32}$/.test(code)||!Number.isFinite(rate)||rate<0||rate>50)throw fail(400,"Enter affiliate name, referral code and 0–50% commission.");
     return{name,code,commissionPercent:rate,contactEmail:clean(input.contactEmail,254)};
   }
   if(kind==="collection"){
     const name=clean(input.name,100),slug=clean(input.slug,80).toLowerCase();
     if(name.length<2||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw fail(400,"Collection needs a name and lowercase URL slug.");
     const productIds=[...new Set(String(input.productIds||"").split(",").map(x=>clean(x.trim(),150)).filter(Boolean))].slice(0,100);
     return{name,slug,productIds};
   }
   if(kind==="automation"){
     const name=clean(input.name,90),event=clean(input.event,50),message=clean(input.message,250);
     if(name.length<2||!EVENTS.has(event)||message.length<3)throw fail(400,"Choose a supported event and an alert message.");
     return{name,event,message};
   }
   throw fail(404,"Module not found.");
 }
 function publicItem(row){return{id:row.id,kind:row.kind,code:row.code,active:row.active,...row.data,createdAt:row.created_at,updatedAt:row.updated_at};}
 app.get("/api/admin/advanced/:kind",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     if(!KINDS.has(req.params.kind))return res.status(404).json({error:"Module not found."});
     const q=await pool.query("SELECT * FROM admin3_records WHERE kind=$1 ORDER BY updated_at DESC LIMIT 500",[req.params.kind]);
     res.set("Cache-Control","no-store").json({items:q.rows.map(publicItem)});
   }catch(e){next(e);}
 });
 app.post("/api/admin/advanced/:kind",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const kind=req.params.kind,record=validate(kind,req.body);
     const code=kind==="affiliate"?record.code:kind==="collection"?record.slug:crypto.randomUUID();
     const id=crypto.randomUUID();
     const q=await pool.query("INSERT INTO admin3_records(id,kind,code,data,active) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
       [id,kind,code,JSON.stringify(record),req.body?.active!==false]);
     await audit(req.adminSession,"advanced."+kind+".created",{recordId:id});
     res.status(201).json({ok:true,item:publicItem(q.rows[0])});
   }catch(e){if(e.code==="23505")return res.status(409).json({error:"This code or slug is already in use."});if(e.status)return res.status(e.status).json({error:e.message});next(e);}
 });
 app.patch("/api/admin/advanced/:kind/:id",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const kind=req.params.kind;if(!KINDS.has(kind))return res.status(404).json({error:"Module not found."});
     const old=await pool.query("SELECT * FROM admin3_records WHERE kind=$1 AND id=$2",[kind,req.params.id]);
     if(!old.rowCount)return res.status(404).json({error:"Record not found."});
     const data=validate(kind,{...old.rows[0].data,...req.body});
     const code=kind==="affiliate"?data.code:kind==="collection"?data.slug:old.rows[0].code;
     const q=await pool.query("UPDATE admin3_records SET code=$3,data=$4::jsonb,active=$5,updated_at=NOW() WHERE kind=$1 AND id=$2 RETURNING *",
       [kind,req.params.id,code,JSON.stringify(data),req.body?.active===undefined?old.rows[0].active:req.body.active===true]);
     await audit(req.adminSession,"advanced."+kind+".updated",{recordId:req.params.id});
     res.json({ok:true,item:publicItem(q.rows[0])});
   }catch(e){if(e.code==="23505")return res.status(409).json({error:"This code or slug is already in use."});if(e.status)return res.status(e.status).json({error:e.message});next(e);}
 });
 app.get("/api/storefront/collections",async(_req,res,next)=>{
   try{
     const r=await pool.query("SELECT data FROM admin3_records WHERE kind='collection' AND active=TRUE ORDER BY updated_at DESC LIMIT 50");
     res.set("Cache-Control","public, max-age=30").json({collections:r.rows.map(x=>x.data)});
   }catch(e){next(e);}
 });
 const supportLimit=rateLimit({windowMs:60*60*1000,limit:5,standardHeaders:"draft-7",legacyHeaders:false,
   message:{error:"Too many messages. Please try again later."}});
 app.post("/api/support/tickets",supportLimit,async(req,res,next)=>{
   try{
     const name=clean(req.body?.name,90),email=clean(req.body?.email,254).toLowerCase(),subject=clean(req.body?.subject,140),message=clean(req.body?.message,1200);
     if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||subject.length<3||message.length<10)
       return res.status(400).json({error:"Enter your name, valid email, subject and a message of at least 10 characters."});
     const id=crypto.randomUUID(),code="TKT-"+crypto.randomBytes(5).toString("hex").toUpperCase();
     await pool.query("INSERT INTO admin3_records(id,kind,code,data,active) VALUES($1,'support_ticket',$2,$3::jsonb,TRUE)",
       [id,code,JSON.stringify({name,email,subject,message,status:"open",createdAt:new Date().toISOString()})]);
     res.status(201).json({ok:true,ticket:code});
   }catch(e){next(e);}
 });
 app.get("/api/admin/support/tickets",requireAdmin,requireOwner,async(_req,res,next)=>{
   try{
     const q=await pool.query("SELECT * FROM admin3_records WHERE kind='support_ticket' ORDER BY created_at DESC LIMIT 500");
     res.set("Cache-Control","no-store").json({tickets:q.rows.map(publicItem)});
   }catch(e){next(e);}
 });
 app.patch("/api/admin/support/tickets/:id",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const status=clean(req.body?.status,20);
     if(!["open","in_progress","resolved"].includes(status))return res.status(400).json({error:"Invalid ticket status."});
     const q=await pool.query("UPDATE admin3_records SET data=jsonb_set(data,'{status}',to_jsonb($2::text)),updated_at=NOW() WHERE id=$1 AND kind='support_ticket' RETURNING *",
       [req.params.id,status]);
     if(!q.rowCount)return res.status(404).json({error:"Ticket not found."});
     await audit(req.adminSession,"support.status.updated",{ticketId:req.params.id,status});
     res.json({ok:true,ticket:publicItem(q.rows[0])});
   }catch(e){next(e);}
 });
 app.get("/api/admin/notifications",requireAdmin,requireOwner,async(_req,res,next)=>{
   try{const r=await pool.query("SELECT * FROM admin_notifications ORDER BY id DESC LIMIT 100");
      res.set("Cache-Control","no-store").json({notifications:r.rows});}
   catch(e){next(e);}
 });
 app.patch("/api/admin/notifications/:id/read",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const r=await pool.query("UPDATE admin_notifications SET read_at=NOW() WHERE id=$1 RETURNING id",[req.params.id]);
     res.status(r.rowCount?200:404).json(r.rowCount?{ok:true}:{error:"Alert not found."});
   }catch(e){next(e);}
 });
 app.get("/api/admin/seo",requireAdmin,requireOwner,async(_req,res,next)=>{
   try{const r=await pool.query("SELECT data FROM store_settings WHERE key='seo_profile'");
      res.json({seo:r.rows[0]?.data||{}});}
   catch(e){next(e);}
 });
 app.put("/api/admin/seo",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const title=clean(req.body?.title,70),description=clean(req.body?.description,160),
           socialImage=clean(req.body?.socialImage,800);
     if(title.length<5||description.length<25||(socialImage&&!/^https:\/\//i.test(socialImage)))
       return res.status(400).json({error:"Enter a 5–70 character title, 25–160 character description, and optional HTTPS share image."});
     const data={title,description,socialImage};
     await pool.query("INSERT INTO store_settings(key,data,updated_at) VALUES('seo_profile',$1::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()",[JSON.stringify(data)]);
     await audit(req.adminSession,"seo.updated");
     res.json({ok:true,seo:data});
   }catch(e){next(e);}
 });
};
