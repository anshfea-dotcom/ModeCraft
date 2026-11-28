"use strict";
const PDFDocument = require("pdfkit");

// A4, compact champagne editorial layout approved for AERLON.
// All text and amounts originate from the stored, immutable invoice snapshot.
const C = { ink:"#342719", muted:"#71665D", gold:"#B08A63", edge:"#DCCABB", pale:"#F8F0E8", white:"#FFFFFF" };
const left=42, right=553, width=511;
const fmt=n=>"INR "+(Number(n||0)).toFixed(2);
const paisa=n=>fmt(Number(n||0)/100);
const str=v=>String(v??"").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,"");
function print(pdf,value,x,y,w,{font="Helvetica",size=8.7,color=C.ink,align="left",height=19}={}) {
  pdf.font(font).fontSize(size).fillColor(color).text(str(value),x,y,{width:w,height,align,ellipsis:true,lineBreak:false});
}
function horizontal(pdf,y,stroke=C.edge) {pdf.moveTo(left,y).lineTo(right,y).lineWidth(.65).strokeColor(stroke).stroke();}
function date(v) {
  const d=new Date(v);
  return Number.isFinite(d.getTime())?d.toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric"}):"—";
}
function card(pdf,x,y,w,title,person,address,details=[]) {
  pdf.roundedRect(x,y,w,113,5).lineWidth(.7).strokeColor(C.edge).stroke();
  pdf.roundedRect(x,y,w,26,5).fill(C.pale);
  pdf.rect(x,y+21,w,5).fill(C.pale);
  print(pdf,title,x+13,y+6,w-26,{font:"Times-Italic",size:13,color:C.ink});
  print(pdf,person,x+13,y+35,w-26,{font:"Helvetica-Bold",size:9.1,height:15});
  print(pdf,address,x+13,y+53,w-26,{size:8.25,height:34});
  const detail=details.filter(Boolean).join("  |  ");
  if(detail)print(pdf,detail,x+13,y+91,w-26,{size:7.5,height:13,color:C.muted});
}
function itemHeader(pdf,y,gst) {
  pdf.rect(left,y,width,28).fill(C.pale);
  print(pdf,"S. No.",left+8,y+7,34,{font:"Helvetica-Bold",size:7.7});
  print(pdf,"Product / Details",left+48,y+7,gst?186:233,{font:"Helvetica-Bold",size:8});
  if(gst){
    print(pdf,"Qty",left+255,y+7,30,{font:"Helvetica-Bold",size:7.7,align:"right"});
    print(pdf,"Taxable",left+294,y+7,67,{font:"Helvetica-Bold",size:7.7,align:"right"});
    print(pdf,"GST",left+374,y+7,51,{font:"Helvetica-Bold",size:7.7,align:"right"});
  }else{
    print(pdf,"Qty",left+300,y+7,28,{font:"Helvetica-Bold",size:7.7,align:"right"});
    print(pdf,"Price",left+342,y+7,72,{font:"Helvetica-Bold",size:7.7,align:"right"});
  }
  print(pdf,"Amount",left+432,y+7,70,{font:"Helvetica-Bold",size:7.7,align:"right"});
  return y+28;
}
function drawBrand(pdf,kind,x){
  // A restrained champagne corner flourish instead of a full-page background.
  pdf.moveTo(0,0).lineTo(148,0).bezierCurveTo(115,36,73,61,0,82).closePath().fill(C.pale);
  pdf.moveTo(10,78).bezierCurveTo(74,61,118,34,160,0).lineWidth(.7).strokeColor(C.gold).stroke();
  print(pdf,"A E R L O N",139,42,317,{font:"Times-Roman",size:29,align:"center",height:38});
  print(pdf,"TM",415,46,22,{font:"Helvetica",size:7,color:C.ink,height:12});
  horizontal(pdf,110,C.gold);
  print(pdf,"P R E M I U M   F A S H I O N",154,88,288,{size:8.1,color:C.gold,align:"center",height:14});
  pdf.rect(left,130,271,38).fill(C.pale);
  print(pdf,kind==="gst"?"Tax Invoice":"Invoice",left+11,134,255,{font:"Times-Italic",size:25,color:C.ink,height:32});
}
function render(x,res,kind) {
  const gst=kind==="gst";
  const inv=str(x.invoiceNumber||"Invoice").replace(/[^A-Za-z0-9/_-]/g,"");
  const filename="AERLON-"+inv.replace(/\//g,"-")+".pdf";
  res.set({"Content-Type":"application/pdf","Content-Disposition":'attachment; filename="'+filename+'"',"Cache-Control":"no-store"});
  const pdf=new PDFDocument({size:"A4",margin:42,info:{Title:"AERLON "+inv,Author:"AERLON"}});
  pdf.on("error",err=>{if(!res.headersSent)res.status(500).end();else res.destroy(err);});
  pdf.pipe(res);
  drawBrand(pdf,kind);
  const seller=x.seller||{},buyer=gst?(x.buyer||{}):(x.customer||{});
  print(pdf,"Invoice No.",365,129,82,{size:8.4,color:C.muted});
  print(pdf,inv,445,129,108,{size:8.4,align:"right"});
  print(pdf,"Invoice Date",365,146,82,{size:8.4,color:C.muted});
  print(pdf,date(x.createdAt),445,146,108,{size:8.4,align:"right"});
  print(pdf,"Order No.",365,163,82,{size:8.4,color:C.muted});
  print(pdf,str(x.orderId),445,163,108,{size:8.1,align:"right"});
  horizontal(pdf,192);
  const customerAddress=gst?buyer.address:[buyer.house,buyer.street,buyer.address,buyer.city,buyer.state,buyer.postalCode].filter(Boolean).join(", ");
  card(pdf,left,205,248,"Seller (AERLON)",seller.legalName||"AERLON",seller.address||"",[seller.gstin?"GSTIN: "+seller.gstin:"",seller.phone]);
  card(pdf,left+260,205,251,"Buyer",buyer.name||"Customer",customerAddress,[gst&&buyer.gstin?"GSTIN: "+buyer.gstin:"",!gst?buyer.phone:""]);
  let y=itemHeader(pdf,337,gst);
  const rows=Array.isArray(x.items)?x.items:[];
  for(let i=0;i<rows.length;i++){
    const item=rows[i]||{};
    if(y+44>646){
      pdf.addPage();
      print(pdf,"AERLON / "+inv,left,37,width,{font:"Times-Roman",size:15,color:C.gold});
      y=itemHeader(pdf,72,gst);
    }
    const name=str(item.name||item.id||"Product").slice(0,110);
    const detail=gst?["HSN "+str(item.hsn||""),str(item.gstRate)+"% GST",item.color,item.size].filter(Boolean).join("  |  "):
      [item.color,item.size].filter(Boolean).join(" / ");
    print(pdf,String(i+1),left+8,y+11,34,{size:8});
    print(pdf,name,left+48,y+7,gst?190:235,{font:"Helvetica-Bold",size:8.4,height:17});
    if(detail)print(pdf,detail,left+48,y+25,gst?190:235,{size:7.4,color:C.muted,height:15});
    if(gst){
      print(pdf,item.quantity,left+255,y+14,30,{size:8.5,align:"right"});
      print(pdf,paisa(item.taxablePaisa),left+288,y+14,73,{size:8,align:"right"});
      print(pdf,paisa(item.taxPaisa),left+366,y+14,59,{size:8,align:"right"});
      print(pdf,paisa(item.grossPaisa),left+425,y+14,77,{size:8,align:"right"});
    }else{
      const qty=Number(item.quantity)||0,price=Number(item.unitPrice)||0;
      print(pdf,qty,left+300,y+14,28,{size:8.5,align:"right"});
      print(pdf,fmt(price),left+337,y+14,77,{size:8,align:"right"});
      print(pdf,fmt(qty*price),left+425,y+14,77,{size:8,align:"right"});
    }
    y+=44;horizontal(pdf,y,C.edge);
  }
  if(y+169>730){pdf.addPage();y=60;}
  y+=21;
  print(pdf,gst?"Tax Summary":"Invoice Summary",left,y,225,{font:"Times-Italic",size:14,color:C.ink});
  if(gst){
    print(pdf,"Place of supply",left,y+28,106,{size:8,color:C.muted});
    print(pdf,str(x.placeOfSupplyName)+" ("+str(x.placeOfSupplyCode)+")",left+101,y+28,153,{size:8});
    print(pdf,"Tax category",left,y+47,100,{size:8,color:C.muted});
    print(pdf,x.taxType==="intra"?"CGST + SGST":"IGST",left+101,y+47,150,{size:8});
    print(pdf,"Reverse charge: No",left,y+66,234,{size:7.8,color:C.muted});
  }else{
    print(pdf,"Payment",left,y+29,90,{size:8,color:C.muted});
    print(pdf,[x.paymentMethod,x.paymentStatus].filter(Boolean).join(" / "),left+91,y+29,160,{size:8});
    print(pdf,"This is a commercial invoice.",left,y+53,246,{size:7.8,color:C.muted});
    print(pdf,"GST tax breakdown not recorded.",left,y+67,246,{size:7.8,color:C.muted});
  }
  const bx=325,bw=228,bh=gst?147:128;
  pdf.roundedRect(bx,y-5,bw,bh,5).lineWidth(.7).strokeColor(C.edge).stroke();
  const values=gst?[
    ["Taxable value",paisa(x.taxablePaisa)],
    ["CGST",paisa(x.cgstPaisa)],
    ["SGST",paisa(x.sgstPaisa)],
    ["IGST",paisa(x.igstPaisa)]
  ]:[
    ["Subtotal",fmt(x.subtotal)],
    ["Discount","- "+fmt(x.discount)],
    ["Shipping",fmt(x.shipping)]
  ];
  values.forEach(([label,value],index)=>{
    print(pdf,label,bx+12,y+5+index*19,104,{size:8.1});
    print(pdf,value,bx+113,y+5+index*19,103,{size:8.1,align:"right"});
  });
  const totalY=y+(gst?87:70);
  pdf.roundedRect(bx+6,totalY,bw-12,36,5).fill(C.pale);
  print(pdf,"Grand Total",bx+15,totalY+8,96,{font:"Times-Italic",size:13});
  print(pdf,gst?paisa(x.totalPaisa):fmt(x.total),bx+115,totalY+9,bw-131,{font:"Helvetica-Bold",size:10.5,align:"right"});
  const footerY=y+bh+22;
  horizontal(pdf,footerY);
  print(pdf,x.seller?.note||"Thank you for shopping with AERLON.",left,footerY+19,281,{font:"Times-Italic",size:11.5,color:C.ink,height:32});
  print(pdf,"We appreciate your support.",left,footerY+47,267,{size:7.7,color:C.muted});
  pdf.moveTo(421,footerY+53).lineTo(right,footerY+53).strokeColor(C.gold).lineWidth(.7).stroke();
  print(pdf,"Authorized Signatory",403,footerY+61,150,{size:8,align:"right"});
  if(gst)print(pdf,"Verify all statutory GST/IRN requirements before issue.",left,810,width,{size:7,color:C.muted,height:12});
  pdf.end();
}
module.exports={renderCommercial:(x,res)=>render(x,res,"commercial"),renderGST:(x,res)=>render(x,res,"gst")};
