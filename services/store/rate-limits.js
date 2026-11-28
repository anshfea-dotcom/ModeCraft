"use strict";
const crypto = require("node:crypto");
const { isIP } = require("node:net");

// One shared PostgreSQL store for all application instances; no memory counters.
const minute = (name, limit, extra = {}) => ({ name, limit, seconds: 60, ...extra });
function policyFor(method, path) {
  // Express routes are case-insensitive and ignore trailing / by default.
  // Match its behavior so path variants cannot downgrade to a weaker tier.
  const p = (String(path || "").split("?")[0].toLowerCase().replace(/\/+$/, "") || "/");
  const verb = String(method || "GET").toUpperCase();
  if (p === "/api/razorpay/webhook") return minute("payment-webhook", 300, { ipOnly: true });
  if (p === "/health") return minute("health", 60, { ipOnly: true });
  if (/^\/storefront-images\/[^/]+$/.test(p)) return minute("storefront-media", 180, { ipOnly: true });
  if (/^\/r\/[^/]+$/.test(p)) return minute("affiliate-redirect", 90, { ipOnly: true });
  if (!p.startsWith("/api/")) return null;
  // Static route groups stop cycling path parameters to evade a per-route limit.
  if (/^\/api\/(?:auth\/login|admin\/login|login)$/.test(p))
    return minute("auth-login", 5, { account: true });
  if (p === "/api/admin/login-challenge") return minute("auth-challenge", 10, { ipOnly: true });
  if (/^\/api\/(?:auth\/signup|signup)$/.test(p)) return minute("auth-signup", 5, { account: true });
  if (/^\/api\/(?:auth\/forgot-password|forgot-password)$/.test(p))
    return minute("auth-forgot", 3, { account: true });
  if (/^\/api\/(?:auth\/reset-password|reset-password)$/.test(p)) return minute("auth-reset", 5);
  if (/^\/api\/(?:auth\/)?(?:otp|verify-otp|send-otp)(?:\/|$)/.test(p) ||
      /^\/api\/auth\/.*otp(?:\/|$)/.test(p))
    return minute("auth-otp", 5, { account: true });
  // Future LLM endpoints. No LLM-backed server endpoint exists in this revision.
  if (/^\/api\/(?:ai|chat|generate|llm|style-studio)(?:\/|$)/.test(p))
    return minute("ai", 15, { dailyUser: 200, dailyIp: 500 });
  if (/^\/api\/admin\/backups(?:\/|$)/.test(p)) return minute("admin-backup", 10);
  if (/^\/api\/(?:orders\/(?:cod|gift)|payments\/razorpay\/(?:order|verify))(?:\/|$)/.test(p))
    return minute("checkout-order", 12);
  if (/^\/api\/(?:coupons\/validate|gift-cards\/check)(?:\/|$)/.test(p))
    return minute("checkout-code", 12);
  if (/^\/api\/checkout\/address(?:\/|$)/.test(p)) return minute("address-lookup", 20);
  if (p === "/api/storefront/newsletter") return minute("newsletter", 5, { account: true });
  if (p === "/api/orders/track") return minute("order-tracking", 20);
  return minute(verb === "GET" || verb === "HEAD" ? "api-read" : "api-write",
    verb === "GET" || verb === "HEAD" ? 120 : 60);
}

function digest(value) {
  const secret = process.env.RATE_LIMIT_KEY_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error("Rate-limit secret is not configured");
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}
function clientIp(req) {
  // Express req.ip uses the socket plus strictly configured trusted proxy CIDRs.
  // Never interpret caller-supplied X-Forwarded-For or X-Real-IP directly.
  const value = req.ip || req.socket?.remoteAddress || "";
  return isIP(value) ? value.toLowerCase() : "unknown-peer";
}
function accountValue(req) {
  const value = req.body?.email ?? req.body?.username ?? req.body?.phone ?? req.query?.email ?? "";
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 180) : "";
}
function principal(req) {
  if (typeof req.session?.customer?.id === "string") return "customer:" + req.session.customer.id;
  const admin = req.session?.admin;
  if (admin?.staffId) return "staff:" + admin.staffId;
  if (admin?.username) return "admin:" + String(admin.username).toLowerCase();
  return null;
}
async function takeCounter(pool, key, max, seconds) {
  // Atomic UPSERT serializes concurrent increments, even across app instances.
  const r = await pool.query(
    `INSERT INTO api_rate_limits AS lim (key, hits, expires_at)
     VALUES ($1, 1, NOW() + $2::integer * INTERVAL '1 second')
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN lim.expires_at <= NOW() THEN 1 ELSE lim.hits + 1 END,
       expires_at = CASE WHEN lim.expires_at <= NOW() THEN EXCLUDED.expires_at ELSE lim.expires_at END
     RETURNING hits,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW()))))::integer AS retry_after`,
    [key, seconds]
  );
  const hits = Number(r.rows[0].hits);
  return { allowed: hits <= max, remaining: Math.max(0, max - hits),
    retryAfter: Math.max(1, Number(r.rows[0].retry_after) || seconds), limit: max };
}
function rejectLimited(res, outcome) {
  const sec = Math.max(1, Math.ceil(outcome.retryAfter));
  res.set("Cache-Control", "no-store");
  res.set("Retry-After", String(sec));
  res.set("RateLimit-Limit", String(outcome.limit));
  res.set("RateLimit-Remaining", "0");
  res.set("RateLimit-Reset", String(sec));
  return res.status(429).json({ error: "Too many requests. Please retry later.", retryAfter: sec });
}
function rejectUnavailable(res) {
  res.set("Cache-Control", "no-store");
  res.set("Retry-After", "30");
  return res.status(503).json({ error: "Request protection temporarily unavailable. Please retry shortly." });
}
async function enforce(req, res, pool, policy) {
  const ip = clientIp(req), user = principal(req);
  const checks = [["ip", ip, policy.limit, policy.seconds]];
  if (!policy.ipOnly && user) checks.push(["user", user, policy.limit, policy.seconds]);
  const account = policy.account && accountValue(req);
  if (account) checks.push(["account", account, policy.limit, policy.seconds]);
  if (policy.dailyUser) {
    checks.push(["daily-user", user || "anonymous:" + ip, policy.dailyUser, 86400]);
    checks.push(["daily-ip", ip, policy.dailyIp, 86400]);
  }
  for (const [scope, value, limit, seconds] of checks) {
    const outcome = await takeCounter(pool, "rl:v1:" + policy.name + ":" + scope + ":" + digest(value), limit, seconds);
    if (!outcome.allowed) { rejectLimited(res, outcome); return false; }
    if (scope === "ip") {
      res.set("RateLimit-Limit", String(limit));
      res.set("RateLimit-Remaining", String(outcome.remaining));
      res.set("RateLimit-Reset", String(outcome.retryAfter));
    }
  }
  return true;
}
function createRateLimiter(pool) {
  return async (req, res, next) => {
    const policy = policyFor(req.method, req.originalUrl || req.path);
    if (!policy) return next();
    try { if (await enforce(req, res, pool, policy)) next(); }
    catch (error) {
      console.error("Rate-limit storage unavailable:", error.message);
      rejectUnavailable(res); // fail closed, never fall back to local memory
    }
  };
}
function lockIdentity(kind, account) {
  return "auth-lock:v1:" + kind + ":" + digest(String(account).trim().toLowerCase());
}
async function checkAuthLock(pool, kind, account) {
  const r = await pool.query(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::integer AS retry_after
     FROM auth_lockouts WHERE identity=$1 AND locked_until > NOW()`,
    [lockIdentity(kind, account)]
  );
  return Number(r.rows[0]?.retry_after || 0);
}
async function recordAuthFailure(pool, kind, account) {
  // 5 failures within 15m => 60s lock; doubles on new failures, max 30m.
  await pool.query(
    `INSERT INTO auth_lockouts AS locks (identity, failures, locked_until, updated_at)
     VALUES ($1, 1, NULL, NOW())
     ON CONFLICT (identity) DO UPDATE SET
       failures = CASE WHEN locks.updated_at < NOW() - INTERVAL '15 minutes'
         THEN 1 ELSE LEAST(20, locks.failures + 1) END,
       locked_until = CASE
         WHEN locks.updated_at < NOW() - INTERVAL '15 minutes' THEN NULL
         WHEN locks.failures + 1 >= 5 THEN NOW() +
           LEAST(1800, (60 * POWER(2, LEAST(5, locks.failures - 4)))::integer) * INTERVAL '1 second'
         ELSE NULL END,
       updated_at = NOW()`,
    [lockIdentity(kind, account)]
  );
}
async function clearAuthFailures(pool, kind, account) {
  await pool.query("DELETE FROM auth_lockouts WHERE identity=$1", [lockIdentity(kind, account)]);
}
function cleanupCounters(pool) {
  const job = setInterval(() => {
    Promise.all([
      pool.query("DELETE FROM api_rate_limits WHERE expires_at < NOW() - INTERVAL '1 day'"),
      pool.query("DELETE FROM auth_lockouts WHERE updated_at < NOW() - INTERVAL '30 days'")
    ]).catch(error => console.error("Rate-limit cleanup failed:", error.message));
  }, 6 * 3600000);
  job.unref?.();
  return () => clearInterval(job);
}

async function allowStandalone(req, res, pool, name, max = 600) {
  // Standalone reader services are externally reachable if deployed separately.
  // Gateway-managed loopback readers are protected at the gateway instead.
  if (process.send) return true;
  try {
    const peer = req.socket?.remoteAddress || "unknown-peer";
    const hash = crypto.createHash("sha256").update(name + ":" + peer).digest("hex");
    const result = await takeCounter(pool, "rl:v1:standalone:" + name + ":" + hash, max, 60);
    if (result.allowed) return true;
    res.writeHead(429, {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Retry-After": String(result.retryAfter), "RateLimit-Limit": String(max),
      "RateLimit-Remaining": "0"
    });
    res.end(JSON.stringify({ error: "Too many requests. Please retry later.", retryAfter: result.retryAfter }));
    return false;
  } catch (error) {
    console.error("Standalone service rate-limit unavailable:", error.message);
    res.writeHead(503, {
      "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "30"
    });
    res.end(JSON.stringify({ error: "Request protection temporarily unavailable." }));
    return false;
  }
}

module.exports = {
  policyFor, createRateLimiter, clientIp, takeCounter, rejectLimited, rejectUnavailable, allowStandalone,
  checkAuthLock, recordAuthFailure, clearAuthFailures, cleanupCounters
};
