import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayRequest,
  createWebmcpStore,
  emptySite,
  fillTemplate,
  inferSchema,
  isSensitiveName,
  matchSnapshot,
  mergeCapture,
  applySkeleton,
  dynamicToolName,
  formatSuggestions,
  scoreEndpoint,
  skeletonFor,
  snapshotTexts,
  toMcpTool,
  mergeSchemas,
  parseUrl,
  pickPaths,
  redactHeaders,
  shouldCapturePre,
  shouldKeep,
  siteKeyFor,
  templatePath,
  toDescriptor,
  toExportDescriptor,
  toolNameFor
} from "../plugins/safari-browser-use/server/src/webmcp-catalog.mjs";

function capture(overrides = {}) {
  return {
    method: "GET",
    url: "https://api.example.com/v1/users/123/posts?page=2&limit=20",
    requestHeaders: {
      accept: "application/json",
      authorization: "Bearer secret-token",
      "x-csrf-token": "abc"
    },
    status: 200,
    responseContentType: "application/json; charset=utf-8",
    responseBody: JSON.stringify({ items: [{ id: 1 }], total: 1 }),
    timestamp: 1_700_000_000_000,
    ...overrides
  };
}

test("parseUrl works without the URL global", () => {
  const url = parseUrl("https://user@API.Example.com:8443/v1/a%20b?x=1&y=two+words#frag");

  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "api.example.com:8443");
  assert.equal(url.hostname, "api.example.com");
  assert.equal(url.origin, "https://api.example.com:8443");
  assert.equal(url.pathname, "/v1/a%20b");
  assert.equal(url.search, "?x=1&y=two+words");
  assert.deepEqual(url.searchParams, [["x", "1"], ["y", "two words"]]);
  assert.throws(() => parseUrl("not a url"), /invalid_url/);
});

test("site keys group subdomains and respect second-level public suffixes", () => {
  assert.equal(siteKeyFor("app.example.com"), "example.com");
  assert.equal(siteKeyFor("example.com"), "example.com");
  assert.equal(siteKeyFor("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteKeyFor("shop.taobao.com.cn"), "taobao.com.cn");
  assert.equal(siteKeyFor("localhost"), "localhost");
  assert.equal(siteKeyFor("127.0.0.1"), "127.0.0.1");
});

test("capture filters drop static assets and non-JSON failures", () => {
  assert.equal(shouldCapturePre("GET", parseUrl("https://a.com/app.js")), false);
  assert.equal(shouldCapturePre("GET", parseUrl("https://www.google-analytics.com/collect")), true);
  assert.equal(shouldCapturePre("OPTIONS", parseUrl("https://a.com/api")), false);
  assert.equal(shouldCapturePre("GET", parseUrl("https://a.com/api/items")), true);
  assert.equal(shouldKeep(capture({ status: 404 })), false);
  assert.equal(shouldKeep(capture({ responseContentType: "text/html", responseBody: "<html>" })), false);
  assert.equal(shouldKeep(capture({
    status: 204,
    responseContentType: undefined,
    requestBody: "{}",
    requestContentType: "application/json"
  })), true);
});

test("templates numeric, uuid, hash and GraphQL query id segments", () => {
  const result = templatePath(
    "/api/users/123/posts/9f8e7d6c-1234-4abc-9def-0123456789ab/rev/abcdef0123456789abcdef"
  );

  assert.equal(
    result.templatePath,
    "/api/users/{userId}/posts/{postId}/rev/{revId}"
  );
  assert.deepEqual(result.pathParams.map(param => param.kind), [
    "numeric", "uuid", "hash"
  ]);

  const graphql = templatePath("/i/api/graphql/qjhLfJKwuRiKMQ6zBgkfYQ/HomeTimeline");
  assert.equal(graphql.templatePath, "/i/api/graphql/{queryId}/HomeTimeline");
  assert.equal(fillTemplate("/a/{id}", { id: "x y" }), "/a/x%20y");
  assert.throws(() => fillTemplate("/a/{id}", {}), /missing required path parameter/);
});

test("schema inference widens across observations", () => {
  const first = inferSchema({ a: 1, b: "x", c: null });
  const second = inferSchema({ a: 2.5, c: true });
  const merged = mergeSchemas(first, second);

  assert.deepEqual(merged.required, ["a", "c"]);
  assert.equal(merged.properties.a.type, "number");
  assert.equal(merged.properties.b.type, "string");
  assert.equal(merged.properties.c.type, "boolean");
});

test("tool names are stable and unique per site", () => {
  const existing = new Set();
  const first = toolNameFor("GET", "/api/users/{userId}/posts", undefined, existing);
  existing.add(first);
  const second = toolNameFor("GET", "/api/users/{userId}/posts", undefined, existing);
  existing.add(second);
  const third = toolNameFor("POST", "/graphql", "HomeTimeline", existing);

  assert.equal(first, "get_api_users_posts");
  assert.equal(second, "get_api_users_posts_by_userid");
  assert.equal(third, "post_graphql_home_timeline");
});

test("captures aggregate into a WebMCP descriptor with redacted metadata", () => {
  const site = emptySite("example.com");
  mergeCapture(site, capture());
  mergeCapture(site, capture({
    url: "https://api.example.com/v1/users/456/posts?page=3",
    timestamp: 1_700_000_001_000
  }));

  const endpoint = Object.values(site.endpoints)[0];
  const descriptor = toDescriptor("example.com", endpoint);

  assert.equal(descriptor.name, "get_v1_users_posts");
  assert.equal(descriptor.annotations.readOnlyHint, true);
  assert.equal(descriptor.annotations.untrustedContentHint, true);
  assert.deepEqual(descriptor.inputSchema.required, ["userId", "page"]);
  assert.equal(descriptor.inputSchema.properties.limit.type, "integer");
  assert.deepEqual(descriptor.meta.replayHeaders.sort(), [
    "accept", "authorization", "x-csrf-token"
  ]);
  assert.match(descriptor.description, /GET \/v1\/users\/\{userId\}\/posts on api.example.com/);
  assert.equal(JSON.stringify(descriptor).includes("secret-token"), false);

  const exported = toExportDescriptor("example.com", endpoint);
  assert.equal("replayHeaders" in exported.meta, false);
  assert.equal("paramDefaults" in exported.meta, false);
});

test("replay requests fill defaults and merge partial bodies", () => {
  const site = emptySite("example.com");
  mergeCapture(site, capture({
    method: "POST",
    url: "https://api.example.com/v1/search?crumb=SESSION123",
    requestContentType: "application/json",
    requestBody: JSON.stringify({ query: "old", sortBy: "date", sessionId: "s1" })
  }));
  const endpoint = Object.values(site.endpoints)[0];
  const request = buildReplayRequest(endpoint, { body: { query: "new" } });

  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.example.com/v1/search?crumb=SESSION123");
  assert.deepEqual(JSON.parse(request.body), {
    query: "new", sortBy: "date", sessionId: "s1"
  });
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.authorization, "Bearer secret-token");
  assert.equal("cookie" in request.headers, false);

  const getSite = emptySite("example.com");
  mergeCapture(getSite, capture());
  const getRequest = buildReplayRequest(
    Object.values(getSite.endpoints)[0],
    { userId: "999", page: 7 }
  );
  assert.equal(
    getRequest.url,
    "https://api.example.com/v1/users/999/posts?page=7&limit=20"
  );
  assert.equal(getRequest.body, undefined);
});

test("sensitive names are redacted for agent output", () => {
  assert.equal(isSensitiveName("Authorization"), true);
  assert.equal(isSensitiveName("x-csrf-token"), true);
  assert.equal(isSensitiveName("accept"), false);
  assert.deepEqual(
    redactHeaders({ accept: "a", authorization: "b" }),
    { accept: "a", authorization: "«redacted»" }
  );
});

test("pickPaths selects nested fields and wildcards", () => {
  const value = { data: { items: [{ id: 1, t: "a" }, { id: 2, t: "b" }], page: 3 } };

  assert.deepEqual(pickPaths(value, ["data.items[*].id", "data.page", "missing.x"]), {
    "data.items[*].id": [1, 2],
    "data.page": 3,
    "missing.x": undefined
  });
  assert.equal(pickPaths(value, []), value);
});

test("session store tracks recording tabs and exports without secrets", () => {
  const store = createWebmcpStore(() => 42);
  store.record("1:2", "example.com");
  assert.equal(store.mergeCaptures("example.com", [capture(), { junk: true }]), 1);
  assert.deepEqual(store.recordingTabIds(), ["1:2"]);

  store.retarget("1:2", "1:3");
  assert.deepEqual(store.recordingTabIds(), ["1:3"]);
  assert.equal(store.recording("1:2"), null);

  const compact = store.listTools("example.com", { compact: true });
  assert.equal(compact.length, 1);
  assert.equal(compact[0].readOnlyHint, true);

  const exported = store.exportSite("example.com");
  assert.equal(exported.format, "webmcp-tools");
  assert.equal(JSON.stringify(exported).includes("secret-token"), false);

  const request = store.buildRequest("example.com", compact[0].name, {});
  assert.equal(request.url, "https://api.example.com/v1/users/123/posts?page=2&limit=20");

  assert.throws(() => store.describe("example.com", "nope"), /webmcp_unknown_tool/);
  assert.equal(store.stop("1:3"), true);
  store.reset();
  assert.deepEqual(store.sites(), []);
});

test("first-party endpoints sort ahead of third-party ones", () => {
  const store = createWebmcpStore(() => 1);
  store.mergeCaptures("example.com", [
    capture({ url: "https://cdn.vendor.net/anim.json", timestamp: 3 }),
    capture({ url: "https://api.example.com/v1/feed", timestamp: 1, credentials: "same-origin" })
  ]);

  const tools = store.listTools("example.com", { compact: true, all: true });
  assert.deepEqual(tools.map(tool => [tool.host, tool.firstParty]), [
    ["api.example.com", true],
    ["cdn.vendor.net", false]
  ]);

  const request = store.buildRequest("example.com", tools[0].name, {});
  assert.equal(request.credentials, "same-origin");
  assert.equal(store.describe("example.com", tools[0].name).meta.firstParty, true);
});

test("GraphQL query documents over POST are read-only, overrides are honoured", () => {
  const store = createWebmcpStore(() => 1);
  store.mergeCaptures("example.com", [
    capture({
      method: "POST",
      url: "https://api.example.com/graphql",
      requestContentType: "application/json",
      requestBody: JSON.stringify({ operationName: "Feed", query: "query Feed { feed { id } }" })
    }),
    capture({
      method: "POST",
      url: "https://api.example.com/graphql",
      requestContentType: "application/json",
      requestBody: JSON.stringify({ operationName: "Like", query: "mutation Like { like { id } }" })
    }),
    capture({
      method: "POST",
      url: "https://api.example.com/youtubei/v1/browse",
      requestContentType: "application/json",
      requestBody: JSON.stringify({ browseId: "FEwhat_to_watch" })
    })
  ]);

  const tools = Object.fromEntries(
    store.listTools("example.com", { all: true }).map(tool => [tool.name, tool])
  );
  assert.equal(tools.post_graphql_feed.annotations.readOnlyHint, true);
  assert.equal(tools.post_graphql_like.annotations.readOnlyHint, false);
  assert.equal(tools.post_youtubei_v1_browse.annotations.readOnlyHint, false);

  const marked = store.setReadOnly("example.com", "post_youtubei_v1_browse", true);
  assert.equal(marked.annotations.readOnlyHint, true);
  assert.equal(
    store.describe("example.com", "post_youtubei_v1_browse").annotations.readOnlyHint,
    true
  );
});

test("recording entries follow the tab identity and the tab's current site", () => {
  const store = createWebmcpStore(() => 1);
  const identity = { id: "1:5", url: "https://a.example.com/" };
  store.record("1:5", "example.com", identity);

  identity.id = "1:4"; // an earlier tab closed and the index shifted
  assert.equal(store.recording("1:4"), null);
  assert.equal(store.syncIdentity(identity).site, "example.com");
  assert.ok(store.recording("1:4"));
  assert.equal(store.recording("1:5"), null);
  assert.equal(store.syncIdentity(null), null);

  store.setSite("1:4", "other.org");
  assert.equal(store.recording("1:4").site, "other.org");
  assert.deepEqual(store.sites().map(site => site.site).sort(), ["example.com", "other.org"]);
});

test("nothing is filtered by host or path; JSON bodies are sniffed", () => {
  assert.equal(shouldCapturePre("POST", parseUrl("https://zhihu-web-analytics.zhihu.com/api/v2/za/logs/batch")), true);
  assert.equal(shouldCapturePre("POST", parseUrl("https://x.com/i/api/1.1/promoted_content/log.json")), true);
  assert.equal(shouldKeep({ status: 200, responseContentType: undefined, responseBody: ' \n{"a":1}' }), true);
  assert.equal(shouldKeep({ status: 200, responseContentType: "text/plain", responseBody: "[1,2]" }), true);
  assert.equal(shouldKeep({ status: 200, responseContentType: undefined, responseBody: "<html>" }), false);
});


function feedCapture(overrides = {}) {
  return capture({
    url: "https://api.example.com/v1/feed?page=1",
    responseBody: JSON.stringify({
      items: [
        { id: 1, title: "Safari 26 ships WebMCP recorder" },
        { id: 2, title: "How JXA lost its URL global" },
        { id: 3, title: "Probing unseen endpoints" }
      ],
      total: 3
    }),
    ...overrides
  });
}

test("endpoints are scored from their responses alone; acknowledgements land in the noise tier", () => {
  const site = emptySite("example.com");
  mergeCapture(site, feedCapture());
  mergeCapture(site, capture({
    method: "POST",
    url: "https://analytics.example.com/collect",
    requestContentType: "application/json",
    requestBody: "{\"event\":\"view\"}",
    responseBody: "{}"
  }));
  mergeCapture(site, capture({
    url: "https://api.example.com/v1/config",
    responseBody: JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 })
  }));

  const byName = Object.fromEntries(
    Object.values(site.endpoints).map(e => [e.toolName, scoreEndpoint("example.com", e)])
  );
  assert.equal(byName.get_v1_feed.tier, "data");
  assert.ok(byName.get_v1_feed.reasons.includes("list(3)"));
  assert.equal(byName.post_collect.tier, "noise");
  assert.equal(byName.get_v1_config.tier, "config");

  const store = createWebmcpStore(() => 1);
  store.mergeCaptures("example.com", [feedCapture(), capture({
    method: "POST", url: "https://analytics.example.com/collect",
    requestContentType: "application/json", requestBody: "{}", responseBody: "{}"
  })]);
  assert.deepEqual(store.listTools("example.com", { compact: true }).map(t => t.name), ["get_v1_feed"]);
  assert.equal(store.listTools("example.com", { compact: true, all: true }).length, 2);
  store.setTier("example.com", "post_collect", "data");
  assert.equal(store.listTools("example.com", { compact: true }).length, 2);
});

test("snapshot texts are matched against response samples", () => {
  const store = createWebmcpStore(() => 1);
  store.mergeCaptures("example.com", [feedCapture(), capture({
    url: "https://api.example.com/v1/me",
    responseBody: JSON.stringify({ name: "Jack", plan: "pro" })
  })]);
  const snapshot = [
    "- main:",
    '  - heading "Latest"',
    '  - link "Safari 26 ships WebMCP recorder"',
    '  - link "How JXA lost its URL global"',
    "  - text: Probing unseen endpoints",
    '  - button "Load more"'
  ].join("\n");

  assert.deepEqual(snapshotTexts(snapshot).sort(), [
    "How JXA lost its URL global", "Latest", "Load more",
    "Probing unseen endpoints", "Safari 26 ships WebMCP recorder"
  ]);
  const suggestions = store.suggest("example.com", snapshot);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].name, "get_v1_feed");
  assert.equal(suggestions[0].matched, 3);
  assert.equal(suggestions[0].items, 3);
  assert.match(formatSuggestions(suggestions), /# webmcp: get_v1_feed .*matched 3\/5 visible texts, returns 3 items/);
  assert.equal(formatSuggestions([]), "");
  assert.deepEqual(matchSnapshot("example.com", [], snapshot), []);
});

test("site memory keeps endpoint skeletons without credentials or samples", () => {
  const store = createWebmcpStore(() => 42);
  store.mergeCaptures("example.com", [feedCapture({
    url: "https://api.example.com/v1/feed?page=2&token=SECRET&limit=10"
  })]);
  const skeleton = store.skeleton("example.com");
  const text = JSON.stringify(skeleton);

  assert.equal(skeleton.format, "webmcp-site-memory");
  assert.equal(skeleton.endpoints.length, 1);
  assert.equal(skeleton.endpoints[0].probeUrl, "https://api.example.com/v1/feed?page=2&limit=10");
  assert.equal(text.includes("SECRET"), false);
  assert.equal(text.includes("secret-token"), false);
  assert.equal(text.includes("Safari 26 ships"), false);
  assert.equal(skeleton.endpoints[0].sessions, 1);

  const fresh = createWebmcpStore(() => 43);
  assert.equal(fresh.remember("example.com", skeleton), 1);
  assert.deepEqual(fresh.rememberedProbeUrls("example.com"), [
    "https://api.example.com/v1/feed?page=2&limit=10"
  ]);
  assert.deepEqual(fresh.listTools("example.com"), []);
  assert.equal(fresh.listTools("example.com", { includeRemembered: true, compact: true })[0].remembered, true);
  assert.equal(fresh.skeleton("example.com").endpoints[0].sessions, 1);

  fresh.mergeCaptures("example.com", [feedCapture()]);
  assert.equal(fresh.rememberedProbeUrls("example.com").length, 0);
  assert.equal(fresh.skeleton("example.com").endpoints[0].sessions, 2);
  assert.equal(applySkeleton(emptySite("x"), { format: "other" }), 0);
});

test("data-bearing read endpoints become MCP tools with stable names", () => {
  const store = createWebmcpStore(() => 1);
  store.mergeCaptures("shop.example.co.uk", [
    feedCapture({ url: "https://api.shop.example.co.uk/v1/orders/123/items?page=1" }),
    capture({ method: "POST", url: "https://api.shop.example.co.uk/v1/orders", requestContentType: "application/json", requestBody: "{\"x\":1}", responseBody: JSON.stringify({ items: [1, 2, 3] }) })
  ]);
  const tools = store.mcpTools();

  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool.name, "web__shop_example_co_uk__get_v1_orders_items");
  assert.equal(tools[0].tool.annotations.readOnlyHint, true);
  assert.ok(tools[0].tool.inputSchema.properties._pick);
  assert.deepEqual(tools[0].tool.inputSchema.required, ["orderId", "page"]);
  assert.ok(dynamicToolName("a.b", "x".repeat(100)).length <= 64);
  assert.match(store.exposureSignature(), /web__shop_example_co_uk__get_v1_orders_items/);
  const endpoint = store.endpoint("shop.example.co.uk", "get_v1_orders_items");
  assert.equal(toMcpTool("shop.example.co.uk", endpoint).description.includes("untrusted"), true);
});
