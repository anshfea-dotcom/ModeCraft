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
  let notices = [], loadingNotices = false;
  let readKeys = new Set();

  const menuOpen = () => menu?.getAttribute("aria-expanded") === "true";
  const syncMenu = () => {
    if(!menu)return;
    const open=menuOpen();
    menu.textContent=open ? "←" : "☰";
    menu.setAttribute("aria-label",open?"Back to dashboard":"Open navigation menu");
    menu.setAttribute("title",open?"Close navigation":"Open navigation menu");
  };
  syncMenu();
  menu?.addEventListener("click",syncMenu);
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
    if(!notices.length){
      const p=document.createElement("p");p.className="admin-notification-empty";
      p.textContent="No active order, payment, stock or automation alerts.";
      notificationList.append(p);
      return;
    }
    for(const item of notices.slice(0,35)){
      const button=document.createElement("button");button.type="button";
      button.className="admin-notification-item"+(readKeys.has(item.key)?"":" unread");
      const icon=document.createElement("span");icon.className="admin-n-icon";icon.setAttribute("aria-hidden","true");icon.textContent=item.icon;
      const body=document.createElement("span"),title=document.createElement("strong"),description=document.createElement("small");
      title.textContent=item.title;description.textContent=item.detail;
      body.append(title,description);button.append(icon,body);
      button.addEventListener("click",()=>{
        readKeys.add(item.key);saveReadKeys();renderNotifications();closeNotifications();
        const permission=document.querySelector('#nav button[data-section="'+item.section+'"]:not(.hidden)');
        if(!permission)return;
        navigate(item.section);
        if(item.orderId){
          const query=by("orderSearch");
          if(query){query.value=item.orderId;renderOrders();}
        }
      });
      notificationList.append(button);
    }
  };
  async function loadNotifications(){
    if(!currentUser || app.classList.contains("hidden") || loadingNotices)return;
    loadingNotices=true;
    const checks=[];
    if(currentUser.permissions?.includes("orders.view"))checks.push({kind:"orders",work:api("/api/admin/orders")});
    if(currentUser.permissions?.includes("products.view"))checks.push({kind:"inventory",work:api("/api/admin/inventory/alerts")});
    if(currentUser.isOwner)checks.push({kind:"automation",work:api("/api/admin/automations")});
    const results=await Promise.allSettled(checks.map(item=>item.work));
    const items=[];
    let failed=0;
    for(let i=0;i<checks.length;i++){
      if(results[i].status!=="fulfilled"){failed++;continue;}
      const data=results[i].value;
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
    items.sort((a,b)=>new Date(b.at||0)-new Date(a.at||0));
    notices=items.slice(0,60);
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
    notificationPanel.hidden=!opening;
    bell.setAttribute("aria-expanded",String(opening));
    if(opening)await loadNotifications();
  });
  by("adminNotificationRefresh")?.addEventListener("click",loadNotifications);
  by("adminNotificationRead")?.addEventListener("click",()=>{
    for(const notice of notices)readKeys.add(notice.key);
    saveReadKeys();renderNotifications();
  });
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
      closeNotifications();notices=[];notificationCount.hidden=true;
      return;
    }
    loadNotifications();
  }).observe(app,{attributes:true,attributeFilter:["class"]});
  /* Session checking stays in the existing security module; avoid background API polling. */
})();
