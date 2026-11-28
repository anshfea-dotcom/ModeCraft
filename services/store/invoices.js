"use strict";
const PDFDocument = require("pdfkit");

// Commercial invoices use a snapshot of a real order. No GST tax breakdown is
// inferred from payments that did not record tax rates, HSN, or place of supply.
module.exports = function registerInvoices(app, { pool, getOrder, requireAdmin, requireOwner, cleanText, audit }) {
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
  app.get("/api/admin/invoices", requireAdmin, requireOwner, async (_req,res,next) => {
    try {
      const result = await pool.query("SELECT id,order_id,data,issued_at FROM invoices ORDER BY id DESC LIMIT 500");
      res.set("Cache-Control","no-store").json({invoices:result.rows.map(row=>({
        id:String(row.id),orderId:row.order_id,invoiceNumber:row.data.invoiceNumber,
        amount:row.data.total,createdAt:row.issued_at,customerName:row.data.customer?.name||"Customer"
      }))});
    } catch(e){next(e);}
  });
  app.post("/api/admin/invoices", requireAdmin, requireOwner, async (req,res,next) => {
    let client;
    try {
      const orderId = cleanText(req.body?.orderId, 150);
      if (!orderId) return res.status(400).json({error:"Select an order."});
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
      res.status(saved?201:200).json({ok:true,id:String(invoice.rows[0].id),invoiceNumber:invoice.rows[0].data.invoiceNumber,alreadyIssued:!saved});
    } catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});if(e.status)res.status(e.status).json({error:e.message});else next(e);}
    finally{client?.release();}
  });
  app.get("/api/admin/invoices/:id/pdf",requireAdmin,requireOwner,async(req,res,next)=>{
    try{
      if(!/^\d{1,16}$/.test(req.params.id))return res.status(400).json({error:"Invalid invoice reference."});
      const result=await pool.query("SELECT data FROM invoices WHERE id=$1",[req.params.id]);
      if(!result.rowCount)return res.status(404).json({error:"Invoice not found."});
      const x=result.rows[0].data;
      const filename="AERLON-"+String(x.invoiceNumber).replace(/[^A-Z0-9-]/gi,"")+".pdf";
      res.set({"Content-Type":"application/pdf","Content-Disposition":'attachment; filename="'+filename+'"',"Cache-Control":"no-store"});
      const doc=new PDFDocument({size:"A4",margin:46,info:{Title:x.invoiceNumber,Author:"AERLON"}});
      doc.on("error",error=>{if(!res.headersSent)next(error);else res.destroy(error);});
      doc.pipe(res);
      const ink="#1b1b1a",gold="#a27e40";
      doc.font("Helvetica-Bold").fontSize(25).fillColor(ink).text("A E R L O N",46,43);
      doc.font("Helvetica").fontSize(10).fillColor(gold).text("COMMERCIAL INVOICE",46,78);
      doc.moveTo(46,102).lineTo(548,102).lineWidth(1).stroke(gold);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(11).text(String(x.seller.legalName),46,121,{width:310});
      doc.font("Helvetica").fontSize(9).text(String(x.seller.address),46,139,{width:310});
      if(x.seller.gstin)doc.text("Seller GSTIN: "+x.seller.gstin,{width:310});
      if(x.seller.email)doc.text(x.seller.email,{width:310});
      if(x.seller.phone)doc.text(x.seller.phone,{width:310});
      doc.fontSize(9).text("Invoice: "+x.invoiceNumber,370,122,{width:175,align:"right"});
      doc.text("Issued: "+new Date(x.createdAt).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}),370,137,{width:175,align:"right"});
      doc.text("Order: "+String(x.orderId),370,152,{width:175,align:"right"});
      const billY=Math.max(217,doc.y+28);
      doc.font("Helvetica-Bold").fontSize(10).text("BILL TO",46,billY);
      const buyer=x.customer||{};
      doc.font("Helvetica").fontSize(9).text(String(buyer.name||"Customer"),46,billY+17,{width:480});
      let buyerLine=[buyer.house,buyer.street,buyer.address,buyer.city,buyer.state,buyer.postalCode].filter(Boolean).join(", ");
      if(buyerLine)doc.text(buyerLine,46,doc.y+3,{width:480});
      if(buyer.email)doc.text(String(buyer.email),46,doc.y+3);
      let y=Math.max(315,doc.y+28);
      function rowHeader(){
        doc.rect(46,y,502,25).fill("#f5f0e8");
        doc.fillColor(ink).font("Helvetica-Bold").fontSize(9);
        doc.text("Item",55,y+8,{width:290}).text("Qty",367,y+8,{width:40,align:"right"}).text("Amount (INR)",421,y+8,{width:117,align:"right"});
        y+=32;
      }
      rowHeader();
      for(const line of x.items){
        if(y>680){doc.addPage();y=52;rowHeader();}
        const price=Number(line.unitPrice||0),qty=Number(line.quantity||0);
        const name=String(line.name||line.id||"Product").slice(0,110);
        doc.font("Helvetica").fontSize(9).fillColor(ink).text(name,55,y,{width:296});
        const variant=[line.color,line.size].filter(Boolean).join(" / ");
        if(variant)doc.fontSize(8).fillColor("#646464").text(String(variant).slice(0,90),55,y+14,{width:296});
        doc.fillColor(ink).fontSize(9).text(String(qty),367,y,{width:40,align:"right"})
          .text((price*qty).toFixed(2),421,y,{width:117,align:"right"});
        y+=variant?42:32;
        doc.moveTo(46,y-5).lineTo(548,y-5).strokeColor("#dedbd6").stroke();
      }
      if(y>677){doc.addPage();y=65;}
      const amount=n=>"INR "+Number(n||0).toFixed(2);
      doc.font("Helvetica").fontSize(10).fillColor(ink)
        .text("Subtotal: "+amount(x.subtotal),335,y+12,{width:210,align:"right"});
      doc.text("Discount: "+amount(x.discount),335,y+30,{width:210,align:"right"});
      doc.font("Helvetica-Bold").fontSize(13).text("TOTAL: "+amount(x.total),315,y+55,{width:230,align:"right"});
      const footerY=Math.min(750,y+116);
      doc.font("Helvetica").fontSize(8).fillColor("#555").text("Payment: "+String(x.paymentMethod)+" · "+String(x.paymentStatus),46,footerY,{width:490});
      if(x.seller.note)doc.text(String(x.seller.note),46,footerY+16,{width:490});
      doc.fontSize(7.5).fillColor("#6d6d6d").text("This is a commercial invoice, not a GST tax invoice. HSN and tax breakdown have not been recorded.",46,790,{width:500});
      doc.end();
    }catch(e){next(e);}
  });
};
