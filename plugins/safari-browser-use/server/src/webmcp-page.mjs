// Page-side recorder and replay executor for Site API Tools.
//
// Like runPageOperation, this function is stringified and injected into
// the controlled Safari tab with `do JavaScript`, so it must stay
// self-contained. Persistent state lives on `window` because every call
// runs in a fresh closure. The fetch/XHR patch is installed once per
// document and re-installed by the session after navigation.

export function runWebmcpPageOperation(
  document,
  window,
  method,
  params = {}
) {
  const stateKey = "__safari_browser_use_webmcp_state__";
  const capturesKey = "__safari_browser_use_webmcp_captures__";
  const callsKey = "__safari_browser_use_webmcp_calls__";
  const spillKey = "__safari_browser_use_webmcp_spill__";
  const maxRequestBodyBytes = 256 * 1024;
  const maxResponseBodyBytes = 64 * 1024;
  const maxHeaderValueBytes = 4 * 1024;
  const maxSpillBytes = 512 * 1024;
  const maxBufferedCaptures = 400;
  const staticExtensions = new Set([
    "js", "mjs", "cjs", "css", "map",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "webm", "ogg", "wav", "m3u8", "ts",
    "pdf", "zip", "wasm", "html", "htm", "xml", "txt"
  ]);
  function isJsonish(contentType) {
    return Boolean(contentType) && /json/i.test(String(contentType));
  }

  function sniffsAsJson(text) {
    if (typeof text !== "string") {
      return false;
    }

    const head = text.slice(0, 64).replace(/^﻿/, "").trimStart();
    return head.startsWith("{") || head.startsWith("[");
  }

  function shouldCapturePre(requestMethod, url) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    const upper = String(requestMethod).toUpperCase();

    if (upper === "OPTIONS" || upper === "HEAD") {
      return false;
    }

    // Telemetry is not filtered here: the session scores endpoints from
    // their responses and hides the noise itself. Only obvious non-API
    // traffic (static assets) is skipped before it reaches the buffer.
    const lastSegment = url.pathname.split("/").pop() || "";
    const dot = lastSegment.lastIndexOf(".");

    if (dot > 0 && staticExtensions.has(
      lastSegment.slice(dot + 1).toLowerCase()
    )) {
      return false;
    }

    return true;
  }

  function shouldKeep(capture) {
    if (capture.status < 200 || capture.status >= 300) {
      return false;
    }

    if (isJsonish(capture.responseContentType)) {
      return true;
    }

    if (sniffsAsJson(capture.responseBody)) {
      capture.responseContentType = "application/json; sniffed";
      return true;
    }

    return (
      capture.requestBody !== undefined &&
      isJsonish(capture.requestContentType)
    );
  }

  function rememberSeen(url) {
    const state = window[stateKey];

    if (!state) {
      return;
    }

    state.seenUrls ??= [];
    const key = url.origin + url.pathname;

    if (!state.seenUrls.includes(key)) {
      state.seenUrls.push(key);

      if (state.seenUrls.length > 300) {
        state.seenUrls.shift();
      }
    }
  }

  // Requests the performance timeline saw but the patch did not: code that
  // bound `fetch` before recording started, or Service Worker traffic.
  // Returns full URLs (query included) so they can be probed later.
  function unseenEntries(options = {}) {
    const state = window[stateKey];

    if (!state) {
      return [];
    }

    const seen = new Set(state.seenUrls || []);
    const includeBeforeArm = options.includeBeforeArm === true;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
    const out = [];

    try {
      const entries = window.performance?.getEntriesByType?.("resource") || [];

      for (const entry of entries) {
        if (
          entry.initiatorType !== "fetch" &&
          entry.initiatorType !== "xmlhttprequest"
        ) {
          continue;
        }

        if (
          !includeBeforeArm &&
          entry.startTime + (window.performance.timeOrigin || 0) < state.installedAt
        ) {
          continue;
        }

        let url;

        try {
          url = new URL(entry.name, window.location.href);
        } catch (error) {
          continue;
        }

        const key = url.origin + url.pathname;

        if (seen.has(key) || !shouldCapturePre("GET", url)) {
          continue;
        }

        seen.add(key);
        out.push({ key, url: url.origin + url.pathname + url.search });

        if (out.length >= limit) {
          break;
        }
      }
    } catch (error) {
      return out;
    }

    return out;
  }

  function unseenUrls() {
    return unseenEntries().map(entry => entry.key);
  }

  // Probe unseen GET URLs from the page context so endpoints the patch could
  // not intercept still enter the catalog. Only 2xx JSON responses are kept.
  // Each URL is probed at most once per document.
  function probe() {
    const state = window[stateKey];
    const token = String(params.token || "");

    if (!state) {
      throw new Error("webmcp_probe_requires_recording");
    }

    if (!token) {
      throw new Error("webmcp_probe_token_required");
    }

    state.probed ??= [];
    const probed = new Set(state.probed);
    const sameSiteOnly = params.thirdParty !== true;
    const siteSuffix = String(params.site || "").toLowerCase();
    const isFirstParty = hostname =>
      !siteSuffix || hostname === siteSuffix || hostname.endsWith("." + siteSuffix);
    // Asset hosts and asset-like paths are never APIs; skip them so probing
    // does not spend requests on fonts, images, and bundles.
    const probeSkipHostRe =
      /^(static|cdn|cdnv?\d*|assets?|img|images?|fonts?|media|s3-|uploads?|errors?|sentry)[.-]/i;
    const probeSkipPathRe =
      /\/(uploads?|fonts?|font|webpack-artifacts|assets|static|_next\/static|bundles?)\/|\.(br|gz|woff2?|wasm)$|\.min\.[a-z-]+\.json/i;
    const explicit = Array.isArray(params.urls) ? params.urls : null;
    const toEntry = url => {
      try {
        const parsed = new URL(String(url), window.location.href);
        return { key: parsed.origin + parsed.pathname, url: parsed.href, parsed };
      } catch (error) {
        return null;
      }
    };
    const extra = (Array.isArray(params.extraUrls) ? params.extraUrls : [])
      .map(toEntry)
      .filter(Boolean);
    const discovered = explicit
      ? explicit.map(toEntry).filter(Boolean)
      : unseenEntries({ includeBeforeArm: true, limit: Number(params.limit) || 30 })
          .map(entry => ({ ...entry, parsed: new URL(entry.url) }));
    const seenKeys = new Set();
    const candidates = discovered.concat(extra).filter(entry => {
      if (seenKeys.has(entry.key)) {
        return false;
      }

      seenKeys.add(entry.key);
      return true;
    }).filter(entry =>
      !probed.has(entry.key) &&
      shouldCapturePre("GET", entry.parsed) &&
      !probeSkipHostRe.test(entry.parsed.hostname) &&
      !probeSkipPathRe.test(entry.parsed.pathname) &&
      (!sameSiteOnly || isFirstParty(entry.parsed.hostname))
    );

    const slot = { status: "pending", startedAt: Date.now(), total: candidates.length, results: [] };
    calls()[token] = slot;
    const fetchImpl = state.nativeFetch || window.fetch;
    const maxBytes = maxResponseBodyBytes;

    for (const entry of candidates) {
      probed.add(entry.key);
      state.probed.push(entry.key);
    }

    if (state.probed.length > 500) {
      state.probed.splice(0, state.probed.length - 500);
    }

    async function probeOne(entry) {
      const result = { url: entry.url.slice(0, 200), status: 0, kept: false };

      try {
        const response = await fetchImpl.call(window, entry.url, {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json, text/plain, */*" }
        });
        result.status = response.status;
        const responseContentType = response.headers.get("content-type") ?? undefined;
        result.contentType = responseContentType || null;
        let responseBody;

        if (response.ok && response.type !== "opaque") {
          responseBody = (await response.text()).slice(0, maxBytes);
        }

        const capture = {
          method: "GET",
          url: entry.url,
          requestHeaders: { accept: "application/json, text/plain, */*" },
          status: response.status,
          responseContentType,
          responseBody,
          timestamp: Date.now(),
          via: "probe",
          credentials: "include"
        };

        if (shouldKeep(capture)) {
          buffer().push(capture);
          count("kept");
          result.kept = true;
        } else {
          result.reason = response.ok ? "not_json" : "http_" + response.status;
        }
      } catch (error) {
        result.reason = error && error.message ? error.message : String(error);
      }

      slot.results.push(result);
    }

    (async () => {
      const queue = candidates.slice();
      const workers = [];

      for (let index = 0; index < Math.min(4, queue.length); index++) {
        workers.push((async () => {
          while (queue.length > 0) {
            await probeOne(queue.shift());
          }
        })());
      }

      await Promise.all(workers);
      slot.status = "done";
      slot.finishedAt = Date.now();
    })();

    if (candidates.length === 0) {
      slot.status = "done";
    }

    return { token, status: slot.status, total: candidates.length };
  }

  function buffer() {
    if (!Array.isArray(window[capturesKey])) {
      window[capturesKey] = [];
    }

    return window[capturesKey];
  }

  function calls() {
    if (!window[callsKey] || typeof window[callsKey] !== "object") {
      window[callsKey] = {};
    }

    return window[callsKey];
  }

  function counters() {
    const state = window[stateKey];

    if (state && !state.counters) {
      state.counters = { fetchSeen: 0, xhrSeen: 0, filtered: 0, kept: 0 };
    }

    return state ? state.counters : null;
  }

  function count(field) {
    const current = counters();

    if (current) {
      current[field] += 1;
    }
  }

  function noteDropped(capture) {
    const state = window[stateKey];

    if (!state) {
      return;
    }

    state.dropped ??= [];
    state.dropped.push({
      method: capture.method,
      url: String(capture.url).slice(0, 160),
      status: capture.status,
      contentType: capture.responseContentType || null
    });

    if (state.dropped.length > 8) {
      state.dropped.splice(0, state.dropped.length - 8);
    }
  }

  function push(capture) {
    if (!shouldKeep(capture)) {
      count("filtered");
      noteDropped(capture);
      return;
    }

    count("kept");

    const list = buffer();
    list.push(capture);

    if (list.length > maxBufferedCaptures) {
      list.splice(0, list.length - maxBufferedCaptures);
    }
  }

  function readSpill() {
    let storage;

    try {
      storage = window.sessionStorage;
    } catch (error) {
      return [];
    }

    try {
      const raw = storage.getItem(spillKey);

      if (!raw) {
        return [];
      }

      storage.removeItem(spillKey);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      try {
        storage.removeItem(spillKey);
      } catch (ignored) {
        // storage unavailable
      }

      return [];
    }
  }

  function writeSpill() {
    const list = buffer();

    if (list.length === 0) {
      return;
    }

    try {
      let payload = JSON.stringify(list);

      while (payload.length > maxSpillBytes && list.length > 1) {
        list.shift();
        payload = JSON.stringify(list);
      }

      window.sessionStorage.setItem(spillKey, payload);
    } catch (error) {
      // storage full or unavailable
    }
  }

  function collectHeaders(input, init) {
    const out = {};
    const add = headers => {
      headers.forEach((value, name) => {
        const lower = name.toLowerCase();

        if (lower !== "cookie") {
          out[lower] = String(value).slice(0, maxHeaderValueBytes);
        }
      });
    };

    try {
      if (window.Request && input instanceof window.Request) {
        add(input.headers);
      }

      if (init?.headers) {
        add(new window.Headers(init.headers));
      }
    } catch (error) {
      // malformed headers
    }

    return out;
  }

  function installFetchPatch(state) {
    const nativeFetch = window.fetch;
    state.nativeFetch = nativeFetch;

    window.fetch = function patchedFetch(input, init) {
      let url;
      let requestMethod = "GET";
      let credentials = "same-origin";
      count("fetchSeen");
      let requestHeaders = {};
      let requestBodyPromise = Promise.resolve(undefined);

      try {
        const isRequest = window.Request && input instanceof window.Request;
        const rawUrl = isRequest ? input.url : String(input);
        url = new URL(rawUrl, window.location.href);
        requestMethod = String(
          init?.method ?? (isRequest ? input.method : "GET")
        ).toUpperCase();
        credentials = String(
          init?.credentials ?? (isRequest ? input.credentials : "same-origin")
        );

        if (shouldCapturePre(requestMethod, url)) {
          rememberSeen(url);
          requestHeaders = collectHeaders(input, init);

          if (isJsonish(requestHeaders["content-type"])) {
            if (typeof init?.body === "string") {
              requestBodyPromise = Promise.resolve(
                init.body.slice(0, maxRequestBodyBytes)
              );
            } else if (isRequest && init?.body == null && !input.bodyUsed) {
              requestBodyPromise = input.clone().text()
                .then(text => text.slice(0, maxRequestBodyBytes))
                .catch(() => undefined);
            }
          }
        } else {
          url = undefined;
        }
      } catch (error) {
        url = undefined;
      }

      const responsePromise = nativeFetch.call(window, input, init);

      if (url !== undefined) {
        const capturedUrl = url;
        responsePromise.then(async response => {
          try {
            const responseContentType =
              response.headers.get("content-type") ?? undefined;
            let responseBody;

            // Read the body even without a JSON content type so JSON served
            // as text/plain or without headers can be sniffed.
            if (
              response.status >= 200 && response.status < 300 &&
              response.type !== "opaque"
            ) {
              responseBody = (await response.clone().text())
                .slice(0, maxResponseBodyBytes);
            }

            push({
              method: requestMethod,
              url: capturedUrl.origin + capturedUrl.pathname +
                capturedUrl.search,
              requestHeaders,
              requestBody: await requestBodyPromise,
              requestContentType: requestHeaders["content-type"],
              status: response.status,
              responseContentType,
              responseBody,
              timestamp: Date.now(),
              via: "fetch",
              credentials
            });
          } catch (error) {
            // capture must never break the page
          }
        }).catch(() => {});
      }

      return responsePromise;
    };
  }

  function installXhrPatch(state) {
    const proto = window.XMLHttpRequest?.prototype;

    if (!proto) {
      return;
    }

    const originalOpen = proto.open;
    const originalSetRequestHeader = proto.setRequestHeader;
    const originalSend = proto.send;
    const slot = "__safari_browser_use_webmcp_xhr__";
    state.xhr = { originalOpen, originalSetRequestHeader, originalSend };

    proto.open = function patchedOpen(requestMethod, url, ...rest) {
      try {
        this[slot] = {
          method: String(requestMethod).toUpperCase(),
          url: String(url),
          headers: {}
        };
      } catch (error) {
        // never break the page
      }

      return originalOpen.call(this, requestMethod, url, ...rest);
    };

    proto.setRequestHeader = function patchedSetRequestHeader(name, value) {
      try {
        const entry = this[slot];
        const lower = String(name).toLowerCase();

        if (entry && lower !== "cookie") {
          entry.headers[lower] = String(value).slice(0, maxHeaderValueBytes);
        }
      } catch (error) {
        // ignore
      }

      return originalSetRequestHeader.call(this, name, value);
    };

    proto.send = function patchedSend(body) {
      try {
        const entry = this[slot];

        if (entry && !entry.hooked) {
          entry.hooked = true;
          count("xhrSeen");

          if (typeof body === "string") {
            entry.body = body.slice(0, maxRequestBodyBytes);
          }

          this.addEventListener("loadend", () => {
            try {
              const url = new URL(entry.url, window.location.href);

              if (!shouldCapturePre(entry.method, url)) {
                return;
              }

              rememberSeen(url);

              let responseContentType;

              try {
                responseContentType =
                  this.getResponseHeader("content-type") ?? undefined;
              } catch (error) {
                responseContentType = undefined;
              }

              let responseBody;

              if (this.responseType === "" || this.responseType === "text") {
                responseBody = String(this.responseText)
                  .slice(0, maxResponseBodyBytes);
              } else if (this.responseType === "json" && this.response != null) {
                responseBody = JSON.stringify(this.response)
                  .slice(0, maxResponseBodyBytes);
                responseContentType ??= "application/json";
              } else if (
                this.responseType === "arraybuffer" &&
                this.response &&
                window.TextDecoder
              ) {
                const bytes = new Uint8Array(this.response);
                responseBody = new window.TextDecoder("utf-8", { fatal: false })
                  .decode(bytes.subarray(0, maxResponseBodyBytes));
              }

              push({
                method: entry.method,
                url: url.origin + url.pathname + url.search,
                requestHeaders: entry.headers,
                requestBody: entry.body,
                requestContentType: entry.headers["content-type"],
                status: this.status,
                responseContentType,
                responseBody,
                timestamp: Date.now(),
                via: "xhr",
                credentials: this.withCredentials ? "include" : "same-origin"
              });
            } catch (error) {
              // capture must never break the page
            }
          });
        }
      } catch (error) {
        // ignore
      }

      return originalSend.call(this, body);
    };
  }

  function missedBeforeArm() {
    try {
      const entries = window.performance?.getEntriesByType?.("resource") || [];
      const seen = new Set();
      const out = [];

      for (const entry of entries) {
        if (
          entry.initiatorType !== "fetch" &&
          entry.initiatorType !== "xmlhttprequest"
        ) {
          continue;
        }

        let url;

        try {
          url = new URL(entry.name, window.location.href);
        } catch (error) {
          continue;
        }

        if (!shouldCapturePre("GET", url)) {
          continue;
        }

        const key = url.origin + url.pathname;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        out.push(url.origin + url.pathname + url.search);

        if (out.length >= 40) {
          break;
        }
      }

      return out;
    } catch (error) {
      return [];
    }
  }

  function install() {
    const handoff = readSpill();

    if (handoff.length > 0) {
      buffer().push(...handoff);
    }

    if (window[stateKey]) {
      return {
        installed: true,
        already: true,
        handoff: handoff.length,
        pending: buffer().length
      };
    }

    const state = { installedAt: Date.now() };
    installFetchPatch(state);
    installXhrPatch(state);
    state.onPageHide = () => writeSpill();
    window.addEventListener("pagehide", state.onPageHide);

    // The default resource-timing buffer holds 250 entries and silently
    // stops recording once full, which hides later API calls from the
    // `unseen` diagnostics on busy pages.
    try {
      window.performance?.setResourceTimingBufferSize?.(2000);
      state.onBufferFull = () => {
        try {
          window.performance.setResourceTimingBufferSize(4000);
        } catch (error) {
          // ignore
        }
      };
      window.performance?.addEventListener?.(
        "resourcetimingbufferfull",
        state.onBufferFull
      );
    } catch (error) {
      // performance timeline unavailable
    }

    window[stateKey] = state;

    return {
      installed: true,
      already: false,
      handoff: handoff.length,
      pending: buffer().length,
      missedBeforeArm: missedBeforeArm()
    };
  }

  function uninstall() {
    const state = window[stateKey];

    if (!state) {
      return { uninstalled: false, pending: buffer().length };
    }

    try {
      if (state.nativeFetch) {
        window.fetch = state.nativeFetch;
      }

      if (state.xhr && window.XMLHttpRequest) {
        const proto = window.XMLHttpRequest.prototype;
        proto.open = state.xhr.originalOpen;
        proto.setRequestHeader = state.xhr.originalSetRequestHeader;
        proto.send = state.xhr.originalSend;
      }

      window.removeEventListener("pagehide", state.onPageHide);

      if (state.onBufferFull) {
        window.performance?.removeEventListener?.(
          "resourcetimingbufferfull",
          state.onBufferFull
        );
      }
    } finally {
      delete window[stateKey];
    }

    return { uninstalled: true, pending: buffer().length };
  }

  function drain() {
    const handoff = readSpill();
    const list = buffer();
    const captures = handoff.concat(list.splice(0, list.length));
    return { captures, handoff: handoff.length };
  }

  function resourceCounts() {
    const counts = { fetch: 0, xhr: 0 };

    try {
      for (const entry of window.performance?.getEntriesByType?.("resource") || []) {
        if (entry.initiatorType === "fetch") {
          counts.fetch += 1;
        } else if (entry.initiatorType === "xmlhttprequest") {
          counts.xhr += 1;
        }
      }
    } catch (error) {
      // performance timeline unavailable
    }

    return counts;
  }

  // Shares the document id key with runPageOperation so the session can
  // tell one document's recorder state from the next after navigation.
  function documentId() {
    const key = "__safari_browser_use_document_id__";

    if (!window[key]) {
      window[key] =
        `document-${Date.now().toString(36)}-` +
        Math.random().toString(36).slice(2);
    }

    return window[key];
  }

  function status() {
    return {
      documentId: documentId(),
      readyState: document.readyState,
      installed: Boolean(window[stateKey]),
      pending: buffer().length,
      calls: Object.keys(calls()).length,
      counters: counters() || { fetchSeen: 0, xhrSeen: 0, filtered: 0, kept: 0 },
      dropped: window[stateKey]?.dropped || [],
      unseen: unseenUrls(),
      resources: resourceCounts(),
      fetchPatched: Boolean(
        window[stateKey] && window.fetch !== window[stateKey].nativeFetch
      )
    };
  }

  function execute() {
    const request = params.request || {};
    const token = String(params.token || "");
    const maxBytes = Number(params.maxBytes) > 0
      ? Number(params.maxBytes)
      : 1024 * 1024;

    if (!token) {
      throw new Error("webmcp_call_token_required");
    }

    const state = window[stateKey];
    const fetchImpl = state?.nativeFetch || window.fetch;
    const slot = { status: "pending", startedAt: Date.now() };
    calls()[token] = slot;

    const controller = window.AbortController
      ? new window.AbortController()
      : null;
    slot.abort = () => controller?.abort();

    const init = {
      method: request.method || "GET",
      headers: request.headers || {},
      credentials: request.credentials || "include",
      signal: controller ? controller.signal : undefined
    };

    if (request.body !== undefined && request.body !== null) {
      init.body = request.body;
    }

    let crossOrigin = false;

    try {
      crossOrigin = new URL(String(request.url), window.location.href).origin !==
        window.location.origin;
    } catch (error) {
      crossOrigin = false;
    }

    function attempt(currentInit) {
      return fetchImpl.call(window, String(request.url), currentInit);
    }

    Promise.resolve()
      .then(() => attempt(init))
      .catch(error => {
        // A cross-origin replay that carried credentials can be refused by
        // CORS even though the page's own anonymous request succeeded.
        // Retry once without credentials before reporting failure.
        if (crossOrigin && init.credentials === "include" && !controller?.signal?.aborted) {
          slot.retriedWithoutCredentials = true;
          return attempt({ ...init, credentials: "omit" });
        }

        throw error;
      })
      .then(async response => {
        const contentType = response.headers.get("content-type") ?? "";
        let text = await response.text();
        const bytes = text.length;
        const truncated = bytes > maxBytes;

        if (truncated) {
          text = text.slice(0, maxBytes);
        }

        Object.assign(slot, {
          status: "done",
          ok: response.ok,
          httpStatus: response.status,
          statusText: response.statusText,
          url: response.url,
          contentType,
          bytes,
          truncated,
          text,
          finishedAt: Date.now()
        });
      })
      .catch(error => {
        Object.assign(slot, {
          status: "error",
          error: error && error.message ? error.message : String(error),
          finishedAt: Date.now()
        });
      });

    return { token, status: "pending" };
  }

  function callStatus() {
    const token = String(params.token || "");
    const slot = calls()[token];

    if (!slot) {
      return { token, status: "unknown" };
    }

    if (slot.status === "pending") {
      if (params.abort === true) {
        try {
          slot.abort?.();
        } catch (error) {
          // ignore
        }
      }

      return { token, status: "pending", elapsedMs: Date.now() - slot.startedAt };
    }

    if (params.consume !== false) {
      delete calls()[token];
    }

    const { abort, ...result } = slot;
    return { token, ...result };
  }

  function pageTools() {
    const token = String(params.token || "");
    const modelContext = document.modelContext;
    const available =
      Boolean(modelContext) &&
      typeof modelContext.registerTool === "function";

    if (!token) {
      return { available, tools: [] };
    }

    const slot = { status: "pending", startedAt: Date.now() };
    calls()[token] = slot;

    if (!available || typeof modelContext.getTools !== "function") {
      Object.assign(slot, { status: "done", available, tools: [] });
      return { token, status: "done", available };
    }

    Promise.resolve()
      .then(() => modelContext.getTools())
      .then(tools => {
        Object.assign(slot, {
          status: "done",
          available,
          tools: (tools || []).map(tool => ({
            name: tool.name,
            description: String(tool.description ?? ""),
            inputSchema: tool.inputSchema
          }))
        });
      })
      .catch(error => {
        Object.assign(slot, {
          status: "error",
          available,
          error: error && error.message ? error.message : String(error)
        });
      });

    return { token, status: "pending", available };
  }

  switch (method) {
    case "webmcp.install":
      return install();
    case "webmcp.uninstall":
      return uninstall();
    case "webmcp.drain":
      return drain();
    case "webmcp.status":
      return status();
    case "webmcp.execute":
      return execute();
    case "webmcp.callStatus":
      return callStatus();
    case "webmcp.pageTools":
      return pageTools();
    case "webmcp.probe":
      return probe();
    default:
      throw new Error(`unsupported_webmcp_method: ${method}`);
  }
}
