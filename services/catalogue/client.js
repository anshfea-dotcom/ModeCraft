const { fork } = require("node:child_process");
const path = require("node:path");

function createCatalogueClient(localRead) {
  let endpoint = process.env.CATALOGUE_SERVICE_URL;
  let child;
  let restartTimer;
  let stopping = false;

  function start() {
    if (endpoint || child || stopping) return;
    child = fork(path.join(__dirname, "server.js"), [], {
      env: { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV },
      execArgv: []
    });
    child.on("message", message => {
      if (Number.isInteger(message?.port)) endpoint = "http://127.0.0.1:" + message.port;
    });
    child.on("error", error => console.error("Catalogue process error:", error.message));
    child.once("close", () => {
      child = null;
      endpoint = null;
      if (!stopping) restartTimer = setTimeout(start, 5000);
    });
  }

  async function read() {
    if (endpoint) {
      try {
        const response = await fetch(new URL("/api/products", endpoint), {
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

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    child?.kill();
  }

  return { start, read, stop };
}

module.exports = { createCatalogueClient };
