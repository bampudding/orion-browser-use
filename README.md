# Orion Browser Use

An Orion port developed in the [Safari Browser Use](https://github.com/citrolabs/safari-browser-use) fork. The original Safari implementation and history remain in this repository; [README.upstream.md](README.upstream.md) documents that project. Both projects are covered by the original [MIT license](LICENSE).

This port controls an existing Orion window through macOS Apple Events and Orion's `do JavaScript` command. It exposes a persistent MCP JavaScript REPL with `js` and `js_reset`, plus the `control-orion` Agent Skill. It uses no browser extension, agent-browser, or Playwright.

**Requirements:** macOS, Orion with an open window, Node.js 20 or newer, and macOS Automation permission for the client launching the MCP server. `browser.doctor()` checks whether page JavaScript is available. Tested against Orion 1.1.2 on macOS.

## Install

### Codex plugin and bundled Skill

```sh
codex plugin marketplace add bampudding/orion-browser-use
codex plugin add orion-browser-use@bampudding
```

Start a new Codex task after installation. The plugin includes `control-orion` and the two MCP tools.

### Standalone Agent Skill

```sh
npx skills add bampudding/orion-browser-use --skill control-orion -g
```

The Skill instructs an agent to use the MCP server. It does not start or install the server by itself.

### OpenCode

When working in this clone, the included [opencode.json](opencode.json) starts the MCP server. For other projects, merge [examples/opencode.json](examples/opencode.json) into your project `opencode.json` or global `~/.config/opencode/opencode.json`. Replace `/ABSOLUTE/PATH/TO/orion-browser-use` with your clone path. OpenCode discovers a Skill installed in `~/.agents/skills/control-orion` or `~/.config/opencode/skills/control-orion`.

### Google Antigravity

When working in this clone, the included [.agents/mcp_config.json](.agents/mcp_config.json) starts the MCP server. For other projects, merge [examples/antigravity-mcp_config.json](examples/antigravity-mcp_config.json) into `~/.gemini/config/mcp_config.json` or the MCP config opened from Antigravity settings. Replace the absolute path. Install `skills/control-orion` into `~/.gemini/config/skills/control-orion` for global use. Restart or refresh MCP servers and Skills in Antigravity.

### Other MCP clients

Run `node /absolute/path/to/plugins/orion-browser-use/server/index.mjs` as a local stdio MCP server and install `skills/control-orion` where that client discovers Agent Skills. The server uses newline-delimited JSON-RPC on stdio and has no runtime package dependencies.

## Use

In the `js` MCP tool, call `browser.doctor()` and `browser.documentation()` first. The main API is `browser.tabs.list()`, `browser.tabs.active()`, `browser.tabs.open(url)`, `browser.tabs.activate(ref)`, `browser.tabs.navigate(url, ref)`, `browser.tabs.close(ref)`, `browser.page.snapshot(ref)`, and `browser.page.evaluate(code, ref)`, and CSS locators via `browser.page.locator(css, ref)` with `count`, `text`, `click`, `fill`, `check`, `selectOption`, `scrollIntoView`, and bounded `waitFor`. Mutating locators require a unique match and dispatch DOM input/change events. These do not synthesize trusted hardware input; read the resulting page state to verify each action. Tab references contain `windowIndex` and `tabIndex` and can become stale when tabs move. Use a new task tab for independent browsing and close it when done.

This initial Orion port supports tab operations and synchronous page JavaScript. It does not expose screenshot, console, network capture, or Safari MCP's other debugging tools.

## Verification

The repository validates the Codex plugin manifest and Skill metadata with Codex's validators. The MCP server can be checked by issuing `initialize`, `tools/list`, and `tools/call` requests over stdio. A live Orion check should open a task tab, read a snapshot, evaluate `document.title`, switch between task tabs, and close them. Do not use existing user tabs for a smoke test.
