"use strict";
const STATES={"01":"Jammu and Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur","15":"Mizoram","16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat","25":"Daman and Diu","26":"Dadra and Nagar Haveli","27":"Maharashtra","29":"Karnataka","30":"Goa","31":"Lakshadweep","32":"Kerala","33":"Tamil Nadu","34":"Puducherry","35":"Andaman and Nicobar Islands","36":"Telangana","37":"Andhra Pradesh","38":"Ladakh","97":"Other Territory"};
const GSTIN=/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const bad=m=>Object.assign(new Error(m),{status:400}),cent=n=>Math.round(Number(n)*100);
function buildGstSnapshot(order,seller,input){
 const gstin=String(seller.gstin||"").toUpperCase(),place=String(input.placeOfSupplyStateCode||"");
 if(!GSTIN.test(gstin)||!STATES[gstin.slice(0,2)])throw bad("A registered seller GSTIN is required.");
 if(!STATES[place])throw bad("Choose a valid place-of-supply state.");
 const buyerAddress=String(input.buyerAddress||"").trim().slice(0,500),signatory=String(input.signatory||"").trim().slice(0,100);
 const buyerGstin=String(input.buyerGstin||"").trim().toUpperCase();
 if(buyerAddress.length<8||signatory.length<2)throw bad("Enter a full recipient address and authorised signatory.");
 if(buyerGstin&&!GSTIN.test(buyerGstin))throw bad("Recipient GSTIN is invalid.");
 if(Number(order.shipping||0)!==0)throw bad("Shipping charges require manual tax classification; use a normal invoice for this order.");
 if(input.reverseCharge)throw bad("Reverse charge is not supported in this workflow.");
 const items=order.items||[],rates=input.lines||[];
 if(!Array.isArray(items)||!items.length||items.length>80||!Array.isArray(rates)||rates.length!==items.length)throw bad("Enter HSN and GST rate for every item.");
 const gross=items.map(item=>cent(Number(item.unitPrice)*Number(item.quantity)));
 if(gross.some((n,i)=>!Number.isSafeInteger(n)||n<0||!Number.isInteger(Number(items[i].quantity))||Number(items[i].quantity)<1))throw bad("Invalid order items.");
 const subtotal=gross.reduce((a,b)=>a+b,0),discount=cent(order.discount||0),total=cent(order.total);
 if(Math.abs(cent(order.subtotal??subtotal/100)-subtotal)>1||discount<0||discount>subtotal||subtotal-discount!==total)throw bad("Stored order total does not reconcile.");
 const intra=gstin.slice(0,2)===place;let remainder=discount;
 const lines=items.map((item,i)=>{
   const hsn=String(rates[i]?.hsn||""),rate=Number(rates[i]?.gstRate);
   if(!/^[0-9]{4,8}$/.test(hsn)||!Number.isFinite(rate)||rate<0||rate>40||Math.round(rate*100)!==rate*100)throw bad("Check HSN and manually entered GST rate for item "+(i+1)+".");
   const reduction=i===items.length-1?remainder:Math.round(gross[i]*discount/subtotal);remainder-=reduction;
   const totalPaise=gross[i]-reduction,taxable=Math.round(totalPaise*100/(100+rate)),tax=totalPaise-taxable;
   const cgst=intra?Math.floor(tax/2):0,sgst=intra?tax-cgst:0;
   return{name:String(item.name||item.id).slice(0,120),quantity:Number(item.quantity),color:item.color||"",size:item.size||"",uom:"PCS",hsn,rate,
     taxable:taxable/100,cgst:cgst/100,sgst:sgst/100,igst:intra?0:tax/100,amount:totalPaise/100};
 });
 const sum=k=>Number((lines.reduce((a,l)=>a+cent(l[k]),0)/100).toFixed(2));
 if(cent(sum("amount"))!==total)throw bad("GST tax split does not match the paid amount.");
 return{type:"gst_tax_invoice",gst:{sellerState:STATES[gstin.slice(0,2)],sellerStateCode:gstin.slice(0,2),
   placeOfSupply:STATES[place],placeOfSupplyStateCode:place,buyerAddress,buyerGstin,signatory,intraState:intra,
   reverseCharge:false,taxInclusive:true,lines,taxable:sum("taxable"),cgst:sum("cgst"),sgst:sum("sgst"),igst:sum("igst")}};
}
function renderGstInvoice(doc,x){
 const g=x.gst,m=n=>"INR "+Number(n||0).toFixed(2);
 const txt=(s,a,b,w=495)=>doc.font("Helvetica").fontSize(9).fillColor("#252525").text(String(s),a,b,{width:w});
 const strong=(s,a,b,w=495)=>doc.font("Helvetica-Bold").fontSize(10).fillColor("#252525").text(String(s),a,b,{width:w});
 let y=46;strong("A E R L O N",46,y);strong("GST TAX INVOICE",370,y);
 y+=36;doc.moveTo(46,y).lineTo(548,y).strokeColor("#ad8b57").stroke();y+=16;
 strong(x.seller.legalName,46,y,280);txt(x.seller.address,46,y+17,280);
 txt("Seller GSTIN: "+x.seller.gstin,46,y+57,300);txt("Seller state: "+g.sellerState,46,y+71,300);
 txt("Invoice: "+x.invoiceNumber,355,y,189);txt("Date: "+new Date(x.createdAt).toLocaleDateString("en-IN"),355,y+18,189);
 txt("Order: "+x.orderId,355,y+36,189);y+=114;
 strong("BILL TO",46,y);txt(x.customer?.name||"Customer",46,y+17);txt(g.buyerAddress,46,y+30);
 y+=84;txt("Place of supply: "+g.placeOfSupply+" ("+g.placeOfSupplyStateCode+")",46,y);y+=17;
 if(g.buyerGstin){txt("Buyer GSTIN: "+g.buyerGstin,46,y);y+=17;}
 txt("Tax inclusive prices | Reverse charge: No",46,y);y+=26;
 function header(){doc.rect(46,y,502,23).fill("#f2eee8");strong("Item / HSN",52,y+5,250);strong("Qty",315,y+5,32);strong("Rate",359,y+5,43);strong("Tax",411,y+5,70);strong("Amount",486,y+5,62);y+=31;}
 header();
 for(const l of g.lines){
   if(y>660){doc.addPage();y=50;header();}
   strong(l.name,52,y,250);txt("HSN "+l.hsn+" / "+l.uom+" "+[l.color,l.size].filter(Boolean).join("/"),52,y+15,250);
   txt(l.quantity,315,y,32);txt(l.rate+"%",359,y,43);txt(m(l.cgst+l.sgst+l.igst),404,y,80);txt(m(l.amount),480,y,68);
   y+=43;doc.moveTo(46,y-4).lineTo(548,y-4).strokeColor("#e9e2d8").stroke();
 }
 if(y>665){doc.addPage();y=50;}
 for(const [label,num] of [["Taxable",g.taxable],...(g.intraState?[["CGST",g.cgst],["SGST",g.sgst]]:[["IGST",g.igst]]),["Total (GST included)",x.total]]){
   strong(label+": "+m(num),300,y,246);y+=20;
 }
 y+=16;txt("Payment: "+x.paymentMethod+" / "+x.paymentStatus,46,y);y+=23;
 txt("Authorised signatory: "+g.signatory+" (typed name; not a digital signature)",46,y);
}
module.exports={STATES,buildGstSnapshot,renderGstInvoice};
