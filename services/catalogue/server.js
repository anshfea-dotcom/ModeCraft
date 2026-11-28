const http = require("node:http");
const { createPool } = require("../database");
const { readCatalogue } = require("./catalogue");
const { allowStandalone } = require("../store/rate-limits");

const pool = createPool(2);
const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" || req.url !== "/api/products") {
    res.writeHead(404).end();
    return;
  }
  if (!await allowStandalone(req, res, pool, "catalogue", 600)) return;
  try {
    const data = await readCatalogue(pool);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error("Catalogue read failed:", error.message);
    res.writeHead(503).end();
  }
});

// The gateway launches a loopback listener. A standalone deployment uses PORT.
const managed = Boolean(process.send);
async function start() {
  await readCatalogue(pool);
  server.listen(managed ? 0 : Number(process.env.PORT || 3001), managed ? "127.0.0.1" : "0.0.0.0", () => {
    if (managed) process.send({ port: server.address().port });
    console.log("Catalogue service ready after database read");
  });
}
start().catch(error => {
  console.error("Catalogue startup failed:", error.message);
  process.exit(1);
});
function stop() {
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.once("SIGTERM", stop);
if (managed) process.once("disconnect", stop);
