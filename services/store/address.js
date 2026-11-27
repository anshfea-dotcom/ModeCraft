const { rateLimit } = require("express-rate-limit");
const postalGroups = require("./data/india-postal-areas.json");

const pinPattern = /^[1-9]\d{5}$/;
const index = new Map();
for (const [city, state, pins] of postalGroups) {
  const area = { city, state };
  for (const pin of pins.split(" ")) {
    if (!index.has(pin)) index.set(pin, []);
    index.get(pin).push(area);
  }
}
const fail = (status, message) => Object.assign(new Error(message), { status });
function postalAreas(pin) {
  if (typeof pin !== "string" || !pinPattern.test(pin)) throw fail(400, "Enter a valid six-digit Indian PIN.");
  return index.get(pin) || [];
}

async function reverseAddress(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw fail(400, "Location unavailable.");
  const query = new URLSearchParams({ lat: lat.toFixed(4), lng: lon.toFixed(4), layers: "lgd_villages,lgd_states,datagov_pincodes" });
  let response;
  try {
    response = await fetch("https://bharatlas.com/api/v1/locate?" + query, {
      headers: { "User-Agent": "AERLON-Checkout/2.0 (aerlon.in)" }, signal: AbortSignal.timeout(8500)
    });
  } catch {
    throw fail(503, "Address lookup timed out. Enter your address manually.");
  }
  if (!response.ok) throw fail(response.status === 429 ? 429 : 503, "Address lookup is busy. Enter your address manually.");
  const { results } = await response.json();
  if (!results || typeof results !== "object") throw fail(503, "Address lookup is unavailable.");
  const layers = Object.values(results).filter(Array.isArray).flat();
  const props = name => layers.find(layer => layer.layer_id === name)?.feature?.properties || {};
  const locality = props("lgd_villages");
  const postal = props("datagov_pincodes");
  const state = props("lgd_states").STNAME || locality.stname || "";
  const pin = pinPattern.test(postal.Pincode || "") ? String(postal.Pincode) : "";
  if (!state && !pin) throw fail(422, "No Indian delivery area was found. Enter an Indian address manually.");
  const city = (locality.vilname11 || "").replace(/\s*\((M Corp\.|M|CT|NP|NPP|CB|TP)\)$/i, "").trim();
  const area = index.get(pin)?.[0];
  const isTown = city !== (locality.vilname11 || "").trim();
  return {
    pin, city: isTown ? city : (locality.dtname || area?.city || city),
    state: state || area?.state || "", address: isTown ? "" : city
  };
}

function addressRoutes(app) {
  app.use("/api/checkout/address", rateLimit({ windowMs: 60000, limit: 15, message: { error: "Too many lookups. Enter your address manually." } }));
  app.post("/api/checkout/address/:kind", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (req.params.kind === "pin") {
        const areas = postalAreas(req.body?.pin);
        if (!areas.length) throw fail(404, "PIN not found in the directory. Check it and enter your address manually.");
        return res.json(areas[0]);
      }
      if (req.params.kind !== "location") return res.sendStatus(404);
      return res.json(await reverseAddress(req.body?.lat, req.body?.lon));
    } catch (error) {
      res.status(error.status || 503).json({ error: error.status ? error.message : "Lookup unavailable. Enter your address manually." });
    }
  });
}
module.exports = { addressRoutes, postalAreas, pinPattern };
