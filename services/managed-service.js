const { fork } = require("node:child_process");

module.exports = function managedService(entry, remoteUrl) {
  let endpoint = remoteUrl;
  let child;
  let restartTimer;
  let stopping = false;

  function start() {
    if (endpoint || child || stopping) return;
    child = fork(entry, [], {
      env: { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV },
      execArgv: []
    });
    child.on("message", message => {
      if (Number.isInteger(message?.port)) endpoint = "http://127.0.0.1:" + message.port;
    });
    child.on("error", error => console.error("Service process error:", error.message));
    child.once("close", () => {
      child = null;
      endpoint = null;
      if (!stopping) restartTimer = setTimeout(start, 5000);
    });
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    child?.kill();
  }

  return { start, stop, get endpoint() { return endpoint; } };
};
