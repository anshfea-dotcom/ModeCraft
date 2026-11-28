(function() {
  "use strict";
  const by = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const moneyV3 = n => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(n)||0);
  const dateV3 = value => value ? new Date(value).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "—";
  let lastInvoiceLoad = 0;
  let loadingInvoices = false;
  let invoiceOrders = [];

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
    if(!currentUser?.permissions?.includes('invoices.issue') || loadingInvoices) return;
    loadingInvoices=true;
    try{
      const [p,items,orders]=await Promise.all([
        currentUser.isOwner ? api("/api/admin/invoices/profile") : Promise.resolve({profile:{}}),
        api("/api/admin/invoices"),
        api("/api/admin/orders")
      ]);
      const profile=p.profile||{},form=by("v3InvoiceProfile");
       by("v3InvoiceBusinessCard")?.classList.toggle("hidden",!currentUser.isOwner);
      for(const [name,value] of Object.entries(profile)) if(form.elements.namedItem(name)) form.elements.namedItem(name).value=String(value??"");
      const options=(orders.orders||[]).filter(order=>!["cancelled","awaiting_payment"].includes(order.orderStatus));
       invoiceOrders=options;
       renderGstFields();
      by("v3InvoiceOrder").innerHTML='<option value="">Choose an order</option>'+options.map(order=>'<option value="'+escapeHTML(order.id)+'">'+escapeHTML(order.id)+' · '+escapeHTML(order.customer?.name||"Customer")+' · '+escapeHTML(moneyV3(order.total))+'</option>').join("");
      const invoices=items.invoices||[];
      by("v3InvoiceRows").innerHTML=invoices.map(invoice=>'<tr><td><strong>'+escapeHTML(invoice.invoiceNumber)+'</strong></td><td>'+escapeHTML(invoice.type==="gst_tax_invoice"?"GST Tax":"Normal")+'</td><td>'+escapeHTML(invoice.orderId)+'</td><td>'+escapeHTML(dateV3(invoice.createdAt))+'</td><td>'+escapeHTML(moneyV3(invoice.amount))+'</td><td><button type="button" class="btn small v3-pdf" data-type="'+escapeHTML(invoice.type||"commercial_invoice")+'" data-id="'+escapeHTML(invoice.id)+'">Download PDF</button></td></tr>').join("")||'<tr><td colspan="6" class="empty">No invoices have been issued yet.</td></tr>';
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
    if(section==="warehouses") loadWarehouses();
    if(section==="categories"||section==="brands") loadTaxonomy();
    if(section==="backups") loadBackupAudit();
  };
  let warehouseCache={warehouses:[],assignments:[],variants:[]};
  async function loadWarehouses(){
    if(!currentUser?.isOwner)return;
    try{
      const [a,b]=await Promise.all([api("/api/admin/warehouses"),api("/api/admin/warehouses/variants")]);
      warehouseCache={warehouses:a.warehouses||[],assignments:a.assignments||[],variants:b.variants||[]};
      by("v3WarehouseList").innerHTML=warehouseCache.warehouses.map(w=>'<div><span><strong>'+escapeHTML(w.name)+'</strong><small style="display:block">'+escapeHTML(w.code)+' · '+escapeHTML(w.city||"—")+', '+escapeHTML(w.state||"—")+' · '+(w.active?"Active":"Inactive")+'</small></span><span><small>'+escapeHTML(w.assignedUnits||0)+' assigned units</small> <button type="button" class="btn small v3-toggle-wh" data-id="'+escapeHTML(w.id)+'">'+(w.active?"Disable":"Enable")+'</button></span></div>').join("")||'<p class="muted">No warehouses created.</p>';
      const currentWh=by("v3WarehouseId").value,oldVar=by("v3WarehouseVariantId").value;
      by("v3WarehouseId").innerHTML='<option value="">Choose location</option>'+warehouseCache.warehouses.filter(w=>w.active).map(w=>'<option value="'+escapeHTML(w.id)+'">'+escapeHTML(w.name)+'</option>').join("");
      by("v3WarehouseVariantId").innerHTML='<option value="">Choose variant</option>'+warehouseCache.variants.map(v=>'<option value="'+escapeHTML(v.id)+'">'+escapeHTML(v.name)+' · '+escapeHTML(v.color)+' / '+escapeHTML(v.size)+' · '+escapeHTML(v.totalStock)+' in stock</option>').join("");
      if(warehouseCache.warehouses.some(w=>w.id===currentWh&&w.active))by("v3WarehouseId").value=currentWh;
      if(warehouseCache.variants.some(v=>v.id===oldVar))by("v3WarehouseVariantId").value=oldVar;
      showWarehouseAllocation();
    }catch(e){by("v3WarehouseList").textContent="Cannot load warehouses: "+e.message;toast(e.message,true);}
  }
  function showWarehouseAllocation(){
    const wh=by("v3WarehouseId").value,variant=by("v3WarehouseVariantId").value;
    const x=warehouseCache.assignments.find(a=>a.warehouseId===wh&&a.variantId===variant);
    const p=warehouseCache.variants.find(a=>a.id===variant);
    const qty=by("v3WarehouseStockForm").elements.namedItem("quantity");
    const status=by("v3WarehouseVariantStockStatus"), productStatus=by("v3WarehouseProductStockStatus");
    qty.value=wh&&variant?String(x?.quantity||0):"";
    if(!p){
      qty.removeAttribute("max");
      by("v3WarehouseAllocationSummary").textContent="Choose a product variant.";
      if(status)status.textContent="Choose a size to see available stock.";
      if(productStatus)productStatus.textContent="";
      return;
    }
    const central=Number(p.totalStock)||0,current=Number(x?.quantity||0);
    const other=warehouseCache.assignments.filter(a=>a.variantId===variant&&a.warehouseId!==wh)
      .reduce((sum,a)=>sum+Number(a.quantity||0),0);
    const used=warehouseCache.assignments.filter(a=>warehouseCache.variants.some(v=>v.id===a.variantId&&v.productId===p.productId))
      .reduce((sum,a)=>sum+Number(a.quantity||0),0);
    const cap=Number(p.productStock);
    const capSet=Number.isSafeInteger(cap)&&cap>0;
    const totalMax=capSet?Math.max(0,cap-(used-current)):Infinity;
    const variantMax=Math.max(0,central-other);
    const max=Math.max(0,Math.min(totalMax,variantMax));
    qty.max=String(Math.floor(max));
    by("v3WarehouseAllocationSummary").textContent="Size "+p.size+" · Central: "+central+
      " · Assigned elsewhere: "+other+" · Unassigned: "+Math.max(0,central-other-current)+
      " · Maximum here: "+max;
    if(status)status.textContent="Available for this size: "+Math.max(0,central-other-current)+
      " unit(s) · Already here: "+current+" · Maximum assignment here: "+max;
    if(productStatus)productStatus.textContent=capSet?
      "Product-wide limit: "+cap+" units · Assigned across all sizes/warehouses: "+used+
      " · Remaining: "+Math.max(0,cap-used)+". The server blocks any total above "+cap+".":
      "No positive product-wide limit is configured; this size remains limited by its real central inventory.";
  }

  by("v3WarehouseId")?.addEventListener("change",showWarehouseAllocation);
  by("v3WarehouseVariantId")?.addEventListener("change",showWarehouseAllocation);
  by("v3ReloadWarehouses")?.addEventListener("click",loadWarehouses);
  by("v3WarehouseForm")?.addEventListener("submit",async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector("button[type=submit]");
    button.disabled=true;
    try{await api("/api/admin/warehouses",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});
      form.reset();toast("Warehouse created.");await loadWarehouses();
    }catch(err){toast(err.message,true);}finally{button.disabled=false;}
  });
  by("v3WarehouseStockForm")?.addEventListener("submit",async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector("button[type=submit]");
    button.disabled=true;
    try{await api("/api/admin/warehouses/stock",{method:"PUT",body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});
      toast("Warehouse assignment saved.");await loadWarehouses();
    }catch(err){toast(err.message,true);}finally{button.disabled=false;}
  });
  by("v3WarehouseList")?.addEventListener("click",async e=>{
    const button=e.target.closest(".v3-toggle-wh");if(!button)return;
    const wh=warehouseCache.warehouses.find(x=>x.id===button.dataset.id);if(!wh)return;
    if(!window.confirm((wh.active?"Disable ":"Enable ")+wh.name+"?"))return;
    button.disabled=true;
    try{await api("/api/admin/warehouses/"+encodeURIComponent(wh.id),{method:"PATCH",body:JSON.stringify({active:!wh.active})});
      toast("Warehouse status updated.");await loadWarehouses();
    }catch(err){toast(err.message,true);}finally{button.disabled=false;}
  });
  by("v3ReloadInvoices")?.addEventListener("click",loadInvoices);
  function renderGstFields(){
    const isGST=by("v3InvoiceType").value==="gst";
    by("v3GstFields").classList.toggle("hidden",!isGST);
    for(const el of by("v3GstFields").querySelectorAll("[required]")) el.disabled=!isGST;
    if(!isGST)return;
    const selected=invoiceOrders.find(o=>String(o.id)===by("v3InvoiceOrder").value);
    const items=selected?.items||[];
    by("v3GstLines").innerHTML=items.map((item,i)=>'<fieldset class="v3-gst-line" style="border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0"><legend>'+escapeHTML(item.name||"Item "+(i+1))+' · Qty '+escapeHTML(item.quantity)+'</legend><div class="formgrid"><div class="formfield"><label>HSN code</label><input name="hsn" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required placeholder="HSN"></div><div class="formfield"><label>GST rate (%)</label><input name="rate" type="number" min="0" max="100" step="0.01" required placeholder="Enter actual rate"></div><div class="formfield full"><label>Gross amount including GST (INR)</label><input name="gross" type="number" min="0.01" max="999999999" step="0.01" required placeholder="Manually allocate the order total"></div></div></fieldset>').join("")||'<p class="notice">Select an order with items.</p>';
    by("v3GstOrderAmount").textContent=selected?"Order total including taxes: "+moneyV3(selected.total):"Select an order first.";
  }
  function gstInvoicePayload(orderId){
    const fields=by("v3GstFields");
    const elements=fields.querySelectorAll("input:not([type=checkbox])");
    for(const item of elements) if(!item.checkValidity()){item.reportValidity();throw Error("Complete every required GST invoice field.");}
    const lines=[...by("v3GstLines").querySelectorAll(".v3-gst-line")].map(box=>({
      hsn:box.querySelector('[name="hsn"]').value,
      rate:box.querySelector('[name="rate"]').value,
      gross:box.querySelector('[name="gross"]').value
    }));
    if(!lines.length)throw Error("Choose an order with at least one item.");
    const selected=invoiceOrders.find(o=>String(o.id)===orderId);
    const sum=lines.reduce((n,l)=>n+Math.round(Number(l.gross)*100),0);
    if(sum!==Math.round(Number(selected?.total||0)*100))throw Error("The GST line gross amounts must add up to the original order total.");
    return {
      orderId,lines,buyerName:by("v3GstBuyerName").value,
      buyerAddress:by("v3GstBuyerAddress").value,
      buyerGstin:by("v3GstBuyerGstin").value,
      placeOfSupplyCode:by("v3GstStateCode").value,
      placeOfSupplyName:by("v3GstStateName").value
    };
  }
  by("v3InvoiceType")?.addEventListener("change",renderGstFields);
  by("v3InvoiceOrder")?.addEventListener("change",renderGstFields);
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
      const gst=by("v3InvoiceType").value==="gst";
       const body=gst?gstInvoicePayload(orderId):{orderId};
       if(!window.confirm("Issue "+(gst?"GST Tax":"Normal")+" invoice for order "+orderId+"? This creates a permanent invoice record."))return;
       const x=await api(gst?"/api/admin/gst-invoices":"/api/admin/invoices",{method:"POST",body:JSON.stringify(body)});
      toast(x.alreadyIssued?"Existing invoice retrieved.":"Invoice issued successfully.");
      await loadInvoices();
    }catch(e){toast(e.message,true);}
    finally{btn.disabled=false;}
  });
  by("v3InvoiceRows")?.addEventListener("click",async event=>{
    const button=event.target.closest(".v3-pdf");if(!button)return;
    button.disabled=true;
    try{
      const response=await fetch((button.dataset.type==="gst_tax_invoice"?"/api/admin/gst-invoices/":"/api/admin/invoices/")+encodeURIComponent(button.dataset.id)+"/pdf",{credentials:"same-origin"});
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
