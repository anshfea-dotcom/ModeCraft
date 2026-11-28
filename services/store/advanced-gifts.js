"use strict";
const crypto=require("node:crypto");
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const read=(v,max)=>String(v||"").trim().slice(0,max);
const toPaise=v=>Math.round(Number(v)*100);
module.exports=function registerGiftCards(app,{pool,requireAdmin,requireOwner,audit}){
  app.get("/api/admin/gift-cards",requireAdmin,requireOwner,async(_req,res,next)=>{
    try{
      const r=await pool.query("SELECT id,code,label,initial_paise,balance_paise,active,funding_ref,expires_at,created_at FROM gift_cards ORDER BY created_at DESC LIMIT 500");
      res.set("Cache-Control","no-store").json({cards:r.rows,checkoutRedemptionEnabled:true});
    }catch(e){next(e);}
  });
  app.post("/api/admin/gift-cards",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const label=read(req.body?.label,100),amount=toPaise(req.body?.amount),expiry=req.body?.expiresAt?new Date(req.body.expiresAt):null;
      if(label.length<2||!Number.isSafeInteger(amount)||amount<5000||amount>10000000)throw fail("Enter a label and value between Rs 50 and Rs 100,000.");
      if(expiry&&(!Number.isFinite(expiry.getTime())||expiry.getTime()<=Date.now()))throw fail("Expiration must be in the future.");
      const id=crypto.randomUUID(),code="AGC-"+crypto.randomBytes(12).toString("hex").toUpperCase();
      await pool.query("INSERT INTO gift_cards(id,code,label,initial_paise,balance_paise,active,expires_at) VALUES($1,$2,$3,$4,$4,FALSE,$5)",[id,code,label,amount,expiry?.toISOString()||null]);
      await audit(req.adminSession,"gift_card.issued_draft",{id,amount});
      res.status(201).json({ok:true,card:{id,code,label,initial_paise:amount,balance_paise:amount,active:false}});
    }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.patch("/api/admin/gift-cards/:id",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const reference=read(req.body?.fundingReference,100);
      const active=req.body?.active===true;
      if(active&&reference.length<4)throw fail("Record the verified funding reference before activating a card.");
      const r=await pool.query("UPDATE gift_cards SET active=$2,funding_ref=CASE WHEN $2 THEN $3 ELSE funding_ref END,updated_at=NOW() WHERE id=$1 RETURNING id,code,active",[req.params.id,active,reference]);
      if(!r.rowCount)return res.status(404).json({error:"Gift card not found."});
      await audit(req.adminSession,"gift_card.status_updated",{id:req.params.id,active});
      res.json({ok:true,card:r.rows[0]});
    }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.post("/api/admin/gift-cards/:id/redeem",requireAdmin,requireOwner,async(req,res,next)=>{
    let client;
    try{
      const amount=toPaise(req.body?.amount),reference=read(req.body?.reference,100);
      if(!Number.isSafeInteger(amount)||amount<1||reference.length<4)throw fail("Enter a positive redemption amount and unique offline transaction reference.");
      client=await pool.connect();await client.query("BEGIN");
      const record=await client.query("SELECT id,active,balance_paise,expires_at FROM gift_cards WHERE id=$1 FOR UPDATE",[req.params.id]);
      const card=record.rows[0];
      if(!card)throw fail("Gift card not found.",404);
      if(!card.active||card.expires_at&&new Date(card.expires_at)<new Date())throw fail("Gift card is inactive or expired.",409);
      if(amount>Number(card.balance_paise))throw fail("Insufficient gift card balance.",409);
      const ledger=await client.query("INSERT INTO gift_card_redemptions(card_id,reference,amount_paise,actor) VALUES($1,$2,$3,$4) ON CONFLICT(card_id,reference) DO NOTHING RETURNING id",[card.id,reference,amount,req.adminSession.username]);
      if(!ledger.rowCount)throw fail("This offline redemption reference has already been used.",409);
      const nextBalance=Number(card.balance_paise)-amount;
      await client.query("UPDATE gift_cards SET balance_paise=$2,updated_at=NOW() WHERE id=$1",[card.id,nextBalance]);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,"gift_card.offline_redeemed",{id:card.id,amount,reference});
      res.json({ok:true,remainingPaise:nextBalance});
    }catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)return res.status(e.status).json({error:e.message});next(e);}
    finally{client?.release();}
  });
  app.post("/api/gift-cards/check",async(req,res,next)=>{
    try{
      const code=read(req.body?.code,60).toUpperCase();
      if(!/^AGC-[A-F0-9]{24}$/.test(code))return res.status(404).json({error:"Gift card not found."});
      const r=await pool.query("SELECT balance_paise,active,expires_at FROM gift_cards WHERE code=$1",[code]);
      const row=r.rows[0];
      if(!row||!row.active||row.expires_at&&new Date(row.expires_at)<new Date())return res.status(404).json({error:"Gift card unavailable."});
      res.set("Cache-Control","no-store").json({ok:true,balance:row.balance_paise/100,currency:"INR",checkoutRedemptionEnabled:true});
    }catch(e){next(e);}
  });
};