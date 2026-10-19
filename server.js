require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");

const products = [
  { id: "tee-black", name: "Essential Black Tee", category: "T-Shirts", price: 599, image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=700&q=85", description: "A clean everyday essential." },
  { id: "tee-white", name: "Classic White Tee", category: "T-Shirts", price: 549, image: "https://images.unsplash.com/photo-1503341504253-dff4815485f1?auto=format&fit=crop&w=700&q=85", description: "Minimal style, easy to wear." },
  { id: "shirt-urban", name: "Urban Oversized Shirt", category: "Shirts", price: 999, image: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=700&q=85", description: "Relaxed fit for everyday looks." },
  { id: "hoodie-minimal", name: "Minimal Street Hoodie", category: "Hoodies", price: 1299, image: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=700&q=85", description: "A versatile layering piece." },
  { id: "denim-everyday", name: "Everyday Denim", category: "Bottomwear", price: 1199, image: "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=700&q=85", description: "A wardrobe staple." },
  { id: "shirt-neutral", name: "Relaxed Fit Shirt", category: "Shirts", price: 899, image: "https://images.unsplash.com/photo-1603252109303-2751441dd157?auto=format&fit=crop&w=700&q=85", description: "An easy smart-casual option." },
  { id: "tee-neutral", name: "Premium Neutral Tee", category: "T-Shirts", price: 699, image: "https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?auto=format&fit=crop&w=700&q=85", description: "Soft-looking, understated style." },
  { id: "trousers-modern", name: "Modern Casual Trousers", category: "Bottomwear", price: 1099, image: "https://images.unsplash.com/photo-1473966968600-fa801b869a1a?auto=format&fit=crop&w=700&q=85", description: "Everyday comfort with a clean silhouette." }
];

function readOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); }
  catch { return []; }
}
function saveOrder(order) {
  const orders = readOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanText(value, max = 300) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function buildOrder(body) {
  const customer = body.customer || {};
  const name = cleanText(customer.name, 100);
  const email = cleanText(customer.email, 180);
  const phone = cleanText(customer.phone, 10);
  const address = cleanText(customer.address, 300);
  const city = cleanText(customer.city, 100);
  const postalCode = cleanText(customer.postalCode, 6);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !/^\d{10}$/.test(phone) || !address || !city || !/^\d{6}$/.test(postalCode)) {
    const error = new Error("Enter valid name, email, 10-digit phone, address, city and 6-digit PIN code.");
    error.status = 400; throw error;
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    const error = new Error("Your cart is empty or invalid."); error.status = 400; throw error;
  }
  const items = [];
  let total = 0;
  for (const item of body.items) {
    const product = products.find(p => p.id === item.id);
    const quantity = Number(item.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      const error = new Error("A product or quantity is invalid."); error.status = 400; throw error;
    }
    items.push({ id: product.id, name: product.name, unitPrice: product.price, quantity });
    total += product.price * quantity;
  }
  return {
    customer: { name, email, phone, address, city, postalCode },
    items, total, currency: "INR"
  };
}

app.use((req, res, next) => {
  const allowed = (process.env.ALLOWED_ORIGIN || "http://localhost:3000").split(",").map(s => s.trim());
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Razorpay-Signature");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Webhook body must be raw for signature verification, so register before express.json().
app.post("/api/razorpay/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send("Webhook secret is not configured");
  const signature = req.get("X-Razorpay-Signature") || "";
  const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!safeEqual(signature, expected)) return res.status(400).send("Invalid signature");
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); }
  catch { return res.status(400).send("Invalid JSON"); }
  // Production: update the matching order by Razorpay payment/order ID and make handling idempotent.
  console.log("Verified Razorpay webhook event:", event.event);
  res.json({ received: true });
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/products", (_req, res) => res.json({ products }));
app.get("/api/config", (_req, res) => res.json({ razorpayEnabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), keyId: process.env.RAZORPAY_KEY_ID || "" }));

app.post("/api/orders/cod", (req, res) => {
  try {
    const orderData = buildOrder(req.body);
    const order = {
      id: "MC-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      ...orderData, paymentMethod: "COD", paymentStatus: "pending", orderStatus: "received",
      createdAt: new Date().toISOString()
    };
    saveOrder(order);
    res.status(201).json({ ok: true, orderId: order.id, message: "Order received. The store owner must confirm supplier availability and delivery." });
  } catch (e) { res.status(e.status || 500).json({ error: e.message || "Unable to create order." }); }
});

app.post("/api/payments/razorpay/order", async (req, res) => {
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: "Online payments are not configured yet. Add Razorpay keys to .env." });
    }
    const orderData = buildOrder(req.body);
    const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const receipt = "mc_" + crypto.randomBytes(8).toString("hex");
    const rpOrder = await razorpay.orders.create({
      amount: orderData.total * 100, currency: "INR", receipt,
      notes: { store: "ModeCraft", customer_email: orderData.customer.email }
    });
    // Pending record: never mark as paid until signature/payment is verified server-side.
    saveOrder({
      id: receipt, razorpayOrderId: rpOrder.id, ...orderData,
      paymentMethod: "Razorpay", paymentStatus: "created", orderStatus: "awaiting_payment",
      createdAt: new Date().toISOString()
    });
    res.status(201).json({ keyId: process.env.RAZORPAY_KEY_ID, razorpayOrderId: rpOrder.id, amount: rpOrder.amount, currency: rpOrder.currency, storeName: "ModeCraft", customer: { name: orderData.customer.name, email: orderData.customer.email, phone: orderData.customer.phone } });
  } catch (e) { res.status(e.status || 500).json({ error: e.message || "Could not create payment order." }); }
});

app.post("/api/payments/razorpay/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(400).json({ error: "Missing payment details or server configuration." });
    }
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    if (!safeEqual(razorpay_signature, expected)) return res.status(400).json({ error: "Payment signature verification failed." });
    const orders = readOrders();
    const match = orders.find(o => o.razorpayOrderId === razorpay_order_id);
    if (!match) return res.status(404).json({ error: "Order not found." });
    match.paymentId = razorpay_payment_id;
    match.paymentStatus = "paid";
    match.orderStatus = "received";
    match.paidAt = new Date().toISOString();
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    res.json({ ok: true, orderId: match.id, message: "Payment verified. The store owner must confirm supplier availability and delivery." });
  } catch (e) { res.status(500).json({ error: "Unable to verify payment." }); }
});

app.get("*", (req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.listen(PORT, () => console.log(`ModeCraft running at http://localhost:${PORT}`));
