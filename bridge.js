// Isolated-world script: relays messages between the popup and inject.js
// (which runs in the page) and remembers progress so the popup can be
// closed and reopened without losing track of a running job.
(() => {
  "use strict";
  if (window.__ymuBridge) return;
  window.__ymuBridge = true;

  const state = {
    mainReady: false,
    phase: "idle", // idle | loading | ready | error
    count: 0,
    error: "",
    channels: [],
    job: null, // {running, done, failed, total, results:{id:bool}, stopped, error}
  };

  const toMain = (cmd, extra) =>
    window.postMessage({ ymu: "bridge", cmd, ...extra }, location.origin);

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.ymu !== "main") return;

    switch (m.type) {
      case "ready":
        state.mainReady = true;
        break;
      case "list-start":
        state.phase = "loading";
        state.count = 0;
        state.error = "";
        break;
      case "list-progress":
        state.count = m.count;
        break;
      case "list-done":
        state.channels = m.channels;
        state.count = m.channels.length;
        state.phase = "ready";
        break;
      case "list-error":
        state.phase = "error";
        state.error = m.error;
        break;
      case "unsub-start":
        state.job = { running: true, done: 0, failed: 0, total: m.total, results: {}, stopped: false, error: "" };
        break;
      case "unsub-progress":
        if (state.job) {
          state.job.done = m.done;
          state.job.failed = m.failed;
          state.job.results[m.id] = m.ok;
          if (m.error) state.job.error = m.error;
        }
        if (m.ok) {
          const c = state.channels.find((x) => x.id === m.id);
          if (c) c.done = true;
        }
        break;
      case "unsub-finished":
        if (state.job) {
          state.job.running = false;
          state.job.done = m.done;
          state.job.failed = m.failed;
          state.job.stopped = m.stopped;
          if (m.error) state.job.error = m.error;
        }
        break;
      case "job-error":
        if (state.job) {
          state.job.running = false;
          state.job.error = m.error;
        } else {
          state.job = { running: false, done: 0, failed: 0, total: 0, results: {}, stopped: false, error: m.error };
        }
        break;
    }
  });

  async function ensureMain() {
    if (state.mainReady) return true;
    toMain("hello");
    for (let i = 0; i < 15 && !state.mainReady; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return state.mainReady;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "ymu-ping":
        sendResponse({ ok: true });
        return;

      case "ymu-status":
        sendResponse({
          phase: state.phase,
          count: state.count,
          error: state.error,
          job: state.job,
        });
        return;

      case "ymu-channels":
        sendResponse({ channels: state.channels });
        return;

      case "ymu-list":
        (async () => {
          if (state.phase === "loading") return sendResponse({ started: true });
          if (state.phase === "ready" && !msg.force) return sendResponse({ cached: true });
          if (!(await ensureMain())) return sendResponse({ error: "main-not-ready" });
          state.phase = "loading";
          state.count = 0;
          state.error = "";
          toMain("list");
          sendResponse({ started: true });
        })();
        return true;

      case "ymu-unsub":
        (async () => {
          if (state.job && state.job.running) return sendResponse({ error: "busy" });
          if (!(await ensureMain())) return sendResponse({ error: "main-not-ready" });
          state.job = { running: true, done: 0, failed: 0, total: (msg.ids || []).length, results: {}, stopped: false, error: "" };
          toMain("unsub", { ids: msg.ids });
          sendResponse({ started: true });
        })();
        return true;

      case "ymu-stop":
        toMain("stop");
        sendResponse({ ok: true });
        return;
    }
  });
})();
