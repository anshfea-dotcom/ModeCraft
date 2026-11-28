"use strict";
const crypto=require("node:crypto");
module.exports=function registerWarehouses(app,{pool,requireAdmin,requireOwner,audit,cleanText}){
  const text=(v,len)=>cleanText(v,len);
  const problem=(message,status=400)=>Object.assign(new Error(message),{status});
  const readWarehouse=(body,create)=>{
    const name=text(body?.name,100),city=text(body?.city,80),state=text(body?.state,80),address=text(body?.address,350);
    if(!name||name.length<2)throw problem("Provide a valid warehouse name.");
    const code=text(body?.code,24).toUpperCase();
    if(create&&!/^[A-Z0-9_-]{2,24}$/.test(code))throw problem("Warehouse code must be 2–24 letters, digits, hyphens or underscores.");
    return{code,name,city,state,address,active:true};
  };
  app.get("/api/admin/warehouses",requireAdmin,requireOwner,async(_req,res,next)=>{
    try{
      const [wh,stock]=await Promise.all([
        pool.query("SELECT id,code,data FROM warehouses ORDER BY created_at DESC LIMIT 250"),
        pool.query("SELECT warehouse_id AS \"warehouseId\",variant_id AS \"variantId\",quantity FROM warehouse_stock ORDER BY warehouse_id LIMIT 10000")
      ]);
      const assignments=stock.rows.map(s=>({warehouseId:s.warehouseId,variantId:s.variantId,quantity:Number(s.quantity)}));
      const warehouses=wh.rows.map(w=>({id:w.id,code:w.code,...w.data,
        assignedUnits:assignments.filter(a=>a.warehouseId===w.id).reduce((s,a)=>s+a.quantity,0)}));
      res.set("Cache-Control","no-store").json({warehouses,assignments});
    }catch(e){next(e);}
  });
  app.get("/api/admin/warehouses/variants",requireAdmin,requireOwner,async(_req,res,next)=>{
    try{
      const r=await pool.query(`SELECT v.id,v.quantity AS "totalStock",v.color,v.size,COALESCE(p.data->>'name','Product') AS name
        FROM inventory_variants v JOIN products p ON p.id=v.product_id ORDER BY name,v.color,v.size LIMIT 10000`);
      res.set("Cache-Control","no-store").json({variants:r.rows});
    }catch(e){next(e);}
  });
  app.post("/api/admin/warehouses",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      const data=readWarehouse(req.body,true);
      const id=crypto.randomUUID();
      await pool.query("INSERT INTO warehouses(id,code,data) VALUES($1,$2,$3::jsonb)",[id,data.code,JSON.stringify(data)]);
      await audit(req.adminSession,"warehouse.created",{id,code:data.code});
      res.status(201).json({ok:true,id,...data});
    }catch(e){if(e.code==="23505")return res.status(409).json({error:"Warehouse code already exists."});if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.patch("/api/admin/warehouses/:id",requireAdmin,requireOwner,async(req,res,next)=>{
    let client;
    try{
      client=await pool.connect();await client.query("BEGIN");
      const found=await client.query("SELECT id,code,data FROM warehouses WHERE id=$1 FOR UPDATE",[req.params.id]);
      if(!found.rowCount)throw problem("Warehouse not found.",404);
      const original=found.rows[0];
      const nextData={...original.data};
      for(const k of ["name","city","state","address"])if(req.body?.[k]!==undefined)nextData[k]=text(req.body[k],k==="address"?350:k==="name"?100:80);
      if(!nextData.name||nextData.name.length<2)throw problem("Warehouse name is required.");
      if(req.body?.active!==undefined)nextData.active=req.body.active===true;
      if(!nextData.active){
        const count=await client.query("SELECT COALESCE(SUM(quantity),0)::integer AS n FROM warehouse_stock WHERE warehouse_id=$1",[req.params.id]);
        if(count.rows[0].n>0)throw problem("Clear all stock assignments before disabling this warehouse.",409);
      }
      await client.query("UPDATE warehouses SET data=$2::jsonb,updated_at=NOW() WHERE id=$1",[req.params.id,JSON.stringify(nextData)]);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,"warehouse.updated",{id:req.params.id});
      res.json({ok:true,id:req.params.id,...nextData});
    }catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)res.status(e.status).json({error:e.message});else next(e);}finally{client?.release();}
  });
  app.put("/api/admin/warehouses/stock",requireAdmin,requireOwner,async(req,res,next)=>{
    let client;
    try{
      const warehouseId=text(req.body?.warehouseId,120),variantId=text(req.body?.variantId,120);
      const quantity=Number(req.body?.quantity);
      if(!warehouseId||!variantId||!Number.isSafeInteger(quantity)||quantity<0||quantity>1000000)throw problem("Select a warehouse, variant and a valid whole-number quantity.");
      client=await pool.connect();await client.query("BEGIN");
      const wh=await client.query("SELECT data FROM warehouses WHERE id=$1 FOR UPDATE",[warehouseId]);
      if(!wh.rowCount||!wh.rows[0].data.active)throw problem("Warehouse not found or disabled.",404);
      const v=await client.query("SELECT quantity FROM inventory_variants WHERE id=$1 FOR UPDATE",[variantId]);
      if(!v.rowCount)throw problem("Inventory variant not found.",404);
      const assigned=await client.query("SELECT COALESCE(SUM(quantity),0)::integer AS n FROM warehouse_stock WHERE variant_id=$1 AND warehouse_id<>$2",[variantId,warehouseId]);
      if(Number(assigned.rows[0].n)+quantity>Number(v.rows[0].quantity))throw problem("Warehouse assignments cannot exceed central stock. Reduce the quantity.",409);
      if(quantity===0)await client.query("DELETE FROM warehouse_stock WHERE warehouse_id=$1 AND variant_id=$2",[warehouseId,variantId]);
      else await client.query(`INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity,updated_at)
         VALUES($1,$2,$3,NOW()) ON CONFLICT(warehouse_id,variant_id)
         DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=NOW()`,[warehouseId,variantId,quantity]);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,"warehouse.stock.assigned",{warehouseId,variantId,quantity});
      res.json({ok:true,warehouseId,variantId,quantity});
    }catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)res.status(e.status).json({error:e.message});else next(e);}finally{client?.release();}
  });
};