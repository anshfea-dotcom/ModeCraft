
require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createPool } = require("./services/database");
const { cleanText, normalizeProductFamilyValue, getProducts: listProducts, readCatalogue } = require("./services/catalogue/catalogue");
const { createCatalogueClient } = require("./services/catalogue/client");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const SESSION_COOKIE = "mc_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

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

const pool = createPool(8);
const catalogue = createCatalogueClient(() => readCatalogue(pool));
const createAccessControls = require("./services/store/security");
const initDatabase = require("./services/store/schema");
const createRepository = require("./services/store/repository");
const registerCustomers = require("./services/store/customers");
const registerStorefront = require("./services/store/storefront");
const registerStaff = require("./services/store/staff");
const registerOrderManagement = require("./services/store/orders");
const registerProductManagement = require("./services/store/products");
const registerInvoices = require("./services/store/invoices");
const registerAdminOperations = require("./services/store/admin-operations");
const registerAdminCatalogue = require("./services/store/admin-catalogue");
const registerInventory = require("./services/store/inventory");
const registerCheckout = require("./services/store/checkout");

const repository = createRepository({ listProducts, pool, cleanText });
const access = createAccessControls({ getStaff: repository.getStaff, pool });
const { safeEqual, requireAdmin, requireOwner, audit } = access;
const context = {
  ...repository, ...access, pool, cleanText, normalizeProductFamilyValue,
  SESSION_COOKIE
};

app.disable("x-powered-by");
app.set("trust proxy", 1);

// Public crawler endpoints must not depend on session or database middleware.
for (const filename of ["robots.txt", "sitemap.xml"]) {
  app.get("/" + filename, (_req, res) => {
    res.sendFile(path.join(ROOT, "public", filename), { maxAge: 300000 });
  });
}

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

    if (event.event === "payment.captured") {
      try { await require("./services/store/payment").confirmCapturedPayment(pool, event.payload?.payment?.entity); }
      catch (error) { return res.status(error.status || 503).send("Payment confirmation pending."); }
    }
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

require('./services/store/account-pages')(app);

// Keep published asset URLs usable by cached HTML and existing product records.
app.use("/editorial", express.static(path.join(ROOT, "public/assets/images/editorial")));
for (const directory of ["css", "js"]) {
  app.use(express.static(path.join(ROOT, "public/assets", directory)));
}
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

app.get("/api/products", async (_req, res, next) => {
  try {
    // Product data is the source of truth for the storefront. Inventory is
    // supplemental: a stock-table read problem must never blank the catalogue.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    res.json(await catalogue.read());
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

const media = require('./services/media/routes')(app, pool, requireAdmin, requireOwner, audit);
registerCustomers(app, context);
registerStorefront(app, context);
registerStaff(app, context);
registerOrderManagement(app, context);
registerProductManagement(app, context);
registerInvoices(app, context);
registerAdminOperations(app, context);
registerAdminCatalogue(app, context);
registerInventory(app, context);
registerCheckout(app, context);

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
  await initDatabase(pool);
  catalogue.start();
  media.start();

  app.listen(PORT, () => {
    console.log(`AERLON running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("Could not start AERLON:", error.message);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  try {
    catalogue.stop();
    media.stop();
    await pool.end();
  } finally {
    process.exit(0);
  }
});