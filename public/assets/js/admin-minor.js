/* Focused AERLON Admin 3.0 UX upgrades; core APIs and data rules stay unchanged. */
(() => {
  "use strict";
  const by=id=>document.getElementById(id);
  const menu=by("workspaceMenu"), search=by("adminSearchToggle"), panel=by("adminQuickSearchPanel");
  const input=by("adminQuickSearchInput"),results=by("adminQuickSearchResults");
  const mobileLogout=by("adminMobileLogout");
  if(menu)menu.setAttribute("aria-label","Open workspace menu");
  const closeSearch=()=>{
    if(panel)panel.hidden=true;
    search?.setAttribute("aria-expanded","false");
    input.value="";
    results.replaceChildren();
  };
  const availableEntries=()=>{
    if(!currentUser)return [];
    const entries=[];
    document.querySelectorAll("#nav button[data-section]").forEach(node=>{
      if(node.classList.contains("hidden")||node.hidden)return;
      entries.push({kind:"Section",name:node.textContent.trim(),section:node.dataset.section});
    });
    if(has("products.view"))for(const product of products){
      entries.push({kind:"Product",name:String(product.name||"Product"),note:[product.category,product.id].filter(Boolean).join(" · "),section:"products",id:String(product.id)});
    }
    if(has("orders.view"))for(const order of allOrders){
      entries.push({kind:"Order",name:String(order.id||order.orderId||"Order"),note:String(order.customer?.name||""),section:"orders",id:String(order.id||order.orderId||"")});
    }
    return entries;
  };
  const showResults=()=>{
    results.replaceChildren();
    const query=input.value.trim().toLocaleLowerCase();
    if(!query){const p=document.createElement("p");p.textContent="Search sections, products or orders.";results.append(p);return;}
    const matches=availableEntries().filter(x=>(x.name+" "+(x.note||"")+" "+x.kind).toLocaleLowerCase().includes(query)).slice(0,18);
    if(!matches.length){const p=document.createElement("p");p.textContent="No matching records in your permitted sections.";results.append(p);return;}
    for(const item of matches){
      const b=document.createElement("button");b.type="button";
      const kind=document.createElement("span");kind.className="search-kind";kind.textContent=item.kind;
      const content=document.createElement("span"),title=document.createElement("strong");title.textContent=item.name;content.append(title);
      if(item.note){const subtitle=document.createElement("small");subtitle.textContent=item.note;content.append(subtitle);}
      b.append(kind,content);
      b.addEventListener("click",()=>{
        closeSearch();
        if(!item.section||!document.querySelector('#nav button[data-section="'+item.section+'"]:not(.hidden)'))return;
        navigate(item.section);
        if(item.kind==="Order" && item.id){
          const field=by("orderSearch");if(field){field.value=item.id;renderOrders();}
        }
        if(item.kind==="Product" && item.id){
          const highlight=()=>{
            const row=Array.from(document.querySelectorAll("#productsGrid [data-product-id]")).find(node=>node.dataset.productId===item.id);
            if(!row)return false;
            row.scrollIntoView({block:"center",behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});
            row.classList.add("admin-product-found");
            setTimeout(()=>row.classList.remove("admin-product-found"),2200);
            return true;
          };
          if(!highlight())setTimeout(highlight,450);
        }
      });
      results.append(b);
    }
  };
  search?.addEventListener("click",()=>{
    if(!currentUser)return;
    const opening=panel.hidden;
    if(opening && menu?.getAttribute("aria-expanded")==="true")menu.click();
    panel.hidden=!opening;
    search.setAttribute("aria-expanded",String(opening));
    if(opening){showResults();input.focus();}
  });
  input?.addEventListener("input",showResults);
  input?.addEventListener("keydown",event=>{
    if(event.key==="Enter"){const first=results.querySelector("button");if(first){event.preventDefault();first.click();}}
    if(event.key==="Escape")closeSearch();
  });
  menu?.addEventListener("click",()=>{if(panel&&!panel.hidden)closeSearch();});
  mobileLogout?.addEventListener("click",()=>by("logout")?.click());
  document.addEventListener("pointerdown",event=>{
    if(panel && !panel.hidden && !panel.contains(event.target) && event.target!==search && !search.contains(event.target))closeSearch();
  });
  document.addEventListener("keydown",event=>{if(event.key==="Escape" && panel && !panel.hidden)closeSearch();});
  document.querySelector("#nav")?.addEventListener("click",()=>{if(panel&&!panel.hidden)closeSearch();});

  // Warehouse "Add units" is deliberately additive; the existing PUT endpoint
  // saves absolute assigned quantities. It never increases central inventory.
  const form=by("v3WarehouseStockForm"), addBtn=by("v3WarehouseQuickAdd"), extra=by("v3WarehouseExtraUnits");
  const helper=by("v3WarehouseQuickMessage");
  if(!form||!addBtn||!extra)return;
  addBtn.addEventListener("click",async()=>{
    if(!currentUser?.isOwner)return;
    const warehouseId=by("v3WarehouseId")?.value,variantId=by("v3WarehouseVariantId")?.value;
    const delta=Number(extra.value);
    if(!warehouseId||!variantId){helper.textContent="Choose a warehouse and product/size first.";return;}
    if(!Number.isSafeInteger(delta)||delta<=0||delta>1000000){helper.textContent="Enter a positive whole number of units.";extra.focus();return;}
    addBtn.disabled=true;helper.textContent="Checking the latest warehouse allocation…";
    try{
      const [w,v]=await Promise.all([api("/api/admin/warehouses"),api("/api/admin/warehouses/variants")]);
      if(by("v3WarehouseId")?.value!==warehouseId||by("v3WarehouseVariantId")?.value!==variantId)throw Error("Selection changed. Please try again.");
      const wh=(w.warehouses||[]).find(x=>x.id===warehouseId);
      const variant=(v.variants||[]).find(x=>x.id===variantId);
      if(!wh?.active||!variant)throw Error("Warehouse or product size is no longer available.");
      const current=Number((w.assignments||[]).find(x=>x.warehouseId===warehouseId&&x.variantId===variantId)?.quantity||0);
      const other=(w.assignments||[]).filter(x=>x.warehouseId!==warehouseId&&x.variantId===variantId).reduce((sum,x)=>sum+Number(x.quantity||0),0);
      const next=current+delta;
      if(!Number.isSafeInteger(next)||next+other>Number(variant.totalStock)){
        throw Error("Only "+Math.max(0,Number(variant.totalStock)-current-other)+" unassigned units are available for this size. Increase central inventory first.");
      }
      const overallCap=Number(variant.productStock);
      if(Number.isSafeInteger(overallCap)&&overallCap>0){
        const ids=new Set((v.variants||[]).filter(row=>row.productId===variant.productId).map(row=>row.id));
        const assignedAcrossProduct=(w.assignments||[]).filter(row=>ids.has(row.variantId)).reduce((sum,row)=>sum+Number(row.quantity||0),0);
        if(assignedAcrossProduct+delta>overallCap)
          throw Error("This product has "+overallCap+" total units. Only "+Math.max(0,overallCap-assignedAcrossProduct)+" unassigned units remain across all sizes and warehouses.");
      }
      const qty=form.elements.namedItem("quantity");
      qty.value=String(next);
      helper.textContent="Saving "+delta+" additional unit(s) for "+wh.name+"…";
      // Use the existing transaction-safe PUT endpoint. Do not submit the other form
      // simultaneously, and never change the central inventory quantity here.
      await api("/api/admin/warehouses/stock",{
        method:"PUT",body:JSON.stringify({warehouseId,variantId,quantity:next})
      });
      helper.textContent="Added "+delta+" unit(s). "+next+" units now assigned here.";
      extra.value="";
      by("v3ReloadWarehouses")?.click();
      toast("Warehouse stock assignment updated.");
    }catch(err){helper.textContent=err.message;toast(err.message,true);}
    finally{addBtn.disabled=false;}
  });
  by("v3WarehouseId")?.addEventListener("change",()=>{helper.textContent="";});
  by("v3WarehouseVariantId")?.addEventListener("change",()=>{helper.textContent="";});
})();