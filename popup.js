(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    total: $("total"),
    refresh: $("refresh"),
    problem: $("problem"),
    problemText: $("problemText"),
    problemBtn: $("problemBtn"),
    main: $("main"),
    search: $("search"),
    selAll: $("selAll"),
    selAllText: $("selAllText"),
    msg: $("msg"),
    list: $("list"),
    barWrap: $("barWrap"),
    fill: $("fill"),
    count: $("count"),
    stop: $("stop"),
    go: $("go"),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let tabId = null;
  let channels = []; // {id, name, meta, avatar, done}
  let selected = new Set();
  let results = {}; // id -> true | false (from the running/finished job)
  let channelsLoaded = false;
  let jobRunning = false;
  let pollTimer = null;
  let confirmTimer = null;
  let confirming = false;

  // ---------- messaging ----------

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    });
  }

  async function findYouTubeTab() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active.url && active.url.startsWith("https://www.youtube.com/")) {
      return active;
    }
    const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
    return tabs[0] || null;
  }

  // ---------- UI ----------

  function showProblem(text, label, action) {
    el.main.hidden = true;
    el.problem.hidden = false;
    el.problemText.textContent = text;
    el.problemBtn.textContent = label;
    el.problemBtn.onclick = action;
  }

  function showMain() {
    el.problem.hidden = true;
    el.main.hidden = false;
  }

  function say(text, isError = false) {
    el.msg.textContent = text;
    el.msg.classList.toggle("error", isError);
  }

  function isVisible(c) {
    const q = el.search.value.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || (c.meta || "").toLowerCase().includes(q);
  }

  function isDone(c) {
    return c.done || results[c.id] === true;
  }

  function pending() {
    return channels.filter((c) => selected.has(c.id) && !isDone(c));
  }

  function resetConfirm() {
    confirming = false;
    clearTimeout(confirmTimer);
    updateFooter();
  }

  function syncMaster() {
    const visible = channels.filter((c) => isVisible(c) && !isDone(c));
    const picked = visible.filter((c) => selected.has(c.id)).length;
    const all = visible.length > 0 && picked === visible.length;
    el.selAll.checked = all;
    el.selAll.indeterminate = picked > 0 && !all;
    el.selAll.disabled = jobRunning || visible.length === 0;
    const filtered = el.search.value.trim() !== "";
    el.selAllText.textContent =
      (all ? "Deselect all" : "Select all") + (filtered ? ` (${visible.length} shown)` : ` (${visible.length})`);
  }

  function updateFooter() {
    syncMaster();
    const n = pending().length;
    el.count.textContent = `${n} selected`;
    el.go.disabled = jobRunning || n === 0;
    el.go.textContent = confirming ? `Confirm: unsubscribe ${n}` : n ? `Unsubscribe ${n}` : "Unsubscribe";
    el.total.textContent = channels.length ? `${channels.length} channels` : "";
  }

  function render() {
    el.list.textContent = "";
    const frag = document.createDocumentFragment();

    for (const c of channels) {
      if (!isVisible(c)) continue;
      const done = isDone(c);
      const failed = results[c.id] === false;

      const li = document.createElement("li");
      li.className =
        "row" +
        (selected.has(c.id) && !done ? " selected" : "") +
        (done ? " done" : "") +
        (failed ? " failed" : "");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(c.id) && !done;
      cb.disabled = done || jobRunning;

      const img = document.createElement("img");
      img.className = "avatar";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      if (c.avatar) img.src = c.avatar;

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = c.name || c.id;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = c.meta || "";
      info.append(name, meta);

      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = done ? "Unsubscribed" : failed ? "Failed" : "";

      li.append(cb, img, info, tag);

      li.addEventListener("click", (e) => {
        if (jobRunning || done) return;
        if (e.target !== cb) cb.checked = !cb.checked;
        if (cb.checked) selected.add(c.id);
        else selected.delete(c.id);
        li.classList.toggle("selected", cb.checked);
        resetConfirm();
      });

      frag.appendChild(li);
    }

    el.list.appendChild(frag);
    updateFooter();
  }

  function setRunningUI(running) {
    jobRunning = running;
    el.stop.hidden = !running;
    el.refresh.disabled = running;
    el.selAll.disabled = running;
  }

  // ---------- polling ----------

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(tick, 600);
    tick();
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const st = await send({ type: "ymu-status" });
      if (!st) return;

      if (st.phase === "loading") {
        showMain();
        say(`Loading your subscriptions… ${st.count} so far`);
        return;
      }

      if (st.phase === "error") {
        stopPolling();
        showProblem(st.error || "Couldn't load your subscriptions.", "Try again", () => load(true));
        return;
      }

      if (st.phase === "ready") {
        if (!channelsLoaded) {
          const res = await send({ type: "ymu-channels" });
          channels = res.channels || [];
          channelsLoaded = true;
          showMain();
          say(channels.length ? "Tick the channels you want to unsubscribe from." : "No channels found.");
          render();
        }

        const job = st.job;
        if (job) {
          results = job.results || {};
          const finishedCount = job.done + job.failed;
          el.barWrap.hidden = job.total === 0;
          el.fill.style.width = job.total ? `${(finishedCount / job.total) * 100}%` : "0";

          if (job.running) {
            setRunningUI(true);
            say(`Unsubscribing… ${finishedCount}/${job.total}. You can close this popup; it keeps going while the YouTube tab stays open.`);
            render();
          } else {
            const wasRunning = jobRunning;
            setRunningUI(false);
            stopPolling();
            for (const c of channels) if (results[c.id] === true) selected.delete(c.id);
            say(
              (job.stopped ? "Stopped. " : "Finished. ") +
                `Unsubscribed ${job.done}` +
                (job.failed ? `, ${job.failed} failed` : "") +
                "." +
                (job.error ? ` ${job.error}` : ""),
              job.failed > 0 || !!job.error
            );
            render();
            if (!wasRunning) {
              /* reopened after a finished job: keep summary visible */
            }
          }
        } else {
          stopPolling();
        }
      }
    } catch (_) {
      stopPolling();
      showProblem(
        "Lost contact with the YouTube tab. Reload it and try again.",
        "Reload YouTube tab",
        reloadAndRetry
      );
    } finally {
      ticking = false;
    }
  }

  // ---------- actions ----------

  async function load(force) {
    showMain();
    say("Loading your subscriptions…");
    channelsLoaded = false;
    results = {};
    try {
      const res = await send({ type: "ymu-list", force: !!force });
      if (res && res.error === "main-not-ready") {
        showProblem(
          "The extension isn't active in this YouTube tab yet. Reload the tab and try again.",
          "Reload YouTube tab",
          reloadAndRetry
        );
        return;
      }
      startPolling();
    } catch (_) {
      showProblem(
        "Couldn't reach the YouTube tab. Reload it and try again.",
        "Reload YouTube tab",
        reloadAndRetry
      );
    }
  }

  async function reloadAndRetry() {
    el.problemText.textContent = "Reloading YouTube…";
    el.problemBtn.disabled = true;
    await chrome.tabs.reload(tabId);
    for (let i = 0; i < 25; i++) {
      await sleep(700);
      try {
        const r = await send({ type: "ymu-ping" });
        if (r && r.ok) {
          el.problemBtn.disabled = false;
          return load(false);
        }
      } catch (_) {
        /* page still loading */
      }
    }
    el.problemBtn.disabled = false;
    showProblem("YouTube took too long to load. Reload it manually and click the icon again.", "Close", () => window.close());
  }

  async function startUnsubscribe() {
    const picked = pending();
    if (!picked.length) return;

    // Two-step confirmation inside the popup
    if (!confirming) {
      confirming = true;
      updateFooter();
      confirmTimer = setTimeout(resetConfirm, 4000);
      return;
    }
    resetConfirm();

    try {
      const res = await send({ type: "ymu-unsub", ids: picked.map((c) => c.id) });
      if (!res || res.error) {
        say(res && res.error === "busy" ? "A job is already running." : "Couldn't start. Reload the YouTube tab and try again.", true);
        return;
      }
    } catch (_) {
      say("Lost contact with the YouTube tab. Reload it and try again.", true);
      return;
    }
    results = {};
    setRunningUI(true);
    el.barWrap.hidden = false;
    el.fill.style.width = "0";
    render();
    startPolling();
  }

  // ---------- wiring ----------

  el.search.addEventListener("input", render);
  el.selAll.addEventListener("change", () => {
    // Applies to the channels currently shown, so it works with the search filter too
    for (const c of channels) {
      if (!isVisible(c) || isDone(c)) continue;
      if (el.selAll.checked) selected.add(c.id);
      else selected.delete(c.id);
    }
    resetConfirm();
    render();
  });
  el.refresh.addEventListener("click", () => load(true));
  el.go.addEventListener("click", startUnsubscribe);
  el.stop.addEventListener("click", () => {
    send({ type: "ymu-stop" }).catch(() => {});
    say("Stopping after the current channel…");
  });

  async function init() {
    const tab = await findYouTubeTab();
    if (!tab) {
      showProblem(
        "Open YouTube in a tab (and sign in), then click this icon again.",
        "Open YouTube",
        () => chrome.tabs.create({ url: "https://www.youtube.com/" })
      );
      return;
    }
    tabId = tab.id;

    try {
      await send({ type: "ymu-ping" });
    } catch (_) {
      showProblem(
        "The extension isn't active in this YouTube tab yet. Reload the tab to activate it.",
        "Reload YouTube tab",
        reloadAndRetry
      );
      return;
    }

    try {
      const st = await send({ type: "ymu-status" });
      if (st.phase === "ready" || st.phase === "loading") {
        showMain();
        startPolling(); // pick up cached list or in-progress work
      } else {
        await load(false);
      }
    } catch (_) {
      await load(false);
    }
  }

  init();
})();
