import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const templateUrl = new URL(
  "../plugins/safari-browser-use/server/src/jxa-server.template.js",
  import.meta.url
);
const documentationUrl = new URL(
  "../plugins/safari-browser-use/server/src/documentation.md",
  import.meta.url
);

async function loadOpenTab() {
  const template = await readFile(templateUrl, "utf8");
  const source = template.match(
    /  function tabMetadata[\s\S]*?\n  function readBackgroundPageSource/
  )?.[0];

  assert.ok(source, "expected to find Safari tab helpers");

  const context = {
    collectTabs() {},
    result: null,
    safari: null
  };

  vm.runInNewContext(
    source.replace(/\n  function readBackgroundPageSource$/, ""),
    context
  );

  return context;
}

function createWindow(id) {
  let activeTab = createTab("about:start", 1);
  let activationCount = 0;
  const tabs = [activeTab];
  const tabsAccessor = () => tabs;
  tabsAccessor.push = tab => tabs.push(tab);
  const window = {
    id: () => id,
    tabs: tabsAccessor
  };

  Object.defineProperty(window, "currentTab", {
    get() {
      return () => activeTab;
    },
    set(tab) {
      activeTab = tab;
      activationCount += 1;
    }
  });

  return {
    window,
    tabs,
    get activationCount() {
      return activationCount;
    }
  };
}

function createTab(url, index) {
  let closeCount = 0;

  return {
    close: () => {
      closeCount += 1;
    },
    closeCount: () => closeCount,
    index: () => index,
    name: () => "",
    url: () => url
  };
}

test("opens an inactive tab in the current Safari window by default", async () => {
  const context = await loadOpenTab();
  const user = createWindow(101);

  context.safari = {
    Document: () => ({ make() {} }),
    Tab: ({ url }) => createTab(url, 2),
    windows: () => [user.window]
  };

  const result = context.openTab({});

  assert.equal(user.tabs.length, 2);
  assert.equal(user.activationCount, 0);
  assert.equal(result.id, "101:2");
});

test("opens an inactive tab only in the requested Safari window", async () => {
  const context = await loadOpenTab();
  const user = createWindow(101);
  const worker = createWindow(202);

  context.safari = {
    Document: () => ({ make() {} }),
    Tab: ({ url }) => createTab(url, 2),
    windows: () => [user.window, worker.window]
  };

  const result = context.openTab({ windowId: 202, active: false });

  assert.equal(user.tabs.length, 1);
  assert.equal(worker.tabs.length, 2);
  assert.equal(worker.activationCount, 0);
  assert.equal(result.id, "202:2");
});

test("does not fall back when the requested Safari window is missing", async () => {
  const context = await loadOpenTab();
  const user = createWindow(101);

  context.safari = {
    Document: () => ({ make() {} }),
    Tab: ({ url }) => createTab(url, 2),
    windows: () => [user.window]
  };

  assert.throws(
    () => context.openTab({ windowId: 999, active: false }),
    /Safari window not found: 999/
  );
  assert.equal(user.tabs.length, 1);
  assert.equal(user.activationCount, 0);
});

test("opens an inactive tab without requiring a Safari window ID", async () => {
  const context = await loadOpenTab();
  const user = createWindow(101);

  context.safari = {
    Document: () => ({ make() {} }),
    Tab: ({ url }) => createTab(url, 2),
    windows: () => [user.window]
  };

  const result = context.openTab({ active: false });

  assert.equal(result.id, "101:2");
  assert.equal(user.tabs.length, 2);
  assert.equal(user.activationCount, 0);
});

test("closes a background task tab without changing the selected tab", async () => {
  const context = await loadOpenTab();
  const user = createWindow(101);
  const taskTab = createTab("https://example.com/task", 2);
  user.tabs.push(taskTab);

  context.safari = {
    windows: () => [user.window]
  };

  context.closeTab("101:2");

  assert.equal(taskTab.closeCount(), 1);
  assert.equal(user.activationCount, 0);
});

test("refuses to close the selected Safari tab", async () => {
  const context = await loadOpenTab();
  const user = createWindow(101);
  const selectedTab = user.tabs[0];

  context.safari = {
    windows: () => [user.window]
  };

  assert.throws(
    () => context.closeTab("101:1"),
    /Refusing to close the selected Safari tab/
  );
  assert.equal(selectedTab.closeCount(), 0);
  assert.equal(user.activationCount, 0);
});

test("browser.tabs.new defaults to a background tab", async () => {
  const template = await readFile(templateUrl, "utf8");
  const body = template.match(
    /      new: function[^\{]*\{([\s\S]*?)\n      \}\n    \}\)/
  )?.[1];

  assert.ok(body, "expected to find browser.tabs.new");

  const calls = [];
  const context = {
    callSafari(method, params) {
      calls.push({ method, params });
      return { id: "202:2", title: "", url: "about:blank" };
    },
    options: {},
    result: null,
    wrapTab: value => value
  };

  vm.runInNewContext(
    `result = (function (options) {${body}\n})(options);`,
    context
  );

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      method: "tabs.open",
      params: { active: false }
    }
  ]);
});

test("documents non-disruptive task-tab creation and cleanup", async () => {
  const documentation = await readFile(documentationUrl, "utf8");

  assert.match(
    documentation,
    /browser\.tabs\.new\(\{\s*active:\s*false\s*\}\)/
  );
  assert.match(documentation, /selected tab remains unchanged/i);
  assert.match(documentation, /close.*by default/is);
  assert.match(documentation, /keep.*user.*(?:view|inspect)/is);
  assert.match(documentation, /does not expose inactive Tab Groups/i);
});
