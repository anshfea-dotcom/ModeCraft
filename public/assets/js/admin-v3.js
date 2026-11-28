(function() {
  "use strict";
  const by = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const moneyV3 = n => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(n)||0);
  const dateV3 = value => value ? new Date(value).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "—";
  let lastInvoiceLoad = 0;
  let invoiceOrderCache=[];
  let loadingInvoices = false;

  async function loadAlerts() {
    if (!currentUser?.permissions?.includes("analytics.view")) {
      for(const id of ["v3LowStock","v3PendingOrders","v3UnpaidOrders"]) if(by(id))by(id).textContent="—";
      return;
    }
    try {
      const [analytics,orders] = await Promise.all([
        api("/api/admin/analytics"),
        currentUser.permissions.includes("orders.view") ? api("/api/admin/orders") : Promise.resolve({orders:[]})
      ]);
      by("v3LowStock").textContent=String(analytics.lowStockVariants ?? 0);
      by("v3PendingOrders").textContent=String((orders.orders||[]).filter(x=>!x.archivedAt && !["delivered","cancelled"].includes(x.orderStatus)).length);
      by("v3UnpaidOrders").textContent=String((orders.orders||[]).filter(x=>!x.archivedAt && x.paymentStatus!=="paid" && x.orderStatus!=="cancelled").length);
    } catch(e) { console.warn("Dashboard insights unavailable:", e.message); }
  }
  window.refreshAerlonV3 = loadAlerts;

  async function loadReports() {
    if (!currentUser?.permissions?.includes("analytics.view")) return;
    try {
      const data=await api("/api/admin/analytics");
      const numbers=[
        ["Total orders",data.totalOrders],["Paid revenue",moneyV3(data.paidRevenue)],
        ["Paid orders",data.paidOrders],["Pending orders",data.pendingOrders],
        ["Cancelled orders",data.cancelledOrders],["Low-stock variants",data.lowStockVariants]
      ];
      by("v3Reports").innerHTML=numbers.map(([label,value])=>'<article><small>'+escapeHTML(label)+'</small><strong>'+escapeHTML(value)+'</strong></article>').join("");
    }catch(e){by("v3Reports").textContent="Could not load reports: "+e.message;}
  }

  async function loadInvoices() {
    if(!currentUser?.isOwner || loadingInvoices) return;
    loadingInvoices=true;
    try{
      const [p,items,orders]=await Promise.all([
        api("/api/admin/invoices/profile"),
        api("/api/admin/invoices"),
        api("/api/admin/orders")
      ]);
      const profile=p.profile||{},form=by("v3InvoiceProfile");
      for(const [name,value] of Object.entries(profile)) if(form.elements.namedItem(name)) form.elements.namedItem(name).value=String(value??"");
      const options=(orders.orders||[]).filter(order=>!["cancelled","awaiting_payment"].includes(order.orderStatus));
      invoiceOrderCache=options;
      by("v3InvoiceOrder").innerHTML='<option value="">Choose an order</option>'+options.map(order=>'<option value="'+escapeHTML(order.id)+'">'+escapeHTML(order.id)+' · '+escapeHTML(order.customer?.name||"Customer")+' · '+escapeHTML(moneyV3(order.total))+'</option>').join("");
      showGstFields();
      const invoices=items.invoices||[];
      by("v3InvoiceRows").innerHTML=invoices.map(invoice=>'<tr><td><strong>'+escapeHTML(invoice.invoiceNumber)+'</strong></td><td>'+escapeHTML(invoice.orderId)+'</td><td>'+escapeHTML(dateV3(invoice.createdAt))+'</td><td>'+escapeHTML(moneyV3(invoice.amount))+'</td><td>'+escapeHTML(invoice.invoiceType==="gst"?"GST Tax":"Normal")+'</td><td><button type="button" class="btn small v3-pdf" data-id="'+escapeHTML(invoice.id)+'">Download PDF</button></td></tr>').join("")||'<tr><td colspan="6" class="empty">No invoices have been issued yet.</td></tr>';
      lastInvoiceLoad=Date.now();
    }catch(e){toast(e.message,true);}
    finally{loadingInvoices=false;}
  }

  window.loadAerlonV3Section = section => {
    if(section==="overview") loadAlerts();
    if(section==="invoices") loadInvoices();
    if(section==="reports") loadReports();
    if(section==="pos") { loadPOSVariants(); loadPOSHistory(); }
    if(section==="payments") loadPayments();
    if(section==="shipping") loadShipping();
    if(section==="categories"||section==="brands") loadTaxonomy();
    if(section==="backups") loadBackupAudit();
  };
  const gstStates=[{"code":"10","name":"Bihar"},{"code":"11","name":"Sikkim"},{"code":"12","name":"Arunachal Pradesh"},{"code":"13","name":"Nagaland"},{"code":"14","name":"Manipur"},{"code":"15","name":"Mizoram"},{"code":"16","name":"Tripura"},{"code":"17","name":"Meghalaya"},{"code":"18","name":"Assam"},{"code":"19","name":"West Bengal"},{"code":"20","name":"Jharkhand"},{"code":"21","name":"Odisha"},{"code":"22","name":"Chhattisgarh"},{"code":"23","name":"Madhya Pradesh"},{"code":"24","name":"Gujarat"},{"code":"25","name":"Daman and Diu"},{"code":"26","name":"Dadra and Nagar Haveli"},{"code":"27","name":"Maharashtra"},{"code":"29","name":"Karnataka"},{"code":"30","name":"Goa"},{"code":"31","name":"Lakshadweep"},{"code":"32","name":"Kerala"},{"code":"33","name":"Tamil Nadu"},{"code":"34","name":"Puducherry"},{"code":"35","name":"Andaman and Nicobar Islands"},{"code":"36","name":"Telangana"},{"code":"37","name":"Andhra Pradesh"},{"code":"38","name":"Ladakh"},{"code":"97","name":"Other Territory"},{"code":"01","name":"Jammu and Kashmir"},{"code":"02","name":"Himachal Pradesh"},{"code":"03","name":"Punjab"},{"code":"04","name":"Chandigarh"},{"code":"05","name":"Uttarakhand"},{"code":"06","name":"Haryana"},{"code":"07","name":"Delhi"},{"code":"08","name":"Rajasthan"},{"code":"09","name":"Uttar Pradesh"}];
  by("v3GstState").innerHTML='<option value="">Select state</option>'+gstStates.map(s=>'<option value="'+s.code+'">'+s.code+' · '+escapeHTML(s.name)+'</option>').join("");
  function showGstFields(){
    const gst=by("v3InvoiceType").value==="gst";
    by("v3GstFields").hidden=!gst;
    if(!gst)return;
    const order=invoiceOrderCache.find(x=>String(x.id)===by("v3InvoiceOrder").value);
    if(order&&by("v3GstFields").dataset.order!==String(order.id)){
      by("v3BuyerAddress").value=[order.customer?.address,order.customer?.city,order.customer?.state,order.customer?.postalCode].filter(Boolean).join(", ");
      by("v3GstFields").dataset.order=String(order.id);
    }
    by("v3GstItems").innerHTML=(order?.items||[]).map((line,i)=>'<fieldset class="v3-gst-item"><legend>'+escapeHTML(line.name||line.id)+'</legend>'+
      '<label>HSN (4–8 digits)<input data-hsn="'+i+'" pattern="[0-9]{4,8}" maxlength="8" required></label>'+
      '<label>GST rate % (manual)<input type="number" data-rate="'+i+'" min="0" max="40" step="0.01" required></label></fieldset>').join("");
  }
  by("v3InvoiceType").addEventListener("change",showGstFields);
  by("v3InvoiceOrder").addEventListener("change",showGstFields);
  by("v3ReloadInvoices")?.addEventListener("click",loadInvoices);
  by("v3RefreshReports")?.addEventListener("click",loadReports);
  by("v3InvoiceProfile")?.addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const body=Object.fromEntries(new FormData(form).entries());
    const save=form.querySelector('button[type="submit"]');save.disabled=true;
    try{await api("/api/admin/invoices/profile",{method:"PUT",body:JSON.stringify(body)});toast("Invoice business details saved.");}
    catch(e){toast(e.message,true);}
    finally{save.disabled=false;}
  });
  by("v3IssueInvoiceForm")?.addEventListener("submit",async event=>{
    event.preventDefault();
    const orderId=by("v3InvoiceOrder").value;
    if(!orderId) return;
    const btn=by("v3IssueInvoice");btn.disabled=true;
    try{
      const invoiceType=by("v3InvoiceType").value;
      const payload={orderId,invoiceType};
      if(invoiceType==="gst"){
        payload.placeOfSupplyStateCode=by("v3GstState").value;
        payload.buyerAddress=by("v3BuyerAddress").value;
        payload.buyerGstin=by("v3BuyerGSTIN").value;
        payload.signatory=by("v3Signatory").value;
        payload.lines=[...by("v3GstItems").querySelectorAll("fieldset")].map(field=>({
          hsn:field.querySelector("[data-hsn]").value,
          gstRate:field.querySelector("[data-rate]").value
        }));
      }
      const x=await api("/api/admin/invoices",{method:"POST",body:JSON.stringify(payload)});
      toast(x.alreadyIssued?"Existing invoice retrieved.":"Invoice issued successfully.");
      await loadInvoices();
    }catch(e){toast(e.message,true);}
    finally{btn.disabled=false;}
  });
  by("v3InvoiceRows")?.addEventListener("click",async event=>{
    const button=event.target.closest(".v3-pdf");if(!button)return;
    button.disabled=true;
    try{
      const response=await fetch("/api/admin/invoices/"+encodeURIComponent(button.dataset.id)+"/pdf",{credentials:"same-origin"});
      if(response.status===401){lockAdmin();return;}
      if(!response.ok){let error=await response.json().catch(()=>({}));throw Error(error.error||"Could not download PDF.");}
      const blob=await response.blob();
      const link=document.createElement("a");const url=URL.createObjectURL(blob);
      link.href=url;link.download="AERLON-invoice-"+button.dataset.id+".pdf";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),2000);
    }catch(e){toast(e.message,true);}finally{button.disabled=false;}
  });
  async function loadPOSVariants() {
    if(!currentUser?.isOwner)return;
    try{
      const data=await api("/api/admin/pos/variants");
      by("v3POSVariant").innerHTML='<option value="">Choose stocked colour and size</option>'+
        (data.variants||[]).map(v=>'<option value="'+escapeHTML(v.id)+'">'+escapeHTML(v.name)+' · '+escapeHTML(v.color)+' / '+escapeHTML(v.size)+' · '+escapeHTML(moneyV3(v.unitPrice))+' · '+escapeHTML(v.quantity)+' available</option>').join("");
    }catch(e){toast(e.message,true);}
  }
  async function loadPOSHistory() {
    if(!currentUser?.isOwner)return;
    try{
      const data=await api("/api/admin/orders");
      const orders=(data.orders||[]).filter(o=>o.source==="pos").slice(0,30);
      by("v3POSRows").innerHTML=orders.map(o=>'<tr><td><strong>'+escapeHTML(o.id)+'</strong></td><td>'+escapeHTML(o.customer?.name||"Walk-in")+'</td><td>'+escapeHTML(moneyV3(o.total))+'</td><td>'+escapeHTML(dateV3(o.createdAt))+'</td></tr>').join("")||'<tr><td colspan="4" class="empty">No POS sales recorded.</td></tr>';
    }catch(e){toast(e.message,true);}
  }
  by("v3ReloadPOS")?.addEventListener("click",loadPOSVariants);
  by("v3POSRefreshHistory")?.addEventListener("click",loadPOSHistory);
  by("v3POSForm")?.addEventListener("submit",async event=>{
    event.preventDefault();const f=event.currentTarget;
    const data=Object.fromEntries(new FormData(f).entries());
    data.paymentConfirmed=f.elements.paymentConfirmed.checked;
    const b=by("v3POSSubmit");b.disabled=true;
    try{
      const sale=await api("/api/admin/pos/orders",{method:"POST",body:JSON.stringify(data)});
      toast("Cash sale "+sale.orderId+" recorded. Stock updated.");
      f.reset();await Promise.all([loadPOSVariants(),loadPOSHistory(),loadAlerts()]);
    }catch(e){toast(e.message,true);}
    finally{b.disabled=false;}
  });
  async function loadPayments() {
    if(!currentUser?.isOwner)return;
    try{
      const data=await api("/api/admin/orders");
      const orders=(data.orders||[]).filter(o=>!o.archivedAt);
      const paid=orders.filter(o=>o.paymentStatus==="paid");
      const unpaid=orders.filter(o=>o.paymentStatus!=="paid"&&o.orderStatus!=="cancelled");
      by("v3PaymentMetrics").innerHTML=[
        ['Paid revenue',moneyV3(paid.reduce((sum,o)=>sum+Number(o.total||0),0))],
        ['Paid orders',paid.length],['Awaiting payment',unpaid.length]
      ].map(([label,value])=>'<article><small>'+escapeHTML(label)+'</small><strong>'+escapeHTML(value)+'</strong></article>').join("");
      by("v3PaymentRows").innerHTML=orders.slice(0,100).map(o=>'<tr><td>'+escapeHTML(o.id)+'</td><td>'+escapeHTML(o.paymentMethod||"—")+'</td><td>'+escapeHTML(o.paymentStatus||"pending")+'</td><td>'+escapeHTML(moneyV3(o.total))+'</td><td>'+escapeHTML(dateV3(o.createdAt))+'</td></tr>').join("")||'<tr><td colspan="5" class="empty">No payments recorded.</td></tr>';
    }catch(e){toast(e.message,true);}
  }
  by("v3RefreshPayments")?.addEventListener("click",loadPayments);
  async function loadShipping() {
    if(!currentUser?.permissions?.includes("orders.update"))return;
    try{
      const data=await api("/api/admin/orders");
      const orders=(data.orders||[]).filter(o=>!o.archivedAt&&!["cancelled","delivered","awaiting_payment"].includes(o.orderStatus));
      by("v3ShippingRows").innerHTML=orders.slice(0,100).map(o=>'<tr data-order="'+escapeHTML(o.id)+'"><td><strong>'+escapeHTML(o.id)+'</strong></td><td>'+escapeHTML(o.customer?.name||"Customer")+'</td><td>'+escapeHTML(o.orderStatus)+'</td><td><input class="v3-carrier" aria-label="Carrier" placeholder="Carrier" maxlength="80" value="'+escapeHTML(o.shipment?.carrier||"")+'"><input class="v3-tracking" aria-label="Tracking reference" placeholder="Tracking ref" maxlength="100" value="'+escapeHTML(o.shipment?.trackingNumber||"")+'"></td><td><button type="button" class="btn small v3-save-shipping">Save tracking</button></td></tr>').join("")||'<tr><td colspan="5" class="empty">No active shipments.</td></tr>';
    }catch(e){toast(e.message,true);}
  }
  by("v3RefreshShipping")?.addEventListener("click",loadShipping);
  by("v3ShippingRows")?.addEventListener("click",async event=>{
    const button=event.target.closest(".v3-save-shipping");if(!button)return;
    const row=button.closest("tr");button.disabled=true;
    try{
      await api("/api/admin/orders/"+encodeURIComponent(row.dataset.order)+"/shipping",{
        method:"PATCH",body:JSON.stringify({carrier:row.querySelector(".v3-carrier").value,trackingNumber:row.querySelector(".v3-tracking").value})
      });
      toast("Shipping tracking saved.");await loadShipping();
    }catch(e){toast(e.message,true);}finally{button.disabled=false;}
  });
  async function loadTaxonomy(){
    if(!currentUser?.permissions?.includes("products.view"))return;
    try{
      const result=await api("/api/admin/catalogue/taxonomy");
      by("v3CategoryList").innerHTML=result.categories.map(row=>'<div><strong>'+escapeHTML(row.name)+'</strong><small>'+escapeHTML(row.count)+' products</small></div>').join("")||'<p class="muted">No product categories.</p>';
      by("v3BrandList").innerHTML=result.brands.map(row=>'<div><strong>'+escapeHTML(row.name)+'</strong><small>'+escapeHTML(row.count)+' products</small></div>').join("")||'<p class="muted">No brands assigned.</p>';
      by("v3CategoryFrom").innerHTML=result.categories.map(row=>'<option value="'+escapeHTML(row.name)+'">'+escapeHTML(row.name)+'</option>').join("");
      by("v3BrandProduct").innerHTML=result.products.map(row=>'<option value="'+escapeHTML(row.id)+'">'+escapeHTML(row.name)+(row.brand?' · '+escapeHTML(row.brand):'')+'</option>').join("");
    }catch(e){toast(e.message,true);}
  }
  by("v3ReloadCategories")?.addEventListener("click",loadTaxonomy);
  by("v3ReloadBrands")?.addEventListener("click",loadTaxonomy);
  by("v3CategoryRename")?.addEventListener("submit",async e=>{
    e.preventDefault();const form=e.currentTarget,body=Object.fromEntries(new FormData(form).entries());
    const button=form.querySelector('button[type="submit"]');button.disabled=true;
    try{const result=await api("/api/admin/catalogue/categories",{method:"PATCH",body:JSON.stringify(body)});
      toast(result.updated+" products updated.");form.reset();await loadTaxonomy();
    }catch(err){toast(err.message,true);}finally{button.disabled=false;}
  });
  by("v3BrandAssign")?.addEventListener("submit",async e=>{
    e.preventDefault();const form=e.currentTarget;
    const body=Object.fromEntries(new FormData(form).entries());
    const button=form.querySelector('button[type="submit"]');button.disabled=true;
    try{await api("/api/admin/catalogue/brands",{method:"PATCH",body:JSON.stringify(body)});
      toast("Product brand saved.");await loadTaxonomy();
    }catch(err){toast(err.message,true);}finally{button.disabled=false;}
  });
  async function loadBackupAudit(){
    if(!currentUser?.isOwner)return;
    try{
      const data=await api("/api/admin/audit");
      by("v3BackupAudit").innerHTML=(data.events||[]).slice(0,25).map(e=>'<div><strong>'+escapeHTML(e.action)+'</strong><small>'+escapeHTML(e.actor)+' · '+escapeHTML(dateV3(e.at))+'</small></div>').join("")||'<p>No recent audit events.</p>';
    }catch(e){toast(e.message,true);}
  }
  by("v3DownloadBackup")?.addEventListener("click",async e=>{
    if(!currentUser?.isOwner)return;
    const button=e.currentTarget;button.disabled=true;
    try{
      const response=await fetch("/api/admin/backups/operational.json",{credentials:"same-origin"});
      if(response.status===401){lockAdmin();return;}
      if(!response.ok){const d=await response.json().catch(()=>({}));throw Error(d.error||"Export failed.");}
      const blob=await response.blob(),url=URL.createObjectURL(blob);
      const link=document.createElement("a");link.href=url;link.download="aerlon-operations-"+new Date().toISOString().slice(0,10)+".json";
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
      toast("Operational data export downloaded.");
    }catch(err){toast(err.message,true);}finally{button.disabled=false;}
  });
  document.querySelectorAll("[data-v3-action]").forEach(button=>button.addEventListener("click",()=>{
    if(!currentUser)return;
    if(button.dataset.v3Action==="product" && currentUser.permissions?.includes("products.manage")) productModal();
    if(button.dataset.v3Action==="invoice" && currentUser.isOwner) navigate("invoices");
  }));
})();
