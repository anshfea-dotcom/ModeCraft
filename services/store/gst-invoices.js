"use strict";
const PDFDocument=require("pdfkit");
const validGSTIN=/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const paisa=value=>Math.round(Number(value)*100);
const cash=value=>"INR "+(Number(value)/100).toFixed(2);
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const read=(value,max)=>String(value??"").trim().slice(0,max);
function parseGSTRequest(body,order,seller){
  const sellerGSTIN=read(seller.gstin,15).toUpperCase();
  if(!validGSTIN.test(sellerGSTIN))throw error("Save a valid registered supplier GSTIN in Business details before issuing GST invoices.");
  const buyerName=read(body.buyerName,120);
  const buyerAddress=read(body.buyerAddress,450);
  const buyerGstin=read(body.buyerGstin,15).toUpperCase();
  const placeOfSupplyName=read(body.placeOfSupplyName,80);
  const placeOfSupplyCode=read(body.placeOfSupplyCode,2);
  if(!buyerName||!buyerAddress||!placeOfSupplyName||!/^[0-9]{2}$/.test(placeOfSupplyCode))throw error("Buyer, billing address and place of supply are required.");
  if(buyerGstin&&!validGSTIN.test(buyerGstin))throw error("Buyer GSTIN format is invalid.");
  if(Number(placeOfSupplyCode)<1||Number(placeOfSupplyCode)>38)throw error("Invalid GST place-of-supply state code.");
  if(!Array.isArray(order.items)||!order.items.length||!Array.isArray(body.lines)||body.lines.length!==order.items.length)throw error("Provide GST details for every order item.");
  const totalPaisa=paisa(order.total);
  if(!Number.isSafeInteger(totalPaisa)||totalPaisa<=0)throw error("Order total is not valid for tax invoicing.",409);
  let sumGross=0;
  const type=placeOfSupplyCode===sellerGSTIN.slice(0,2)?"intra":"inter";
  const lines=order.items.map((original,i)=>{
    const input=body.lines[i]||{};
    const hsn=read(input.hsn,8);
    const rate=Number(input.rate);
    const gross=paisa(input.gross);
    const qty=Number(original.quantity);
    if(!/^\d{4,8}$/.test(hsn))throw error("Each item needs a valid 4 to 8 digit HSN code.");
    if(!Number.isFinite(rate)||rate<0||rate>100||Math.abs(Math.round(rate*100)-rate*100)>1e-6)throw error("Enter a valid GST rate with at most two decimals.");
    if(!Number.isSafeInteger(gross)||gross<=0||!Number.isFinite(qty)||qty<=0)throw error("Enter a valid gross amount and item quantity.");
    const taxBasePaisa=Math.round(gross*10000/(10000+Math.round(rate*100)));
    const taxPaisa=gross-taxBasePaisa;
    const cgstPaisa=type==="intra"?Math.floor(taxPaisa/2):0;
    const sgstPaisa=type==="intra"?taxPaisa-cgstPaisa:0;
    const igstPaisa=type==="inter"?taxPaisa:0;
    sumGross+=gross;
    return {name:read(original.name||original.id||"Product",110),quantity:qty,
      hsn,gstRate:rate,grossPaisa:gross,taxablePaisa:taxBasePaisa,
      cgstPaisa,sgstPaisa,igstPaisa,taxPaisa,
      color:read(original.color,50),size:read(original.size,50)};
  });
  if(sumGross!==totalPaisa)throw error("Sum of GST gross line amounts must exactly match the original order total.");
  const fyYear=new Date().toLocaleString("en-GB",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"});
  const [month,year]=fyYear.split("/").map(Number);
  const fiscalStart=month>=4?year:year-1;
  const fiscalYear=String(fiscalStart)+"-"+String(fiscalStart+1);
  return {
    type:"gst_tax_invoice",orderId:order.id,orderDate:order.createdAt,
    fiscalYear,orderTotal:order.total,createdAt:new Date().toISOString(),
    seller:{legalName:read(seller.legalName,120),address:read(seller.address,450),
      gstin:sellerGSTIN,email:read(seller.email,254),phone:read(seller.phone,30),note:read(seller.note,300)},
    buyer:{name:buyerName,address:buyerAddress,gstin:buyerGstin},placeOfSupplyName,placeOfSupplyCode,
    taxType:type,reverseCharge:false,items:lines,totalPaisa,
    taxablePaisa:lines.reduce((s,l)=>s+l.taxablePaisa,0),
    cgstPaisa:lines.reduce((s,l)=>s+l.cgstPaisa,0),
    sgstPaisa:lines.reduce((s,l)=>s+l.sgstPaisa,0),
    igstPaisa:lines.reduce((s,l)=>s+l.igstPaisa,0)
  };
}
function renderGST(x,res){
  const filename="AERLON-"+String(x.invoiceNumber).replace(/[^A-Z0-9-/]/gi,"").replace(/\//g,"-")+".pdf";
  res.set({"Content-Type":"application/pdf","Content-Disposition":'attachment; filename="'+filename+'"',"Cache-Control":"no-store"});
  const pdf=new PDFDocument({size:"A4",margin:42,info:{Title:x.invoiceNumber,Author:"AERLON"}});
  pdf.on("error",err=>res.destroy(err));pdf.pipe(res);
  const ink="#1c1a17",gold="#98733d";
  pdf.fillColor(ink).font("Helvetica-Bold").fontSize(23).text("A E R L O N",42,38);
  pdf.fillColor(gold).fontSize(10).text("GST TAX INVOICE",42,73);
  pdf.moveTo(42,96).lineTo(552,96).strokeColor(gold).stroke();
  pdf.fillColor(ink).font("Helvetica-Bold").fontSize(10).text(x.seller.legalName,42,110,{width:290});
  pdf.font("Helvetica").fontSize(9).text(x.seller.address,42,126,{width:290});
  pdf.text("GSTIN: "+x.seller.gstin,42,pdf.y+5,{width:300});
  if(x.seller.email)pdf.text(x.seller.email,42,pdf.y+2,{width:300});
  if(x.seller.phone)pdf.text(x.seller.phone,42,pdf.y+2,{width:300});
  pdf.text("Invoice: "+x.invoiceNumber,350,110,{width:202,align:"right"});
  pdf.text("Issued: "+new Date(x.createdAt).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"}),350,125,{width:202,align:"right"});
  pdf.text("Order: "+x.orderId,350,140,{width:202,align:"right"});
  const y0=Math.max(206,pdf.y+20);
  pdf.font("Helvetica-Bold").fontSize(10).text("BILL TO",42,y0);
  pdf.font("Helvetica").fontSize(9).text(x.buyer.name,42,y0+18,{width:440});
  pdf.text(x.buyer.address,42,pdf.y+4,{width:480});
  if(x.buyer.gstin)pdf.text("Buyer GSTIN: "+x.buyer.gstin,42,pdf.y+4);
  pdf.text("Place of supply: "+x.placeOfSupplyName+" ("+x.placeOfSupplyCode+")",42,pdf.y+5,{width:495});
  pdf.text("Tax type: "+(x.taxType==="intra"?"CGST + SGST":"IGST")+"   |   Reverse charge: No",42,pdf.y+4);
  let y=Math.max(335,pdf.y+28);
  function header(){
    pdf.rect(42,y,510,25).fill("#f3f0ea");
    pdf.font("Helvetica-Bold").fillColor(ink).fontSize(8);
    pdf.text("Item / HSN",48,y+8,{width:165});
    pdf.text("Rate",218,y+8,{width:35,align:"right"});
    pdf.text("Taxable",261,y+8,{width:80,align:"right"});
    pdf.text("GST",353,y+8,{width:65,align:"right"});
    pdf.text("Gross",430,y+8,{width:115,align:"right"});y+=32;
  }
  header();
  for(const item of x.items){
    if(y>686){pdf.addPage();y=52;header();}
    pdf.fillColor(ink).font("Helvetica").fontSize(8);
    pdf.text(item.name,48,y,{width:162});
    pdf.text("HSN "+item.hsn+"  Qty "+item.quantity,48,y+15,{width:162});
    pdf.text(item.gstRate+"%",218,y+6,{width:35,align:"right"});
    pdf.text((item.taxablePaisa/100).toFixed(2),261,y+6,{width:80,align:"right"});
    pdf.text((item.taxPaisa/100).toFixed(2),353,y+6,{width:65,align:"right"});
    pdf.text((item.grossPaisa/100).toFixed(2),430,y+6,{width:115,align:"right"});
    y+=41;
    pdf.moveTo(42,y-4).lineTo(552,y-4).strokeColor("#dddddd").stroke();
  }
  if(y>660){pdf.addPage();y=65;}
  const totals=[["Taxable value",x.taxablePaisa],["CGST",x.cgstPaisa],["SGST",x.sgstPaisa],["IGST",x.igstPaisa],["GRAND TOTAL",x.totalPaisa]];
  totals.forEach(([name,value],i)=>{pdf.fillColor(ink).font(i===4?"Helvetica-Bold":"Helvetica").fontSize(i===4?11:9).text(name+": "+cash(value),305,y+10+i*19,{width:245,align:"right"});});
  const endY=Math.min(758,y+135);
  pdf.font("Helvetica").fontSize(8).text("For "+x.seller.legalName+" / Authorized signatory",42,endY,{width:480});
  pdf.fontSize(7).fillColor("#666").text("Tax calculated from manually entered GST-inclusive line totals. Verify statutory e-invoice / IRN requirements where applicable.",42,790,{width:510});
  pdf.end();
}
module.exports=function registerGSTInvoices(app,{pool,getOrder,requireAdmin,requirePermission,audit}){
  const authorised=requirePermission("invoices.issue");
  app.post("/api/admin/gst-invoices",requireAdmin,authorised,async(req,res,next)=>{
    let client;
    try{
      const orderId=read(req.body?.orderId,150);
      if(!orderId)throw error("Select an order.");
      const order=await getOrder(orderId);
      if(!order)throw error("Order not found.",404);
      if(["cancelled","awaiting_payment"].includes(order.orderStatus))throw error("Cancelled and unconfirmed orders cannot be invoiced.",409);
      const profileResult=await pool.query("SELECT data FROM store_settings WHERE key=$1",["invoice_profile"]);
      const snapshot=parseGSTRequest(req.body,order,profileResult.rows[0]?.data||{});
      client=await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(883155, $1::integer)",[Number(snapshot.fiscalYear.slice(0,4))]);
      const count=await client.query("SELECT COUNT(*)::integer AS n FROM invoices WHERE data->>'type'='gst_tax_invoice' AND data->>'fiscalYear'=$1",[snapshot.fiscalYear]);
      const serial=count.rows[0].n+1;
      if(serial>999999)throw error("Invoice serial limit reached.",409);
      const years=snapshot.fiscalYear.split("-").map(y=>y.slice(-2));
      snapshot.invoiceNumber="G"+years.join("-")+"-"+String(serial).padStart(6,"0");
      const result=await client.query("INSERT INTO invoices(order_id,data) VALUES($1,$2::jsonb) ON CONFLICT(order_id) DO NOTHING RETURNING id",[order.id,JSON.stringify(snapshot)]);
      if(!result.rowCount)throw error("This order already has an invoice. Download the existing one; duplicates are not created.",409);
      await client.query("COMMIT");client.release();client=null;
      await audit(req.adminSession,"gst.invoice.issued",{orderId:order.id,invoiceNumber:snapshot.invoiceNumber});
      res.status(201).json({ok:true,id:String(result.rows[0].id),invoiceNumber:snapshot.invoiceNumber});
    }catch(e){
      if(client)await client.query("ROLLBACK").catch(()=>{});
      if(e.status)res.status(e.status).json({error:e.message});else next(e);
    }finally{client?.release();}
  });
  app.get("/api/admin/gst-invoices/:id/pdf",requireAdmin,authorised,async(req,res,next)=>{
    try{
      if(!/^\d{1,16}$/.test(req.params.id))throw error("Invalid invoice reference.");
      const result=await pool.query("SELECT data FROM invoices WHERE id=$1",[req.params.id]);
      if(!result.rowCount||result.rows[0].data.type!=="gst_tax_invoice")throw error("GST invoice not found.",404);
      renderGST(result.rows[0].data,res);
    }catch(e){if(e.status)res.status(e.status).json({error:e.message});else next(e);}
  });
};
module.exports.parseGSTRequest=parseGSTRequest;
