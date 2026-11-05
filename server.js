
require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const Razorpay = require("razorpay");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const SESSION_COOKIE = "mc_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const VALID_ORDER_STATUSES = new Set([
  "received",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "awaiting_payment"
]);

if (
  !process.env.DATABASE_URL ||
  !process.env.ADMIN_USERNAME ||
  !process.env.ADMIN_PASSWORD
) {
  console.error(
    "Missing required environment variables: DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD"
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

pool.on("error", error => {
  console.error("PostgreSQL pool error:", error.message);
});

const DEFAULT_PRODUCTS = [
  {
    id: "tee-black",
    name: "Essential Black Tee",
    category: "T-Shirts",
    price: 599,
    image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=700&q=85",
    description: "A clean everyday essential.",
    stock: 0,
    active: true
  },
  {
    id: "tee-white",
    name: "Classic White Tee",
    category: "T-Shirts",
    price: 549,
    image: "https://images.unsplash.com/photo-1503341504253-dff4815485f1?auto=format&fit=crop&w=700&q=85",
    description: "Minimal style, easy to wear.",
    stock: 0,
    active: true
  },
  {
    id: "shirt-urban",
    name: "Urban Oversized Shirt",
    category: "Shirts",
    price: 999,
    image: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=700&q=85",
    description: "Relaxed fit for everyday looks.",
    stock: 0,
    active: true
  },
  {
    id: "hoodie-minimal",
    name: "Minimal Street Hoodie",
    category: "Hoodies",
    price: 1299,
    image: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=700&q=85",
    description: "A versatile layering piece.",
    stock: 0,
    active: true
  },
  {
    id: "denim-everyday",
    name: "Everyday Denim",
    category: "Bottomwear",
    price: 1199,
    image: "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=700&q=85",
    description: "A wardrobe staple.",
    stock: 0,
    active: true
  },
  {
    id: "shirt-neutral",
    name: "Relaxed Fit Shirt",
    category: "Shirts",
    price: 899,
    image: "https://images.unsplash.com/photo-1603252109303-2751441dd157?auto=format&fit=crop&w=700&q=85",
    description: "An easy smart-casual option.",
    stock: 0,
    active: true
  },
  {
    id: "tee-neutral",
    name: "Premium Neutral Tee",
    category: "T-Shirts",
    price: 699,
    image: "https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?auto=format&fit=crop&w=700&q=85",
    description: "Soft-looking, understated style.",
    stock: 0,
    active: true
  },
  {
    id: "trousers-modern",
    name: "Modern Casual Trousers",
    category: "Bottomwear",
    price: 1099,
    image: "https://images.unsplash.com/photo-1473966968600-fa801b869a1a?auto=format&fit=crop&w=700&q=85",
    description: "Everyday comfort with a clean silhouette.",
    stock: 0,
    active: true
  }
];

const PERMISSION_CATALOG = [
  { id: "dashboard.view", label: "View dashboard" },
  { id: "orders.view", label: "View orders" },
  { id: "orders.update", label: "Update order status" },
  { id: "orders.cancel", label: "Cancel orders" },
  { id: "orders.payment.receive", label: "Record COD payment received" },
  { id: "products.view", label: "View products" },
  { id: "products.manage", label: "Create, edit, disable and delete products" },
  { id: "customers.view", label: "View customer profiles and order history" },
  { id: "analytics.view", label: "View analytics" },
  { id: "audit.view", label: "View activity log" }
];
const GRANTABLE_PERMISSIONS = new Set(PERMISSION_CATALOG.map(item => item.id));
const ROLE_PERMISSIONS = {
  owner: [...PERMISSION_CATALOG.map(item => item.id), "staff.manage"],
  manager: ["dashboard.view", "orders.view", "orders.update", "orders.cancel", "orders.payment.receive", "products.view", "products.manage", "analytics.view", "audit.view"],
  staff: ["dashboard.view", "orders.view", "orders.update", "orders.payment.receive", "products.view"]
};
const OWNER_ONLY_ROUTES = new Set(["offers.manage", "coupons.manage", "staff.manage"]);
function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === "owner") return ROLE_PERMISSIONS.owner;
  const saved = Array.isArray(user.permissions) ? user.permissions : ROLE_PERMISSIONS[user.role] || [];
  return [...new Set(saved.filter(permission => GRANTABLE_PERMISSIONS.has(permission)))];
}
function validatePermissions(value) {
  if (!Array.isArray(value)) return null;
  if (value.some(permission => typeof permission !== "string" || !GRANTABLE_PERMISSIONS.has(permission))) return null;
  return [...new Set(value)];
}

function cleanText(value, max = 300) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  return aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString("hex")
  };
}

function verifyPassword(password, salt, hash) {
  try {
    return safeEqual(
      crypto.scryptSync(password, salt, 64).toString("hex"),
      hash
    );
  } catch {
    return false;
  }
}

function publicStaff(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    permissions: effectivePermissions(user),
    createdAt: user.createdAt
  };
}
function can(user, permission) {
  if (!user) return false;
  if (user.role === "owner") return true;
  if (OWNER_ONLY_ROUTES.has(permission)) return false;
  return effectivePermissions(user).includes(permission);
}
function requireOwner(req, res, next) {
  if (!(req.session?.admin || req.adminSession) || (req.session?.admin || req.adminSession).role !== "owner") {
    return res.status(403).json({ error: "Only the store owner can perform this action." });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: "Please sign in again." });
  }
  const sessionUser = req.session.admin;
  if (sessionUser.role === "owner" && safeEqual(sessionUser.username, process.env.ADMIN_USERNAME)) {
    req.adminSession = sessionUser;
    return next();
  }
  if (!sessionUser.staffId) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Please sign in again." });
  }
  getStaff().then(users => {
    const user = users.find(item => item.id === sessionUser.staffId);
    if (!user || !user.active) {
      return req.session.destroy(() => res.status(401).json({ error: "This staff account is disabled. Please sign in again." }));
    }
    sessionUser.username = user.username;
    sessionUser.displayName = user.displayName;
    sessionUser.role = user.role;
    sessionUser.permissions = effectivePermissions(user);
    req.adminSession = sessionUser;
    next();
  }).catch(next);
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.adminSession, permission)) {
      return res.status(403).json({
        error: "Your role does not have permission for this action."
      });
    }

    next();
  };
}

async function audit(actor, action, details = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs
       (actor, role, action, details, created_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())`,
      [
        actor?.username || "system",
        actor?.role || "system",
        action,
        JSON.stringify(details)
      ]
    );
  } catch (error) {
    console.error("Audit logging failed:", error.message);
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inventory_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      sku TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (product_id, color, size)
    );

    CREATE INDEX IF NOT EXISTS inventory_variants_product_idx
      ON inventory_variants (product_id, color, size);

    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales_banners (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sales_banners_display_idx
      ON sales_banners (active, sort_order, created_at DESC);

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_reviews (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, customer_id)
    );

    ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_enabled BOOLEAN NOT NULL DEFAULT TRUE;

    CREATE INDEX IF NOT EXISTS product_reviews_product_idx
      ON product_reviews (product_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS customer_wishlist (
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (customer_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS stock_notifications (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(customer_id, product_id, color, size)
    );
    CREATE INDEX IF NOT EXISTS stock_notifications_variant_idx
      ON stock_notifications (product_id, LOWER(color), LOWER(size));

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unsubscribed')),
      consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'storefront',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS newsletter_subscribers_status_idx
      ON newsletter_subscribers (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS password_reset_customer_idx
      ON password_reset_tokens (customer_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS user_sessions_expire_idx
      ON user_sessions (expire);
  `);

  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM products"
  );

  if (result.rows[0].count === 0) {
    for (const product of DEFAULT_PRODUCTS) {
      await pool.query(
        `INSERT INTO products (id, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [product.id, JSON.stringify(product)]
      );
    }
  }

  console.log("ModeCraft database initialized.");
}

async function getProducts() {
  const result = await pool.query(
    "SELECT data FROM products ORDER BY updated_at DESC"
  );

  return result.rows.map(row => row.data).sort((a, b) => Number(a.sortOrder ?? 999999) - Number(b.sortOrder ?? 999999));
}

async function getProduct(id) {
  const result = await pool.query(
    "SELECT data FROM products WHERE id = $1",
    [id]
  );

  return result.rows[0]?.data || null;
}

async function putProduct(product) {
  await pool.query(
    `INSERT INTO products (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [product.id, JSON.stringify(product)]
  );
}

async function getOrders() {
  const result = await pool.query(
    "SELECT data FROM orders ORDER BY created_at DESC"
  );

  return result.rows.map(row => row.data);
}

async function getOrder(id) {
  const result = await pool.query(
    "SELECT data FROM orders WHERE id = $1",
    [String(id)]
  );

  return result.rows[0]?.data || null;
}

async function ensureCustomerRecord(customer) {
  const name = cleanText(customer?.name, 120);
  const email = cleanText(customer?.email, 254).toLowerCase();
  const phone = cleanText(customer?.phone, 30);
  if (!name || !email || !phone) return null;
  const existing = await pool.query(
    "SELECT id FROM customers WHERE lower(email) = $1 OR phone = $2 LIMIT 1",
    [email, phone]
  );
  if (existing.rowCount) {
    await pool.query(
      "UPDATE customers SET name = $1, updated_at = NOW() WHERE id = $2",
      [name, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  const id = "mc-customer-" + crypto.randomBytes(10).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.randomBytes(48).toString("hex");
  try {
    await pool.query(
      `INSERT INTO customers (id, name, email, phone, password_salt, password_hash, password_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE) ON CONFLICT DO NOTHING`,
      [id, name, email, phone, salt, hash]
    );
    const saved = await pool.query("SELECT id FROM customers WHERE lower(email)=$1 OR phone=$2 LIMIT 1", [email, phone]);
    return saved.rows[0]?.id || null;
  } catch (error) {
    console.error("Customer directory sync failed:", error.message);
    return null;
  }
}

async function putOrder(order) {
  await pool.query(
    `INSERT INTO orders (id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [String(order.id), JSON.stringify(order)]
  );
}

async function getStaff() {
  const result = await pool.query(
    "SELECT data FROM staff ORDER BY updated_at DESC"
  );

  return result.rows.map(row => row.data);
}

async function putStaff(user) {
  await pool.query(
    `INSERT INTO staff (id, username, data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       username = EXCLUDED.username,
       data = EXCLUDED.data,
       updated_at = NOW()`,
    [user.id, user.username, JSON.stringify(user)]
  );
}

async function removeStaff(id) {
  await pool.query(
    "DELETE FROM staff WHERE id = $1",
    [id]
  );
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const allowed = (process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  const origin = req.headers.origin;

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Razorpay-Signature"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS"
    );
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Razorpay webhook requires the unparsed request body.
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
      return res.status(503).send(
        "Webhook secret is not configured."
      );
    }

    const signature = req.get("X-Razorpay-Signature") || "";
    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (!safeEqual(signature, expected)) {
      return res.status(400).send("Invalid signature.");
    }

    let event;

    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON.");
    }

    console.log("Verified Razorpay webhook:", event.event);

    // This verifies the webhook only. It does not update order status.
    return res.json({ received: true });
  }
);

app.use(express.json({ limit: "100kb" }));

app.use(
  session({
    name: SESSION_COOKIE,
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
      ttl: Math.floor(SESSION_TTL_MS / 1000)
    }),
    secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS
    }
  })
);

app.use(express.static(path.join(ROOT, "public")));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: "connected"
    });
  } catch {
    res.status(503).json({
      ok: false,
      database: "unavailable"
    });
  }
});

// Customer authentication and reviews. Customer sessions are kept separate from admin sessions.
function publicCustomer(row) {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, createdAt: row.created_at };
}

function requireCustomer(req, res, next) {
  if (!req.session?.customer?.id) {
    return res.status(401).json({ error: "Please sign in to continue." });
  }
  next();
}

const customerLoginAttempts = new Map();

app.post("/api/auth/signup", async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 100);
    const email = cleanText(req.body?.email, 180).toLowerCase();
    const phone = cleanText(req.body?.phone, 10);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{10}$/.test(phone) || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: "Enter your name, valid email, 10-digit phone number and a password of at least 8 characters." });
    }
    const existing = await pool.query("SELECT id, email, phone, password_enabled FROM customers WHERE lower(email) = $1 OR phone = $2 LIMIT 1", [email, phone]);
    const { salt, hash } = hashPassword(password);
    let result;
    if (existing.rowCount) {
      const guest = existing.rows[0];
      if (guest.password_enabled !== false || String(guest.email).toLowerCase() !== email || String(guest.phone) !== phone) return res.status(409).json({ error: "An account already exists with this email or phone number." });
      result = await pool.query(
        `UPDATE customers SET name=$1, password_salt=$2, password_hash=$3, password_enabled=TRUE, updated_at=NOW()
         WHERE id=$4 RETURNING id, name, email, phone, created_at`,
        [name, salt, hash, guest.id]
      );
    } else {
      const id = "cus_" + crypto.randomBytes(12).toString("hex");
      result = await pool.query(
        `INSERT INTO customers (id, name, email, phone, password_salt, password_hash, password_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id, name, email, phone, created_at`,
        [id, name, email, phone, salt, hash]
      );
    }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.customer = { id: result.rows[0].id };
      req.session.save(saveError => {
        if (saveError) return next(saveError);
        res.status(201).json({ ok: true, user: publicCustomer(result.rows[0]) });
      });
    });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account already exists with this email or phone number." });
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = cleanText(req.body?.email, 180).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let attempt = customerLoginAttempts.get(ip);
    if (attempt && now - attempt.startedAt < 15 * 60 * 1000 && attempt.count >= 10) {
      return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes." });
    }
    if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
      attempt = { startedAt: now, count: 0 };
      customerLoginAttempts.set(ip, attempt);
    }
    const result = await pool.query("SELECT id, name, email, phone, password_salt, password_hash, password_enabled, created_at FROM customers WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || user.password_enabled === false || !verifyPassword(password, user.password_salt, user.password_hash)) {
      attempt.count += 1;
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    customerLoginAttempts.delete(ip);
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.customer = { id: user.id };
      req.session.save(saveError => {
        if (saveError) return next(saveError);
        res.json({ ok: true, user: publicCustomer(user) });
      });
    });
  } catch (error) { next(error); }
});

app.get("/api/auth/me", async (req, res, next) => {
  try {
    if (!req.session?.customer?.id) return res.json({ authenticated: false, user: null });
    const result = await pool.query("SELECT id, name, email, phone, created_at FROM customers WHERE id = $1", [req.session.customer.id]);
    if (!result.rowCount) return res.json({ authenticated: false, user: null });
    res.json({ authenticated: true, user: publicCustomer(result.rows[0]) });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", (req, res, next) => {
  // Only clear the customer identity; preserve an admin identity if the same browser has one.
  if (req.session) delete req.session.customer;
  if (!req.session) return res.json({ ok: true });
  req.session.save(error => error ? next(error) : res.json({ ok: true }));
});

app.post("/api/auth/forgot-password", async (req, res, next) => {
  try {
    const email = cleanText(req.body?.email, 180).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    // Keep the response generic so account existence is not disclosed.
    const found = await pool.query("SELECT id FROM customers WHERE email = $1", [email]);
    if (found.rowCount) {
      const resendApiKey = process.env.RESEND_API_KEY;
      const smtpUser = (process.env.GMAIL_USER || process.env.SMTP_USER || process.env.EMAIL_USER || "").trim();
      const smtpPassword = String(process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || process.env.EMAIL_PASS || "").replace(/\s+/g, "");
      const fromEmail = (process.env.PASSWORD_RESET_FROM || (smtpUser ? `ModeCraft <${smtpUser}>` : "ModeCraft <onboarding@resend.dev>")).trim();
      const baseUrl = process.env.PASSWORD_RESET_BASE_URL;
      const smtpConfigured = Boolean(smtpUser && smtpPassword);

      if (!smtpConfigured && !resendApiKey) {
        console.error("Password reset email not configured: set GMAIL_USER + GMAIL_APP_PASSWORD (or SMTP_USER + SMTP_PASS), or RESEND_API_KEY in Render.");
        return res.status(503).json({ error: "Password reset email is not configured. Add Gmail SMTP credentials or a Resend API key in Render." });
      }

      // Normalize and validate the reset URL before creating a token in the database.
      const cleanBaseUrl = typeof baseUrl === "string"
        ? baseUrl.trim().replace(/^([\"'])(.*)\1$/, "$2").trim()
        : "";
      let resetUrl;
      try {
        const candidate = cleanBaseUrl || process.env.RENDER_EXTERNAL_URL || "https://modecraft-india.onrender.com";
        resetUrl = new URL(candidate);
        if (resetUrl.protocol !== "https:" && resetUrl.protocol !== "http:") {
          throw new TypeError("Password reset URL must use http:// or https://");
        }
      } catch (urlError) {
        console.error("Invalid PASSWORD_RESET_BASE_URL; using the ModeCraft Render URL. Check the Render environment variable.");
        resetUrl = new URL(process.env.RENDER_EXTERNAL_URL || "https://modecraft-india.onrender.com");
      }

      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      await pool.query("DELETE FROM password_reset_tokens WHERE customer_id = $1", [found.rows[0].id]);
      await pool.query(
        "INSERT INTO password_reset_tokens (token_hash, customer_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
        [tokenHash, found.rows[0].id]
      );

      resetUrl.searchParams.set("token", rawToken);
      const subject = "Reset your ModeCraft password";
      const textBody = `We received a request to reset your ModeCraft password. Open this link within 30 minutes: ${resetUrl.toString()}\n\nIf you did not request this, ignore this email.`;
      const htmlBody = `<p>We received a request to reset your ModeCraft password.</p><p><a href="${resetUrl.toString()}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>`;
      try {
        if (smtpConfigured) {
          const smtpPort = Number(process.env.SMTP_PORT || 465);
          const smtpSecure = process.env.SMTP_SECURE === undefined
            ? smtpPort === 465
            : String(process.env.SMTP_SECURE).toLowerCase() === "true";
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: smtpPort,
            secure: smtpSecure,
            auth: { user: smtpUser, pass: smtpPassword }
          });
          await transporter.sendMail({ from: fromEmail, to: email, subject, text: textBody, html: htmlBody });
          transporter.close();
          console.log("Password reset email accepted by SMTP provider.");
        } else {
          const emailResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: fromEmail, to: [email], subject, text: textBody, html: htmlBody })
          });
          const emailResult = await emailResponse.json().catch(() => ({}));
          if (!emailResponse.ok) throw new Error(`Resend API returned ${emailResponse.status}: ${emailResult.message || emailResult.name || "email delivery request failed"}`);
          console.log("Password reset email accepted by Resend.");
        }
      } catch (mailError) {
        await pool.query("DELETE FROM password_reset_tokens WHERE token_hash = $1", [tokenHash]);
        console.error("Password reset email delivery failed:", mailError.message);
        return res.status(502).json({ error: "Password reset email could not be sent. Check Gmail SMTP credentials/app password or Resend sender settings in Render." });
      }
    }

    res.json({ ok: true, message: "If an account exists for that email and email delivery is configured, a password reset link will be sent." });
  } catch (error) { next(error); }
});

app.post("/api/auth/reset-password", async (req, res, next) => {
  let client;
  try {
    const token = cleanText(req.body?.token, 200);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: "Provide a valid reset token and a password of at least 8 characters." });
    }
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { salt, hash } = hashPassword(password);
    // A transaction must use one checked-out PostgreSQL connection. Using pool.query
    // for BEGIN/UPDATE/COMMIT can run each statement on a different connection.
    // Locking the token row also prevents two requests consuming the same link.
    client = await pool.connect();
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT customer_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE",
      [tokenHash]
    );
    if (!found.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This reset link is invalid or has expired." });
    }
    const customerId = found.rows[0].customer_id;
    const updated = await client.query(
      "UPDATE customers SET password_salt = $1, password_hash = $2, updated_at = NOW() WHERE id = $3",
      [salt, hash, customerId]
    );
    if (!updated.rowCount) throw new Error("The customer account for this reset link no longer exists.");
    await client.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1", [tokenHash]);
    await client.query("DELETE FROM password_reset_tokens WHERE customer_id = $1 AND token_hash <> $2", [customerId, tokenHash]);
    await client.query("COMMIT");
    res.json({ ok: true, message: "Password updated. You can now sign in." });
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    next(error);
  } finally {
    if (client) client.release();
  }
});

app.get("/api/orders/my", requireCustomer, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT data FROM orders
       WHERE lower(data->'customer'->>'email') = (SELECT lower(email) FROM customers WHERE id = $1)
       ORDER BY created_at DESC LIMIT 100`, [req.session.customer.id]
    );
    res.json({ orders: result.rows.map(row => row.data) });
  } catch (error) { next(error); }
});

app.get("/api/orders/track", async (req, res, next) => {
  try {
    const orderId = cleanText(req.query?.orderId, 100);
    const phone = cleanText(req.query?.phone, 10);
    if (!orderId || !/^\d{10}$/.test(phone)) return res.status(400).json({ error: "Enter the order ID and the 10-digit phone number used at checkout." });
    const order = await getOrder(orderId);
    if (!order || order.customer?.phone !== phone) return res.status(404).json({ error: "No order found for those details." });
    res.set("Cache-Control", "no-store, max-age=0");
    res.json({ order: { id: order.id, orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, createdAt: order.createdAt, statusHistory: order.statusHistory || [], items: order.items } });
  } catch (error) { next(error); }
});

app.get("/api/products/:id/reviews", async (req, res, next) => {
  try {
    const product = await getProduct(cleanText(req.params.id, 150));
    if (!product) return res.status(404).json({ error: "Product not found." });
    const [reviewsResult, summaryResult] = await Promise.all([
      pool.query(
        `SELECT pr.id, pr.customer_name AS "customerName", pr.rating, pr.title,
                pr.comment, pr.created_at AS "createdAt",
                EXISTS (
                  SELECT 1
                  FROM customers c
                  JOIN orders o
                    ON lower(o.data->'customer'->>'email') = lower(c.email)
                  WHERE c.id = pr.customer_id
                    AND COALESCE(o.data->>'orderStatus', '') <> 'cancelled'
                    AND (
                      o.data->>'paymentStatus' = 'paid'
                      OR o.data->>'paymentMethod' = 'COD'
                    )
                    AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(
                        CASE
                          WHEN jsonb_typeof(o.data->'items') = 'array' THEN o.data->'items'
                          ELSE '[]'::jsonb
                        END
                      ) AS order_items(item)
                      WHERE order_items.item->>'id' = pr.product_id
                    )
                ) AS "verifiedPurchase"
         FROM product_reviews pr
         WHERE pr.product_id = $1
         ORDER BY pr.created_at DESC
         LIMIT 200`,
        [product.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS average
         FROM product_reviews WHERE product_id = $1`,
        [product.id]
      )
    ]);
    res.set("Cache-Control", "no-store, max-age=0");
    res.json({ reviews: reviewsResult.rows, summary: summaryResult.rows[0] || { count: 0, average: 0 } });
  } catch (error) { next(error); }
});

app.post("/api/products/:id/reviews", requireCustomer, async (req, res, next) => {
  try {
    const product = await getProduct(cleanText(req.params.id, 150));
    if (!product) return res.status(404).json({ error: "Product not found." });
    const rating = Number(req.body?.rating);
    const title = cleanText(req.body?.title, 120);
    const comment = cleanText(req.body?.comment, 1500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length < 3) {
      return res.status(400).json({ error: "Choose a rating from 1 to 5 and write a review of at least 3 characters." });
    }
    const customerResult = await pool.query("SELECT id, name FROM customers WHERE id = $1", [req.session.customer.id]);
    if (!customerResult.rowCount) return res.status(401).json({ error: "Please sign in again." });
    const customer = customerResult.rows[0];
    const id = "rev_" + crypto.randomBytes(10).toString("hex");
    const result = await pool.query(
      `INSERT INTO product_reviews (id, product_id, customer_id, customer_name, rating, title, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, customer_id) DO UPDATE SET
         rating = EXCLUDED.rating, title = EXCLUDED.title, comment = EXCLUDED.comment, created_at = NOW()
       RETURNING id, customer_name AS "customerName", rating, title, comment, created_at AS "createdAt"`,
      [id, product.id, customer.id, customer.name, rating, title, comment]
    );
    res.status(201).json({ ok: true, review: result.rows[0] });
  } catch (error) { next(error); }
});

app.post("/api/products/:id/stock-notifications", requireCustomer, async (req, res, next) => {
  try {
    const productId = cleanText(req.params.id, 120);
    const color = cleanText(req.body?.color, 50).replace(/\s+/g, " ");
    const size = cleanText(req.body?.size, 30).replace(/\s+/g, " ");
    if (!productId || !color || !size) return res.status(400).json({ error: "Choose a colour and size first." });
    const product = await getProduct(productId);
    if (!product) return res.status(404).json({ error: "Product not found." });
    const variant = await pool.query(
      `SELECT quantity FROM inventory_variants WHERE product_id=$1 AND LOWER(color)=LOWER($2) AND LOWER(size)=LOWER($3) LIMIT 1`,
      [productId, color, size]
    );
    if (!variant.rowCount) return res.status(400).json({ error: "This colour and size combination is not configured for stock alerts." });
    if (Number(variant.rows[0].quantity) > 0) return res.status(409).json({ error: "This size is already in stock. Please refresh the product and order normally." });
    await pool.query(
      `INSERT INTO stock_notifications (customer_id, product_id, color, size)
       VALUES ($1,$2,$3,$4) ON CONFLICT (customer_id, product_id, color, size) DO NOTHING`,
      [req.session.customer.id, productId, color, size]
    );
    res.status(201).json({ ok: true, message: "We’ll email you when this colour and size is back in stock." });
  } catch (error) { next(error); }
});

app.get("/api/wishlist", requireCustomer, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.data, w.created_at AS "addedAt"
       FROM customer_wishlist w JOIN products p ON p.id = w.product_id
       WHERE w.customer_id = $1 ORDER BY w.created_at DESC`,
      [req.session.customer.id]
    );
    res.json({ wishlist: result.rows.map(row => ({ ...row.data, addedAt: row.addedAt })) });
  } catch (error) { next(error); }
});

app.post("/api/wishlist/:productId", requireCustomer, async (req, res, next) => {
  try {
    const product = await getProduct(cleanText(req.params.productId, 150));
    if (!product || product.active === false) return res.status(404).json({ error: "Product not found." });
    await pool.query(
      "INSERT INTO customer_wishlist (customer_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [req.session.customer.id, product.id]
    );
    res.status(201).json({ ok: true, productId: product.id });
  } catch (error) { next(error); }
});

app.delete("/api/wishlist/:productId", requireCustomer, async (req, res, next) => {
  try {
    await pool.query("DELETE FROM customer_wishlist WHERE customer_id = $1 AND product_id = $2", [req.session.customer.id, cleanText(req.params.productId, 150)]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/products", async (_req, res, next) => {
  try {
    // Product data is the source of truth for the storefront. Inventory is
    // supplemental: a stock-table read problem must never blank the catalogue.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const products = await getProducts();
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

    res.json({
      products: activeProducts.map(product => ({
        ...product,
        colorVariants: safeLinksByParent.get(String(product.id)) || {},
        isColorVariantChild: claimedChildren.has(String(product.id)),
        inventoryVariants: inventoryByProduct.get(String(product.id)) || []
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/config", (_req, res) => {
  res.json({
    razorpayEnabled: Boolean(
      process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET
    ),
    keyId: process.env.RAZORPAY_KEY_ID || ""
  });
});

const loginAttempts = new Map();

app.get("/api/storefront/header", async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT data FROM store_settings WHERE key = $1", ["storefront_header"]);
    res.json({ header: result.rows[0]?.data || {} });
  } catch (error) { next(error); }
});

const newsletterAttempts = new Map();
app.post("/api/storefront/newsletter", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: "Please confirm consent to receive updates." });
    }
    const now = Date.now();
    const ip = String(req.ip || "unknown");
    const previous = newsletterAttempts.get(ip) || { count: 0, startedAt: now };
    if (now - previous.startedAt > 15 * 60 * 1000) {
      previous.count = 0;
      previous.startedAt = now;
    }
    previous.count += 1;
    newsletterAttempts.set(ip, previous);
    if (previous.count > 5) {
      return res.status(429).json({ error: "Too many subscription attempts. Please try again later." });
    }
    if (newsletterAttempts.size > 5000) {
      for (const [key, value] of newsletterAttempts) {
        if (now - value.startedAt > 15 * 60 * 1000) newsletterAttempts.delete(key);
      }
    }
    await pool.query(
      `INSERT INTO newsletter_subscribers (email, status, consent_at, source, updated_at)
       VALUES ($1, 'subscribed', NOW(), 'storefront', NOW())
       ON CONFLICT (email) DO UPDATE SET status = 'subscribed', consent_at = NOW(), updated_at = NOW()`,
      [email]
    );
    res.json({ ok: true, message: "You're on the ModeCraft update list. Thank you for subscribing." });
  } catch (error) { next(error); }
});

app.get("/api/admin/newsletter/subscribers", requireAdmin, requireOwner, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT email, status, consent_at AS "consentAt", created_at AS "createdAt" FROM newsletter_subscribers ORDER BY created_at DESC LIMIT 5000`
    );
    res.json({ subscribers: result.rows });
  } catch (error) { next(error); }
});

app.get("/api/admin/storefront/header", requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT data FROM store_settings WHERE key = $1", ["storefront_header"]);
    res.json({ header: result.rows[0]?.data || {} });
  } catch (error) { next(error); }
});

app.put("/api/admin/storefront/header", requireAdmin, requireOwner, async (req, res, next) => {
  try {
    const input = req.body || {};
    const header = {
      announcement: cleanText(input.announcement, 180),
      brandText: cleanText(input.brandText, 60) || "MODECRAFT",
      tagline: cleanText(input.tagline, 100) || "Wear Your Identity.",
      logoUrl: typeof input.logoUrl === "string" && /^https:\/\//i.test(input.logoUrl.trim()) ? input.logoUrl.trim().slice(0, 1500) : "",
      showAnnouncement: input.showAnnouncement !== false,
      showTagline: input.showTagline !== false
    };
    await pool.query(`INSERT INTO store_settings (key, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, ["storefront_header", JSON.stringify(header)]);
    await audit(req.session.admin, "storefront.header.update", { brandText: header.brandText });
    res.json({ ok: true, header });
  } catch (error) { next(error); }
});

// Promotional banners are editable by the owner and publicly readable on the storefront.
app.get("/api/storefront/banners", async (_req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, data, sort_order, active FROM sales_banners WHERE active = TRUE ORDER BY sort_order ASC, created_at DESC"
    );
    res.json({ banners: result.rows.map(row => ({ id: row.id, ...row.data, sortOrder: row.sort_order, active: row.active })) });
  } catch (error) { next(error); }
});

app.get("/api/admin/banners", requireAdmin, requireOwner, async (_req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, data, sort_order, active, created_at, updated_at FROM sales_banners ORDER BY sort_order ASC, created_at DESC"
    );
    res.json({ banners: result.rows.map(row => ({ id: row.id, ...row.data, sortOrder: row.sort_order, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })) });
  } catch (error) { next(error); }
});

function cleanBanner(input = {}) {
  const title = cleanText(input.title, 100);
  const subtitle = cleanText(input.subtitle, 220);
  const imageUrl = typeof input.imageUrl === "string" && /^https:\/\//i.test(input.imageUrl.trim()) ? input.imageUrl.trim().slice(0, 1800) : "";
  const buttonText = cleanText(input.buttonText, 40);
  const buttonUrl = cleanText(input.buttonUrl, 500);
  const sortOrder = Number(input.sortOrder ?? 0);
  if (!title || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) {
    const error = new Error("Enter a banner title and a valid display order."); error.status = 400; throw error;
  }
  if (buttonUrl && !(/^(https:\/\/|\/|#)/i.test(buttonUrl))) {
    const error = new Error("Banner button link must be HTTPS or a local path."); error.status = 400; throw error;
  }
  return { data: { title, subtitle, imageUrl, buttonText, buttonUrl }, sortOrder, active: input.active !== false };
}

app.post("/api/admin/banners", requireAdmin, requireOwner, async (req, res, next) => {
  try {
    const banner = cleanBanner(req.body);
    const id = "banner_" + crypto.randomBytes(9).toString("hex");
    const result = await pool.query(
      "INSERT INTO sales_banners (id, data, sort_order, active) VALUES ($1, $2::jsonb, $3, $4) RETURNING id, data, sort_order, active, created_at, updated_at",
      [id, JSON.stringify(banner.data), banner.sortOrder, banner.active]
    );
    await audit(req.session.admin, "sales_banner.created", { bannerId: id, title: banner.data.title });
    const row = result.rows[0]; res.status(201).json({ ok: true, banner: { id: row.id, ...row.data, sortOrder: row.sort_order, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at } });
  } catch (error) { next(error); }
});

app.patch("/api/admin/banners/:id", requireAdmin, requireOwner, async (req, res, next) => {
  try {
    const existing = await pool.query("SELECT data, sort_order, active FROM sales_banners WHERE id = $1", [req.params.id]);
    if (!existing.rowCount) return res.status(404).json({ error: "Banner not found." });
    const input = { ...existing.rows[0].data, sortOrder: existing.rows[0].sort_order, active: existing.rows[0].active, ...(req.body || {}) };
    const banner = cleanBanner(input);
    const result = await pool.query(
      "UPDATE sales_banners SET data=$1::jsonb, sort_order=$2, active=$3, updated_at=NOW() WHERE id=$4 RETURNING id, data, sort_order, active, created_at, updated_at",
      [JSON.stringify(banner.data), banner.sortOrder, banner.active, req.params.id]
    );
    await audit(req.session.admin, "sales_banner.updated", { bannerId: req.params.id, title: banner.data.title });
    const row = result.rows[0]; res.json({ ok: true, banner: { id: row.id, ...row.data, sortOrder: row.sort_order, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at } });
  } catch (error) { next(error); }
});

app.delete("/api/admin/banners/:id", requireAdmin, requireOwner, async (req, res, next) => {
  try {
    const result = await pool.query("DELETE FROM sales_banners WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Banner not found." });
    await audit(req.session.admin, "sales_banner.deleted", { bannerId: req.params.id });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/admin/login", async (req, res, next) => {
  try {
    const username = cleanText(req.body?.username, 100);
    const password = typeof req.body?.password === "string"
      ? req.body.password
      : "";

    if (!username || !password) {
      return res.status(400).json({
        error: "Enter username and password."
      });
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let attempt = loginAttempts.get(ip);

    if (
      attempt &&
      now - attempt.startedAt < 15 * 60 * 1000 &&
      attempt.count >= 10
    ) {
      return res.status(429).json({
        error: "Too many login attempts. Please wait 15 minutes."
      });
    }

    if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
      attempt = { startedAt: now, count: 0 };
      loginAttempts.set(ip, attempt);
    }

    let account = null;

    if (
      safeEqual(username, process.env.ADMIN_USERNAME) &&
      safeEqual(password, process.env.ADMIN_PASSWORD)
    ) {
      account = {
        username: process.env.ADMIN_USERNAME,
        displayName: "Founder & CEO",
        role: "owner",
        active: true
      };
    } else {
      const users = await getStaff();
      const user = users.find(
        item => item.username.toLowerCase() === username.toLowerCase()
      );

      if (
        user &&
        user.active &&
        verifyPassword(password, user.salt, user.passwordHash)
      ) {
        account = {
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          staffId: user.id,
          permissions: effectivePermissions(user),
          active: true
        };
      }
    }

    if (!account) {
      attempt.count += 1;

      return res.status(401).json({
        error: "Incorrect username or password, or account disabled."
      });
    }

    loginAttempts.delete(ip);

    req.session.regenerate(error => {
      if (error) return next(error);

      req.session.admin = account;

      req.session.save(async saveError => {
        if (saveError) return next(saveError);

        await audit(account, "login");

        res.json({
          ok: true,
          user: {
            username: account.username,
            displayName: account.displayName,
            role: account.role
          }
        });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  const user = req.adminSession;
  res.json({
    authenticated: true,
    role: user.role,
    username: user.username,
    displayName: user.displayName,
    isOwner: user.role === "owner",
    permissions: effectivePermissions(user)
  });
});

app.post("/api/admin/logout", async (req, res, next) => {
  const user = req.session?.admin;

  if (user) await audit(user, "logout");

  req.session.destroy(error => {
    res.clearCookie(SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    if (error) return next(error);

    res.json({ ok: true });
  });
});

app.get(
  "/api/admin/orders",
  requireAdmin,
  requirePermission("orders.view"),
  async (req, res, next) => {
    try {
      const orders = await getOrders();
      const includeArchived = req.query?.includeArchived === "true";
      const visibleOrders = (includeArchived ? orders : orders.filter(order => !order.archivedAt))
        .map(order => req.adminSession?.role === "owner" ? order : ({
            ...order,
            customer: order.customer ? { name: order.customer.name || "Customer", email: "", phone: "", address: "", city: "", postalCode: "" } : order.customer
          }));
      res.json({ orders: visibleOrders });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/customers",
  requireAdmin,
  requirePermission("customers.view"),
  async (_req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT id, name, email, phone, created_at FROM customers ORDER BY created_at DESC LIMIT 1000"
      );
      const orders = await getOrders();
      // Backfill older guest checkouts into the persistent directory when the owner opens it.
      for (const order of orders) {
        if (!order.archivedAt && order.customer?.email && order.customer?.phone) await ensureCustomerRecord(order.customer);
      }
      const refreshed = await pool.query("SELECT id, name, email, phone, created_at FROM customers ORDER BY created_at DESC LIMIT 1000");
      const customers = refreshed.rows.map(row => {
        const history = orders.filter(order =>
          String(order.customer?.email || "").toLowerCase() === String(row.email || "").toLowerCase() ||
          String(order.customer?.phone || "") === String(row.phone || "")
        ).map(order => ({
          id: order.id,
          createdAt: order.createdAt,
          total: Number(order.total || 0),
          paymentMethod: order.paymentMethod || "—",
          paymentStatus: order.paymentStatus || "pending",
          orderStatus: order.orderStatus || "received",
          address: order.customer?.address || "",
          city: order.customer?.city || "",
          postalCode: order.customer?.postalCode || "",
          items: Array.isArray(order.items) ? order.items : []
        }));
        return {
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone,
          createdAt: row.created_at,
          orderCount: history.length,
          totalSpent: history.filter(o => o.paymentStatus === "paid").reduce((sum, o) => sum + Number(o.total || 0), 0),
          orders: history
        };
      });
      res.json({ customers });
    } catch (error) {
      next(error);
    }
  }
);


app.patch("/api/admin/orders/:id/archive", requireAdmin, requireOwner, async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    const restore = req.body?.restore === true;
    if (restore) { delete order.archivedAt; delete order.archivedBy; }
    else { order.archivedAt = new Date().toISOString(); order.archivedBy = req.adminSession.username; }
    order.updatedAt = new Date().toISOString();
    await putOrder(order);
    await audit(req.adminSession, restore ? "order.restored" : "order.archived", { orderId: order.id });
    res.json({ ok: true, order });
  } catch (error) { next(error); }
});

app.patch(
  "/api/admin/orders/:id",
  requireAdmin,
  requirePermission("orders.update"),
  async (req, res, next) => {
    try {
      const status = cleanText(req.body?.orderStatus, 40);
      const reason = cleanText(req.body?.cancellationReason, 300);

      if (!VALID_ORDER_STATUSES.has(status)) {
        return res.status(400).json({ error: "Invalid order status." });
      }

      if (
        status === "cancelled" &&
        !can(req.adminSession, "orders.cancel")
      ) {
        return res.status(403).json({
          error: "Only owners and managers can cancel orders."
        });
      }

      if (status === "cancelled" && !reason) {
        return res.status(400).json({
          error: "Enter a cancellation reason."
        });
      }

      const order = await getOrder(req.params.id);

      if (!order) {
        return res.status(404).json({ error: "Order not found." });
      }

      if (
        ["delivered", "cancelled"].includes(order.orderStatus) &&
        status !== order.orderStatus
      ) {
        return res.status(409).json({
          error: "Delivered or cancelled orders cannot be reopened."
        });
      }

      if (!Array.isArray(order.statusHistory)) {
        order.statusHistory = [];
      }

      order.statusHistory.push({
        status,
        reason: status === "cancelled" ? reason : "",
        by: req.adminSession.username,
        at: new Date().toISOString()
      });

      order.orderStatus = status;
      if (status === "cancelled") order.cancellationReason = reason;
      order.updatedAt = new Date().toISOString();

      await putOrder(order);

      await audit(req.adminSession, "order.status.updated", {
        orderId: order.id,
        status
      });

      const responseOrder = req.adminSession.role === "owner" ? order : {
        ...order,
        customer: order.customer ? { name: order.customer.name || "Customer", email: "", phone: "", address: "", city: "", postalCode: "" } : order.customer
      };
      res.json({ ok: true, order: responseOrder });
    } catch (error) {
      next(error);
    }
  }
);

app.patch(
  "/api/admin/orders/:id/payment",
  requireAdmin,
  requirePermission("orders.payment.receive"),
  async (req, res, next) => {
    try {
      const order = await getOrder(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found." });
      if (String(order.paymentMethod || "").toUpperCase() !== "COD") {
        return res.status(409).json({ error: "Only COD payments can be manually marked as received. Online payments must be verified by Razorpay." });
      }
      if (order.paymentStatus === "paid") {
        return res.status(409).json({ error: "This order is already marked as paid." });
      }
      const note = cleanText(req.body?.note, 250);
      order.paymentStatus = "paid";
      order.paymentReceivedAt = new Date().toISOString();
      order.paymentReceivedBy = req.adminSession.username;
      order.paymentReceivedRole = req.adminSession.role;
      order.paymentReceivedNote = note;
      order.updatedAt = new Date().toISOString();
      if (!Array.isArray(order.paymentHistory)) order.paymentHistory = [];
      order.paymentHistory.push({
        status: "paid",
        method: "COD",
        by: req.adminSession.username,
        role: req.adminSession.role,
        note,
        at: order.paymentReceivedAt
      });
      await putOrder(order);
      await audit(req.adminSession, "order.payment.received", { orderId: order.id, method: "COD" });
      res.json({ ok: true, orderId: order.id, paymentStatus: order.paymentStatus, paymentReceivedAt: order.paymentReceivedAt, paymentReceivedBy: order.paymentReceivedBy });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/analytics",
  requireAdmin,
  requirePermission("analytics.view"),
  async (_req, res, next) => {
    try {
      const orders = await getOrders();
      const paid = orders.filter(order => order.paymentStatus === "paid");
      const active = orders.filter(
        order => !["cancelled", "delivered"].includes(order.orderStatus)
      );

      const byDay = [];

      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - i);

        const key = date.toISOString().slice(0, 10);
        const dayOrders = orders.filter(
          order => String(order.createdAt || "").slice(0, 10) === key
        );

        byDay.push({
          date: key,
          orders: dayOrders.length,
          revenue: dayOrders
            .filter(order => order.paymentStatus === "paid")
            .reduce((sum, order) => sum + Number(order.total || 0), 0)
        });
      }

      const lowStockResult = await pool.query("SELECT COUNT(*)::int AS count FROM inventory_variants WHERE quantity <= 5");
      res.json({
        lowStockVariants: lowStockResult.rows[0]?.count || 0,
        totalOrders: orders.length,
        pendingOrders: active.length,
        paidOrders: paid.length,
        cancelledOrders: orders.filter(
          order => order.orderStatus === "cancelled"
        ).length,
        paidRevenue: paid.reduce(
          (sum, order) => sum + Number(order.total || 0),
          0
        ),
        byDay
      });
    } catch (error) {
      next(error);
    }
  }
);

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

function normalizeProductFamilyValue(value) {
  return cleanText(value, 100).replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

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

app.get(
  "/api/admin/staff",
  requireAdmin,
  requireOwner,
  async (_req, res, next) => {
    try {
      res.json({ staff: (await getStaff()).map(publicStaff) });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/staff",
  requireAdmin,
  requireOwner,
  async (req, res, next) => {
    try {
      const username = cleanText(req.body?.username, 60);
      const displayName = cleanText(req.body?.displayName, 100);
      const password = typeof req.body?.password === "string"
        ? req.body.password
        : "";
      const role = req.body?.role;
      const permissions = req.body?.permissions === undefined
        ? [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.staff)]
        : validatePermissions(req.body.permissions);

      if (req.body?.permissions !== undefined && permissions === null) {
        return res.status(400).json({ error: "One or more permissions are invalid." });
      }
      if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) {
        return res.status(400).json({
          error: "Username must be 3–60 characters using letters, numbers, dots, underscores or hyphens."
        });
      }

      if (
        displayName.length < 2 ||
        password.length < 10 ||
        !["manager", "staff"].includes(role)
      ) {
        return res.status(400).json({
          error: "Provide a display name, password of at least 10 characters, and Manager or Staff role."
        });
      }

      const users = await getStaff();

      if (users.some(
        user => user.username.toLowerCase() === username.toLowerCase()
      )) {
        return res.status(409).json({
          error: "That username already exists."
        });
      }

      const hashed = hashPassword(password);

      const user = {
        id: crypto.randomUUID(),
        username,
        displayName,
        role,
        permissions,
        active: true,
        salt: hashed.salt,
        passwordHash: hashed.hash,
        createdAt: new Date().toISOString()
      };

      await putStaff(user);
      await audit(req.adminSession, "staff.created", {
        staffId: user.id,
        role
      });

      res.status(201).json({
        ok: true,
        staff: publicStaff(user)
      });
    } catch (error) {
      next(error);
    }
  }
);

app.patch(
  "/api/admin/staff/:id",
  requireAdmin,
  requireOwner,
  async (req, res, next) => {
    try {
      const users = await getStaff();
      const user = users.find(item => item.id === req.params.id);

      if (!user) {
        return res.status(404).json({
          error: "Staff account not found."
        });
      }

      if (req.body?.role !== undefined) {
        if (!["manager", "staff"].includes(req.body.role)) {
          return res.status(400).json({
            error: "Staff can only be Manager or Staff."
          });
        }

        user.role = req.body.role;
        if (!Array.isArray(user.permissions)) user.permissions = [...(ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.staff)];
      }

      if (req.body?.permissions !== undefined) {
        const permissions = validatePermissions(req.body.permissions);
        if (permissions === null) return res.status(400).json({ error: "One or more permissions are invalid." });
        user.permissions = permissions;
      }

      if (req.body?.active !== undefined) {
        user.active = Boolean(req.body.active);
      }

      let passwordChanged = false;

      if (req.body?.password !== undefined) {
        if (
          typeof req.body.password !== "string" ||
          req.body.password.length < 10
        ) {
          return res.status(400).json({
            error: "New password must be at least 10 characters."
          });
        }

        const hashed = hashPassword(req.body.password);
        user.salt = hashed.salt;
        user.passwordHash = hashed.hash;
        passwordChanged = true;
      }

      await putStaff(user);

      if (!user.active || passwordChanged) {
        await pool.query(
          `DELETE FROM user_sessions
           WHERE sess::text LIKE $1`,
          [`%${user.id}%`]
        );
      }

      await audit(req.adminSession, "staff.updated", {
        staffId: user.id,
        passwordChanged
      });

      res.json({ ok: true, staff: publicStaff(user) });
    } catch (error) {
      next(error);
    }
  }
);

app.delete(
  "/api/admin/staff/:id",
  requireAdmin,
  requireOwner,
  async (req, res, next) => {
    try {
      const users = await getStaff();
      const user = users.find(item => item.id === req.params.id);

      if (!user) {
        return res.status(404).json({
          error: "Staff account not found."
        });
      }

      await removeStaff(user.id);

      await pool.query(
        `DELETE FROM user_sessions
         WHERE sess::text LIKE $1`,
        [`%${user.id}%`]
      );

      await audit(req.adminSession, "staff.deleted", {
        staffId: user.id
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/audit",
  requireAdmin,
  requirePermission("audit.view"),
  async (_req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, actor, role, action, details, created_at AS at
         FROM audit_logs
         ORDER BY id DESC
         LIMIT 100`
      );

      res.json({ events: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

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
    const fromEmail = (process.env.PASSWORD_RESET_FROM || (smtpUser ? `ModeCraft <${smtpUser}>` : "onboarding@resend.dev")).trim();
    if (!((smtpUser && smtpPassword) || resendApiKey)) {
      console.warn("Back-in-stock subscribers are queued; configure SMTP or RESEND_API_KEY to send alerts.");
      return;
    }
    const subject = `Back in stock: ${subscribers.rows[0].product_name || "ModeCraft product"}`;
    const textBody = `${subscribers.rows[0].product_name || "Your ModeCraft product"} is back in stock in ${color}, size ${size}. Visit https://modecraft-india.onrender.com/ to shop.`;
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
        store: "ModeCraft",
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
      storeName: "ModeCraft",
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

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API endpoint not found."
    });
  }

  res.sendFile(
    path.join(ROOT, "public", "index.html"),
    error => {
      if (error) next(error);
    }
  );
});

app.use((error, _req, res, _next) => {
  console.error("Request error:", error.stack || error.message || error);

  if (res.headersSent) return;

  res.status(500).json({
    error: "Internal server error. Check Render logs."
  });
});

async function start() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`ModeCraft running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("Could not start ModeCraft:", error.message);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});
