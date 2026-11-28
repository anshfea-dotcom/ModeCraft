"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { policyFor, createRateLimiter, clientIp } = require("../services/store/rate-limits");

process.env.RATE_LIMIT_KEY_SECRET = "ci-only-not-a-production-key";

function fakePool() {
  const counters = new Map();
  return {
    async query(sql, args) {
      assert.match(sql, /ON CONFLICT \(key\) DO UPDATE/);
      const [key, seconds] = args;
      const now = Date.now();
      let row = counters.get(key);
      if (!row || row.expires <= now) row = { hits: 0, expires: now + seconds * 1000 };
      row.hits++;
      counters.set(key, row);
      return { rows: [{ hits: row.hits, retry_after: Math.max(1, Math.ceil((row.expires - now) / 1000)) }] };
    }
  };
}
function response(resolve) {
  const headers = {};
  return {
    headers, statusCode: 200,
    set(k, v) { headers[k.toLowerCase()] = String(v); return this; },
    status(n) { this.statusCode = n; return this; },
    json(body) { this.body = body; resolve({ pass: false, code: this.statusCode, headers, body }); return this; }
  };
}
function request(pathname, method = "GET", ip = "203.0.113.10", body = {}, session = null) {
  return { method, originalUrl: pathname, path: pathname, ip,
    socket: { remoteAddress: ip }, body, session, headers: { "x-forwarded-for": "1.2.3.4" } };
}
function invoke(limiter, req) {
  return new Promise(resolve => {
    const res = response(resolve);
    limiter(req, res, () => resolve({ pass: true, code: 200, headers: res.headers }));
  });
}
async function test() {
  // Every installed endpoint has a policy, including parameterized routes.
  const paths = ["server.js", "services/media/routes.js", "services/catalogue/server.js",
    "services/media/server.js", ...fs.readdirSync(path.join(__dirname, "../services/store"))
      .filter(f => f.endsWith(".js")).map(f => "services/store/" + f)];
  let scanned = 0;
  for (const file of paths) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const re = /\bapp\.(get|post|put|patch|delete|head|all)\s*\(\s*["']([^"']+)["']/g;
    for (const m of source.matchAll(re)) {
      const [method, url] = [m[1].toUpperCase(), m[2]];
      if (url.startsWith("/api/") || url.startsWith("/r/") || url.startsWith("/storefront-images/") || url === "/health") {
        assert.ok(policyFor(method, url), "No limiter for " + method + " " + url + " in " + file);
        scanned++;
      }
    }
  }
  assert.ok(scanned >= 80, "Route inventory unexpectedly small: " + scanned);

  assert.equal(policyFor("POST", "/api/auth/login").limit, 5);
  assert.equal(policyFor("POST", "/api/admin/login").limit, 5);
  assert.equal(policyFor("POST", "/api/auth/forgot-password").limit, 3);
  assert.equal(policyFor("POST", "/api/auth/otp/send").limit, 5);
  assert.equal(policyFor("POST", "/api/chat").dailyUser, 200);
  assert.equal(policyFor("POST", "/api/ai/generate").limit, 15);
  assert.equal(policyFor("GET", "/api/products").limit, 120);
  assert.equal(policyFor("PATCH", "/api/admin/products/42").limit, 60);
  assert.equal(policyFor("POST", "/api/orders/cod").limit, 12);
  assert.equal(policyFor("POST", "/api/coupons/validate").limit, 12);
  assert.equal(policyFor("GET", "/api/admin/backups/operational.json").limit, 10);
  assert.equal(policyFor("POST", "/api/razorpay/webhook").limit, 300);
  assert.equal(policyFor("GET", "/storefront-images/home").limit, 180);
  assert.equal(policyFor("GET", "/images/background.jpg"), null);

  // Forged XFF never influences the identity if the trusted proxy logic gives
  // us the socket peer; the gateway only trusts explicitly listed proxy CIDRs.
  const req = request("/api/auth/login", "POST", "203.0.113.42", { email: "abc@example.com" });
  assert.equal(clientIp(req), "203.0.113.42");
  req.headers["x-forwarded-for"] = "9.9.9.9";
  assert.equal(clientIp(req), "203.0.113.42");
  const gateway = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(gateway, /TRUSTED_PROXY_CIDRS/);
  assert.doesNotMatch(gateway, /app\.set\("trust proxy",\s*1\s*\)/);

  const limiter = createRateLimiter(fakePool());
  for (let i = 0; i < 5; i++) assert.equal((await invoke(limiter, req)).pass, true);
  const blocked = await invoke(limiter, req);
  assert.equal(blocked.code, 429);
  assert.ok(Number(blocked.headers["retry-after"]) >= 1);
  assert.equal(blocked.headers["ratelimit-remaining"], "0");

  // Account quota is shared between source IPs, not just the same IP bucket.
  const sharedAccount = await invoke(limiter, request("/api/auth/login", "POST",
    "203.0.113.43", { email: "abc@example.com" }));
  assert.equal(sharedAccount.code, 429);

  const ai = createRateLimiter(fakePool());
  const aiRequest = request("/api/ai/generate", "POST", "198.51.100.21", {},
    { customer: { id: "user-123" } });
  for (let i = 0; i < 15; i++) assert.equal((await invoke(ai, aiRequest)).pass, true);
  assert.equal((await invoke(ai, aiRequest)).code, 429);

  const unavailable = createRateLimiter({ query: async () => { throw new Error("db unavailable"); } });
  const fail = await invoke(unavailable, request("/api/products"));
  assert.equal(fail.code, 503);
  assert.equal(fail.headers["retry-after"], "30");

  console.log("Rate-limit policy, route scan, spoofing, shared counters, 429 and fail-closed checks passed (" + scanned + " declared routes).");
}
test().catch(error => { console.error(error); process.exitCode = 1; });
