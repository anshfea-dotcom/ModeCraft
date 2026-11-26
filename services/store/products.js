const crypto = require("node:crypto");

module.exports = function registerProductManagement(app, { requireAdmin, requirePermission, getProducts, normalizeProductFamilyValue, cleanText, putProduct, audit, getProduct, pool }) {
  app.get(
    "/api/admin/products",
    requireAdmin,
    requirePermission("products.view"),
    async (_req, res, next) => {
      try {
        res.json({ products: await getProducts() });
      } catch (error) {
        next(error);
      }
    }
  );

  async function validateColorProductLinks(sourceProduct, links, { isNew = false } = {}) {
    const entries = Object.entries(links || {});
    const seenIds = new Set();
    const allProducts = await getProducts();
    const sourceId = String(sourceProduct.id || "");
    const sourceCategory = normalizeProductFamilyValue(sourceProduct.category);
    const sourceType = normalizeProductFamilyValue(sourceProduct.productType || sourceProduct.category);

    // A linked colour record must be a sibling SKU of the same garment type.
    // It cannot be a different category (e.g. a shirt linked to a hoodie).
    for (const [rawColor, rawId] of entries) {
      const color = cleanText(rawColor, 40);
      const linkedId = cleanText(rawId, 150);
      if (!color || !linkedId || linkedId === sourceId || seenIds.has(linkedId)) {
        throw Object.assign(new Error("Each colour must link to a different, valid product record."), { status: 400 });
      }
      seenIds.add(linkedId);
      const linkedProduct = allProducts.find(item => String(item.id) === linkedId);
      if (!linkedProduct || linkedProduct.active === false) {
        throw Object.assign(new Error(`The linked product for ${color} does not exist or is unavailable.`), { status: 400 });
      }
      const linkedCategory = normalizeProductFamilyValue(linkedProduct.category);
      const linkedType = normalizeProductFamilyValue(linkedProduct.productType || linkedProduct.category);
      if (!sourceCategory || !linkedCategory || sourceCategory !== linkedCategory || sourceType !== linkedType) {
        throw Object.assign(new Error(`${color} must link to another ${sourceProduct.category || sourceProduct.productType || "same-type"} product. Cross-category colour links are not allowed.`), { status: 400 });
      }
      const targetLinks = linkedProduct.colorVariants && typeof linkedProduct.colorVariants === "object" ? linkedProduct.colorVariants : {};
      if (Object.keys(targetLinks).length) {
        throw Object.assign(new Error(`${linkedProduct.name} already acts as a parent product. Link only standalone colour records to avoid circular or nested product families.`), { status: 400 });
      }
      const linkedAsChildElsewhere = allProducts.some(item =>
        String(item.id) !== sourceId &&
        Object.values(item.colorVariants || {}).some(id => String(id) === linkedId)
      );
      if (linkedAsChildElsewhere) {
        throw Object.assign(new Error(`${linkedProduct.name} is already linked to another product family. A colour product can belong to only one family.`), { status: 400 });
      }
    }

    // Do not let a child record become a parent as well; this prevents A -> B -> A loops.
    if (!isNew) {
      const sourceIsChild = allProducts.some(item =>
        String(item.id) !== sourceId &&
        Object.values(item.colorVariants || {}).some(id => String(id) === sourceId)
      );
      if (sourceIsChild && entries.length) {
        throw Object.assign(new Error("This product is already a colour in another product family. Edit the parent product to manage its colours."), { status: 400 });
      }
    }
  }

  app.post(
    "/api/admin/products",
    requireAdmin,
    requirePermission("products.manage"),
    async (req, res, next) => {
      try {
        const name = cleanText(req.body?.name, 120);
        const category = cleanText(req.body?.category, 80);
        const suppliedImages = Array.isArray(req.body?.images)
          ? req.body.images.map(value => cleanText(value, 1000)).filter(Boolean).slice(0, 12)
          : [];
        const image = cleanText(req.body?.image, 1000) || suppliedImages[0] || "";
        const images = [...new Set([image, ...suppliedImages].filter(Boolean))].slice(0, 12);
        const description = cleanText(req.body?.description, 500);
        const price = Number(req.body?.price);
        const salePriceInput = req.body?.salePrice;
        const salePrice = salePriceInput === undefined || salePriceInput === null || salePriceInput === "" ? null : Number(salePriceInput);
        const stock = Number(req.body?.stock ?? 0);

        if (
          !name ||
          !category ||
          !Number.isFinite(price) ||
          price <= 0 ||
          (salePrice !== null && (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice >= price)) ||
          !Number.isInteger(stock) ||
          stock < 0
        ) {
          return res.status(400).json({
            error: "Enter a product name, category, valid original price, an optional sale price lower than the original price, and non-negative stock."
          });
        }

        const product = {
          id: "mc-prod-" + crypto.randomBytes(6).toString("hex"),
          name,
          category,
          audience: cleanText(req.body?.audience, 30) || "Unisex",
          productType: cleanText(req.body?.productType, 80) || category,
          sortOrder: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : Date.now(),
          price,
          salePrice,
          image,
          images,
          description,
          stock,
          active: req.body?.active !== false,
          colors: Array.isArray(req.body?.colors) ? req.body.colors.map(value => cleanText(value, 40)).filter(Boolean).slice(0, 30) : [],
          sizesByColor: req.body?.sizesByColor && typeof req.body.sizesByColor === "object" && !Array.isArray(req.body.sizesByColor) ? req.body.sizesByColor : {},
          colorVariants: req.body?.colorVariants && typeof req.body.colorVariants === "object" && !Array.isArray(req.body.colorVariants) ? req.body.colorVariants : {},
          createdAt: new Date().toISOString()
        };

        const colorLinks = product.colorVariants || {};
        const allowedColors = new Set(product.colors || []);
        for (const rawColor of Object.keys(colorLinks)) {
          if (!allowedColors.has(cleanText(rawColor, 40))) {
            return res.status(400).json({ error: "A linked product must use a colour selected for this product." });
          }
        }
        await validateColorProductLinks(product, colorLinks, { isNew: true });
        await putProduct(product);
        await audit(req.adminSession, "product.created", {
          productId: product.id
        });

        res.status(201).json({ ok: true, product });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/admin/products/:id",
    requireAdmin,
    requirePermission("products.manage"),
    async (req, res, next) => {
      try {
        const product = await getProduct(req.params.id);

        if (!product) {
          return res.status(404).json({ error: "Product not found." });
        }

        if (req.body?.name !== undefined) {
          product.name = cleanText(req.body.name, 120);
        }

        if (req.body?.category !== undefined) {
          product.category = cleanText(req.body.category, 80);
          product.productType = product.category;
        }
        if (req.body?.audience !== undefined) product.audience = cleanText(req.body.audience, 30) || "Unisex";
        if (req.body?.productType !== undefined) product.productType = cleanText(req.body.productType, 80);
        if (req.body?.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))) product.sortOrder = Number(req.body.sortOrder);

        if (req.body?.image !== undefined) {
          product.image = cleanText(req.body.image, 1000);
        }

        if (req.body?.images !== undefined) {
          if (!Array.isArray(req.body.images)) {
            return res.status(400).json({ error: "Images must be an array of image URLs." });
          }
          product.images = [...new Set(req.body.images.map(value => cleanText(value, 1000)).filter(Boolean))].slice(0, 12);
          if (!product.image && product.images.length) product.image = product.images[0];
        }
        if (req.body?.image !== undefined && !product.images?.length && product.image) {
          product.images = [product.image];
        }

        if (req.body?.description !== undefined) {
          product.description = cleanText(req.body.description, 500);
        }

        if (req.body?.price !== undefined) {
          const price = Number(req.body.price);
          if (!Number.isFinite(price) || price <= 0) {
            return res.status(400).json({ error: "Original price must be greater than zero." });
          }
          product.price = price;
        }
        if (req.body?.salePrice !== undefined) {
          if (req.body.salePrice === null || req.body.salePrice === "") {
            product.salePrice = null;
          } else {
            const salePrice = Number(req.body.salePrice);
            if (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice >= Number(product.price)) {
              return res.status(400).json({ error: "Sale price must be greater than zero and lower than the original price." });
            }
            product.salePrice = salePrice;
          }
        } else if (product.salePrice != null && Number(product.salePrice) >= Number(product.price)) {
          return res.status(400).json({ error: "Original price must be higher than the saved sale price. Update or clear the sale price too." });
        }

        if (req.body?.stock !== undefined) {
          const stock = Number(req.body.stock);

          if (!Number.isInteger(stock) || stock < 0) {
            return res.status(400).json({
              error: "Stock must be a non-negative whole number."
            });
          }

          product.stock = stock;
        }

        if (req.body?.active !== undefined) {
          product.active = Boolean(req.body.active);
        }
        if (req.body?.colors !== undefined) {
          if (!Array.isArray(req.body.colors)) return res.status(400).json({ error: "Colours must be a list of selected colour names." });
          product.colors = [...new Set(req.body.colors.map(value => cleanText(value, 40)).filter(Boolean))].slice(0, 30);
        }
        if (req.body?.sizesByColor !== undefined) {
          if (!req.body.sizesByColor || typeof req.body.sizesByColor !== "object" || Array.isArray(req.body.sizesByColor)) return res.status(400).json({ error: "Choose sizes for each selected colour." });
          const selectedColors = new Set(product.colors || []);
          product.sizesByColor = Object.fromEntries(Object.entries(req.body.sizesByColor).filter(([color, sizes]) => selectedColors.has(color) && Array.isArray(sizes)).map(([color, sizes]) => [color, [...new Set(sizes.map(value => cleanText(value, 30)).filter(Boolean))].slice(0, 20)]));
        }
        if (req.body?.colorVariants !== undefined) {
          if (!req.body.colorVariants || typeof req.body.colorVariants !== "object" || Array.isArray(req.body.colorVariants)) return res.status(400).json({ error: "Colour product links must be an object." });
          const selectedColors = new Set(product.colors || []);
          const links = {};
          for (const [rawColor, rawId] of Object.entries(req.body.colorVariants)) {
            const color = cleanText(rawColor, 40);
            const linkedId = cleanText(rawId, 150);
            if (!selectedColors.has(color) || !linkedId) continue;
            if (linkedId === product.id) return res.status(400).json({ error: `A colour cannot link to the same product (${color}). Leave it unlinked to use this product's own images.` });
            const linkedProduct = await getProduct(linkedId);
            if (!linkedProduct || linkedProduct.active === false) return res.status(400).json({ error: `The linked product for ${color} does not exist or is unavailable.` });
            links[color] = linkedId;
          }
          product.colorVariants = links;
        }

        await validateColorProductLinks(product, product.colorVariants || {});
        await putProduct(product);

        await audit(req.adminSession, "product.updated", {
          productId: product.id
        });

        res.json({ ok: true, product });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/admin/products/:id",
    requireAdmin,
    requirePermission("products.manage"),
    async (req, res, next) => {
      try {
        const product = await getProduct(req.params.id);

        if (!product) {
          return res.status(404).json({ error: "Product not found." });
        }

        const allProducts = await getProducts();
        for (const parent of allProducts) {
          const links = parent.colorVariants && typeof parent.colorVariants === "object" ? parent.colorVariants : {};
          const cleaned = Object.fromEntries(Object.entries(links).filter(([, linkedId]) => String(linkedId) !== String(req.params.id)));
          if (Object.keys(cleaned).length !== Object.keys(links).length) {
            parent.colorVariants = cleaned;
            await putProduct(parent);
          }
        }
        await pool.query(
          "DELETE FROM products WHERE id = $1",
          [req.params.id]
        );

        await audit(req.adminSession, "product.deleted", {
          productId: req.params.id
        });

        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );


  app.post("/api/admin/products/reorder", requireAdmin, requirePermission("products.manage"), async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(v => String(v)) : [];
      if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) return res.status(400).json({ error: "Provide a valid ordered product ID list." });
      const existing = await getProducts();
      const existingIds = new Set(existing.map(p => String(p.id)));
      if (ids.some(id => !existingIds.has(id)) || ids.length !== existing.length) return res.status(400).json({ error: "The product list changed. Refresh and try again." });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let i = 0; i < ids.length; i++) {
          const product = existing.find(p => String(p.id) === ids[i]);
          product.sortOrder = i + 1;
          await client.query("UPDATE products SET data=$1::jsonb, updated_at=NOW() WHERE id=$2", [JSON.stringify(product), ids[i]]);
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      await audit(req.adminSession, "products.reordered", { count: ids.length });
      res.json({ ok: true, products: await getProducts() });
    } catch (error) { next(error); }
  });
};
