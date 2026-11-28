"use strict";
const crypto = require("node:crypto");

module.exports = function registerAdminOperations(app, {pool, requireAdmin, requireOwner, requirePermission, getOrder, getOrders, putOrder, cleanText, audit}) {
  // POS lists only physically tracked variants. Displayed prices are informational:
  // the server re-prices under the transaction before committing.
  app.get("/api/admin/pos/variants", requireAdmin,requireOwner,async(_req,res,next)=>{
    try{
      const r=await pool.query(`SELECT v.id, v.color, v.size, v.quantity, p.data, p.id AS product_id
        FROM inventory_variants v JOIN products p ON p.id=v.product_id
        WHERE v.quantity>0 AND COALESCE((p.data->>'active')::boolean,TRUE)
        ORDER BY p.data->>'name',v.color,v.size`);
      res.json({variants:r.rows.map(x=>({
        id:x.id,productId:x.product_id,name:x.data.name,color:x.color,size:x.size,
        quantity:x.quantity,unitPrice:(Number(x.data.salePrice)>0 && Number(x.data.salePrice)<Number(x.data.price))?Number(x.data.salePrice):Number(x.data.price)
      }))});
    }catch(e){next(e);}
  });
  app.post("/api/admin/pos/orders",requireAdmin,requireOwner,async(req,res,next)=>{
    let client;
    try{
      const variantId=cleanText(req.body?.variantId,120);
      const quantity=Number(req.body?.quantity);
      const name=cleanText(req.body?.name,120);
      const phone=cleanText(req.body?.phone,30);
      if(!req.body?.paymentConfirmed || !name || !variantId || !Number.isInteger(quantity) || quantity<1 || quantity>25)
        return res.status(400).json({error:"Enter customer, stocked variant, quantity (1–25) and confirm received cash."});
      client=await pool.connect();await client.query("BEGIN");
      const found=await client.query(`SELECT v.id,v.color,v.size,v.quantity,p.id AS product_id,p.data
        FROM inventory_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 FOR UPDATE OF v`,[variantId]);
      if(!found.rowCount)throw Object.assign(new Error("Inventory variant not found."),{status:404});
      const v=found.rows[0],product=v.data;
      if(product.active===false)throw Object.assign(new Error("This product is disabled."),{status:409});
      const normal=Number(product.price),sale=Number(product.salePrice);
      const unitPrice=product.salePrice!=="" && product.salePrice!==null && product.salePrice!==undefined && sale>0 && sale<normal?sale:normal;
      if(!Number.isFinite(unitPrice)||unitPrice<=0)throw Object.assign(new Error("Invalid product price."),{status:409});
      if(Number(v.quantity)<quantity)throw Object.assign(new Error("Insufficient stock for the chosen variant."),{status:409});
      const dec=await client.query("UPDATE inventory_variants SET quantity=quantity-$2,updated_at=NOW() WHERE id=$1 AND quantity>=$2 RETURNING quantity",[v.id,quantity]);
      if(!dec.rowCount)throw Object.assign(new Error("Stock was changed by another sale; refresh stock."),{status:409});
      const total=Math.round(unitPrice*quantity*100)/100;
      const id="POS-"+crypto.randomBytes(8).toString("hex").toUpperCase();
      const order={
        id,source:"pos",customer:{name,phone,email:"",address:"Walk-in sale"},items:[{
          id:v.product_id,name:product.name,color:v.color,size:v.size,quantity,unitPrice,originalPrice:normal
        }],subtotal:total,discount:0,shipping:0,total,currency:"INR",
        paymentMethod:"Cash",paymentStatus:"paid",orderStatus:"delivered",
        paymentReceivedAt:new Date().toISOString(),paymentReceivedBy:req.adminSession.username,
        createdAt:new Date().toISOString(),statusHistory:[{status:"delivered",by:req.adminSession.username,at:new Date().toISOString()}]
      };
      await client.query("INSERT INTO orders(id,data,created_at,updated_at) VALUES($1,$2::jsonb,NOW(),NOW())",[id,JSON.stringify(order)]);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,"pos.sale.created",{orderId:id,variantId,quantity,total});
      res.status(201).json({ok:true,orderId:id,total,remainingStock:dec.rows[0].quantity});
    }catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)res.status(e.status).json({error:e.message});else next(e);}
    finally{client?.release();}
  });
  app.patch("/api/admin/orders/:id/shipping",requireAdmin,requirePermission("orders.update"),async(req,res,next)=>{
    try{
      const order=await getOrder(req.params.id);
      if(!order)return res.status(404).json({error:"Order not found."});
      if(["cancelled","delivered"].includes(order.orderStatus))return res.status(409).json({error:"Delivered and cancelled orders cannot be edited for shipment."});
      const carrier=cleanText(req.body?.carrier,80),trackingNumber=cleanText(req.body?.trackingNumber,100);
      if(!carrier || !trackingNumber || !/^[A-Za-z0-9./_-]{4,100}$/.test(trackingNumber))
        return res.status(400).json({error:"Enter carrier and a valid 4–100 character tracking reference."});
      order.shipment={...(order.shipment||{}),carrier,trackingNumber,updatedAt:new Date().toISOString(),updatedBy:req.adminSession.username};
      order.updatedAt=new Date().toISOString();
      await putOrder(order);
      await audit(req.adminSession,"order.shipping.updated",{orderId:order.id,carrier});
      res.json({ok:true,shipment:order.shipment});
    }catch(e){next(e);}
  });
};
