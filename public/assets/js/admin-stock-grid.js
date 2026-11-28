/* Accurate per-size stock editor: preserves unsaved values and prevents stale overwrites. */
(() => {
 "use strict";
 let active=null,records=new Map(),ready=false,observer;
 const key=(c,s)=>String(c).toLowerCase()+"\0"+String(s).toLowerCase();
 function redraw(){
  if(!active?.isConnected)return;
  let total=0;
  for(const row of active.querySelectorAll("#colorSizeGroups .size-choice")){
   const tick=row.querySelector('input[type="checkbox"]'),field=row.querySelector("[data-stock-units]");
   if(!tick||!field)continue;
   const k=key(field.dataset.color,field.dataset.size);
   if(!records.has(k))records.set(k,{quantity:0,expectedQuantity:null});
   field.value=String(records.get(k).quantity);
   field.disabled=!tick.checked||!ready;
   row.classList.toggle("stock-selected",tick.checked);
   if(tick.checked)total+=Number(field.value)||0;
  }
  active.elements.stock.value=String(total);
 }
 function mount(product){
  observer?.disconnect();
  const form=document.getElementById("productForm"),group=form.querySelector("#colorSizeGroups");
  active=form;records=new Map();ready=!product;
  const save=form.querySelector('button[type="submit"]');save.disabled=!ready;
  group.addEventListener("input",e=>{
   const field=e.target.closest("[data-stock-units]");if(!field)return;
   const k=key(field.dataset.color,field.dataset.size);
   records.set(k,{...(records.get(k)||{expectedQuantity:null}),quantity:field.value===""?"":Number(field.value)});
   form.elements.stock.value=String([...group.querySelectorAll("[data-stock-units]")].filter(x=>!x.disabled).reduce((sum,x)=>sum+(Number(x.value)||0),0));
  });
  group.addEventListener("change",e=>{if(e.target.matches('input[type="checkbox"]'))redraw();});
  observer=new MutationObserver(redraw);observer.observe(group,{childList:true});redraw();
  if(!product)return;
  const note=document.createElement("small");note.className="stock-load-status";note.textContent="Loading live size quantities…";group.before(note);
  api("/api/admin/inventory").then(data=>{
   if(active!==form||!form.isConnected)return;
   for(const item of data.inventory||[])if(String(item.productId)===String(product.id))
    records.set(key(item.color,item.size),{quantity:Number(item.quantity),expectedQuantity:Number(item.quantity)});
   ready=true;save.disabled=false;note.textContent="Current stock loaded. Concurrent order changes are checked at Save.";redraw();
  }).catch(err=>{if(active===form&&form.isConnected){note.textContent="Stock unavailable: "+err.message+". Reopen to retry.";save.disabled=true;}});
 }
 function read(links={}){
  if(!active?.isConnected||!ready)throw Error("Stock is still loading. Please reopen if it fails.");
  const result=[];
  for(const row of active.querySelectorAll("#colorSizeGroups .size-choice")){
   const tick=row.querySelector('input[type="checkbox"]'),field=row.querySelector("[data-stock-units]");
   if(!tick?.checked||!field||links[field.dataset.color])continue;
   if(field.value.trim()==="")throw Error("Enter units for every selected size; zero is allowed.");
   const quantity=Number(field.value);
   if(!Number.isSafeInteger(quantity)||quantity<0||quantity>1000000)throw Error("Stock units must be a whole number between 0 and 1,000,000.");
   const saved=records.get(key(field.dataset.color,field.dataset.size));
   result.push({color:field.dataset.color,size:field.dataset.size,quantity,expectedQuantity:saved?.expectedQuantity??null});
  }
  return result;
 }
 window.AerlonStockGrid={mount,read};
})();