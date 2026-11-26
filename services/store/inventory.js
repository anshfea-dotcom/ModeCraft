const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

module.exports = function registerInventory(app, { pool, requireAdmin, requirePermission, cleanText, getProduct, audit }) {
  // Inventory variants: persisted independently in PostgreSQL; protected by existing product permissions.
  async function notifyRestockedVariant(productId, color, size) {
    try {
      const subscribers = await pool.query(
        `SELECT sn.id, c.email, c.name, p.data->>'name' AS product_name
         FROM stock_notifications sn
         JOIN customers c ON c.id=sn.customer_id
         JOIN products p ON p.id=sn.product_id
         WHERE sn.product_id=$1 AND LOWER(sn.color)=LOWER($2) AND LOWER(sn.size)=LOWER($3)`,
        [productId, color, size]
      );
      if (!subscribers.rowCount) return;
      const smtpUser = (process.env.GMAIL_USER || process.env.SMTP_USER || process.env.EMAIL_USER || "").trim();
      const smtpPassword = String(process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || process.env.EMAIL_PASS || "").replace(/\s+/g, "");
      const resendApiKey = process.env.RESEND_API_KEY;
      const fromEmail = (process.env.PASSWORD_RESET_FROM || (smtpUser ? `AERLON <${smtpUser}>` : "onboarding@resend.dev")).trim();
      if (!((smtpUser && smtpPassword) || resendApiKey)) {
        console.warn("Back-in-stock subscribers are queued; configure SMTP or RESEND_API_KEY to send alerts.");
        return;
      }
      const shopUrl = process.env.STOREFRONT_URL || process.env.RENDER_EXTERNAL_URL;
      const subject = `Back in stock: ${subscribers.rows[0].product_name || "AERLON product"}`;
      const textBody = `${subscribers.rows[0].product_name || "Your AERLON product"} is back in stock in ${color}, size ${size}.${shopUrl ? ` Visit ${shopUrl} to shop.` : ""}`;
      if (smtpUser && smtpPassword) {
        const port = Number(process.env.SMTP_PORT || 465);
        const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port, secure: process.env.SMTP_SECURE === undefined ? port === 465 : String(process.env.SMTP_SECURE).toLowerCase() === "true", auth: { user: smtpUser, pass: smtpPassword } });
        for (const subscriber of subscribers.rows) await transporter.sendMail({ from: fromEmail, to: subscriber.email, subject, text: textBody });
        transporter.close();
      } else {
        for (const subscriber of subscribers.rows) {
          const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: fromEmail, to: [subscriber.email], subject, text: textBody }) });
          if (!response.ok) throw new Error(`Resend returned ${response.status}`);
        }
      }
      await pool.query("DELETE FROM stock_notifications WHERE product_id=$1 AND LOWER(color)=LOWER($2) AND LOWER(size)=LOWER($3)", [productId, color, size]);
    } catch (error) { console.error("Back-in-stock notification failed:", error.message); }
  }

  app.get("/api/admin/inventory/alerts", requireAdmin, requirePermission("products.view"), async (req, res, next) => {
    try {
      const raw = Number(req.query.threshold ?? 5);
      const threshold = Number.isInteger(raw) ? Math.max(0, Math.min(100, raw)) : 5;
      const result = await pool.query(
        `SELECT v.id, v.product_id, p.data->>'name' AS product_name, v.color, v.size, v.sku, v.quantity
         FROM inventory_variants v JOIN products p ON p.id=v.product_id
         WHERE v.quantity <= $1 ORDER BY v.quantity ASC, p.data->>'name' ASC, v.color, v.size`,
        [threshold]
      );
      res.json({ threshold, count: result.rowCount, alerts: result.rows.map(row => ({ id: row.id, productId: row.product_id, productName: row.product_name || "Unknown product", color: row.color, size: row.size, sku: row.sku, quantity: row.quantity })) });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/inventory", requireAdmin, requirePermission("products.view"), async (_req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT v.id, v.product_id, v.color, v.size, v.sku, v.quantity,
               v.created_at, v.updated_at, p.data->>'name' AS product_name
        FROM inventory_variants v
        JOIN products p ON p.id = v.product_id
        ORDER BY p.data->>'name', v.color, v.size
      `);
      res.json({ inventory: result.rows.map(row => ({
        id: row.id, productId: row.product_id, productName: row.product_name || "Unknown product",
        color: row.color, size: row.size, sku: row.sku, quantity: row.quantity,
        createdAt: row.created_at, updatedAt: row.updated_at
      })) });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/inventory", requireAdmin, requirePermission("products.manage"), async (req, res, next) => {
    try {
      const productId = cleanText(req.body?.productId, 120);
      const color = cleanText(req.body?.color, 50);
      const size = cleanText(req.body?.size, 30);
      const sku = cleanText(req.body?.sku, 80);
      const quantity = Number(req.body?.quantity);
      if (!productId || !color || !size || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
        return res.status(400).json({ error: "Choose a product, enter colour and size, and provide a whole-number quantity from 0 to 1,000,000." });
      }
      const product = await getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found." });
      const configuredColors = (Array.isArray(product.colors) ? product.colors : []).map(v => typeof v === "string" ? v : v?.name || v?.color || v?.colour || "");
      const canonicalColor = configuredColors.find(v => v.toLowerCase() === color.toLowerCase());
      const configuredSizes = product.sizesByColor && typeof product.sizesByColor === "object" ? (product.sizesByColor[canonicalColor] || []) : [];
      if (!canonicalColor || !configuredSizes.some(v => String(v).toLowerCase() === size.toLowerCase())) return res.status(400).json({ error: "Choose a colour and size already configured in this product." });
      const id = "inv_" + crypto.randomBytes(10).toString("hex");
      const result = await pool.query(
        `INSERT INTO inventory_variants (id, product_id, color, size, sku, quantity)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, product_id, color, size, sku, quantity, created_at, updated_at`,
        [id, productId, color, size, sku, quantity]
      );
      await audit(req.adminSession, "inventory.variant.saved", { productId, color, size, quantity });
      if (quantity > 0) await notifyRestockedVariant(productId, color, size);
      const row = result.rows[0];
      res.status(201).json({ ok: true, variant: { id: row.id, productId: row.product_id, productName: product.name, color: row.color, size: row.size, sku: row.sku, quantity: row.quantity, createdAt: row.created_at, updatedAt: row.updated_at } });
    } catch (error) {
      if (error.code === "23503") return res.status(404).json({ error: "Product not found." });
      if (error.code === "23505") return res.status(409).json({ error: "This product already has that colour and size combination. Edit the existing variant instead." });
      next(error);
    }
  });

  app.post("/api/admin/inventory/bulk", requireAdmin, requirePermission("products.manage"), async (req, res, next) => {
    let client;
    try {
      const productId = cleanText(req.body?.productId, 100);
      const color = cleanText(req.body?.color, 50).replace(/\s+/g, " ");
      const variants = Array.isArray(req.body?.variants) ? req.body.variants : [];
      if (!productId || !color || !variants.length || variants.length > 20) {
        return res.status(400).json({ error: "Choose a product, colour and at least one size quantity." });
      }
      const product = await getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found." });
      const configuredColors = (Array.isArray(product.colors) ? product.colors : []).map(v => typeof v === "string" ? v : v?.name || v?.color || v?.colour || "");
      const canonicalColor = configuredColors.find(v => v.toLowerCase() === color.toLowerCase());
      const configuredSizes = product.sizesByColor && typeof product.sizesByColor === "object" ? (product.sizesByColor[canonicalColor] || []) : [];
      if (!canonicalColor) return res.status(400).json({ error: "Choose a colour already configured in this product." });
      const seen = new Set();
      const normalized = variants.map(item => {
        const size = cleanText(item?.size, 30).replace(/\s+/g, " ");
        const quantity = Number(item?.quantity);
        const sku = cleanText(item?.sku, 80);
        if (!size || !configuredSizes.some(v => String(v).toLowerCase() === size.toLowerCase()) || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000 || seen.has(size.toLowerCase())) {
          const error = new Error("Each size must be unique and have a whole-number quantity between 0 and 1,000,000."); error.status = 400; throw error;
        }
        seen.add(size.toLowerCase()); return { size, quantity, sku };
      });
      client = await pool.connect();
      await client.query("BEGIN");
      const saved = [];
      for (const item of normalized) {
        const existingVariant = await client.query(
          `SELECT id FROM inventory_variants
           WHERE product_id=$1 AND LOWER(color)=LOWER($2) AND LOWER(size)=LOWER($3)
           ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
          [productId, color, item.size]
        );
        let result;
        if (existingVariant.rowCount) {
          result = await client.query(
            `UPDATE inventory_variants SET color=$1, size=$2, sku=$3, quantity=$4, updated_at=NOW()
             WHERE id=$5 RETURNING id, product_id, color, size, sku, quantity, created_at, updated_at`,
            [color, item.size, item.sku, item.quantity, existingVariant.rows[0].id]
          );
        } else {
          const id = "inv_" + crypto.randomBytes(12).toString("hex");
          result = await client.query(
            `INSERT INTO inventory_variants (id, product_id, color, size, sku, quantity)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id, product_id, color, size, sku, quantity, created_at, updated_at`,
            [id, productId, color, item.size, item.sku, item.quantity]
          );
        }
        saved.push(result.rows[0]);
      }
      await client.query("COMMIT");
      await audit(req.adminSession, "inventory.bulk.updated", { productId, color, sizes: normalized.map(v => v.size) });
      for (const item of normalized) if (item.quantity > 0) await notifyRestockedVariant(productId, color, item.size);
      res.json({ ok: true, saved: saved.length, variants: saved.map(row => ({ id: row.id, productId: row.product_id, productName: product.name, color: row.color, size: row.size, sku: row.sku, quantity: row.quantity, createdAt: row.created_at, updatedAt: row.updated_at })) });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch {} }
      res.status(error.status || 500).json({ error: error.message || "Could not save stock quantities." });
    } finally { if (client) client.release(); }
  });

  app.patch("/api/admin/inventory/:id", requireAdmin, requirePermission("products.manage"), async (req, res, next) => {
    try {
      const existing = await pool.query("SELECT id FROM inventory_variants WHERE id = $1", [req.params.id]);
      if (!existing.rowCount) return res.status(404).json({ error: "Stock variant not found." });
      const productId = cleanText(req.body?.productId, 120);
      const color = cleanText(req.body?.color, 50);
      const size = cleanText(req.body?.size, 30);
      const sku = cleanText(req.body?.sku, 80);
      const quantity = Number(req.body?.quantity);
      if (!productId || !color || !size || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
        return res.status(400).json({ error: "Choose a product, enter colour and size, and provide a valid non-negative whole-number quantity." });
      }
      const product = await getProduct(productId);
      if (!product) return res.status(404).json({ error: "Product not found." });
      const configuredColors = (Array.isArray(product.colors) ? product.colors : []).map(v => typeof v === "string" ? v : v?.name || v?.color || v?.colour || "");
      const canonicalColor = configuredColors.find(v => v.toLowerCase() === color.toLowerCase());
      const configuredSizes = product.sizesByColor && typeof product.sizesByColor === "object" ? (product.sizesByColor[canonicalColor] || []) : [];
      if (!canonicalColor || !configuredSizes.some(v => String(v).toLowerCase() === size.toLowerCase())) return res.status(400).json({ error: "Choose a colour and size already configured in this product." });
      const result = await pool.query(
        `UPDATE inventory_variants SET product_id=$1, color=$2, size=$3, sku=$4, quantity=$5, updated_at=NOW()
         WHERE id=$6 RETURNING id, product_id, color, size, sku, quantity, created_at, updated_at`,
        [productId, color, size, sku, quantity, req.params.id]
      );
      const row = result.rows[0];
      await audit(req.adminSession, "inventory.variant.updated", { variantId: row.id, productId, color, size, quantity });
      if (quantity > 0) await notifyRestockedVariant(productId, color, size);
      res.json({ ok: true, variant: { id: row.id, productId: row.product_id, productName: product.name, color: row.color, size: row.size, sku: row.sku, quantity: row.quantity, createdAt: row.created_at, updatedAt: row.updated_at } });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "This product already has that colour and size combination." });
      next(error);
    }
  });

  app.delete("/api/admin/inventory/:id", requireAdmin, requirePermission("products.manage"), async (req, res, next) => {
    try {
      const result = await pool.query("DELETE FROM inventory_variants WHERE id=$1 RETURNING id, product_id, color, size", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Stock variant not found." });
      await audit(req.adminSession, "inventory.variant.deleted", result.rows[0]);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
};
