const { remainingSession } = require("./session-policy");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

module.exports = function registerCustomers(app, { cleanText, pool, hashPassword, verifyPassword, getOrder, getProduct }) {
  // Customer authentication and reviews. Customer sessions are kept separate from admin sessions.
  function publicCustomer(row) {
    return { id: row.id, name: row.name, email: row.email, phone: row.phone, createdAt: row.created_at };
  }

  function requireCustomer(req, res, next) {
    res.set("Cache-Control", "no-store");
    remainingSession(pool, req, "customer", true).then(remaining => {
      if (!remaining) return res.status(401).json({ error: "Please sign in to continue." });
      res.set("X-Customer-Remaining-Ms", String(remaining));
      next();
    }).catch(next);
  }

  async function reserveLogin(key, limit) {
    const result = await pool.query(
      `INSERT INTO customer_login_limits AS l (key, attempts, expires)
       VALUES ($1, 1, NOW() + interval '15 minutes')
       ON CONFLICT (key) DO UPDATE SET
         attempts = CASE WHEN l.expires <= NOW() THEN 1 ELSE l.attempts + 1 END,
         expires = CASE WHEN l.expires <= NOW() THEN EXCLUDED.expires ELSE l.expires END
       WHERE l.expires <= NOW() OR l.attempts < $2
       RETURNING expires::text AS window_end`, [key, limit]);
    return result.rows[0]?.window_end;
  }

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
        req.session.customer = { issuedAt: Date.now(), id: result.rows[0].id };
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
      if (!email || !password || password.length > 200) return res.status(400).json({ error: "Enter your email and password." });
      const ipKey = "ip:" + ip;
      const accountKey = "account:" + crypto.createHash("sha256").update(email).digest("hex");
      await pool.query("DELETE FROM customer_login_limits WHERE expires <= NOW()");
      const ipWindow = await reserveLogin(ipKey, 30);
      const accountWindow = ipWindow && await reserveLogin(accountKey, 5);
      if (!accountWindow) {
        return res.set("Retry-After", "900").status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
      }
      const result = await pool.query("SELECT id, name, email, phone, password_salt, password_hash, password_enabled, created_at FROM customers WHERE email = $1", [email]);
      const user = result.rows[0];
      if (!user || user.password_enabled === false || !verifyPassword(password, user.password_salt, user.password_hash)) {
        return res.status(401).json({ error: "Incorrect email or password." });
      }
      await pool.query(
        `UPDATE customer_login_limits SET attempts = GREATEST(0, attempts - 1)
         WHERE (key = $1 AND expires = $2) OR (key = $3 AND expires = $4)`,
        [ipKey, ipWindow, accountKey, accountWindow]);
      req.session.regenerate(error => {
        if (error) return next(error);
        req.session.customer = { issuedAt: Date.now(), id: user.id };
        req.session.save(saveError => {
          if (saveError) return next(saveError);
          res.json({ ok: true, user: publicCustomer(user) });
        });
      });
    } catch (error) { next(error); }
  });

  app.post("/api/auth/activity", requireCustomer, (_req, res) => res.sendStatus(204));

  app.get("/api/auth/me", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      const remaining = await remainingSession(pool, req, "customer", false);
      if (!remaining) return res.json({ authenticated: false, user: null });
      res.set("X-Customer-Remaining-Ms", String(remaining));
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
        const fromEmail = (process.env.PASSWORD_RESET_FROM || (smtpUser ? `AERLON <${smtpUser}>` : "AERLON <onboarding@resend.dev>")).trim();
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
          const candidate = cleanBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.STOREFRONT_URL;
          resetUrl = new URL(candidate);
          if (resetUrl.protocol !== "https:" && resetUrl.protocol !== "http:") {
            throw new TypeError("Password reset URL must use http:// or https://");
          }
        } catch (urlError) {
          console.error("Invalid PASSWORD_RESET_BASE_URL; using the AERLON Render URL. Check the Render environment variable.");
          resetUrl = new URL(process.env.RENDER_EXTERNAL_URL || process.env.STOREFRONT_URL);
        }

        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        await pool.query("DELETE FROM password_reset_tokens WHERE customer_id = $1", [found.rows[0].id]);
        await pool.query(
          "INSERT INTO password_reset_tokens (token_hash, customer_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
          [tokenHash, found.rows[0].id]
        );

        // Direct the email to the responsive AERLON reset-password page.
        resetUrl.pathname = "/reset-password.html";
        resetUrl.search = "";
        resetUrl.searchParams.set("token", rawToken);
        const subject = "Reset your AERLON password";
        const textBody = `We received a request to reset your AERLON password. Open this link within 30 minutes: ${resetUrl.toString()}\n\nIf you did not request this, ignore this email.`;
        const htmlBody = `<p>We received a request to reset your AERLON password.</p><p><a href="${resetUrl.toString()}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>`;
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
      await client.query("DELETE FROM user_sessions WHERE sess->'customer'->>'id' = $1", [customerId]);
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
};
