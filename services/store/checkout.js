const crypto = require("node:crypto");
const Razorpay = require("razorpay");

const { confirmCapturedPayment } = require("./payment");
const { rateLimit } = require("express-rate-limit");
const { addressRoutes, postalAreas, pinPattern } = require("./address");
const reject = (status, message) => Object.assign(new Error(message), { status });

module.exports = function registerCheckout(app, { pool, cleanText, requireAdmin, requireOwner, audit, getProducts, ensureCustomerRecord, safeEqual }) {
  addressRoutes(app);
  app.use(["/api/orders/cod", "/api/payments/razorpay", "/api/coupons/validate"], rateLimit({
    windowMs: 60000, limit: 24, message: { error: "Too many checkout requests. Please wait a minute." }
  }));

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

  async function validateAddress(customer = {}) {

    const name = cleanText(customer.name, 100);
    const email = cleanText(customer.email, 180);
    const phone = cleanText(customer.phone, 32);
    const street = cleanText(customer.address, 180);
    const house = cleanText(customer.house, 100);
    const state = cleanText(customer.state, 100);
    const landmark = cleanText(customer.landmark, 100);
    const addressType = cleanText(customer.addressType, 12);
    const address = [house, street, landmark, state].filter(Boolean).join(", ");
    const city = cleanText(customer.city, 100);
    const postalCode = cleanText(customer.postalCode, 24);

    if (
      !name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !/^[6-9]\d{9}$/.test(phone) ||
      !house || !state || !street || !["Home", "Work", "Other"].includes(addressType) ||
      !city ||
      !pinPattern.test(postalCode)
    ) {
      const error = new Error(
        "Check your contact details, house, street, city, state, address type and PIN."
      );
      error.status = 400;
      throw error;
    }

    const areas = postalAreas(postalCode);
    const states = areas.map(area => area.state.toLowerCase()).filter(Boolean);
    if (states.length && !states.includes(state.toLowerCase())) throw reject(400, "Check the state for this PIN.");
    const cities = areas.map(area => area.city.toLowerCase()).filter(Boolean);
    // Indian PINs can serve several localities. Flag a different city for fulfilment review.
    const cityNeedsReview = cities.length > 0 && !cities.includes(city.toLowerCase());
    return { name, email, phone, house, street, landmark, state, addressType, address, city, postalCode, cityNeedsReview };
  }

  async function priceBag(body) {
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
      if (!stock.rowCount && Number.isFinite(Number(product.stock)) && Number(product.stock) < quantity)
        throw reject(409, "This product is currently out of stock.");
      if (items.some(line => line.id === product.id && (line.color || "") === color && (line.size || "") === size))
        throw reject(400, "Combine duplicate bag items before checking out.");
      const originalPrice = Number(product.price);
      const configuredSalePrice = Number(product.salePrice);
      const unitPrice = product.salePrice !== null && product.salePrice !== undefined && product.salePrice !== "" && Number.isFinite(configuredSalePrice) && configuredSalePrice > 0 && configuredSalePrice < originalPrice
        ? configuredSalePrice
        : originalPrice;
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw reject(409, "Product price is unavailable.");
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
      items,
      subtotal,
      discount,
      couponCode: appliedCode,
      total,
      shipping: 0,
      currency: "INR"
    };
  }

  app.post("/api/coupons/validate", async (req, res) => {
    try {
      if (!req.body?.couponCode) throw reject(400, "Enter a coupon code.");
      const quote = await priceBag(req.body);
      res.json({ ok: true, code: quote.couponCode, discount: quote.discount, subtotal: quote.subtotal, total: quote.total, message: "Coupon applied." });
    } catch (error) {
      res.status(error.status || 503).json({ error: error.status ? error.message : "Coupon lookup unavailable." });
    }
  });

  function gateway() {
    return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }

  function receipt(order) {
    if (order.paymentMethod === "COD") return { ok: true, orderId: order.id, message: "Order received. Track it using your order reference." };
    return {
      keyId: process.env.RAZORPAY_KEY_ID, razorpayOrderId: order.razorpayOrderId,
      amount: Math.round(order.total * 100), currency: order.currency,
      customer: { name: order.customer.name, email: order.customer.email, phone: order.customer.phone }
    };
  }

  function createOrder(method) {
    return async (req, res) => {
      let client;
      try {
        const { attemptId, ...body } = req.body || {};
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId || "")) throw reject(400, "Refresh checkout and retry.");
        if (method === "Razorpay" && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)) throw reject(503, "Online payment is unavailable.");
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify([method, body])).digest("hex");
        async function replay() {
          const found = await pool.query("SELECT a.fingerprint, o.data FROM checkout_attempts a LEFT JOIN orders o ON o.id=a.order_id WHERE a.id=$1", [attemptId]);
          if (!found.rowCount) return false;
          const row = found.rows[0];
          if (row.fingerprint !== fingerprint) throw reject(409, "This attempt belongs to a different order.");
          if (!row.data) throw reject(409, "This order is being confirmed. Keep your bag and retry shortly.");
          if (row.data.paymentStatus === "paid") throw reject(409, "This order is already paid.");
          res.json(receipt(row.data));
          return true;
        }
        if (await replay()) return;
        const customer = await validateAddress(body.customer);
        const data = { customer, ...await priceBag(body) };
        if (body.expectedTotal !== undefined && body.expectedTotal !== data.total)
          throw reject(409, "The bag total has changed. Refresh your bag and review the new total.");
        const id = "MC-" + crypto.randomBytes(10).toString("hex").toUpperCase();
        const online = method === "Razorpay";
        client = await pool.connect();
        await client.query("BEGIN");
        const claim = await client.query("INSERT INTO checkout_attempts(id,fingerprint,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [attemptId,fingerprint,id]);
        if (!claim.rowCount) { if (client) { await client.query("ROLLBACK"); client.release(); client = null; } await replay(); return; }
        const order = { ...data, id, paymentMethod: method, paymentStatus: online ? "created" : "pending",
          orderStatus: online ? "awaiting_payment" : "received", createdAt: new Date().toISOString(), statusHistory: [] };
        if (online) {
          const result = await gateway().orders.create({ amount: Math.round(order.total * 100), currency: order.currency, receipt: id });
          order.razorpayOrderId = result.id;
        }
        await ensureCustomerRecord(order.customer, client);
        await client.query("INSERT INTO orders(id,data) VALUES($1,$2::jsonb)", [id, JSON.stringify(order)]);
        if (!online && order.couponCode) await client.query("UPDATE offers SET data=jsonb_set(data,'{usageCount}',to_jsonb(COALESCE((data->>'usageCount')::int,0)+1)) WHERE code=$1", [order.couponCode]);
        await client.query("COMMIT");
        res.status(201).json(receipt(order));
      } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        res.status(error.status || 503).json({ error: error.status ? error.message : "Unable to confirm the order. Retry with the same bag or contact customer care." });
      } finally { client?.release(); }
    };
  }
  app.post("/api/orders/cod", createOrder("COD"));
  app.post("/api/payments/razorpay/order", createOrder("Razorpay"));

  app.post("/api/payments/razorpay/verify", async (req, res) => {
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

      const payment = await gateway().payments.fetch(razorpay_payment_id);
      if (payment.id !== razorpay_payment_id || payment.order_id !== razorpay_order_id)
        throw reject(409, "Payment reference does not match.");
      res.json(await confirmCapturedPayment(pool, payment));
    } catch (error) {
      res.status(error.status || 503).json({ error: error.status ? error.message : "Payment lookup unavailable. Check your order before paying again." });
    }
  });
};
