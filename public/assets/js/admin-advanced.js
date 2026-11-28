(function(){
"use strict";
const by=id=>document.getElementById(id),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=v=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(Number(v)||0);
let giftCards=[],affiliates=[],rules=[];
async function safe(fn){try{await fn();}catch(e){toast(e.message,true);}}
function onForm(id,fn){by(id)?.addEventListener("submit",async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector("button[type=submit]");b.disabled=true;try{await fn(Object.fromEntries(new FormData(f).entries()),f);toast("Saved successfully.");}catch(err){toast(err.message,true);}finally{b.disabled=false;}});}
const action=(id,fn)=>by(id)?.addEventListener("click",()=>safe(fn));
function reload(id,fn){action("advReload-"+id,fn);}
async function gifts(){
  const d=await api("/api/admin/gift-cards");giftCards=d.cards||[];
  by("advGiftList").innerHTML=giftCards.map(c=>'<div><span><strong>'+esc(c.label)+'</strong><small style="display:block">'+esc(c.code)+' · '+esc(money(c.balance_paise/100))+' remaining · '+(c.active?"Active":"Inactive")+'</small></span><button class="btn small giftToggle" data-id="'+esc(c.id)+'">'+(c.active?"Freeze":"Activate")+'</button></div>').join("")||'<p class="muted">No gift cards yet.</p>';
  by("advGiftSelect").innerHTML='<option value="">Select active card</option>'+giftCards.filter(c=>c.active&&c.balance_paise>0).map(c=>'<option value="'+esc(c.id)+'">'+esc(c.label)+' ('+esc(money(c.balance_paise/100))+')</option>').join("");
}
onForm("advGiftCreate",async(v,f)=>{const d=await api("/api/admin/gift-cards",{method:"POST",body:JSON.stringify(v)});by("advIssued").textContent="Created inactive gift card: "+d.card.code+". Activate only after funding verification.";by("advIssued").classList.remove("hidden");f.reset();await gifts();});
onForm("advGiftRedeem",async(v,f)=>{if(!window.confirm("Record this offline redemption? This reduces the stored gift-card balance."))return;await api("/api/admin/gift-cards/"+encodeURIComponent(v.cardId)+"/redeem",{method:"POST",body:JSON.stringify({amount:v.amount,reference:v.reference})});f.reset();await gifts();});
by("advGiftList")?.addEventListener("click",e=>safe(async()=>{const b=e.target.closest(".giftToggle");if(!b)return;const c=giftCards.find(x=>x.id===b.dataset.id);if(!c)return;const fundingReference=c.active?"":window.prompt("Enter verified payment/funding reference (4+ characters):");if(!c.active&&(!fundingReference||fundingReference.trim().length<4))return;if(c.active&&!window.confirm("Freeze this gift card?"))return;await api("/api/admin/gift-cards/"+encodeURIComponent(c.id),{method:"PATCH",body:JSON.stringify({active:!c.active,fundingReference})});await gifts();}));
reload("giftcards",gifts);
async function affiliatesView(){
  const d=await api("/api/admin/affiliates");affiliates=d.affiliates||[];
  by("advAffiliateList").innerHTML=affiliates.map(a=>'<div><span><strong>'+esc(a.name)+'</strong> · '+esc(a.commission_rate)+'%<small style="display:block">'+esc(a.link)+'</small><small style="display:block">Clicks '+esc(a.clicks)+' · Paid sales '+esc(money(a.paidSales))+' · Earned '+esc(money(a.earned))+'</small></span><button class="btn small affiliateToggle" data-id="'+esc(a.id)+'">'+(a.active?"Pause":"Resume")+'</button></div>').join("")||'<p class="muted">No partners yet.</p>';
}
onForm("advAffiliateCreate",async(v,f)=>{await api("/api/admin/affiliates",{method:"POST",body:JSON.stringify(v)});f.reset();await affiliatesView();});
by("advAffiliateList")?.addEventListener("click",e=>safe(async()=>{const b=e.target.closest(".affiliateToggle");if(!b)return;const a=affiliates.find(x=>x.id===b.dataset.id);if(!a)return;await api("/api/admin/affiliates/"+encodeURIComponent(a.id),{method:"PATCH",body:JSON.stringify({active:!a.active})});await affiliatesView();}));
reload("affiliates",affiliatesView);
async function automationsView(){
  const d=await api("/api/admin/automations");rules=d.rules||[];
  by("advRuleList").innerHTML=rules.map(a=>'<div><span><strong>'+esc(a.name)+'</strong><small style="display:block">'+esc(a.type)+' · threshold '+esc(a.threshold)+' · '+(a.active?"Active":"Paused")+'</small></span><button class="btn small ruleToggle" data-id="'+esc(a.id)+'">'+(a.active?"Pause":"Enable")+'</button></div>').join("")||'<p class="muted">No rules.</p>';
  by("advAlertList").innerHTML=(d.alerts||[]).map(a=>'<div><span><strong>'+esc(a.rule_name)+'</strong><small style="display:block">'+esc(a.entity_key)+' · '+esc(a.detail)+' · '+esc(a.period)+' · '+(a.acknowledged?"Acknowledged":"New")+'</small></span>'+(a.acknowledged?"":'<button class="btn small ackAlert" data-id="'+esc(a.id)+'">Acknowledge</button>')+'</div>').join("")||'<p class="muted">No alerts.</p>';
}
onForm("advAutomationCreate",async(v,f)=>{await api("/api/admin/automations",{method:"POST",body:JSON.stringify(v)});f.reset();await automationsView();});
action("advRunAutomation",async()=>{const x=await api("/api/admin/automations/run",{method:"POST",body:"{}"});await automationsView();toast(x.created+" new alerts.");});
by("advRuleList")?.addEventListener("click",e=>safe(async()=>{const b=e.target.closest(".ruleToggle");if(!b)return;const a=rules.find(x=>x.id===b.dataset.id);if(!a)return;await api("/api/admin/automations/"+encodeURIComponent(a.id),{method:"PATCH",body:JSON.stringify({active:!a.active})});await automationsView();}));
by("advAlertList")?.addEventListener("click",e=>safe(async()=>{const b=e.target.closest(".ackAlert");if(!b)return;await api("/api/admin/automations/alerts/"+encodeURIComponent(b.dataset.id),{method:"PATCH",body:"{}"});await automationsView();}));
reload("automations",automationsView);
async function seoView(){const d=await api("/api/admin/seo"),f=by("advSEOForm");for(const [k,v] of Object.entries(d.profile||{}))if(f.elements.namedItem(k))f.elements.namedItem(k).value=String(v||"");}
onForm("advSEOForm",async(v)=>{await api("/api/admin/seo",{method:"PUT",body:JSON.stringify(v)});await seoView();});
reload("seo",seoView);
const old=window.loadAerlonV3Section;
window.loadAerlonV3Section=function(section){
  old?.(section);
  if(!currentUser?.isOwner)return;
  ({giftcards:gifts,affiliates:affiliatesView,automations:automationsView,seo:seoView}[section])&&safe(({giftcards:gifts,affiliates:affiliatesView,automations:automationsView,seo:seoView}[section]));
};
})();