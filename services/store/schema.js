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

module.exports = async function initDatabase(pool) {
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

    CREATE TABLE IF NOT EXISTS checkout_attempts (
      id UUID PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      data JSONB NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS invoices_issued_at_idx ON invoices (issued_at DESC);

    CREATE TABLE IF NOT EXISTS affiliates (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      commission_rate NUMERIC(5,2) NOT NULL CHECK(commission_rate BETWEEN 0 AND 30),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gift_cards (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      initial_paise INTEGER NOT NULL CHECK(initial_paise>0),
      balance_paise INTEGER NOT NULL CHECK(balance_paise>=0),
      active BOOLEAN NOT NULL DEFAULT FALSE,
      funding_ref TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gift_card_redemptions (
      id BIGSERIAL PRIMARY KEY,
      card_id UUID NOT NULL REFERENCES gift_cards(id),
      reference TEXT NOT NULL,
      amount_paise INTEGER NOT NULL CHECK(amount_paise>0),
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(card_id,reference)
    );
    -- Dismissed dashboard notifications; this never deletes operational source records.
    CREATE TABLE IF NOT EXISTS admin_notification_deletions (
      actor TEXT NOT NULL,
      notification_key TEXT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (actor, notification_key)
    );
    CREATE INDEX IF NOT EXISTS admin_notification_deletions_actor_date_idx
      ON admin_notification_deletions (actor, deleted_at DESC);

    CREATE TABLE IF NOT EXISTS automation_rules (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('low_stock','unpaid_orders','unfulfilled_orders')),
      threshold INTEGER NOT NULL DEFAULT 5,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS automation_alerts (
      id UUID PRIMARY KEY,
      rule_id UUID NOT NULL REFERENCES automation_rules(id),
      entity_key TEXT NOT NULL,
      period DATE NOT NULL,
      detail TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(rule_id,entity_key,period)
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

    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS warehouse_stock (
      warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      variant_id TEXT NOT NULL REFERENCES inventory_variants(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL CHECK(quantity>=0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(warehouse_id, variant_id)
    );
    CREATE INDEX IF NOT EXISTS warehouse_stock_variant_idx ON warehouse_stock(variant_id);

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

    ALTER TABLE user_sessions
      ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS admin_challenge_hash TEXT,
      ADD COLUMN IF NOT EXISTS admin_challenge_expires TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS customer_login_limits (
      key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_login_limits_expire_idx ON customer_login_limits (expires);
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

  console.log("AERLON database initialized.");
};
