"use strict";
const { z, matchRoute, webhook, imageSlot } = require("./input-schemas");

// Only cookies actually consumed by the backend are validated here.
// Unknown analytics and other third-party cookies are ignored (not trusted).
function validateCookies(raw) {
  if (typeof raw !== "string" || raw.length > 8192) return false;
  const seen = new Set();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0,eq).trim(), value = part.slice(eq+1).trim();
    if (!["mc_admin_session","aerlon_aff"].includes(name)) continue;
    if (seen.has(name)) return false;
    seen.add(name);
    if (name === "mc_admin_session") {
      if (value.length > 2048 || !/^[A-Za-z0-9%._~+\/=:-]+$/.test(value)) return false;
    } else {
      if (!/^[A-Z0-9_-]{4,24}\.[a-f0-9]{64}$/.test(value)) return false;
    }
  }
  return true;
}
function invalid(res, section, issues) {
  res.set("Cache-Control","no-store");
  return res.status(400).json({
    error:"Invalid request input.",
    fields:(issues || []).slice(0,8).map(issue=>({
      path: [section, ...issue.path].join(".").slice(0,180),
      code:issue.code,
      message:String(issue.message).slice(0,160)
    }))
  });
}
function invalidSingle(res, section, message) {
  return invalid(res,section,[{path:[],code:"invalid_request",message}]);
}

function validateInput(req,res,next) {
  const pathname = req.path;
  if (!pathname.startsWith("/api/") && pathname !== "/health" &&
      !pathname.startsWith("/r/") && !pathname.startsWith("/storefront-images/"))return next();
  if (req.method === "OPTIONS") return next();
  if (!validateCookies(req.headers.cookie || "")) return invalidSingle(res,"cookies","Invalid application cookie.");

  const matched = matchRoute(req.method, pathname);
  // A newly added API handler cannot silently go live without a schema.
  if (!matched) {
    if (pathname.startsWith("/api/")) return res.status(404).json({error:"API endpoint not found."});
    return next();
  }
  if (matched.malformed) return invalidSingle(res,"params","Malformed path encoding.");
  const {entry, params} = matched;
  const validatedParams = entry.params.safeParse(params);
  if (!validatedParams.success) return invalid(res,"params",validatedParams.error.issues);
  const validatedQuery = entry.query.safeParse(req.query || {});
  if (!validatedQuery.success) return invalid(res,"query",validatedQuery.error.issues);

  // Do not consume raw WebP uploads before their dedicated express.raw parser.
  const isImageUpload = req.method === "PUT" && pathname.toLowerCase().startsWith("/api/admin/storefront/images/");
  if (isImageUpload) {
    if (!/^image\/webp(?:\s*;.*)?$/i.test(req.get("Content-Type") || ""))
      return invalidSingle(res,"body","A WebP image is required.");
    const length = req.get("Content-Length");
    if (length && (!/^\d+$/.test(length) || Number(length) > 1024*1024))
      return invalidSingle(res,"body","Image exceeds the 1MB limit.");
    return next();
  }

  const hasEntity = Number(req.headers["content-length"] || 0) > 0 || Boolean(req.headers["transfer-encoding"]);
  if (!["GET","HEAD","DELETE"].includes(req.method) && hasEntity &&
      !req.is("application/json")) {
    return invalidSingle(res,"body","Expected an application/json request.");
  }
  const result = entry.body.safeParse(req.body === undefined ? {} : req.body);
  if (!result.success) return invalid(res,"body",result.error.issues);

  // Use only the parsed, stripped/transformed allowlist in business handlers.
  req.body = result.data;
  return next();
}
const webp = z.instanceof(Buffer).refine(value =>
  value.length >= 30 && value.length <= 1024*1024 &&
  value.toString("ascii",0,4)==="RIFF" &&
  value.toString("ascii",8,12)==="WEBP" &&
  value.readUInt32LE(4)===value.length-8 &&
  ["VP8 ","VP8L","VP8X"].includes(value.toString("ascii",12,16)),
  "Invalid WebP image.");
function validateWebp(req,res,next) {
  const slot = imageSlot.safeParse(req.params);
  if (!slot.success) return invalid(res,"params",slot.error.issues);
  const result = webp.safeParse(req.body);
  if (!result.success) return invalid(res,"body",result.error.issues);
  next();
}
function validateWebhookData(input) {
  return webhook.safeParse(input);
}

module.exports = { validateInput, validateWebp, validateWebhookData, validateCookies };
