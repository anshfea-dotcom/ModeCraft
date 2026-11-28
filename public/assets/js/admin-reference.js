/* AERLON command centre: real data only, no synthetic commerce figures. */
(function () {
  "use strict";
  const el = id => document.getElementById(id);
  const safe = value => String(value ?? "");
  const hasAccess = permission => !!(window.currentUser || (typeof currentUser !== "undefined" && currentUser)) &&
    (typeof currentUser !== "undefined" && (currentUser.isOwner || currentUser.permissions?.includes(permission)));
  const readable = value => safe(value).replaceAll("_", " ");
  const rup = value => new Intl.NumberFormat("en-IN", {style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value) || 0);
  const state = {search:[],loadedAt:0,results:[],notifications:[],open:false,searchOpen:false,rendering:false};
  const main = document.querySelector(".main");
  const oldHeader = main?.querySelector(".topbar");
  if (!main || !oldHeader) return;
  const bar = document.createElement("div");
  bar.className = "ae-commandbar";
  bar.innerHTML = '<button id="aeMenuToggle" class="ae-icon-button ae-menu" type="button" aria-label="Toggle navigation" aria-expanded="false">☰</button>' +
    '<div class="ae-command-search"><span aria-hidden="true">⌕</span><input id="aeGlobalSearch" type="search" autocomplete="off" maxlength="100" placeholder="Search orders, customers, products, reports and more..." aria-label="Search administration" role="combobox" aria-expanded="false" aria-controls="aeSearchResults"><kbd>⌘ K</kbd><div id="aeSearchResults" class="ae-search-results" role="listbox" hidden></div></div>' +
    '<div class="ae-command-actions"><button type="button" class="ae-icon-button ae-mobile-search" id="aeMobileSearch" aria-label="Search">⌕</button><button type="button" class="ae-icon-button ae-bell" id="aeNotificationToggle" aria-label="Open notifications" aria-expanded="false" aria-controls="aeNotificationPanel"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg><span class="ae-badge" id="aeNotificationCount" hidden></span></button>' +
    '<button type="button" id="aeProfileToggle" class="ae-profile-button" aria-expanded="false" aria-controls="aeProfileMenu"><span class="ae-avatar" id="aeProfileAvatar">A</span><span class="ae-profile-text"><strong id="aeProfileName">AERLON Admin</strong><small id="aeProfileRole">Store administrator</small></span><span aria-hidden="true">⌄</span></button></div>' +
    '<section id="aeNotificationPanel" class="ae-popover ae-notifications" aria-label="Notifications" hidden><div class="ae-popover-head"><strong>Operational notifications</strong><button type="button" id="aeRefreshNotifications" class="ae-mini-link">Refresh</button></div><p class="ae-popover-caption" id="aeNotificationStatus">Open to check live store activity.</p><div id="aeNotificationList" class="ae-notification-list"></div></section>' +
    '<div id="aeProfileMenu" class="ae-popover ae-profile-menu" hidden><strong id="aeMenuName">Administrator</strong><small id="aeMenuRole">AERLON</small><button type="button" id="aeProfileTheme">Switch appearance</button><button type="button" id="aeProfileLogout">Sign out</button></div>';
  main.insertBefore(bar, oldHeader);

  const profileButton = el("aeProfileToggle");
  const profileMenu = el("aeProfileMenu");
  const bell = el("aeNotificationToggle");
  const panel = el("aeNotificationPanel");
  const input = el("aeGlobalSearch");
  const results = el("aeSearchResults");
  const sideToggle = el("aeMenuToggle");

  const welcome = document.querySelector(".v3-greeting");
  if (welcome) welcome.remove();
  const quick = document.querySelector(".v3-actions");
  const right = document.querySelector(".v3-contentgrid > .card:nth-child(2)");
  if (quick && right) {
    quick.classList.add("ae-right-actions");
    const separator = right.querySelector(".v3-separator");
    right.insertBefore(quick, separator);
  }
  const recent = document.querySelector(".v3-recent");
  if (recent) {
    const lower = document.createElement("div");
    lower.className = "ae-bottom-grid";
    recent.parentNode.insertBefore(lower, recent);
    lower.appendChild(recent);
    const selling = document.createElement("article");
    selling.className = "card ae-top-selling";
    selling.innerHTML = '<div class="cardtitle"><div><h2>Top Selling Products</h2><p>Verified paid orders only</p></div><button type="button" class="ae-mini-link" id="aeViewAllProducts">View all</button></div><div id="aeSellingList" class="ae-selling-list"><p class="muted">Loading sales…</p></div>';
    lower.appendChild(selling);
    el("aeViewAllProducts")?.addEventListener("click", () => typeof navigate === "function" && navigate("products"));
  }
  const chartCard = document.querySelector(".v3-contentgrid > .card:first-child");
  const chartTitle = chartCard?.querySelector(".cardtitle");
  if (chartTitle) {
    const tabs = document.createElement("div");
    tabs.className = "ae-chart-tabs";
    tabs.setAttribute("role","group");
    tabs.setAttribute("aria-label","Sales chart metric");
    tabs.innerHTML = '<button type="button" class="active" data-ae-metric="revenue" aria-pressed="true">Revenue</button><button type="button" data-ae-metric="orders" aria-pressed="false">Orders</button><button type="button" data-ae-metric="customers" aria-pressed="false">Customers</button>';
    chartTitle.append(tabs);
    chartTitle.querySelector("#salesRange")?.classList.add("ae-sales-range");
    let metric = "revenue";
    function chartUpdate() {
      if (metric === "revenue" || !hasAccess("orders.view")) return;
      const orders = (typeof allOrders === "undefined" ? [] : allOrders).filter(x => !x.archivedAt);
      const range = Number(el("salesRange")?.value || 30);
      const count = range === 365 ? 12 : range === 90 ? 13 : range;
      const now = new Date(), buckets=[];
      for (let offset=count-1;offset>=0;offset--) {
        const start = new Date(now);
        if (range === 365) { start.setDate(1);start.setMonth(start.getMonth()-offset); }
        else start.setDate(start.getDate()-offset*(range === 90 ? 7 : 1));
        start.setHours(0,0,0,0);
        const end = new Date(start);
        if (range === 365) end.setMonth(end.getMonth()+1);else end.setDate(end.getDate()+(range === 90 ? 7 : 1));
        const selected = orders.filter(o => { const n=Date.parse(o.createdAt || "");return n>=start.getTime() && n<end.getTime();});
        const value = metric === "orders" ? selected.length :
          new Set(selected.map(o => safe(o.customer?.email || o.customer?.phone).trim().toLowerCase()).filter(Boolean)).size;
        buckets.push({label:start.toLocaleDateString("en-IN",range===365?{month:"short"}:{day:"numeric",month:"short"}),value});
      }
      const chart = el("chart"); if (!chart) return;
      const max=Math.max(1,...buckets.map(b=>b.value));
      const points = buckets.map((b,i) => [12+606*i/Math.max(1,count-1),195-b.value/max*170]);
      const route = points.map((p,i) => (i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
      chart.replaceChildren();
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("viewBox","0 0 640 220");
      svg.setAttribute("preserveAspectRatio","none");
      svg.setAttribute("role","img");
      svg.setAttribute("aria-label",(metric==="orders"?"Order count":"Unique customer count")+" over time");
      const fill=document.createElementNS(svg.namespaceURI,"path");
      fill.setAttribute("d",route+" L618 205 L12 205 Z"); fill.setAttribute("fill","#c9a05d33");
      const line=document.createElementNS(svg.namespaceURI,"path");
      line.setAttribute("d",route);line.setAttribute("fill","none");line.setAttribute("stroke","#a67b3f");line.setAttribute("stroke-width","3");
      svg.append(fill,line);
      const labels=document.createElement("div");
      labels.className="ae-chart-axis";
      for (const b of [buckets[0],buckets[Math.floor(buckets.length/2)],buckets.at(-1)]) {
        const span=document.createElement("span"); span.textContent=b?.label||""; labels.appendChild(span);
      }
      chart.append(svg,labels);
    }
    tabs.addEventListener("click", event => {
      const button=event.target.closest("[data-ae-metric]");if(!button)return;
      if (!hasAccess("orders.view")) { toast("This role cannot view order analytics.",true);return; }
      metric=button.dataset.aeMetric;
      tabs.querySelectorAll("button").forEach(b=>{b.classList.toggle("active",b===button);b.setAttribute("aria-pressed",String(b===button));});
      if (metric==="revenue") renderOverview();else chartUpdate();
    });
    el("salesRange")?.addEventListener("change",()=>queueMicrotask(chartUpdate));
    const originalRender = window.renderOverview || renderOverview;
    // Existing overview renderer always computes the correct paid revenue; restore the selected chart afterwards.
    if (typeof originalRender === "function") {
      window.renderOverview=function(){originalRender();chartUpdate();renderTopSelling();};
    }
  }

  function renderTopSelling() {
    const target=el("aeSellingList"); if(!target)return;
    target.replaceChildren();
    if (!hasAccess("orders.view")) { target.textContent="Order access is required for sales rankings.";return; }
    const map=new Map();
    for(const order of (typeof allOrders==="undefined"?[]:allOrders)) {
      if(order.paymentStatus!=="paid" || order.orderStatus==="cancelled" || order.archivedAt)continue;
      for(const item of order.items||[]) {
        const id=safe(item.id || item.productId || item.product_id || item.name);
        if(!id)continue;
        const quantity=Math.max(0,Number(item.quantity)||0);if(!quantity)continue;
        const entry=map.get(id)||{id,name:safe(item.name||"Product"),units:0};
        entry.units+=quantity;map.set(id,entry);
      }
    }
    const ranked=[...map.values()].sort((a,b)=>b.units-a.units).slice(0,5);
    if(!ranked.length){ const p=document.createElement("p");p.className="muted";p.textContent="No paid product sales in the recorded orders yet.";target.append(p);return; }
    for(const item of ranked) {
      const row=document.createElement("div");row.className="ae-seller";
      const product=(typeof products === "undefined" ? [] : products).find(p=>safe(p.id)===item.id||safe(p.name)===item.name);
      if(product?.image && /^(https:\/\/|\/(?!\/))/i.test(product.image)){const img=document.createElement("img");img.src=product.image;img.alt="";img.loading="lazy";row.append(img);}
      else {const art=document.createElement("span");art.className="ae-seller-art";art.textContent="AE";row.append(art);}
      const text=document.createElement("div");const name=document.createElement("strong");name.textContent=product?.name||item.name;const detail=document.createElement("small");detail.textContent=item.units+" sold";text.append(name,detail);
      row.append(text);
      const arrow=document.createElement("span");arrow.className="ae-row-arrow";arrow.textContent="›";row.append(arrow);
      row.tabIndex=0;row.setAttribute("role","button");row.setAttribute("aria-label","View "+name.textContent);
      const open=()=>{if(!hasAccess("products.view"))return; navigate("products");setTimeout(()=>focusProduct(item.id),500);};
      row.addEventListener("click",open);row.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();open();}});
      target.append(row);
    }
  }

  function focusProduct(id) {
    const card = document.querySelector('#productsGrid [data-product-id="'+CSS.escape(safe(id))+'"]');
    if(card){card.scrollIntoView({block:"center",behavior:"smooth"});card.classList.add("ae-found");setTimeout(()=>card.classList.remove("ae-found"),2200);}
  }
  const menu = () => {
    const mobile=matchMedia("(max-width:700px)").matches;
    if(mobile) {
      const workspace=el("workspaceMenu");
      workspace?.click();
      sideToggle.setAttribute("aria-expanded",workspace?.getAttribute("aria-expanded")||"false");
    } else document.querySelector(".app")?.classList.toggle("ae-sidebar-collapsed");
  };
  sideToggle.addEventListener("click",menu);
  const mobileSearch=el("aeMobileSearch");
  mobileSearch?.addEventListener("click",()=>{bar.classList.add("ae-search-active");input.focus();});
  function closeFloating() {
    results.hidden=true;panel.hidden=true;profileMenu.hidden=true;
    bell.setAttribute("aria-expanded","false");
    profileButton.setAttribute("aria-expanded","false");
    input.setAttribute("aria-expanded","false");
    bar.classList.remove("ae-search-active");
  }
  document.addEventListener("pointerdown",e=>{if(!bar.contains(e.target))closeFloating();});
  document.addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){e.preventDefault();input.focus();bar.classList.add("ae-search-active");return;}
    if(e.key==="Escape"){closeFloating();const workspace=el("workspaceMenu");if(workspace?.getAttribute("aria-expanded")==="true"){workspace.click();sideToggle.setAttribute("aria-expanded","false");}}
  });
  profileButton.addEventListener("click",()=>{
    const open=profileMenu.hidden;closeFloating();profileMenu.hidden=!open;profileButton.setAttribute("aria-expanded",String(open));
  });
  el("aeProfileTheme")?.addEventListener("click",()=>{el("themeToggle")?.click();closeFloating();});
  el("aeProfileLogout")?.addEventListener("click",()=>el("logout")?.click());

  function refreshIdentity() {
    if(typeof currentUser==="undefined" || !currentUser)return;
    const name=safe(currentUser.displayName||currentUser.username||"Admin");
    el("aeProfileName").textContent=name;
    el("aeMenuName").textContent=name;
    el("aeProfileRole").textContent=currentUser.isOwner?"Super Administrator":readable(currentUser.role||"Team member");
    el("aeMenuRole").textContent=el("aeProfileRole").textContent;
    el("aeProfileAvatar").textContent=name.trim().slice(0,1).toUpperCase();
    if(el("section-overview")?.classList.contains("active"))el("pageTitle").textContent="Welcome back, "+name;
  }
  new MutationObserver(()=>{if(!el("app")?.classList.contains("hidden")){refreshIdentity();renderTopSelling();}}).observe(el("app"),{attributes:true,attributeFilter:["class"]});

  async function buildSearch() {
    if(!currentUser) return [];
    if(state.loadedAt && Date.now()-state.loadedAt<45000)return state.search;
    const calls=[];
    if(hasAccess("orders.view")) calls.push(api("/api/admin/orders").then(d=>(d.orders||[]).map(x=>({type:"Order",title:safe(x.id),hint:safe(x.customer?.name)+" · "+rup(x.total),section:"orders",id:x.id}))));
    if(hasAccess("products.view")) calls.push(api("/api/admin/products").then(d=>(d.products||[]).map(x=>({type:"Product",title:safe(x.name),hint:safe(x.category),section:"products",id:x.id}))));
    if(hasAccess("customers.view")) calls.push(api("/api/admin/customers").then(d=>(d.customers||[]).map(x=>({type:"Customer",title:safe(x.name),hint:safe(x.email||x.phone),section:"customers",id:x.name}))));
    const settled=await Promise.allSettled(calls);
    const collection=settled.filter(x=>x.status==="fulfilled").flatMap(x=>x.value);
    for(const button of document.querySelectorAll("#nav button[data-section]")){
      if(button.classList.contains("hidden") || button.hidden)continue;
      collection.push({type:"Section",title:button.textContent.trim(),hint:"Open workspace section",section:button.dataset.section});
    }
    state.search=collection;state.loadedAt=Date.now();
    if(settled.some(x=>x.status==="rejected"))el("aeSearchResults").dataset.partial="true";
    return collection;
  }
  function showSearch(rows,query){
    results.replaceChildren();state.results=rows;
    const heading=document.createElement("p");heading.className="ae-search-label";
    heading.textContent=results.dataset.partial==="true"?"Some results are unavailable. Try again.":rows.length?rows.length+" matching results":"No matching records";
    results.append(heading);
    for(const item of rows){
      const b=document.createElement("button");b.type="button";b.className="ae-search-result";b.setAttribute("role","option");
      const icon=document.createElement("span");icon.className="ae-result-type";icon.textContent=item.type.slice(0,1);
      const body=document.createElement("span");const title=document.createElement("strong");title.textContent=item.title;const hint=document.createElement("small");hint.textContent=item.type+" · "+item.hint;body.append(title,hint);b.append(icon,body);
      b.onclick=()=>{
        closeFloating();input.value="";
        if(typeof navigate!=="function")return;
        navigate(item.section);
        if(item.section==="orders" && item.id){el("orderSearch").value=safe(item.id);renderOrders();}
        if(item.section==="customers" && item.id){el("customerSearch").value=safe(item.id);renderCustomers();}
        if(item.section==="products" && item.id)setTimeout(()=>focusProduct(item.id),500);
      };
      results.append(b);
    }
    results.hidden=false;input.setAttribute("aria-expanded","true");
  }
  let lastQuery=0;
  input.addEventListener("input",async()=>{
    const serial=++lastQuery, query=input.value.trim().toLocaleLowerCase();
    if(!query){results.hidden=true;input.setAttribute("aria-expanded","false");return;}
    results.hidden=false;results.textContent="Searching authorised records…";
    try{
      const records=await buildSearch();
      if(serial!==lastQuery)return;
      const matching=records.filter(r=>(r.title+" "+r.hint+" "+r.type).toLocaleLowerCase().includes(query)).slice(0,12);
      showSearch(matching,query);
    }catch(error){if(serial===lastQuery){results.textContent="Search unavailable: "+error.message;results.hidden=false;}}
  });
  input.addEventListener("focus",()=>{if(input.value)input.dispatchEvent(new Event("input"));});
  input.addEventListener("keydown",e=>{if(e.key==="Enter" && !results.hidden){const first=results.querySelector(".ae-search-result");if(first){e.preventDefault();first.click();}}});

  async function refreshNotifications() {
    if(!currentUser)return;
    const list=el("aeNotificationList"),status=el("aeNotificationStatus");
    list.textContent="Loading operational alerts…";
    const jobs=[];
    if(hasAccess("products.view"))jobs.push(api("/api/admin/inventory/alerts").then(d=>({kind:"inventory",items:d.alerts||[]})));
    if(hasAccess("orders.view"))jobs.push(api("/api/admin/orders").then(d=>({kind:"orders",items:d.orders||[]})));
    if(currentUser.isOwner)jobs.push(api("/api/admin/automations").then(d=>({kind:"automation",items:d.alerts||[]})));
    const settled=await Promise.allSettled(jobs);
    const entries=[];
    for(const item of settled) {
      if(item.status!=="fulfilled")continue;
      const {kind,items}=item.value;
      if(kind==="inventory") for(const a of items.slice(0,15))entries.push({type:"Stock",title:safe(a.productName||"Product")+" · "+safe(a.color)+" / "+safe(a.size),body:Number(a.quantity)===0?"Out of stock":Number(a.quantity)+" units remaining",section:"inventory",pending:true});
      if(kind==="orders") {
        const waiting=items.filter(o=>!o.archivedAt&&!["delivered","cancelled"].includes(o.orderStatus)).sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0));
        for(const o of waiting.slice(0,12))entries.push({type:"Order",title:"Order "+safe(o.id),body:readable(o.orderStatus)+" · "+rup(o.total),section:"orders",id:o.id,pending:true});
      }
      if(kind==="automation") for(const a of items.filter(a=>!a.acknowledged).slice(0,20))entries.push({type:"Alert",title:safe(a.rule_name||"Operational alert"),body:safe(a.detail||a.entity_key),section:"automations",alertId:a.id,pending:true});
    }
    state.notifications=entries;
    const count=entries.length;
    el("aeNotificationCount").hidden=!count;
    el("aeNotificationCount").textContent=count>99?"99+":String(count);
    status.textContent=settled.some(x=>x.status==="rejected")?"Some notifications could not be loaded.":count+" current notifications from permitted store records";
    list.replaceChildren();
    if(!count){const p=document.createElement("p");p.className="ae-empty";p.textContent=settled.some(x=>x.status==="rejected")?"Unable to fetch all alerts. Try refresh.":"No outstanding operational notifications.";list.append(p);return;}
    for(const notification of entries){
      const row=document.createElement("div");row.className="ae-notification";
      const type=document.createElement("span");type.className="ae-notification-type";type.textContent=notification.type;
      const copy=document.createElement("div");const title=document.createElement("strong");title.textContent=notification.title;
      const desc=document.createElement("small");desc.textContent=notification.body;copy.append(title,desc);
      const controls=document.createElement("div");controls.className="ae-notification-controls";
      const view=document.createElement("button");view.type="button";view.textContent="View";view.onclick=()=>{
        closeFloating();navigate(notification.section);
        if(notification.id && notification.section==="orders"){el("orderSearch").value=safe(notification.id);renderOrders();}
      };
      controls.append(view);
      if(notification.alertId){
        const acknowledge=document.createElement("button");acknowledge.type="button";acknowledge.textContent="Mark read";
        acknowledge.onclick=async()=>{
          acknowledge.disabled=true;
          try{await api("/api/admin/automations/alerts/"+encodeURIComponent(notification.alertId),{method:"PATCH",body:"{}"});await refreshNotifications();}
          catch(error){toast(error.message,true);acknowledge.disabled=false;}
        };
        controls.append(acknowledge);
      }
      row.append(type,copy,controls);list.append(row);
    }
  }
  bell.addEventListener("click",async()=>{
    const opening=panel.hidden;closeFloating();panel.hidden=!opening;bell.setAttribute("aria-expanded",String(opening));
    if(opening)await refreshNotifications();
  });
  el("aeRefreshNotifications")?.addEventListener("click",refreshNotifications);

  const prior = window.refreshAerlonV3;
  window.refreshAerlonV3=function(){
    if(typeof prior==="function")prior();
    state.loadedAt=0;
    renderTopSelling();
  };
  el("refresh")?.addEventListener("click",()=>{state.loadedAt=0;});
  el("salesRange")?.addEventListener("change",()=>renderTopSelling());
  const dateSelect=el("adminPeriod");
  dateSelect?.addEventListener("change",()=>renderTopSelling());
  // Preserve the supported mobile drawer and existing delegated nav click handling.
  el("nav")?.addEventListener("click",()=>{if(matchMedia("(max-width:700px)").matches)sideToggle.setAttribute("aria-expanded","false");});
  renderTopSelling();
})();