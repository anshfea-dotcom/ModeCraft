/* AERLON approved compact dashboard interactions. Keep existing server-side permissions. */
(() => {
  "use strict";
  const by = id => document.getElementById(id);
  const menu = by("workspaceMenu");
  const nav = by("nav");
  const app = by("app");
  const search = by("adminSearchToggle");
  const searchPanel = by("adminQuickSearchPanel");
  const bell = by("adminNotificationToggle");
  const notificationPanel = by("adminNotificationPanel");
  const notificationList = by("adminNotificationItems");
  const notificationCount = by("adminNotificationCount");
  const addon = by("adminAddonShortcut");
  const addonPanel = by("adminAddonPanel");
  const calendarButton = by("adminCalendarButton");
  const calendarPanel = by("adminCalendarPanel");
  const from = by("adminDateFrom");
  const to = by("adminDateTo");
  let notices = [], loadingNotices = false, deletingNotices = false;
  let deletedKeys = new Set();
  let readKeys = new Set();

  const menuOpen = () => menu?.getAttribute("aria-expanded") === "true";
  const syncMenu = () => {
    if(!menu)return;
    const open=menuOpen();
    menu.textContent=open ? "×" : "☰";
    menu.setAttribute("aria-label",open?"Close navigation menu":"Open navigation menu");
    menu.setAttribute("title",open?"Close navigation":"Open navigation menu");
  };
  syncMenu();
  menu?.addEventListener("click",syncMenu);
  by("adminNavBack")?.addEventListener("click",()=>{
    if(!currentUser)return;
    navigate("overview");
    syncMenu();
    window.scrollTo({top:0,behavior:"instant"});
  });
  nav?.addEventListener("click",event=>{
    if(event.target.closest("button[data-section]"))syncMenu();
  });
  document.addEventListener("pointerdown",event=>{
    if(menuOpen() && !nav?.contains(event.target) && !menu?.contains(event.target))menu.click();
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape" && menuOpen())menu.click();
  });

  const closeAddon = () => {
    addonPanel.hidden=true;
    addon.setAttribute("aria-expanded","false");
  };
  addon?.addEventListener("click",()=>{
    if(!currentUser?.isOwner)return;
    const opening=addonPanel.hidden;
    addonPanel.hidden=!opening;
    addon.setAttribute("aria-expanded",String(opening));
  });
  addonPanel?.addEventListener("click",event=>{
    if(event.target.closest("button[data-goto]"))closeAddon();
  });
  const localDate = date => [
    date.getFullYear(),
    String(date.getMonth()+1).padStart(2,"0"),
    String(date.getDate()).padStart(2,"0")
  ].join("-");
  const today=new Date();
  const thirty=new Date(today);thirty.setDate(today.getDate()-29);
  from.value=localDate(thirty);
  to.value=localDate(today);
  from.max=localDate(today);to.max=localDate(today);
  const setCalendarOpen = open => {
    calendarPanel.hidden=!open;
    calendarButton.setAttribute("aria-expanded",String(open));
  };
  calendarButton?.addEventListener("click",()=>{
    const open=calendarPanel.hidden;
    setCalendarOpen(open);
    if(open)from.focus();
  });
  by("adminDateApply")?.addEventListener("click",()=>{
    if(!from.value || !to.value || from.value>to.value || to.value>localDate(new Date())){
      toast("Choose a valid start and end date, not in the future.",true);
      return;
    }
    window.adminDateRange={from:from.value,to:to.value};
    by("adminPeriod").value="custom";
    setCalendarOpen(false);
    if(currentUser?.permissions?.includes("orders.view"))renderOverview();
    toast("Custom date range applied.");
  });
  by("adminDateClear")?.addEventListener("click",()=>{
    window.adminDateRange=null;
    by("adminPeriod").value="30";
    if(by("salesRange"))by("salesRange").value="30";
    setCalendarOpen(false);
    if(currentUser?.permissions?.includes("orders.view"))renderOverview();
  });
  by("adminPeriod")?.addEventListener("change",()=>{
    if(by("adminPeriod").value==="custom"){
      setCalendarOpen(true);
      from.focus();
    }else setCalendarOpen(false);
  });
  by("refresh")?.addEventListener("click",()=>{if(currentUser)loadNotifications();});
  document.addEventListener("pointerdown",event=>{
    if(!calendarPanel.hidden && !calendarPanel.contains(event.target) && !calendarButton.contains(event.target))setCalendarOpen(false);
    if(!addonPanel.hidden && !addonPanel.contains(event.target) && !addon.contains(event.target))closeAddon();
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"){
      if(!calendarPanel.hidden){setCalendarOpen(false);calendarButton.focus();}
      if(!addonPanel.hidden){closeAddon();addon.focus();}
    }
  });
  const identity=()=>String(currentUser?.username||currentUser?.displayName||"admin").slice(0,80);
  const readStoreKey=()=> "aerlon-admin-seen-notices:"+identity();
  const getReadKeys=()=>{
    try {
      const parsed=JSON.parse(localStorage.getItem(readStoreKey())||"[]");
      return new Set(Array.isArray(parsed)?parsed.slice(-300):[]);
    } catch {return new Set();}
  };
  const saveReadKeys=()=>{
    try {localStorage.setItem(readStoreKey(),JSON.stringify(Array.from(readKeys).slice(-300)));}catch{}
  };
  const closeNotifications=()=>{
    notificationPanel.hidden=true;
    bell?.setAttribute("aria-expanded","false");
  };
  const renderNotifications=()=>{
    notificationList.replaceChildren();
    const unread=notices.filter(item=>!readKeys.has(item.key)).length;
    notificationCount.textContent=String(Math.min(99,unread))+(unread>99?"+":"");
    notificationCount.hidden=unread===0;
    bell.setAttribute("aria-label",unread?unread+" unread admin notifications":"Notifications");
    const allButton=by("adminNotificationDeleteAll");
    if(allButton)allButton.hidden=!notices.length;
    if(!notices.length){
      const p=document.createElement("p");p.className="admin-notification-empty";
      p.textContent="No active order, payment, stock or automation alerts.";
      notificationList.append(p);
      return;
    }
    for(const item of notices.slice(0,35)){
      const row=document.createElement("div");
      row.className="admin-notification-item"+(readKeys.has(item.key)?"":" unread");
      const icon=document.createElement("span");icon.className="admin-n-icon";icon.setAttribute("aria-hidden","true");icon.textContent=item.icon;
      const body=document.createElement("span");body.className="admin-notification-body";
      const title=document.createElement("strong"),description=document.createElement("small");
      title.textContent=item.title;description.textContent=item.detail;
      const actions=document.createElement("span");actions.className="admin-notification-actions";
      const view=document.createElement("button");view.type="button";view.textContent="View";view.setAttribute("aria-label","View "+item.title);
      view.addEventListener("click",()=>{
        readKeys.add(item.key);saveReadKeys();renderNotifications();closeNotifications();
        const permission=document.querySelector('#nav button[data-section="'+item.section+'"]:not(.hidden)');
        if(!permission)return;
        navigate(item.section);
        if(item.orderId){
          const query=by("orderSearch");
          if(query){query.value=item.orderId;renderOrders();}
        }
      });
      const remove=document.createElement("button");remove.type="button";
      remove.textContent="Delete";remove.className="admin-delete-notice";
      remove.setAttribute("aria-label","Delete notification "+item.title);
      remove.addEventListener("click",async()=>{
        remove.disabled=true;
        await deleteNotices([item.key]);
        remove.disabled=false;
      });
      actions.append(view,remove);
      body.append(title,description,actions);row.append(icon,body);
      notificationList.append(row);
    }
  };
  async function deleteNotices(keys){
    if(deletingNotices||!currentUser)return;
    const valid=[...new Set(keys)].filter(key=>notices.some(n=>n.key===key));
    if(!valid.length)return;
    deletingNotices=true;
    try{
      await api("/api/admin/notifications/delete",{
        method:"POST",body:JSON.stringify({keys:valid})
      });
      for(const key of valid)deletedKeys.add(key);
      notices=notices.filter(n=>!deletedKeys.has(n.key));
      renderNotifications();
      toast(valid.length===1?"Notification deleted.":valid.length+" notifications deleted.");
    }catch(err){toast("Could not delete notification: "+err.message,true);}
    finally{deletingNotices=false;}
  }
  by("adminNotificationDeleteAll")?.addEventListener("click",async()=>{
    if(!notices.length||deletingNotices)return;
    if(!window.confirm("Delete all "+notices.length+" visible notifications? Orders and stock records will not be deleted."))return;
    await deleteNotices(notices.map(n=>n.key));
  });
  async function loadNotifications(){
    if(!currentUser || app.classList.contains("hidden") || loadingNotices)return;
    loadingNotices=true;
    if(!notificationPanel.hidden){
      notificationList.replaceChildren();
      const message=document.createElement("p");
      message.className="admin-notification-empty";
      message.textContent="Checking orders, payments, stock and automation alerts…";
      notificationList.append(message);
    }
    const checks=[{kind:"deleted",work:api("/api/admin/notifications/deleted")}];
    if(currentUser.permissions?.includes("orders.view"))checks.push({kind:"orders",work:api("/api/admin/orders")});
    if(currentUser.permissions?.includes("products.view"))checks.push({kind:"inventory",work:api("/api/admin/inventory/alerts")});
    if(currentUser.isOwner)checks.push({kind:"automation",work:api("/api/admin/automations")});
    const results=await Promise.allSettled(checks.map(item=>item.work));
    const items=[];
    let failed=0, deletionStateLoaded=false;
    for(let i=0;i<checks.length;i++){
      if(results[i].status!=="fulfilled"){failed++;continue;}
      const data=results[i].value;
      if(checks[i].kind==="deleted"){
        deletedKeys=new Set(Array.isArray(data.deletedKeys)?data.deletedKeys:[]);
        deletionStateLoaded=true;
        continue;
      }
      if(checks[i].kind==="orders"){
        const orders=(data.orders||[]).filter(o=>!o.archivedAt&&o.orderStatus!=="cancelled")
          .sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,12);
        for(const o of orders){
          const id=String(o.id||"");
          if(!id)continue;
          if(!["delivered","cancelled"].includes(o.orderStatus)){
            items.push({key:"order:"+id+":"+o.orderStatus,title:"Order "+id,
              detail:"Fulfilment: "+String(o.orderStatus||"received").replaceAll("_"," "),
              icon:"▣",section:"orders",orderId:id,at:o.createdAt});
          }
          if(o.paymentStatus!=="paid"){
            items.push({key:"payment:"+id+":"+o.paymentStatus,title:"Payment needs attention",
              detail:"Order "+id+" · "+String(o.paymentStatus||"pending").replaceAll("_"," "),
              icon:"₹",section:"orders",orderId:id,at:o.createdAt});
          }
        }
      } else if(checks[i].kind==="inventory"){
        for(const a of (data.alerts||[]).slice(0,15)){
          items.push({key:"stock:"+String(a.id||a.productId)+":"+String(a.quantity),
            title:"Low stock · "+String(a.productName||"Product"),
            detail:[a.color,a.size,"Remaining "+a.quantity].filter(Boolean).join(" · "),
            icon:"▤",section:"inventory",at:a.updatedAt});
        }
      } else if(checks[i].kind==="automation"){
        for(const a of (data.alerts||[]).filter(x=>!x.acknowledged).slice(0,15)){
          items.push({key:"automation:"+String(a.id),title:String(a.rule_name||"Automation alert"),
            detail:String(a.detail||"Review rule"),icon:"⚡",section:"automations",at:a.created_at});
        }
      }
    }
    // A failed deletion-state fetch must not show previously deleted alerts again.
    if(!deletionStateLoaded){
      notificationList.replaceChildren();
      const message=document.createElement("p");
      message.className="admin-notification-empty";
      message.textContent="Could not load your deleted-notification state. Refresh notifications to retry.";
      notificationList.append(message);
      loadingNotices=false;
      return;
    }
    items.sort((a,b)=>new Date(b.at||0)-new Date(a.at||0));
    notices=items.filter(item=>!deletedKeys.has(item.key)).slice(0,60);
    readKeys=getReadKeys();
    renderNotifications();
    if(failed && !notices.length){
      const p=document.createElement("p");p.className="admin-notification-empty";
      p.textContent="Some alerts could not be loaded. Use Refresh notifications to retry.";
      notificationList.append(p);
    }
    loadingNotices=false;
  }
  bell?.addEventListener("click",async()=>{
    if(!currentUser)return;
    const opening=notificationPanel.hidden;
    if(opening && searchPanel && !searchPanel.hidden)search.click();
    if(opening && menuOpen())menu.click();
    notificationPanel.hidden=!opening;
    bell.setAttribute("aria-expanded",String(opening));
    if(opening)await loadNotifications();
  });
  by("adminNotificationRefresh")?.addEventListener("click",loadNotifications);
  by("adminNotificationRead")?.addEventListener("click",()=>{
    for(const notice of notices)readKeys.add(notice.key);
    saveReadKeys();renderNotifications();
  });
  menu?.addEventListener("click",closeNotifications);
  search?.addEventListener("click",closeNotifications);
  nav?.addEventListener("click",closeNotifications);
  document.addEventListener("pointerdown",event=>{
    if(!notificationPanel.hidden&&!notificationPanel.contains(event.target)&&!bell.contains(event.target))closeNotifications();
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&!notificationPanel.hidden){closeNotifications();bell.focus();}
  });
  new MutationObserver(()=>{
    if(app.classList.contains("hidden")){
      closeNotifications();notices=[];deletedKeys.clear();notificationCount.hidden=true;
      return;
    }
    loadNotifications();
  }).observe(app,{attributes:true,attributeFilter:["class"]});

  /* Trustworthy inline vector glyphs: no external icon library or network dependency. */
  const adminMenuIconPaths={"overview":"<rect x=\"3\" y=\"3\" width=\"8\" height=\"8\" rx=\"1.5\"/><rect x=\"13\" y=\"3\" width=\"8\" height=\"5\" rx=\"1.5\"/><rect x=\"13\" y=\"10\" width=\"8\" height=\"11\" rx=\"1.5\"/><rect x=\"3\" y=\"13\" width=\"8\" height=\"8\" rx=\"1.5\"/>","activity":"<path d=\"M3 12h4l3-7 4 14 3-7h4\"/>","orders":"<rect x=\"5\" y=\"5\" width=\"14\" height=\"16\" rx=\"2\"/><path d=\"M9 3v4m6-4v4M9 12h6m-6 4h6\"/>","customers":"<circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3 20v-2a6 6 0 0 1 12 0v2M17 6a3 3 0 0 1 0 6m2 8v-2a6 6 0 0 0-3-5\"/>","pos":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8m-4-4v4\"/>","invoices":"<path d=\"M7 3h10l3 3v15l-4-2-4 2-4-2-4 2V6z\"/><path d=\"M9 9h6m-6 4h8\"/>","payments":"<rect x=\"2.5\" y=\"5\" width=\"19\" height=\"14\" rx=\"2\"/><path d=\"M2.5 10h19m-14 5h4\"/>","shipping":"<path d=\"M3 6h11v12H3zM14 10h4l3 3v5h-7\"/><circle cx=\"7\" cy=\"19\" r=\"2\"/><circle cx=\"18\" cy=\"19\" r=\"2\"/>","warehouses":"<path d=\"M3 10 12 4l9 6v11H3zM8 21v-8h8v8M3 10h18\"/>","products":"<path d=\"m8 4 4 2 4-2 5 5-4 4-1-1v9H8v-9l-1 1-4-4z\"/>","categories":"<path d=\"m12 3 9 5-9 5-9-5zm-9 10 9 5 9-5M3 18l9 5 9-5\"/>","brands":"<path d=\"M3 12V4h8l10 10-8 8z\"/><circle cx=\"7.5\" cy=\"8\" r=\"1\"/>","inventory":"<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/><path d=\"M4 10h16m-8-6v16\"/>","offers":"<circle cx=\"7\" cy=\"7\" r=\"2\"/><circle cx=\"17\" cy=\"17\" r=\"2\"/><path d=\"M5 19 19 5\"/>","banners":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><circle cx=\"8\" cy=\"9\" r=\"2\"/><path d=\"m3 17 6-5 4 3 3-4 5 5\"/>","giftcards":"<rect x=\"3\" y=\"9\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M3 13h18M12 9v12m0-12c-3 0-7-1-6-4 1-3 5 0 6 4zm0 0c3 0 7-1 6-4-1-3-5 0-6 4z\"/>","affiliates":"<circle cx=\"12\" cy=\"4\" r=\"2\"/><circle cx=\"5\" cy=\"19\" r=\"2\"/><circle cx=\"19\" cy=\"19\" r=\"2\"/><path d=\"M11 6 6 17m7-11 5 11M7 19h10\"/>","settings":"<path d=\"M4 7h16M4 12h16M4 17h16\"/><circle cx=\"9\" cy=\"7\" r=\"2\"/><circle cx=\"16\" cy=\"12\" r=\"2\"/><circle cx=\"8\" cy=\"17\" r=\"2\"/>","images":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><circle cx=\"8\" cy=\"9\" r=\"2\"/><path d=\"m4 19 6-6 3 3 3-4 5 6\"/>","footer":"<path d=\"M4 4h16M4 10h16M4 16h10M4 21h7\"/>","reports":"<path d=\"M4 20V10m5 10V6m5 14v-8m5 8V3\"/><path d=\"M2 21h20\"/>","staff":"<path d=\"m12 2 8 4v6c0 5-4 8-8 10-4-2-8-5-8-10V6z\"/><circle cx=\"12\" cy=\"10\" r=\"2\"/><path d=\"M8 16c1-3 7-3 8 0\"/>","backups":"<rect x=\"4\" y=\"4\" width=\"16\" height=\"5\" rx=\"1\"/><path d=\"M5 9v11h14V9m-9 5h4\"/>","automations":"<path d=\"m13 2-9 12h7l-1 8 10-12h-7z\"/>","seo":"<circle cx=\"10\" cy=\"10\" r=\"7\"/><path d=\"m15 15 6 6\"/>","wallet":"<rect x=\"3\" y=\"6\" width=\"18\" height=\"15\" rx=\"2\"/><path d=\"M3 10h18m-5 4h5v4h-5z\"/>"};
  for(const button of nav?.querySelectorAll("button[data-section]")||[]){
    const icon=button.querySelector(".ico");
    const drawing=adminMenuIconPaths[button.dataset.section];
    if(icon&&drawing){
      icon.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+drawing+'</svg>';
      icon.setAttribute("aria-hidden","true");
    }
  }

  /* Session checking stays in the existing security module; avoid background API polling. */
})();
