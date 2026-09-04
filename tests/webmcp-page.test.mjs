import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

import {
  runWebmcpPageOperation
} from "../plugins/safari-browser-use/server/src/webmcp-page.mjs";

function jsonResponse(body, status = 200, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const response = {
    status,
    ok: status >= 200 && status < 300,
    statusText: "OK",
    url: "https://example.com/api",
    headers: { get: name => name === "content-type" ? contentType : null },
    text: async () => text
  };
  response.clone = () => response;
  return response;
}

class FakeXhr {
  constructor() {
    this.listeners = {};
    this.responseType = "";
    this.status = 200;
    this.responseText = JSON.stringify({ xhr: true });
  }

  open() {}

  setRequestHeader() {}

  getResponseHeader(name) {
    return name === "content-type" ? "application/json" : null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  send() {
    for (const listener of this.listeners.loadend || []) {
      listener.call(this);
    }
  }
}

function createPage() {
  const window = new Window({ url: "https://example.com/app" });
  const calls = [];
  window.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(jsonResponse({ ok: true, url: String(input) }));
  };
  window.XMLHttpRequest = FakeXhr;

  return {
    window,
    calls,
    run(method, params = {}) {
      return runWebmcpPageOperation(window.document, window, method, params);
    }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test("install patches fetch once and drain returns kept captures", async () => {
  const page = createPage();
  const first = page.run("webmcp.install");
  const second = page.run("webmcp.install");

  assert.equal(first.already, false);
  assert.equal(second.already, true);
  assert.equal(page.run("webmcp.status").fetchPatched, true);

  await page.window.fetch("/api/items?page=1", {
    headers: { accept: "application/json", cookie: "secret" }
  });
  await page.window.fetch("/static/app.js");
  await settle();

  const drained = page.run("webmcp.drain");
  assert.equal(drained.captures.length, 1);
  assert.equal(drained.captures[0].url, "https://example.com/api/items?page=1");
  assert.equal(drained.captures[0].method, "GET");
  assert.equal("cookie" in drained.captures[0].requestHeaders, false);
  assert.equal(drained.captures[0].requestHeaders.accept, "application/json");
  assert.equal(page.run("webmcp.drain").captures.length, 0);
  assert.equal(page.run("webmcp.status").counters.fetchSeen, 2);
});

test("XHR traffic is captured through the prototype patch", async () => {
  const page = createPage();
  page.run("webmcp.install");

  const xhr = new page.window.XMLHttpRequest();
  xhr.open("POST", "https://api.example.com/graphql");
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.send(JSON.stringify({ operationName: "Feed", variables: {} }));

  const drained = page.run("webmcp.drain");
  assert.equal(drained.captures.length, 1);
  assert.equal(drained.captures[0].via, "xhr");
  assert.equal(drained.captures[0].requestContentType, "application/json");
  assert.match(drained.captures[0].requestBody, /Feed/);
});

test("uninstall restores the native fetch and XHR methods", async () => {
  const page = createPage();
  const nativeFetch = page.window.fetch;
  const nativeOpen = FakeXhr.prototype.open;
  page.run("webmcp.install");
  assert.notEqual(page.window.fetch, nativeFetch);

  const result = page.run("webmcp.uninstall");
  assert.equal(result.uninstalled, true);
  assert.equal(page.window.fetch, nativeFetch);
  assert.equal(FakeXhr.prototype.open, nativeOpen);
  assert.equal(page.run("webmcp.status").installed, false);
});

test("pending captures spill to sessionStorage and hand off on reinstall", async () => {
  const page = createPage();
  page.run("webmcp.install");
  await page.window.fetch("/api/one");
  await settle();

  page.window.dispatchEvent(new page.window.Event("pagehide"));
  const spilled = page.window.sessionStorage.getItem(
    "__safari_browser_use_webmcp_spill__"
  );
  assert.ok(spilled);
  assert.equal(JSON.parse(spilled).length, 1);

  // Simulate a fresh document that still shares the tab's sessionStorage.
  delete page.window.__safari_browser_use_webmcp_state__;
  delete page.window.__safari_browser_use_webmcp_captures__;
  const reinstalled = page.run("webmcp.install");
  assert.equal(reinstalled.handoff, 1);
  assert.equal(reinstalled.pending, 1);
  assert.equal(page.window.sessionStorage.getItem(
    "__safari_browser_use_webmcp_spill__"
  ), null);
});

test("execute replays through the native fetch and reports via callStatus", async () => {
  const page = createPage();
  page.run("webmcp.install");
  const started = page.run("webmcp.execute", {
    token: "t1",
    maxBytes: 5,
    request: {
      method: "GET",
      url: "https://example.com/api/items?page=2",
      headers: { accept: "application/json" }
    }
  });
  assert.equal(started.status, "pending");
  await settle();

  const done = page.run("webmcp.callStatus", { token: "t1" });
  assert.equal(done.status, "done");
  assert.equal(done.ok, true);
  assert.equal(done.httpStatus, 200);
  assert.equal(done.truncated, true);
  assert.equal(done.text.length, 5);
  assert.equal(page.calls.at(-1).init.credentials, "include");
  // Replays never re-enter the recorder.
  assert.equal(page.run("webmcp.drain").captures.length, 0);
  assert.equal(page.run("webmcp.callStatus", { token: "t1" }).status, "unknown");
});

test("execute reports fetch failures instead of throwing", async () => {
  const page = createPage();
  page.window.fetch = () => Promise.reject(new Error("offline"));
  page.run("webmcp.execute", {
    token: "t2",
    request: { method: "GET", url: "https://example.com/api" }
  });
  await settle();

  const result = page.run("webmcp.callStatus", { token: "t2" });
  assert.equal(result.status, "error");
  assert.equal(result.error, "offline");
});

test("pageTools reports that native WebMCP is unavailable", () => {
  const page = createPage();
  assert.deepEqual(page.run("webmcp.pageTools"), { available: false, tools: [] });
  assert.equal(page.run("webmcp.pageTools", { token: "p1" }).status, "done");
});

test("cross-origin replays retry without credentials after a network failure", async () => {
  const page = createPage();
  const attempts = [];
  page.window.fetch = (input, init) => {
    attempts.push(init.credentials);
    return init.credentials === "include"
      ? Promise.reject(new TypeError("Load failed"))
      : Promise.resolve(jsonResponse({ ok: true }));
  };
  page.run("webmcp.execute", {
    token: "t3",
    request: {
      method: "GET",
      url: "https://cdn.other.example/data.json",
      credentials: "include"
    }
  });
  await settle();
  await settle();

  const result = page.run("webmcp.callStatus", { token: "t3" });
  assert.deepEqual(attempts, ["include", "omit"]);
  assert.equal(result.status, "done");
  assert.equal(result.ok, true);
  assert.equal(result.retriedWithoutCredentials, true);
});

test("captures record the credentials mode of the original request", async () => {
  const page = createPage();
  page.run("webmcp.install");
  await page.window.fetch("https://api.other.example/items", { credentials: "include" });
  await page.window.fetch("/api/local");
  await settle();

  const captures = page.run("webmcp.drain").captures;
  assert.equal(captures[0].credentials, "include");
  assert.equal(captures[1].credentials, "same-origin");
});

test("JSON served without a content type is sniffed and telemetry is ignored", async () => {
  const page = createPage();
  page.window.fetch = input => Promise.resolve(
    jsonResponse(String(input).includes("plain") ? '{"sniffed":true}' : "<html></html>", 200, null)
  );
  page.run("webmcp.install");
  await page.window.fetch("/api/plain");
  await page.window.fetch("/api/html");
  await page.window.fetch("https://analytics.example.com/collect");
  await settle();

  const status = page.run("webmcp.status");
  const drained = page.run("webmcp.drain");
  assert.equal(drained.captures.length, 1);
  assert.equal(drained.captures[0].responseContentType, "application/json; sniffed");
  assert.equal(status.counters.filtered, 1);
  assert.equal(status.counters.fetchSeen, 3);
  assert.equal(Array.isArray(status.unseen), true);
});

test("probe re-requests unseen first-party GET URLs and keeps JSON responses", async () => {
  const page = createPage();
  const requested = [];
  page.window.fetch = (input, init) => {
    requested.push(String(input));
    const url = String(input);
    if (url.includes("/api/feed")) return Promise.resolve(jsonResponse({ items: [1, 2] }));
    if (url.includes("/api/signed")) return Promise.resolve(jsonResponse("forbidden", 403, "text/plain"));
    return Promise.resolve(jsonResponse("<html>", 200, "text/html"));
  };
  page.run("webmcp.install");

  const started = page.run("webmcp.probe", {
    token: "pr1",
    site: "example.com",
    urls: [
      "https://example.com/api/feed?page=1",
      "https://example.com/api/signed",
      "https://example.com/page.html",
      "https://cdn.other.net/data"
    ]
  });
  // page.html is a static asset and cdn.other.net is third-party: both skipped.
  assert.equal(started.total, 2);
  await settle();
  await settle();

  const done = page.run("webmcp.callStatus", { token: "pr1" });
  assert.equal(done.status, "done");
  assert.deepEqual(done.results.map(r => r.kept).sort(), [false, true]);
  assert.equal(requested.some(u => u.includes("cdn.other.net")), false);

  const drained = page.run("webmcp.drain");
  assert.equal(drained.captures.length, 1);
  assert.equal(drained.captures[0].via, "probe");
  assert.equal(drained.captures[0].url, "https://example.com/api/feed?page=1");

  // Second probe of the same URLs is a no-op.
  const again = page.run("webmcp.probe", { token: "pr2", site: "example.com", urls: ["https://example.com/api/feed?page=1"] });
  assert.equal(again.total, 0);
});
