const crypto = require("node:crypto");
const Razorpay = require("razorpay");

module.exports = function registerCheckout(app, { pool, cleanText, requireAdmin, requireOwner, audit, getProducts, ensureCustomerRecord, putOrder, safeEqual }) {
  async function getOffers() {
    const result = await pool.query("SELECT data FROM offers ORDER BY created_at DESC");
    return result.rows.map(row => row.data);
  }
  async function getOfferByCode(code) {
    const result = await pool.query("SELECT data FROM offers WHERE code = $1", [String(code || "").trim().toUpperCase()]);
    return result.rows[0]?.data || null;
  }
  function validateOffer(offer, subtotal) {
    if (!offer || offer.active === false) throw Object.assign(new Error("This coupon code is invalid or inactive."), { status: 400 });
    const now = Date.now();
    if (offer.startsAt && now < new Date(offer.startsAt).getTime()) throw Object.assign(new Error("This offer is not active yet."), { status: 400 });
    if (offer.expiresAt && now > new Date(offer.expiresAt).getTime()) throw Object.assign(new Error("This coupon has expired."), { status: 400 });
    if (subtotal < Number(offer.minimumSubtotal || 0)) throw Object.assign(new Error(`Minimum order subtotal for this code is ₹${Number(offer.minimumSubtotal || 0)}.`), { status: 400 });
    const discount = offer.discountType === "percent"
      ? Math.min(subtotal, Math.floor(subtotal * Number(offer.discountValue) / 100))
      : Math.min(subtotal, Math.floor(Number(offer.discountValue)));
    if (!Number.isFinite(discount) || discount <= 0) throw Object.assign(new Error("This coupon does not provide a valid discount."), { status: 400 });
    return { couponCode: offer.code, discount, subtotal, total: Math.max(0, subtotal - discount) };
  }
  app.get("/api/coupons/validate", async (req, res, next) => {
    try {
      const code = cleanText(req.query?.code, 50).toUpperCase();
      const subtotal = Number(req.query?.subtotal);
      if (!code || !Number.isFinite(subtotal) || subtotal <= 0) return res.status(400).json({ error: "Enter a coupon code and valid subtotal." });
      const offer = await getOfferByCode(code);
      const result = validateOffer(offer, subtotal);
      res.json({ ok: true, code: result.couponCode, discount: result.discount, subtotal: result.subtotal, total: result.total, message: "Coupon applied." });
    } catch (error) { res.status(error.status || 500).json({ error: error.message || "Could not validate coupon." }); }
  });

  app.get("/api/admin/offers", requireAdmin, requireOwner, async (_req, res, next) => {
    try { res.json({ offers: await getOffers() }); } catch (error) { next(error); }
  });
  app.post("/api/admin/offers", requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const code = cleanText(req.body?.code, 32).toUpperCase().replace(/\s+/g, "");
      const title = cleanText(req.body?.title, 100);
      const discountType = req.body?.discountType;
      const discountValue = Number(req.body?.discountValue);
      const minimumSubtotal = Number(req.body?.minimumSubtotal || 0);
      const startsDate = req.body?.startsAt ? new Date(req.body.startsAt) : null;
      const expiresDate = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
      if ((startsDate && Number.isNaN(startsDate.getTime())) || (expiresDate && Number.isNaN(expiresDate.getTime()))) return res.status(400).json({ error: "Offer dates are invalid." });
      const startsAt = startsDate ? startsDate.toISOString() : null;
      const expiresAt = expiresDate ? expiresDate.toISOString() : null;
      if (!/^[A-Z0-9_-]{3,32}$/.test(code) || title.length < 2 || !["percent", "fixed"].includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0 || (discountType === "percent" && discountValue > 100) || !Number.isFinite(minimumSubtotal) || minimumSubtotal < 0) return res.status(400).json({ error: "Enter a valid code, title, discount and minimum subtotal." });
      if (startsAt && Number.isNaN(Date.parse(startsAt)) || expiresAt && Number.isNaN(Date.parse(expiresAt))) return res.status(400).json({ error: "Offer dates are invalid." });
      if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) return res.status(400).json({ error: "Expiry must be later than the start date." });
      const offer = { id: crypto.randomUUID(), code, title, discountType, discountValue, minimumSubtotal, startsAt, expiresAt, active: req.body?.active !== false, usageCount: 0, createdAt: new Date().toISOString() };
      await pool.query("INSERT INTO offers (id, code, data) VALUES ($1, $2, $3::jsonb)", [offer.id, offer.code, JSON.stringify(offer)]);
      await audit(req.adminSession, "offer.created", { code, discountType, discountValue });
      res.status(201).json({ ok: true, offer });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "That coupon code already exists." });
      next(error);
    }
  });
  app.patch("/api/admin/offers/:id", requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const found = await pool.query("SELECT data FROM offers WHERE id = $1", [req.params.id]);
      if (!found.rowCount) return res.status(404).json({ error: "Offer not found." });
      const offer = found.rows[0].data;
      if (req.body?.active !== undefined) offer.active = Boolean(req.body.active);
      if (req.body?.title !== undefined) { const title = cleanText(req.body.title, 100); if (title.length < 2) return res.status(400).json({ error: "Offer title is too short." }); offer.title = title; }
      if (req.body?.discountType !== undefined) { if (!["percent", "fixed"].includes(req.body.discountType)) return res.status(400).json({ error: "Invalid discount type." }); offer.discountType = req.body.discountType; }
      if (req.body?.discountValue !== undefined) { const value = Number(req.body.discountValue); if (!Number.isFinite(value) || value <= 0 || (offer.discountType === "percent" && value > 100)) return res.status(400).json({ error: "Invalid discount value." }); offer.discountValue = value; }
      if (req.body?.minimumSubtotal !== undefined) { const minimum = Number(req.body.minimumSubtotal); if (!Number.isFinite(minimum) || minimum < 0) return res.status(400).json({ error: "Invalid minimum subtotal." }); offer.minimumSubtotal = minimum; }
      for (const key of ["startsAt", "expiresAt"]) {
        if (req.body?.[key] !== undefined) {
          if (req.body[key] === null || req.body[key] === "") offer[key] = null;
          else { const date = new Date(req.body[key]); if (Number.isNaN(date.getTime())) return res.status(400).json({ error: "Offer dates are invalid." }); offer[key] = date.toISOString(); }
        }
      }
      if (offer.startsAt && offer.expiresAt && new Date(offer.expiresAt) <= new Date(offer.startsAt)) return res.status(400).json({ error: "Expiry must be later than the start date." });
      await pool.query("UPDATE offers SET data = $2::jsonb, updated_at = NOW() WHERE id = $1", [offer.id, JSON.stringify(offer)]);
      await audit(req.adminSession, "offer.updated", { code: offer.code, active: offer.active });
      res.json({ ok: true, offer });
    } catch (error) { next(error); }
  });
  app.delete("/api/admin/offers/:id", requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const result = await pool.query("DELETE FROM offers WHERE id = $1 RETURNING code", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Offer not found." });
      await audit(req.adminSession, "offer.deleted", { code: result.rows[0].code });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  async function buildOrder(body = {}) {
    const customer = body.customer || {};

    const name = cleanText(customer.name, 100);
    const email = cleanText(customer.email, 180);
    const phone = cleanText(customer.phone, 10);
    const address = cleanText(customer.address, 300);
    const city = cleanText(customer.city, 100);
    const postalCode = cleanText(customer.postalCode, 6);

    if (
      !name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !/^\d{10}$/.test(phone) ||
      !address ||
      !city ||
      !/^\d{6}$/.test(postalCode)
    ) {
      const error = new Error(
        "Enter valid name, email, 10-digit phone, address, city and 6-digit PIN code."
      );
      error.status = 400;
      throw error;
    }

    if (
      !Array.isArray(body.items) ||
      body.items.length < 1 ||
      body.items.length > 30
    ) {
      const error = new Error("Your cart is empty or invalid.");
      error.status = 400;
      throw error;
    }

    const products = await getProducts();
    const items = [];
    let total = 0;

    for (const item of body.items) {
      const product = products.find(
        current =>
          String(current.id) === String(item.id) &&
          current.active !== false
      );

      const quantity = Number(item.quantity);

      if (
        !product ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        const error = new Error("A product or quantity is invalid.");
        error.status = 400;
        throw error;
      }

      // Treat colour/size labels consistently across the storefront, product settings,
      // and inventory ledger. Admin-entered casing/spacing must not reject a valid choice.
      const normalizeVariant = value => cleanText(value, 50).replace(/\s+/g, " ").toLocaleLowerCase("en-US");
      let color = cleanText(item.color, 40).replace(/\s+/g, " ");
      let size = cleanText(item.size, 30).replace(/\s+/g, " ");

      // Inventory ledger is the source of truth whenever a product has inventory rows.
      // Do not first reject the selected colour against possibly stale product.colors or
      // sizesByColor metadata: that caused valid inventory colours to fail at checkout.
      const stock = await pool.query(
        "SELECT color, size, quantity FROM inventory_variants WHERE product_id = $1 ORDER BY color, size",
        [product.id]
      );
      if (stock.rowCount) {
        const variant = stock.rows.find(v =>
          normalizeVariant(v.color) === normalizeVariant(color) &&
          normalizeVariant(v.size) === normalizeVariant(size)
        );
        if (!color || !size || !variant) {
          const error = new Error(`Choose an available colour and size for ${product.name}.`);
          error.status = 400;
          throw error;
        }
        if (Number(variant.quantity) < quantity) {
          const error = new Error(`${product.name} (${variant.color}, size ${variant.size}) is currently out of stock. Please choose another available variant.`);
          error.status = 409;
          throw error;
        }
        // Store the canonical labels from inventory so orders and tracking are consistent.
        color = cleanText(variant.color, 40).replace(/\s+/g, " ");
        size = cleanText(variant.size, 30).replace(/\s+/g, " ");
      } else if (Array.isArray(product.colors) && product.colors.length) {
        const configuredColors = product.colors.map(value => {
          if (typeof value === "string") return value;
          return value?.name || value?.color || value?.colour || "";
        }).map(value => cleanText(value, 40).replace(/\s+/g, " ")).filter(Boolean);
        const matchedColor = configuredColors.find(value => normalizeVariant(value) === normalizeVariant(color));
        if (!color || !matchedColor) {
          const error = new Error(`Choose an available colour for ${product.name}.`);
          error.status = 400;
          throw error;
        }
        color = matchedColor;

        const sizesEntry = Object.entries(product.sizesByColor || {}).find(([key]) => normalizeVariant(key) === normalizeVariant(color));
        const allowedSizes = Array.isArray(sizesEntry?.[1]) ? sizesEntry[1] : [];
        const matchedSize = allowedSizes.map(value => cleanText(value, 30).replace(/\s+/g, " ")).find(value => normalizeVariant(value) === normalizeVariant(size));
        if (!size || !matchedSize) {
          const error = new Error(`Choose an available size for ${product.name} in ${color}.`);
          error.status = 400;
          throw error;
        }
        size = matchedSize;
      }
      const originalPrice = Number(product.price);
      const configuredSalePrice = Number(product.salePrice);
      const unitPrice = product.salePrice !== null && product.salePrice !== undefined && product.salePrice !== "" && Number.isFinite(configuredSalePrice) && configuredSalePrice > 0 && configuredSalePrice < originalPrice
        ? configuredSalePrice
        : originalPrice;
      items.push({
        id: product.id,
        name: product.name,
        color: color || undefined,
        size: size || undefined,
        unitPrice,
        originalPrice,
        quantity
      });

      total += unitPrice * quantity;
    }

    const subtotal = total;
    const couponCode = cleanText(body.couponCode, 50).toUpperCase();
    let discount = 0;
    let appliedCode = null;
    if (couponCode) {
      const offer = await getOfferByCode(couponCode);
      const applied = validateOffer(offer, subtotal);
      discount = applied.discount;
      total = applied.total;
      appliedCode = applied.couponCode;
    }
    return {
      customer: { name, email, phone, address, city, postalCode },
      items,
      subtotal,
      discount,
      couponCode: appliedCode,
      total,
      currency: "INR"
    };
  }

  app.post("/api/orders/cod", async (req, res) => {
    try {
      const orderData = await buildOrder(req.body);

      const order = {
        id:
          "MC-" +
          Date.now().toString(36).toUpperCase() +
          "-" +
          crypto.randomBytes(3).toString("hex").toUpperCase(),
        ...orderData,
        paymentMethod: "COD",
        paymentStatus: "pending",
        orderStatus: "received",
        createdAt: new Date().toISOString(),
        statusHistory: []
      };

      await ensureCustomerRecord(order.customer);
      await putOrder(order);
      if (order.couponCode) await pool.query("UPDATE offers SET data = jsonb_set(data, '{usageCount}', to_jsonb(COALESCE((data->>'usageCount')::int, 0) + 1), true), updated_at = NOW() WHERE code = $1", [order.couponCode]);

      res.status(201).json({
        ok: true,
        orderId: order.id,
        message: "Order received. The store owner must confirm supplier availability and delivery."
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.message || "Unable to create order."
      });
    }
  });

  app.post("/api/payments/razorpay/order", async (req, res) => {
    try {
      if (
        !process.env.RAZORPAY_KEY_ID ||
        !process.env.RAZORPAY_KEY_SECRET
      ) {
        return res.status(503).json({
          error: "Online payments are not configured. Add Razorpay keys to Render Environment."
        });
      }

      const orderData = await buildOrder(req.body);

      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });

      const receipt = "mc_" + crypto.randomBytes(8).toString("hex");

      const razorpayOrder = await razorpay.orders.create({
        amount: Math.round(orderData.total * 100),
        currency: "INR",
        receipt,
        notes: {
          store: "AERLON",
          customer_email: orderData.customer.email
        }
      });

      await ensureCustomerRecord(orderData.customer);
      await putOrder({
        id: receipt,
        razorpayOrderId: razorpayOrder.id,
        ...orderData,
        paymentMethod: "Razorpay",
        paymentStatus: "created",
        orderStatus: "awaiting_payment",
        createdAt: new Date().toISOString(),
        statusHistory: []
      });
      // A coupon is counted only after Razorpay confirms payment, not when the
      // customer merely opens checkout or abandons the payment window.

      res.status(201).json({
        keyId: process.env.RAZORPAY_KEY_ID,
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        storeName: "AERLON",
        customer: {
          name: orderData.customer.name,
          email: orderData.customer.email,
          phone: orderData.customer.phone
        }
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.message || "Could not create payment order."
      });
    }
  });

  app.post("/api/payments/razorpay/verify", async (req, res) => {
    let client;
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      } = req.body || {};

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature ||
        !process.env.RAZORPAY_KEY_SECRET
      ) {
        return res.status(400).json({
          error: "Missing payment details or server configuration."
        });
      }

      const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

      if (!safeEqual(razorpay_signature, expected)) {
        return res.status(400).json({
          error: "Payment signature verification failed."
        });
      }

      // Lock the order row so a duplicate callback cannot increment coupon usage
      // twice or overwrite a different successful payment.
      client = await pool.connect();
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT id, data FROM orders WHERE data->>'razorpayOrderId' = $1 LIMIT 1 FOR UPDATE",
        [razorpay_order_id]
      );
      if (!found.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Order not found." });
      }

      const order = found.rows[0].data;
      if (order.paymentStatus === "paid") {
        if (order.paymentId === razorpay_payment_id) {
          await client.query("COMMIT");
          return res.json({
            ok: true,
            orderId: order.id,
            message: "Payment was already verified. Your order is confirmed."
          });
        }
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This order has already been paid with a different payment reference." });
      }
      if (order.paymentStatus !== "created" || order.orderStatus !== "awaiting_payment") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This order is not awaiting payment verification." });
      }

      order.paymentId = razorpay_payment_id;
      order.paymentStatus = "paid";
      order.orderStatus = "received";
      order.paidAt = new Date().toISOString();

      await client.query(
        "UPDATE orders SET data = $1::jsonb, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(order), found.rows[0].id]
      );
      if (order.couponCode) {
        await client.query(
          "UPDATE offers SET data = jsonb_set(data, '{usageCount}', to_jsonb(COALESCE((data->>'usageCount')::int, 0) + 1), true), updated_at = NOW() WHERE code = $1",
          [order.couponCode]
        );
      }
      await client.query("COMMIT");

      res.json({
        ok: true,
        orderId: order.id,
        message: "Payment verified. The store owner must confirm supplier availability and delivery."
      });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      console.error("Payment verification failed:", error.message);
      if (res.headersSent) return;
      res.status(error.status || 500).json({
        error: error.message || "Unable to verify payment."
      });
    } finally {
      if (client) client.release();
    }
  });
};
