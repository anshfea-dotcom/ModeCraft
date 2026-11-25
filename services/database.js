const { Pool } = require("pg");

function createPool(max) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
    max,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });

  pool.on("error", error => {
    console.error("PostgreSQL pool error:", error.message);
  });
  return pool;
}

module.exports = { createPool };
