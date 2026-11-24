const money=n=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(n);
function effectivePrice(p){const original=Number(p?.price)||0,sale=Number(p?.salePrice);return p?.salePrice!==null&&p?.salePrice!==undefined&&p?.salePrice!==""&&Number.isFinite(sale)&&sale>0&&sale<original?sale:original}
function makePriceElement(p,className="price"){const el=document.createElement("div");el.className=className;const original=Number(p?.price)||0,current=effectivePrice(p);const currentEl=document.createElement("span");currentEl.textContent=money(current);el.append(currentEl);if(current<original){const old=document.createElement("del");old.className="sale-original-price";old.textContent=money(original);const discount=document.createElement("span");discount.className="sale-discount";discount.textContent=`${Math.round((1-current/original)*100)}% OFF`;el.append(old,discount)}return el}
function catalogueProducts(records) {
  return records
      .filter(item => item && typeof item === "object" && item.active !== false)
      .map(item => {
        const name = String(item.name ?? item.title ?? item.productName ?? "").trim();
        const price = Number(item.price ?? item.amount ?? 0);
        const salePrice = item.salePrice === null || item.salePrice === undefined || item.salePrice === "" ? null : Number(item.salePrice);
        const category = String(item.category ?? item.productCategory ?? "New Arrivals").trim();
        const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
        const image = String(item.image ?? item.imageUrl ?? item.image_url ?? images[0] ?? "").trim();
        return {
          ...item,
          id: String(item.id ?? item.productId ?? item.slug ?? ""),
          name,
          price: Number.isFinite(price) && price >= 0 ? price : 0,
          salePrice: Number.isFinite(salePrice) && salePrice > 0 && salePrice < price ? salePrice : null,
          category,
          image,
          images
        };
      })
      .filter(item => item.id && item.name && !String(item.id).toLowerCase().startsWith("preview-") && item.demo !== true && item.previewOnly !== true && item.isPreview !== true && item.preview_only !== true);
}
