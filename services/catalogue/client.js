const path = require("node:path");
const managedService = require("../managed-service");

function createCatalogueClient(localRead) {
  const service = managedService(path.join(__dirname, "server.js"), process.env.CATALOGUE_SERVICE_URL);
  async function read() {
    if (service.endpoint) {
      try {
        const response = await fetch(new URL("/api/products", service.endpoint), {
          signal: AbortSignal.timeout(5000), redirect: "error"
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data?.products)) return data;
        } else {
          await response.body?.cancel();
        }
      } catch (error) {
        console.warn("Catalogue service unavailable:", error.message);
      }
    }
    return localRead();
  }

  return { start: service.start, read, stop: service.stop };
}

module.exports = { createCatalogueClient };
