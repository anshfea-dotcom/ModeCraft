(function() {
  "use strict";
  const by = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const moneyV3 = n => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(n)||0);
  const dateV3 = value => value ? new Date(value).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "—";
  let lastInvoiceLoad = 0;
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
      by("v3InvoiceOrder").innerHTML='<option value="">Choose an order</option>'+options.map(order=>'<option value="'+escapeHTML(order.id)+'">'+escapeHTML(order.id)+' · '+escapeHTML(order.customer?.name||"Customer")+' · '+escapeHTML(moneyV3(order.total))+'</option>').join("");
      const invoices=items.invoices||[];
      by("v3InvoiceRows").innerHTML=invoices.map(invoice=>'<tr><td><strong>'+escapeHTML(invoice.invoiceNumber)+'</strong></td><td>'+escapeHTML(invoice.orderId)+'</td><td>'+escapeHTML(dateV3(invoice.createdAt))+'</td><td>'+escapeHTML(moneyV3(invoice.amount))+'</td><td><button type="button" class="btn small v3-pdf" data-id="'+escapeHTML(invoice.id)+'">Download PDF</button></td></tr>').join("")||'<tr><td colspan="5" class="empty">No invoices have been issued yet.</td></tr>';
      lastInvoiceLoad=Date.now();
    }catch(e){toast(e.message,true);}
    finally{loadingInvoices=false;}
  }

  window.loadAerlonV3Section = section => {
    if(section==="overview") loadAlerts();
    if(section==="invoices") loadInvoices();
    if(section==="reports") loadReports();
  };
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
      const x=await api("/api/admin/invoices",{method:"POST",body:JSON.stringify({orderId})});
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
  document.querySelectorAll("[data-v3-action]").forEach(button=>button.addEventListener("click",()=>{
    if(!currentUser)return;
    if(button.dataset.v3Action==="product" && currentUser.permissions?.includes("products.manage")) productModal();
    if(button.dataset.v3Action==="invoice" && currentUser.isOwner) navigate("invoices");
  }));
})();
