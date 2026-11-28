"use strict";

// Commercial invoices use a snapshot of a real order. No GST tax breakdown is
// inferred from payments that did not record tax rates, HSN, or place of supply.
module.exports = function registerInvoices(app, { pool, getOrder, requireAdmin, requireOwner, requirePermission, cleanText, audit }) {
  async function profile() {
    const result = await pool.query("SELECT data FROM store_settings WHERE key=$1", ["invoice_profile"]);
    return result.rows[0]?.data || {};
  }
  function cleanProfile(input) {
    const legalName = cleanText(input?.legalName, 120);
    const address = cleanText(input?.address, 450);
    const gstin = cleanText(input?.gstin, 15).toUpperCase();
    const email = cleanText(input?.email, 254).toLowerCase();
    const phone = cleanText(input?.phone, 30);
    const note = cleanText(input?.note, 300);
    if (!legalName || !address) throw Object.assign(new Error("Enter the legal business name and registered address."), {status:400});
    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))
      throw Object.assign(new Error("GSTIN format is invalid."), {status:400});
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw Object.assign(new Error("Enter a valid business email."), {status:400});
    return { legalName, address, gstin, email, phone, note };
  }

  app.get("/api/admin/invoices/profile", requireAdmin, requireOwner, async (_req,res,next) => {
    try { res.set("Cache-Control","no-store").json({profile: await profile()}); }
    catch(e){next(e);}
  });
  app.put("/api/admin/invoices/profile", requireAdmin, requireOwner, async (req,res,next) => {
    try {
      const nextProfile = cleanProfile(req.body);
      await pool.query("INSERT INTO store_settings(key,data,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()", ["invoice_profile",JSON.stringify(nextProfile)]);
      await audit(req.adminSession, "invoice.profile.updated");
      res.json({ok:true, profile:nextProfile});
    } catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.get("/api/admin/invoices", requireAdmin, requirePermission("invoices.issue"), async (_req,res,next) => {
    try {
      const result = await pool.query("SELECT id,order_id,data,issued_at FROM invoices ORDER BY id DESC LIMIT 500");
      res.set("Cache-Control","no-store").json({invoices:result.rows.map(row=>({
        id:String(row.id),orderId:row.order_id,invoiceNumber:row.data.invoiceNumber,
        amount:row.data.type==="gst_tax_invoice"?Number(row.data.totalPaisa||0)/100:row.data.total,type:row.data.type||"commercial_invoice",createdAt:row.issued_at,customerName:row.data.customer?.name||row.data.buyer?.name||"Customer",deletable:row.data.type!=="gst_tax_invoice"&&!row.data.seller?.gstin
      }))});
    } catch(e){next(e);}
  });
  app.post("/api/admin/invoices", requireAdmin, requirePermission("invoices.issue"), async (req,res,next) => {
    let client;
    try {
      const orderId = cleanText(req.body?.orderId, 150);
      if (!orderId) return res.status(400).json({error:"Select an order."});
      // This route is manual-only: it is called exclusively by the authorised Create Invoice action.
      const order = await getOrder(orderId);
      if (!order) return res.status(404).json({error:"Order not found."});
      if (order.orderStatus === "cancelled" || order.orderStatus === "awaiting_payment")
        return res.status(409).json({error:"Cancelled and unconfirmed orders cannot be invoiced."});
      const seller = cleanProfile(await profile());
      const items = Array.isArray(order.items) ? order.items : [];
      const total = Number(order.total);
      if (!items.length || !Number.isFinite(total) || total < 0)
        return res.status(409).json({error:"This order has incomplete invoice data."});
      const snapshot = {
        type:"commercial_invoice",orderId:order.id,orderDate:order.createdAt,
        customer:order.customer||{},items,subtotal:Number(order.subtotal ?? total),
        discount:Number(order.discount || 0),shipping:Number(order.shipping || 0),total,
        currency:"INR",paymentMethod:order.paymentMethod||"",paymentStatus:order.paymentStatus||"pending",
        seller,createdAt:new Date().toISOString()
      };
      client=await pool.connect();
      await client.query("BEGIN");
      const result=await client.query("INSERT INTO invoices(order_id,data) VALUES($1,$2::jsonb) ON CONFLICT(order_id) DO NOTHING RETURNING id", [order.id,JSON.stringify(snapshot)]);
      const saved=result.rowCount?result.rows[0]:null;
      if(saved) {
        snapshot.invoiceNumber="AER-"+new Date().getFullYear()+"-"+String(saved.id).padStart(6,"0");
        await client.query("UPDATE invoices SET data=$2::jsonb WHERE id=$1",[saved.id,JSON.stringify(snapshot)]);
      }
      const invoice=await client.query("SELECT id, data FROM invoices WHERE order_id=$1", [order.id]);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,saved?"invoice.issued":"invoice.retrieved",{orderId:order.id});
      if(!saved && invoice.rows[0].data.type==="gst_tax_invoice") return res.status(409).json({error:"This order already has a GST tax invoice. Download that existing invoice."});
       res.status(saved?201:200).json({ok:true,id:String(invoice.rows[0].id),invoiceNumber:invoice.rows[0].data.invoiceNumber,alreadyIssued:!saved});
    } catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)res.status(e.status).json({error:e.message});else next(e);}
    finally{client?.release();}
  });
  // Owner-only permanent deletion, available only for non-GST commercial bills.
  // The original order is never deleted or altered; issued GST records remain immutable.
  app.delete("/api/admin/invoices/:id",requireAdmin,requireOwner,async(req,res,next)=>{
    let client;
    try{
      if(!/^\d{1,16}$/.test(req.params.id))return res.status(400).json({error:"Invalid invoice reference."});
      const confirmation=String(req.body?.confirmInvoiceNumber||"").trim();
      if(!confirmation)return res.status(400).json({error:"Type the invoice number to confirm permanent deletion."});
      client=await pool.connect();
      await client.query("BEGIN");
      const found=await client.query("SELECT id,order_id,data FROM invoices WHERE id=$1 FOR UPDATE",[req.params.id]);
      if(!found.rowCount){
        await client.query("ROLLBACK");client.release();client=null;
        return res.status(404).json({error:"Invoice not found."});
      }
      const record=found.rows[0],data=record.data||{};
      if(data.type==="gst_tax_invoice"||data.seller?.gstin){
        await client.query("ROLLBACK");client.release();client=null;
        return res.status(409).json({error:"Issued GST or GST-registered business invoices must be retained. Use the applicable correction or credit-note process instead."});
      }
      if(confirmation!==data.invoiceNumber){
        await client.query("ROLLBACK");client.release();client=null;
        return res.status(400).json({error:"Invoice number does not match. Nothing was deleted."});
      }
      await client.query("DELETE FROM invoices WHERE id=$1",[record.id]);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,"invoice.deleted",{id:String(record.id),invoiceNumber:data.invoiceNumber,orderId:record.order_id}).catch(error=>console.error("Invoice deletion audit failed:",error.message));
      res.set("Cache-Control","no-store").json({ok:true,deletedId:String(record.id),invoiceNumber:data.invoiceNumber});
    }catch(e){
      if(client)await client.query("ROLLBACK").catch(()=>{});
      next(e);
    }finally{client?.release();}
  });
  app.get("/api/admin/invoices/:id/pdf",requireAdmin,requirePermission("invoices.issue"),async(req,res,next)=>{
    try{
      if(!/^\d{1,16}$/.test(req.params.id))return res.status(400).json({error:"Invalid invoice reference."});
      const result=await pool.query("SELECT data FROM invoices WHERE id=$1",[req.params.id]);
      if(!result.rowCount)return res.status(404).json({error:"Invoice not found."});
      const x=result.rows[0].data;
      if(x.type==="gst_tax_invoice")return res.status(409).json({error:"Use the GST Tax Invoice download action."});
      require("./invoice-pdf").renderCommercial(x,res);

    }catch(e){next(e);}
  });
};
