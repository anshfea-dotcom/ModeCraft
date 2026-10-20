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
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const STAFF_FILE = path.join(DATA_DIR, "staff.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");

// Admin sessions are stored in memory and expire after 8 hours.
// A server restart signs everyone out; no additional npm package is required.
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();
const loginAttempts = new Map();
const SESSION_COOKIE = "mc_admin_session";
const VALID_ORDER_STATUSES = new Set([
  "received",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "awaiting_payment"
]);

const DEFAULT_PRODUCTS = [
  {
    id: "tee-black",
    name: "Essential Black Tee",
    category: "T-Shirts",
    price: 599,
    image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=700&q=85",
    description: "A clean everyday essential."
  },
  {
    id: "tee-white",
    name: "Classic White Tee",
    category: "T-Shirts",
    price: 549,
    image: "https://images.unsplash.com/photo-1503341504253-dff4815485f1?auto=format&fit=crop&w=700&q=85",
    description: "Minimal style, easy to wear."
  },
  {
    id: "shirt-urban",
    name: "Urban Oversized Shirt",
    category: "Shirts",
    price: 999,
    image: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=700&q=85",
    description: "Relaxed fit for everyday looks."
  },
  {
    id: "hoodie-minimal",
    name: "Minimal Street Hoodie",
    category: "Hoodies",
    price: 1299,
    image: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=700&q=85",
    description: "A versatile layering piece."
  },
  {
    id: "denim-everyday",
    name: "Everyday Denim",
    category: "Bottomwear",
    price: 1199,
    image: "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=700&q=85",
    description: "A wardrobe staple."
  },
  {
    id: "shirt-neutral",
    name: "Relaxed Fit Shirt",
    category: "Shirts",
    price: 899,
    image: "https://images.unsplash.com/photo-1603252109303-2751441dd157?auto=format&fit=crop&w=700&q=85",
    description: "An easy smart-casual option."
  },
  {
    id: "tee-neutral",
    name: "Premium Neutral Tee",
    category: "T-Shirts",
    price: 699,
    image: "https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?auto=format&fit=crop&w=700&q=85",
    description: "Soft-looking, understated style."
  },
  {
    id: "trousers-modern",
    name: "Modern Casual Trousers",
    category: "Bottomwear",
    price: 1099,
    image: "https://images.unsplash.com/photo-1473966968600-fa801b869a1a?auto=format&fit=crop&w=700&q=85",
    description: "Everyday comfort with a clean silhouette."
  }
];

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value;
  } catch { return fallback; }
}
function writeJson(file, value) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
if (!fs.existsSync(PRODUCTS_FILE)) writeJson(PRODUCTS_FILE, DEFAULT_PRODUCTS);
if (!fs.existsSync(STAFF_FILE)) writeJson(STAFF_FILE, []);
if (!fs.existsSync(AUDIT_FILE)) writeJson(AUDIT_FILE, []);
let products = readJson(PRODUCTS_FILE, DEFAULT_PRODUCTS);
if (!Array.isArray(products)) products = DEFAULT_PRODUCTS;
products = products.map(p => ({ ...p, stock: Number.isInteger(p.stock) ? p.stock : 0, active: p.active !== false }));
writeJson(PRODUCTS_FILE, products);
function readStaff() { const v = readJson(STAFF_FILE, []); return Array.isArray(v) ? v : []; }
function writeStaff(v) { writeJson(STAFF_FILE, v); }
function audit(actor, action, details = {}) {
  const rows = readJson(AUDIT_FILE, []);
  rows.unshift({ id: crypto.randomUUID(), actor: actor?.username || "system", role: actor?.role || "system", action, details, at: new Date().toISOString() });
  writeJson(AUDIT_FILE, rows.slice(0, 500));
}
function readOrders() {
  try {
    const data = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function saveOrder(order) {
  const orders = readOrders();
  orders.push(order);
  writeOrders(orders);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cleanText(value, max = 300) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function buildOrder(body = {}) {
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
    const error = new Error("Enter valid name, email, 10-digit phone, address, city and 6-digit PIN code.");
    error.status = 400;
    throw error;
  }

  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    const error = new Error("Your cart is empty or invalid.");
    error.status = 400;
    throw error;
  }

  const items = [];
  let total = 0;

  for (const item of body.items) {
    const product = products.find(p => p.id === item.id);
    const quantity = Number(item.quantity);

    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      const error = new Error("A product or quantity is invalid.");
      error.status = 400;
      throw error;
    }

    items.push({
      id: product.id,
      name: product.name,
      unitPrice: product.price,
      quantity
    });
    total += product.price * quantity;
  }

  return {
    customer: { name, email, phone, address, city, postalCode },
    items,
    total,
    currency: "INR"
  };
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    if (trimmed.slice(0, separator) === name) {
      return trimmed.slice(separator + 1);
    }
  }
  return "";
}

function getAdminSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const session = adminSessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }

  // Extend the session while the admin is active.
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  return session;
}

function requireAdmin(req, res, next) {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ error: "Please sign in again." });
  req.adminSession = session;
  next();
}
const ROLE_PERMISSIONS = {
  owner: new Set(["dashboard.view", "orders.view", "orders.update", "orders.cancel", "products.view", "products.manage", "staff.manage", "analytics.view", "audit.view"]),
  manager: new Set(["dashboard.view", "orders.view", "orders.update", "orders.cancel", "products.view", "products.manage", "analytics.view", "audit.view"]),
  staff: new Set(["dashboard.view", "orders.view", "orders.update", "products.view"])
};
function can(session, permission) { return Boolean(session && ROLE_PERMISSIONS[session.role]?.has(permission)); }
function requirePermission(permission) { return (req, res, next) => {
  if (!can(req.adminSession, permission)) return res.status(403).json({ error: "Your role does not have permission for this action." });
  next();
}; }
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try { return safeEqual(crypto.scryptSync(password, salt, 64).toString("hex"), hash); } catch { return false; }
}
function publicStaff(user) { return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, active: user.active, createdAt: user.createdAt }; }

function getClientIp(req) {
  // Use Express's direct connection address; do not trust arbitrary forwarded headers.
  return req.socket?.remoteAddress || "unknown";
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

app.use((req, res, next) => {
  const allowed = (process.env.ALLOWED_ORIGIN || "http://localhost:3000")
    .split(",")
    .map(s => s.trim());
  const origin = req.headers.origin;

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Razorpay-Signature");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // Production: update the matching order by Razorpay payment/order ID and make handling idempotent.
  console.log("Verified Razorpay webhook event:", event.event);
  res.json({ received: true });
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/products", (_req, res) => res.json({ products: products.filter(p => p.active !== false) }));
app.get("/api/config", (_req, res) => res.json({
  razorpayEnabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  keyId: process.env.RAZORPAY_KEY_ID || ""
}));

// Admin authentication. Configure ADMIN_USERNAME and ADMIN_PASSWORD in Render's environment.
app.post("/api/admin/login", (req, res) => {
  const ownerUsername = process.env.ADMIN_USERNAME;
  const ownerPassword = process.env.ADMIN_PASSWORD;
  const submittedUsername = cleanText(req.body?.username, 100);
  const submittedPassword = typeof req.body?.password === "string" ? req.body.password : "";
  if (!submittedUsername || !submittedPassword) return res.status(400).json({ error: "Enter username and password." });
  const ip = getClientIp(req); const now = Date.now(); const attempt = loginAttempts.get(ip);
  if (attempt && now - attempt.startedAt < 15 * 60 * 1000 && attempt.count >= 10) return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes." });
  if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) loginAttempts.set(ip, { startedAt: now, count: 0 });
  let account = null;
  if (ownerUsername && ownerPassword && safeEqual(submittedUsername, ownerUsername) && safeEqual(submittedPassword, ownerPassword)) {
    account = { username: ownerUsername, displayName: "Store Owner", role: "owner", active: true };
  } else {
    const staffUser = readStaff().find(u => u.username.toLowerCase() === submittedUsername.toLowerCase());
    if (staffUser && staffUser.active && verifyPassword(submittedPassword, staffUser.salt, staffUser.passwordHash)) account = { username: staffUser.username, displayName: staffUser.displayName, role: staffUser.role, staffId: staffUser.id, active: true };
  }
  if (!account) { const current = loginAttempts.get(ip); current.count += 1; return res.status(401).json({ error: "Incorrect username or password, or account disabled." }); }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { ...account, expiresAt: now + ADMIN_SESSION_TTL_MS });
  setSessionCookie(res, token); audit(account, "login");
  res.json({ ok: true, user: { username: account.username, displayName: account.displayName, role: account.role } });
});

app.get("/api/admin/me", (req, res) => {
  const session = getAdminSession(req);
  res.json({ authenticated: Boolean(session), role: session?.role || null, username: session?.username || null, displayName: session?.displayName || null, permissions: session ? [...(ROLE_PERMISSIONS[session.role] || [])] : [] });
});

app.post("/api/admin/logout", (req, res) => {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) { const session = adminSessions.get(token); if (session) audit(session, "logout"); adminSessions.delete(token); }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, requirePermission("orders.view"), (_req, res) => {
  const orders = readOrders().sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  res.json({ orders });
});

app.patch("/api/admin/orders/:id", requireAdmin, requirePermission("orders.update"), (req, res) => {
  const orderStatus = cleanText(req.body?.orderStatus, 40);
  const cancellationReason = cleanText(req.body?.cancellationReason, 300);
  if (!VALID_ORDER_STATUSES.has(orderStatus)) return res.status(400).json({ error: "Invalid order status." });
  if (orderStatus === "cancelled" && !can(req.adminSession, "orders.cancel")) return res.status(403).json({ error: "Only owners and managers can cancel orders." });
  if (orderStatus === "cancelled" && !cancellationReason) return res.status(400).json({ error: "Enter a cancellation reason." });
  const orders = readOrders(); const order = orders.find(item => String(item.id) === String(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (["delivered", "cancelled"].includes(order.orderStatus) && orderStatus !== order.orderStatus) return res.status(409).json({ error: "Delivered or cancelled orders cannot be reopened or moved to an earlier status." });
  if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
  order.statusHistory.push({ status: orderStatus, reason: orderStatus === "cancelled" ? cancellationReason : "", by: req.adminSession.username, at: new Date().toISOString() });
  order.orderStatus = orderStatus; if (orderStatus === "cancelled") order.cancellationReason = cancellationReason;
  order.updatedAt = new Date().toISOString(); writeOrders(orders); audit(req.adminSession, "order.status.updated", { orderId: order.id, status: orderStatus });
  res.json({ ok: true, order });
});

app.get("/api/admin/analytics", requireAdmin, requirePermission("analytics.view"), (_req, res) => {
  const orders = readOrders(); const paid = orders.filter(o => o.paymentStatus === "paid");
  const active = orders.filter(o => !["cancelled", "delivered"].includes(o.orderStatus));
  const byDay = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i); const key = d.toISOString().slice(0,10); const dayOrders = orders.filter(o => String(o.createdAt || "").slice(0,10) === key); byDay.push({ date: key, orders: dayOrders.length, revenue: dayOrders.filter(o=>o.paymentStatus === "paid").reduce((sum,o)=>sum+Number(o.total||0),0) }); }
  res.json({ totalOrders: orders.length, pendingOrders: active.length, paidOrders: paid.length, cancelledOrders: orders.filter(o=>o.orderStatus === "cancelled").length, paidRevenue: paid.reduce((sum,o)=>sum+Number(o.total||0),0), byDay });
});

app.get("/api/admin/products", requireAdmin, requirePermission("products.view"), (_req,res) => res.json({ products }));
app.post("/api/admin/products", requireAdmin, requirePermission("products.manage"), (req,res) => {
  const name=cleanText(req.body?.name,120), category=cleanText(req.body?.category,80), image=cleanText(req.body?.image,1000), description=cleanText(req.body?.description,500), price=Number(req.body?.price), stock=Number(req.body?.stock ?? 0);
  if (!name || !category || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0) return res.status(400).json({error:"Enter a product name, category, valid price and non-negative stock."});
  const product={ id:"mc-prod-"+crypto.randomBytes(6).toString("hex"), name, category, price, image, description, stock, active:req.body?.active !== false, createdAt:new Date().toISOString() }; products.push(product); writeJson(PRODUCTS_FILE,products); audit(req.adminSession,"product.created",{productId:product.id}); res.status(201).json({ok:true,product});
});
app.patch("/api/admin/products/:id", requireAdmin, requirePermission("products.manage"), (req,res) => {
  const product=products.find(p=>p.id===req.params.id); if(!product) return res.status(404).json({error:"Product not found."});
  if(req.body?.name !== undefined) product.name=cleanText(req.body.name,120); if(req.body?.category !== undefined) product.category=cleanText(req.body.category,80); if(req.body?.image !== undefined) product.image=cleanText(req.body.image,1000); if(req.body?.description !== undefined) product.description=cleanText(req.body.description,500);
  if(req.body?.price !== undefined){const price=Number(req.body.price);if(!Number.isFinite(price)||price<=0)return res.status(400).json({error:"Price must be greater than zero."});product.price=price;}
  if(req.body?.stock !== undefined){const stock=Number(req.body.stock);if(!Number.isInteger(stock)||stock<0)return res.status(400).json({error:"Stock must be a non-negative whole number."});product.stock=stock;} if(req.body?.active !== undefined) product.active=Boolean(req.body.active);
  writeJson(PRODUCTS_FILE,products); audit(req.adminSession,"product.updated",{productId:product.id}); res.json({ok:true,product});
});
app.delete("/api/admin/products/:id", requireAdmin, requirePermission("products.manage"), (req,res) => { const i=products.findIndex(p=>p.id===req.params.id); if(i<0)return res.status(404).json({error:"Product not found."}); const [removed]=products.splice(i,1); writeJson(PRODUCTS_FILE,products); audit(req.adminSession,"product.deleted",{productId:removed.id}); res.json({ok:true}); });

app.get("/api/admin/staff", requireAdmin, requirePermission("staff.manage"), (_req,res) => res.json({staff:readStaff().map(publicStaff)}));
app.post("/api/admin/staff", requireAdmin, requirePermission("staff.manage"), (req,res) => {
  const username=cleanText(req.body?.username,60), displayName=cleanText(req.body?.displayName,100), password=typeof req.body?.password === "string" ? req.body.password : "", role=req.body?.role;
  if(!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) return res.status(400).json({error:"Username must be 3–60 characters and use letters, numbers, dots, underscores or hyphens."});
  if(displayName.length<2 || password.length<10 || !["manager","staff"].includes(role)) return res.status(400).json({error:"Provide a display name, password of at least 10 characters, and Manager or Staff role."});
  const users=readStaff(); if(users.some(u=>u.username.toLowerCase()===username.toLowerCase())) return res.status(409).json({error:"That username already exists."});
  const hashed=hashPassword(password); const user={id:crypto.randomUUID(),username,displayName,role,active:true,...{salt:hashed.salt,passwordHash:hashed.hash},createdAt:new Date().toISOString()}; users.push(user); writeStaff(users); audit(req.adminSession,"staff.created",{staffId:user.id,role}); res.status(201).json({ok:true,staff:publicStaff(user)});
});
app.patch("/api/admin/staff/:id", requireAdmin, requirePermission("staff.manage"), (req,res) => {
  const users=readStaff(); const user=users.find(u=>u.id===req.params.id); if(!user)return res.status(404).json({error:"Staff account not found."});
  if(req.body?.role !== undefined){if(!["manager","staff"].includes(req.body.role))return res.status(400).json({error:"Staff can only be Manager or Staff."});user.role=req.body.role;} if(req.body?.active !== undefined)user.active=Boolean(req.body.active);
  let passwordChanged = false;
  if(req.body?.password !== undefined){if(typeof req.body.password!=="string"||req.body.password.length<10)return res.status(400).json({error:"New password must be at least 10 characters."});const hashed=hashPassword(req.body.password);user.salt=hashed.salt;user.passwordHash=hashed.hash;passwordChanged=true;}
  writeStaff(users); for(const [token,session] of adminSessions){if(session.staffId===user.id && (!user.active || session.role!==user.role || passwordChanged))adminSessions.delete(token);} audit(req.adminSession,"staff.updated",{staffId:user.id,passwordChanged}); res.json({ok:true,staff:publicStaff(user)});
});
app.get("/api/admin/audit", requireAdmin, requirePermission("audit.view"), (_req,res) => res.json({events:readJson(AUDIT_FILE,[]).slice(0,100)}));

app.post("/api/orders/cod", (req, res) => {
  try {
    const orderData = buildOrder(req.body);
    const order = {
      id: "MC-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      ...orderData,
      paymentMethod: "COD",
      paymentStatus: "pending",
      orderStatus: "received",
      createdAt: new Date().toISOString()
    };
    saveOrder(order);
    res.status(201).json({
      ok: true,
      orderId: order.id,
      message: "Order received. The store owner must confirm supplier availability and delivery."
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Unable to create order." });
  }
});

app.post("/api/payments/razorpay/order", async (req, res) => {
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: "Online payments are not configured yet. Add Razorpay keys to .env." });
    }

    const orderData = buildOrder(req.body);
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    const receipt = "mc_" + crypto.randomBytes(8).toString("hex");
    const rpOrder = await razorpay.orders.create({
      amount: orderData.total * 100,
      currency: "INR",
      receipt,
      notes: { store: "ModeCraft", customer_email: orderData.customer.email }
    });

    // Pending record: never mark as paid until signature/payment is verified server-side.
    saveOrder({
      id: receipt,
      razorpayOrderId: rpOrder.id,
      ...orderData,
      paymentMethod: "Razorpay",
      paymentStatus: "created",
      orderStatus: "awaiting_payment",
      createdAt: new Date().toISOString()
    });

    res.status(201).json({
      keyId: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: rpOrder.id,
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      storeName: "ModeCraft",
      customer: {
        name: orderData.customer.name,
        email: orderData.customer.email,
        phone: orderData.customer.phone
      }
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not create payment order." });
  }
});

app.post("/api/payments/razorpay/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      return res.status(400).json({ error: "Missing payment details or server configuration." });
    }

    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (!safeEqual(razorpay_signature, expected)) {
      return res.status(400).json({ error: "Payment signature verification failed." });
    }

    const orders = readOrders();
    const match = orders.find(o => o.razorpayOrderId === razorpay_order_id);
    if (!match) return res.status(404).json({ error: "Order not found." });

    match.paymentId = razorpay_payment_id;
    match.paymentStatus = "paid";
    match.orderStatus = "received";
    match.paidAt = new Date().toISOString();
    writeOrders(orders);

    res.json({
      ok: true,
      orderId: match.id,
      message: "Payment verified. The store owner must confirm supplier availability and delivery."
    });
  } catch {
    res.status(500).json({ error: "Unable to verify payment." });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.listen(PORT, () => console.log(`ModeCraft running on port ${PORT}`));
