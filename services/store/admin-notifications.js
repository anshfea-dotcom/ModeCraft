"use strict";

// Store UI-only notification deletions by authenticated admin identity.
// Never alter underlying orders, stock, payment records or automation history.
module.exports=function registerAdminNotifications(app,{pool,requireAdmin,audit}){
  const actorOf=req=>String(req.adminSession?.username||req.session?.admin?.username||"").trim().toLowerCase();
  const keyIsValid=key=>typeof key==="string" && key.length>0 && key.length<=240 &&
    /^(order|payment|stock|automation):[a-zA-Z0-9:_-]+$/.test(key);
  app.get("/api/admin/notifications/deleted",requireAdmin,async(req,res,next)=>{
    try{
      const actor=actorOf(req);
      if(!actor)return res.status(401).json({error:"Authentication required."});
      const result=await pool.query(
        "SELECT notification_key FROM admin_notification_deletions WHERE actor=$1 ORDER BY deleted_at DESC LIMIT 10000",
        [actor]
      );
      res.set("Cache-Control","no-store").json({deletedKeys:result.rows.map(row=>row.notification_key)});
    }catch(err){next(err);}
  });
  app.post("/api/admin/notifications/delete",requireAdmin,async(req,res,next)=>{
    try{
      const actor=actorOf(req);
      if(!actor)return res.status(401).json({error:"Authentication required."});
      const keys=req.body?.keys;
      if(!Array.isArray(keys)||keys.length<1||keys.length>100||keys.some(key=>!keyIsValid(key)))
        return res.status(400).json({error:"Choose 1 to 100 valid notification keys to delete."});
      const unique=[...new Set(keys)];
      await pool.query(
        `INSERT INTO admin_notification_deletions(actor,notification_key)
         SELECT $1, UNNEST($2::text[])
         ON CONFLICT (actor,notification_key) DO NOTHING`,
        [actor,unique]
      );
      await audit(req.adminSession,"admin.notification.deleted",{count:unique.length});
      res.set("Cache-Control","no-store").json({ok:true,deleted:unique.length});
    }catch(err){next(err);}
  });
};
