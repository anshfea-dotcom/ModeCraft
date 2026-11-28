const crypto = require("node:crypto");

module.exports = function createRepository({ listProducts, pool, cleanText }) {
  function getProducts() {
    return listProducts(pool);
  }

  async function getProduct(id) {
    const result = await pool.query(
      "SELECT data FROM products WHERE id = $1",
      [id]
    );

    return result.rows[0]?.data || null;
  }

  async function putProduct(product, db = pool) {
    await db.query(
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

  async function ensureCustomerRecord(customer, db = pool) {
    const name = cleanText(customer?.name, 120);
    const email = cleanText(customer?.email, 254).toLowerCase();
    const phone = cleanText(customer?.phone, 30);
    if (!name || !email || !phone) return null;
    const existing = await db.query(
      "SELECT id FROM customers WHERE lower(email) = $1 OR phone = $2 LIMIT 1",
      [email, phone]
    );
    if (existing.rowCount) {
      await db.query(
        "UPDATE customers SET name = $1, updated_at = NOW() WHERE id = $2",
        [name, existing.rows[0].id]
      );
      return existing.rows[0].id;
    }
    const id = "mc-customer-" + crypto.randomBytes(10).toString("hex");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.randomBytes(48).toString("hex");
    try {
      await db.query(
        `INSERT INTO customers (id, name, email, phone, password_salt, password_hash, password_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE) ON CONFLICT DO NOTHING`,
        [id, name, email, phone, salt, hash]
      );
      const saved = await db.query("SELECT id FROM customers WHERE lower(email)=$1 OR phone=$2 LIMIT 1", [email, phone]);
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

  return { getProducts, getProduct, putProduct, getOrders, getOrder, ensureCustomerRecord, putOrder, getStaff, putStaff, removeStaff };
};
