// Runs inside the YouTube page itself (world: MAIN) so it can read YouTube's
// own config (ytcfg) and call YouTube's internal API with the user's session.
(() => {
  "use strict";
  if (window.__ymuMain) return;
  window.__ymuMain = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (msg) =>
    window.postMessage({ ymu: "main", ...msg }, location.origin);

  let stopFlag = false;
  let busy = false;

  // ---------- YouTube session helpers ----------

  function cfg(key) {
    try {
      return window.ytcfg && window.ytcfg.get ? window.ytcfg.get(key) : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function headers() {
    const h = {
      "Content-Type": "application/json",
      "X-Origin": location.origin,
      "X-Youtube-Client-Name": String(cfg("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
      "X-Youtube-Client-Version": cfg("INNERTUBE_CONTEXT_CLIENT_VERSION") || "",
    };
    const sapisid = getCookie("SAPISID") || getCookie("__Secure-3PAPISID");
    if (sapisid) {
      const ts = Math.floor(Date.now() / 1000);
      const hash = await sha1Hex(`${ts} ${sapisid} ${location.origin}`);
      h["Authorization"] = `SAPISIDHASH ${ts}_${hash}`;
      h["X-Goog-AuthUser"] = String(cfg("SESSION_INDEX") ?? 0);
      const pageId = cfg("DELEGATED_SESSION_ID");
      if (pageId) h["X-Goog-PageId"] = pageId;
    }
    return h;
  }

  async function api(path, body) {
    const context = cfg("INNERTUBE_CONTEXT");
    if (!context) {
      throw new Error("YouTube hasn't finished loading. Reload the tab and try again.");
    }
    const key = cfg("INNERTUBE_API_KEY");
    const url =
      `/youtubei/v1/${path}?prettyPrint=false` +
      (key ? `&key=${encodeURIComponent(key)}` : "");
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: await headers(),
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? " Make sure you're signed in to YouTube."
          : "";
      throw new Error(`YouTube returned HTTP ${res.status}.${hint}`);
    }
    return res.json();
  }

  // ---------- response parsing ----------

  function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, visit);
      return;
    }
    visit(node);
    for (const k in node) walk(node[k], visit);
  }

  const text = (t) =>
    (t && (t.simpleText || (t.runs && t.runs.map((r) => r.text).join("")) || t.content)) || "";

  const fixUrl = (u) => (u && u.startsWith("//") ? "https:" + u : u || "");

  function findUnsubParams(node) {
    let params = "";
    walk(node, (x) => {
      if (!params && x.unsubscribeEndpoint && x.unsubscribeEndpoint.params) {
        params = x.unsubscribeEndpoint.params;
      }
    });
    return params;
  }

  function extract(json) {
    const found = [];
    let token = "";

    walk(json, (n) => {
      // Classic layout
      const cr = n.channelRenderer;
      if (cr && cr.channelId) {
        found.push({
          id: cr.channelId,
          name: text(cr.title),
          meta: [text(cr.subscriberCountText), text(cr.videoCountText)]
            .filter(Boolean)
            .join(" · "),
          avatar: fixUrl(cr.thumbnail && cr.thumbnail.thumbnails && cr.thumbnail.thumbnails[0] && cr.thumbnail.thumbnails[0].url),
          params: findUnsubParams(cr),
        });
      }

      // Newer "lockup" layout
      const lv = n.lockupViewModel;
      if (lv && /^UC[\w-]{22}$/.test(lv.contentId || "")) {
        const md = lv.metadata && lv.metadata.lockupMetadataViewModel;
        const rows =
          (md && md.metadata && md.metadata.contentMetadataViewModel &&
            md.metadata.contentMetadataViewModel.metadataRows) || [];
        const meta = rows
          .flatMap((r) => (r.metadataParts || []).map((p) => p.text && p.text.content))
          .filter(Boolean)
          .join(" · ");
        const img =
          lv.contentImage &&
          lv.contentImage.decoratedAvatarViewModel &&
          lv.contentImage.decoratedAvatarViewModel.avatar &&
          lv.contentImage.decoratedAvatarViewModel.avatar.avatarViewModel &&
          lv.contentImage.decoratedAvatarViewModel.avatar.avatarViewModel.image;
        found.push({
          id: lv.contentId,
          name: (md && md.title && md.title.content) || "",
          meta,
          avatar: fixUrl(img && img.sources && img.sources[0] && img.sources[0].url),
          params: findUnsubParams(lv),
        });
      }

      // Pagination token
      const t =
        (n.continuationItemRenderer &&
          n.continuationItemRenderer.continuationEndpoint &&
          n.continuationItemRenderer.continuationEndpoint.continuationCommand &&
          n.continuationItemRenderer.continuationEndpoint.continuationCommand.token) ||
        (n.nextContinuationData && n.nextContinuationData.continuation);
      if (t) token = t;
    });

    return { found, token };
  }

  // ---------- jobs ----------

  const paramsById = new Map();

  async function listChannels() {
    post({ type: "list-start" });
    const map = new Map();
    let body = { browseId: "FEchannels" };

    for (let page = 0; page < 300 && !stopFlag; page++) {
      const json = await api("browse", body);
      const { found, token } = extract(json);
      for (const c of found) {
        map.set(c.id, c);
        if (c.params) paramsById.set(c.id, c.params);
      }
      post({ type: "list-progress", count: map.size });
      if (!token) break;
      body = { continuation: token };
      await sleep(150);
    }

    if (!map.size) {
      throw new Error(
        "No subscribed channels were found. You may have no subscriptions, or YouTube changed its data format."
      );
    }
    const channels = [...map.values()].map(({ id, name, meta, avatar }) => ({
      id,
      name,
      meta,
      avatar,
    }));
    post({ type: "list-done", channels });
  }

  async function unsubscribe(ids) {
    post({ type: "unsub-start", total: ids.length });
    let done = 0;
    let failed = 0;
    let consecutive = 0;
    let lastError = "";

    for (const id of ids) {
      if (stopFlag) break;
      let ok = false;
      try {
        const body = { channelIds: [id] };
        const params = paramsById.get(id);
        if (params) body.params = params;
        await api("subscription/unsubscribe", body);
        ok = true;
      } catch (e) {
        lastError = e.message || String(e);
        console.warn("[ymu] unsubscribe failed", id, e);
      }
      if (ok) {
        done++;
        consecutive = 0;
      } else {
        failed++;
        consecutive++;
      }
      post({ type: "unsub-progress", id, ok, done, failed, total: ids.length, error: ok ? "" : lastError });
      if (consecutive >= 3) {
        post({
          type: "unsub-finished",
          done,
          failed,
          total: ids.length,
          stopped: true,
          error: `Stopped after 3 failures in a row. Last error: ${lastError}`,
        });
        return;
      }
      await sleep(500 + Math.random() * 800); // be gentle with YouTube
    }

    post({ type: "unsub-finished", done, failed, total: ids.length, stopped: stopFlag, error: "" });
  }

  async function run(fn, errType) {
    if (busy) return;
    busy = true;
    stopFlag = false;
    try {
      await fn();
    } catch (e) {
      post({ type: errType, error: e.message || String(e) });
    } finally {
      busy = false;
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.ymu !== "bridge") return;

    if (m.cmd === "hello") post({ type: "ready" });
    else if (m.cmd === "stop") stopFlag = true;
    else if (m.cmd === "list") run(listChannels, "list-error");
    else if (m.cmd === "unsub" && Array.isArray(m.ids)) {
      run(() => unsubscribe(m.ids), "job-error");
    }
  });

  post({ type: "ready" });
})();
