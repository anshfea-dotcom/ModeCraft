"use strict";
const validGSTIN=/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const paisa=value=>Math.round(Number(value)*100);
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
  return require("./invoice-pdf").renderGST(x,res);
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
