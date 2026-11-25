function cleanText(value, max = 300) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function normalizeProductFamilyValue(value) {
  return cleanText(value, 100).replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

async function getProducts(pool) {
  const result = await pool.query(
    "SELECT data FROM products ORDER BY updated_at DESC"
  );

  return result.rows.map(row => row.data).sort((a, b) => Number(a.sortOrder ?? 999999) - Number(b.sortOrder ?? 999999));
}

async function readCatalogue(pool) {
  const products = await getProducts(pool);
  const activeProducts = products.filter(product =>
    product && typeof product === "object" && product.active !== false
  );

  const inventoryByProduct = new Map();
  try {
    const variants = await pool.query(
      "SELECT product_id, color, size, quantity FROM inventory_variants ORDER BY color, size"
    );
    for (const row of variants.rows) {
      const productId = String(row.product_id);
      if (!inventoryByProduct.has(productId)) inventoryByProduct.set(productId, []);
      inventoryByProduct.get(productId).push({
        color: row.color,
        size: row.size,
        quantity: Number(row.quantity) || 0
      });
    }
  } catch (inventoryError) {
    // Keep products visible even if the optional inventory query has a
    // temporary/schema problem. Log it so the underlying issue is traceable.
    console.error("Storefront inventory lookup failed; serving products without inventory data:", inventoryError.message);
  }

  const byId = new Map(activeProducts.map(product => [String(product.id), product]));
  // A product already referenced as a colour child cannot also be a parent.
  // Legacy nested links used to hide both the parent and its child from the
  // storefront. Only root products may own colour links now.
  const referencedAsChild = new Set();
  for (const product of activeProducts) {
    const links = product.colorVariants && typeof product.colorVariants === "object"
      ? product.colorVariants : {};
    for (const linkedId of Object.values(links)) {
      if (linkedId != null && String(linkedId).trim()) referencedAsChild.add(String(linkedId));
    }
  }

  const claimedChildren = new Set();
  const safeLinksByParent = new Map();
  for (const parent of activeProducts) {
    const parentId = String(parent.id);
    const safeLinks = {};
    // Do not allow a legacy child record to hide another product beneath it.
    if (!referencedAsChild.has(parentId)) {
      const rawLinks = parent.colorVariants && typeof parent.colorVariants === "object"
        ? parent.colorVariants : {};
      const parentCategory = normalizeProductFamilyValue(parent.category);
      const parentType = normalizeProductFamilyValue(parent.productType || parent.category);
      for (const [color, rawId] of Object.entries(rawLinks)) {
        const childId = String(rawId);
        const child = byId.get(childId);
        if (!child || childId === parentId || claimedChildren.has(childId)) continue;
        const childCategory = normalizeProductFamilyValue(child.category);
        const childType = normalizeProductFamilyValue(child.productType || child.category);
        const childHasChildren = Object.keys(child.colorVariants || {}).length > 0;
        if (!parentCategory || parentCategory !== childCategory || parentType !== childType || childHasChildren) continue;
        safeLinks[color] = childId;
        claimedChildren.add(childId);
      }
    }
    safeLinksByParent.set(parentId, safeLinks);
  }

  return {
    products: activeProducts.map(product => ({
      ...product,
      colorVariants: safeLinksByParent.get(String(product.id)) || {},
      isColorVariantChild: claimedChildren.has(String(product.id)),
      inventoryVariants: inventoryByProduct.get(String(product.id)) || []
    }))
  };
}

module.exports = { cleanText, normalizeProductFamilyValue, getProducts, readCatalogue };
