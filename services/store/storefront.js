const crypto = require("node:crypto");

module.exports = function registerStorefront(app, { cleanText, pool, requireAdmin, requireOwner, audit }) {
  const DEFAULT_FOOTER_SETTINGS = {
    enabled: true,
    brandText: "AERLON",
    tagline: "Defined by style. Built for you.",
    intro: "Considered fashion and everyday essentials, curated for a distinctive point of view.",
    logoUrl: "",
    showBrand: true,
    showTagline: true,
    showIntro: true,
    socials: { instagram: "", facebook: "", youtube: "" },
    columns: [
      { id: "shop", title: "SHOP", links: [
        { label: "All Collections", url: "#shop" }, { label: "Men", url: "#men" }, { label: "Women", url: "#women" }, { label: "Jackets", url: "#jackets" }, { label: "Sneakers", url: "#sneakers" }
      ]},
      { id: "help", title: "NEED HELP?", links: [
        { label: "Track Your Order", action: "track" }, { label: "Customer Care", url: "/customer-care.html" }, { label: "Return & Refund Policy", url: "/return-refund-policy.html" }
      ]},
      { id: "information", title: "INFORMATION", links: [
        { label: "About AERLON", url: "#about" }, { label: "Contact Support", url: "https://wa.me/919648629929" }
      ]}
    ],
    newsletterEnabled: true,
    newsletterKicker: "THE AERLON EDIT",
    newsletterTitle: "A considered edit, delivered.",
    newsletterDescription: "Discover new arrivals, style stories and occasional AERLON updates.",
    newsletterButtonText: "SUBSCRIBE",
    newsletterConsentText: "I agree to receive occasional AERLON updates by email.",
    trustEnabled: true,
    trustItems: ["SECURE CHECKOUT", "PAYMENT OPTIONS AT CHECKOUT", "SHOP WITH CONFIDENCE"],
    copyrightText: "ALL RIGHTS RESERVED.",
    backToTopEnabled: true
  };

  function cleanFooterUrl(value, fieldName = "Footer link") {
    const raw = cleanText(value, 1200);
    if (!raw) return "";
    if (/^https:\/\//i.test(raw)) {
      let parsed;
      try { parsed = new URL(raw); } catch { throw Object.assign(new Error(`${fieldName} must be a valid HTTPS URL.`), { status: 400 }); }
      if (parsed.protocol !== "https:") throw Object.assign(new Error(`${fieldName} must use HTTPS.`), { status: 400 });
      return parsed.toString();
    }
    if (/^(?:\/(?!\/)|#)[^\s<>"']*$/.test(raw)) return raw;
    if (/^(?:mailto:|tel:)[^\s<>"']+$/i.test(raw)) return raw;
    throw Object.assign(new Error(`${fieldName} must be an HTTPS URL, local path, #anchor, mailto or tel link.`), { status: 400 });
  }

  function cleanFooterSettings(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const socialsInput = source.socials && typeof source.socials === "object" ? source.socials : {};
    const socials = {};
    for (const key of ["instagram", "facebook", "youtube"]) {
      const raw = cleanText(socialsInput[key], 1200);
      socials[key] = raw ? cleanFooterUrl(raw, `${key} social link`) : "";
      if (socials[key] && !/^https:\/\//i.test(socials[key])) throw Object.assign(new Error(`${key} social link must use HTTPS.`), { status: 400 });
    }
    const columnsInput = Array.isArray(source.columns) ? source.columns : DEFAULT_FOOTER_SETTINGS.columns;
    if (columnsInput.length > 4) throw Object.assign(new Error("Footer can have a maximum of 4 link columns."), { status: 400 });
    const columns = columnsInput.map((column, index) => {
      const title = cleanText(column?.title, 50);
      if (!title) throw Object.assign(new Error(`Enter a heading for footer column ${index + 1}.`), { status: 400 });
      const linksInput = Array.isArray(column?.links) ? column.links : [];
      if (linksInput.length > 12) throw Object.assign(new Error(`Footer column ${index + 1} can have a maximum of 12 links.`), { status: 400 });
      const links = linksInput.map((link, linkIndex) => {
        const label = cleanText(link?.label, 60);
        const action = link?.action === "track" ? "track" : "";
        const rawUrl = cleanText(link?.url, 1200);
        if (!label) throw Object.assign(new Error(`Enter a label for link ${linkIndex + 1} in ${title}.`), { status: 400 });
        if (action === "track") return { label, action: "track" };
        if (!rawUrl) throw Object.assign(new Error(`Enter a destination for ${label}.`), { status: 400 });
        return { label, url: cleanFooterUrl(rawUrl, `${label} destination`) };
      });
      return { id: cleanText(column?.id, 30).toLowerCase().replace(/[^a-z0-9_-]/g, "") || `column-${index + 1}`, title, links };
    });
    const trustItems = Array.isArray(source.trustItems) ? source.trustItems.slice(0, 3).map((item, index) => cleanText(item, 60) || DEFAULT_FOOTER_SETTINGS.trustItems[index]) : DEFAULT_FOOTER_SETTINGS.trustItems;
    const logoUrlRaw = cleanText(source.logoUrl, 1500);
    const logoUrl = logoUrlRaw ? cleanFooterUrl(logoUrlRaw, "Footer logo URL") : "";
    if (logoUrl && !/^https:\/\//i.test(logoUrl)) throw Object.assign(new Error("Footer logo URL must use HTTPS."), { status: 400 });
    return {
      enabled: source.enabled !== false,
      brandText: cleanText(source.brandText, 60) || DEFAULT_FOOTER_SETTINGS.brandText,
      tagline: cleanText(source.tagline, 120),
      intro: cleanText(source.intro, 240),
      logoUrl,
      showBrand: source.showBrand !== false,
      showTagline: source.showTagline !== false,
      showIntro: source.showIntro !== false,
      socials,
      columns,
      newsletterEnabled: source.newsletterEnabled !== false,
      newsletterKicker: cleanText(source.newsletterKicker, 60) || DEFAULT_FOOTER_SETTINGS.newsletterKicker,
      newsletterTitle: cleanText(source.newsletterTitle, 100) || DEFAULT_FOOTER_SETTINGS.newsletterTitle,
      newsletterDescription: cleanText(source.newsletterDescription, 240) || DEFAULT_FOOTER_SETTINGS.newsletterDescription,
      newsletterButtonText: cleanText(source.newsletterButtonText, 20) || DEFAULT_FOOTER_SETTINGS.newsletterButtonText,
      newsletterConsentText: cleanText(source.newsletterConsentText, 180) || DEFAULT_FOOTER_SETTINGS.newsletterConsentText,
      trustEnabled: source.trustEnabled !== false,
      trustItems,
      copyrightText: cleanText(source.copyrightText, 100) || DEFAULT_FOOTER_SETTINGS.copyrightText,
      backToTopEnabled: source.backToTopEnabled !== false
    };
  }

  async function getFooterSettings() {
    const result = await pool.query("SELECT key, data FROM store_settings WHERE key = ANY($1::text[])", [["storefront_footer", "storefront_header"]]);
    const settings = Object.fromEntries(result.rows.map(row => [row.key, row.data || {}]));
    const legacyHeader = settings.storefront_header || {};
    const savedFooter = settings.storefront_footer || {};
    const columns = Array.isArray(savedFooter.columns) ? savedFooter.columns.map(column => ({ ...column, links: Array.isArray(column.links) ? [...column.links] : [] })) : DEFAULT_FOOTER_SETTINGS.columns.map(column => ({ ...column, links: [...column.links] }));
    const appendMissing = (columnId, titleHint, requiredLinks) => {
      let column = columns.find(item => item.id === columnId) || columns.find(item => String(item.title || "").toLowerCase().includes(titleHint));
      if (!column) {
        const fallback = DEFAULT_FOOTER_SETTINGS.columns.find(item => item.id === columnId);
        if (columns.length < 4 && fallback) { column = { ...fallback, links: [] }; columns.push(column); }
        else column = columns.find(item => String(item.title || "").toLowerCase().includes("help")) || columns[columns.length - 1];
      }
      if (!column) return;
      for (const required of requiredLinks) {
        const exists = column.links.some(link => link.url === required.url || link.label === required.label);
        if (!exists) column.links.push(required);
      }
    };
    appendMissing("help", "help", DEFAULT_FOOTER_SETTINGS.columns.find(column => column.id === "help").links.filter(link => link.url === "/customer-care.html" || link.url === "/return-refund-policy.html"));
    // Keep the customer-care and policy links together under Help; avoid duplicating them in Information.
    return cleanFooterSettings({
      ...DEFAULT_FOOTER_SETTINGS,
      brandText: legacyHeader.brandText || DEFAULT_FOOTER_SETTINGS.brandText,
      tagline: legacyHeader.tagline || DEFAULT_FOOTER_SETTINGS.tagline,
      logoUrl: legacyHeader.logoUrl || "",
      ...savedFooter,
      columns
    });
  }

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
      res.json({ ok: true, message: "You're on the AERLON update list. Thank you for subscribing." });
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
        brandText: cleanText(input.brandText, 60) || "AERLON",
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

  // Footer settings are public-read and owner-write; the generic store_settings table keeps them persistent.
  app.get("/api/storefront/footer", async (_req, res, next) => {
    try { res.json({ footer: await getFooterSettings() }); }
    catch (error) { next(error); }
  });

  app.get("/api/admin/storefront/footer", requireAdmin, requireOwner, async (_req, res, next) => {
    try { res.json({ footer: await getFooterSettings() }); }
    catch (error) { next(error); }
  });

  app.put("/api/admin/storefront/footer", requireAdmin, requireOwner, async (req, res, next) => {
    try {
      const footer = cleanFooterSettings(req.body || {});
      await pool.query(
        `INSERT INTO store_settings (key, data, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        ["storefront_footer", JSON.stringify(footer)]
      );
      await audit(req.adminSession, "storefront.footer.update", { columns: footer.columns.length, links: footer.columns.reduce((sum, column) => sum + column.links.length, 0), enabled: footer.enabled });
      res.json({ ok: true, footer });
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
};
