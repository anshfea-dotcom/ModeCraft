"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { takeCounter, checkAuthLock, recordAuthFailure, clearAuthFailures } = require("../services/store/rate-limits");
async function main() {
  const url = process.env.RATE_LIMIT_TEST_DATABASE_URL;
  if (!url) throw new Error("RATE_LIMIT_TEST_DATABASE_URL required for database integration tests");
  process.env.RATE_LIMIT_KEY_SECRET = "ci-only-rate-limit-hmac";
  const pool = new Pool({ connectionString: url, max: 15 });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS api_rate_limits (
      key TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_lockouts (
      identity TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ, window_started TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const key = "ci-rate-limit:" + crypto.randomUUID();
    const races = await Promise.all(Array.from({ length: 30 }, () => takeCounter(pool, key, 5, 60)));
    assert.equal(races.filter(x => x.allowed).length, 5, "Atomic counter exceeded max during concurrent requests");
    assert.equal(races.filter(x => !x.allowed).length, 25);
    assert.ok(races.filter(x => !x.allowed).every(x => x.retryAfter > 0));
    const result = await pool.query("SELECT hits FROM api_rate_limits WHERE key=$1", [key]);
    assert.equal(Number(result.rows[0].hits), 30);

    const identity = "ci-user-" + crypto.randomUUID();
    for (let i = 0; i < 4; i++) {
      await recordAuthFailure(pool, "customer", identity);
      assert.equal(await checkAuthLock(pool, "customer", identity), 0);
    }
    await recordAuthFailure(pool, "customer", identity);
    const lockedFor = await checkAuthLock(pool, "customer", identity);
    assert.ok(lockedFor > 0 && lockedFor <= 60);
    await clearAuthFailures(pool, "customer", identity);
    assert.equal(await checkAuthLock(pool, "customer", identity), 0);

    // Secret account identities must never appear in stored keys.
    const rows = await pool.query("SELECT identity FROM auth_lockouts WHERE identity LIKE 'auth-lock:v1:%'");
    assert.ok(rows.rows.every(r => !r.identity.includes("@")));
    await pool.query("DELETE FROM api_rate_limits WHERE key=$1", [key]);
    console.log("PostgreSQL cross-instance atomic quotas and auth lockout integration checks passed.");
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
