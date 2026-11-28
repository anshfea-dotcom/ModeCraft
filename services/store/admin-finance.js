"use strict";
const crypto=require("node:crypto");
const moneyPaise=value=>Math.round(Number(value)*100);
const reject=(status,message)=>Object.assign(new Error(message),{status});
module.exports=function registerAdminFinance(app,{pool,requireAdmin,requireOwner,cleanText,audit,getOrders}){
 app.get("/api/admin/gift-cards",requireAdmin,requireOwner,async(_req,res,next)=>{
   try{
     const r=await pool.query("SELECT code,initial_paise,balance_paise,customer_email,expires_at,active,created_at FROM gift_cards ORDER BY created_at DESC LIMIT 300");
     res.set("Cache-Control","no-store").json({cards:r.rows.map(x=>({...x,initialAmount:Number(x.initial_paise)/100,balance:Number(x.balance_paise)/100}))});
   }catch(e){next(e);}
 });
 app.post("/api/admin/gift-cards",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const amount=moneyPaise(req.body?.amount),email=cleanText(req.body?.customerEmail,254).toLowerCase();
     const expiresRaw=cleanText(req.body?.expiresAt,10);
     const expires=expiresRaw?new Date(expiresRaw+"T23:59:59.999Z"):null;
     if(!Number.isSafeInteger(amount)||amount<100||amount>100000000||expiresRaw&&(Number.isNaN(expires.getTime())||expires<new Date()))
       return res.status(400).json({error:"Enter a gift card value from ₹1 to ₹10 lakh and optional future expiry date."});
     if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Invalid recipient email."});
     const code="AEGC-"+crypto.randomBytes(8).toString("hex").toUpperCase();
     await pool.query("INSERT INTO gift_cards(code,initial_paise,balance_paise,customer_email,expires_at) VALUES($1,$2,$2,$3,$4)",
       [code,amount,email,expires]);
     await audit(req.adminSession,"giftcard.issued",{code,amount:amount/100});
     res.status(201).json({ok:true,code,balance:amount/100});
   }catch(e){next(e);}
 });
 app.patch("/api/admin/gift-cards/:code",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     if(typeof req.body?.active!=="boolean")return res.status(400).json({error:"Provide active true or false."});
     const r=await pool.query("UPDATE gift_cards SET active=$2,updated_at=NOW() WHERE code=$1 RETURNING code,active,balance_paise",
       [req.params.code,req.body.active]);
     if(!r.rowCount)return res.status(404).json({error:"Gift card not found."});
     await audit(req.adminSession,"giftcard.status.changed",{code:req.params.code,active:req.body.active});
     res.json({ok:true,card:{code:r.rows[0].code,active:r.rows[0].active,balance:Number(r.rows[0].balance_paise)/100}});
   }catch(e){next(e);}
 });
 app.get("/api/admin/wallets",requireAdmin,requireOwner,async(_req,res,next)=>{
   try{
     const [customers,ledger,policy]=await Promise.all([
       pool.query("SELECT c.id,c.name,c.email,COALESCE(SUM(w.amount_paise),0)::bigint AS balance_paise FROM customers c LEFT JOIN wallet_ledger w ON w.customer_id=c.id GROUP BY c.id,c.name,c.email ORDER BY c.name LIMIT 1000"),
       pool.query("SELECT w.id,w.customer_id,c.name,w.amount_paise,w.note,w.actor,w.created_at FROM wallet_ledger w JOIN customers c ON c.id=w.customer_id ORDER BY w.id DESC LIMIT 100"),
       pool.query("SELECT data FROM store_settings WHERE key='rewards_policy'")
     ]);
     res.set("Cache-Control","no-store").json({
       customers:customers.rows.map(c=>({...c,balance:Number(c.balance_paise)/100})),
       ledger:ledger.rows.map(l=>({...l,amount:Number(l.amount_paise)/100})),
       rewardPercent:Number(policy.rows[0]?.data?.rewardPercent||0)
     });
   }catch(e){next(e);}
 });
 app.post("/api/admin/wallets/adjust",requireAdmin,requireOwner,async(req,res,next)=>{
   let client;
   try{
     const customerId=cleanText(req.body?.customerId,100),amount=moneyPaise(req.body?.amount),note=cleanText(req.body?.note,180);
     if(!customerId||!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>100000000||note.length<3)
       return res.status(400).json({error:"Select customer, positive or negative amount up to ₹10 lakh and explain the adjustment."});
     client=await pool.connect();await client.query("BEGIN");
     const c=await client.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE",[customerId]);
     if(!c.rowCount)throw reject(404,"Customer not found.");
     const current=await client.query("SELECT COALESCE(SUM(amount_paise),0)::bigint AS amount FROM wallet_ledger WHERE customer_id=$1",[customerId]);
     const after=Number(current.rows[0].amount)+amount;
     if(after<0)throw reject(409,"Wallet cannot become negative.");
     await client.query("INSERT INTO wallet_ledger(customer_id,amount_paise,note,actor) VALUES($1,$2,$3,$4)",
       [customerId,amount,note,req.adminSession.username]);
     await client.query("COMMIT");client.release();client=null;
     await audit(req.adminSession,"wallet.adjusted",{customerId,amount:amount/100});
     res.status(201).json({ok:true,balance:after/100});
   }catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)res.status(e.status).json({error:e.message});else next(e);}
   finally{client?.release();}
 });
 app.put("/api/admin/rewards/policy",requireAdmin,requireOwner,async(req,res,next)=>{
   try{
     const rewardPercent=Number(req.body?.rewardPercent);
     if(!Number.isFinite(rewardPercent)||rewardPercent<0||rewardPercent>10)return res.status(400).json({error:"Reward percentage must be between 0 and 10."});
     const policy={rewardPercent};
     await pool.query("INSERT INTO store_settings(key,data,updated_at) VALUES('rewards_policy',$1::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()",[JSON.stringify(policy)]);
     await audit(req.adminSession,"wallet.rewards.policy.updated",{rewardPercent});
     res.json({ok:true,policy});
   }catch(e){next(e);}
 });
 app.get("/api/admin/affiliates/commissions",requireAdmin,requireOwner,async(_req,res,next)=>{
   try{
     const [records,orders]=await Promise.all([
       pool.query("SELECT data,active FROM admin3_records WHERE kind='affiliate' ORDER BY updated_at DESC"),
       getOrders()
     ]);
     const affiliates=records.rows.map(r=>{
       const code=r.data.code;
       const qualifying=orders.filter(o=>o.paymentStatus==="paid"&&o.affiliate?.code===code);
       return{...r.data,active:r.active,orders:qualifying.length,
         paidRevenue:qualifying.reduce((sum,o)=>sum+Number(o.total||0),0),
         commission:qualifying.reduce((sum,o)=>sum+Math.round(Number(o.total||0)*Number(o.affiliate?.rate||0))/100,0)};
     });
     res.json({affiliates});
   }catch(e){next(e);}
 });
};
