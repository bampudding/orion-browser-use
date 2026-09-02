import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

test("README one-line prompt routes every supported plugin client", async () => {
  const readme = await readFile(
    new URL("README.md", repositoryRoot),
    "utf8"
  );
  const pluginSection = readme.slice(
    readme.indexOf("### 1. Plugin — one-line prompt"),
    readme.indexOf("### 2. Skill — one-line command")
  );
  const prompt = pluginSection.match(/```text\n([\s\S]*?)\n```/)?.[1];

  assert.ok(prompt, "the plugin section must contain one text prompt");
  assert.match(prompt, /safari-browser-use/);
  assert.match(prompt, /https:\/\/github\.com\/citrolabs\/safari-browser-use/);
  assert.match(prompt, /Codex/i);
  assert.match(prompt, /Claude Code/i);
  assert.match(prompt, /GitHub Copilot CLI/i);
  assert.match(prompt, /CodeBuddy/i);
  assert.match(prompt, /WorkBuddy/i);
  assert.match(prompt, /Qoder/i);
  assert.match(prompt, /Cursor/i);
  assert.match(prompt, /Kiro/i);
  assert.match(prompt, /marketplace/i);
  assert.match(prompt, /local/i);
  assert.match(prompt, /Power|Import/i);
  assert.match(prompt, /verify|确认/i);
});

test("README gives executable installation routes for every plugin client", async () => {
  const readme = await readFile(
    new URL("README.md", repositoryRoot),
    "utf8"
  );

  for (const route of [
    /codex plugin marketplace add citrolabs\/safari-browser-use/,
    /claude plugin marketplace add citrolabs\/safari-browser-use/,
    /copilot plugin install citrolabs\/safari-browser-use/,
    /codebuddy plugin marketplace add citrolabs\/safari-browser-use/,
    /qoder plugins marketplace add citrolabs\/safari-browser-use/,
    /\.cursor\/plugins\/local/,
    /Add Custom Power|Import power from GitHub/i
  ]) {
    assert.match(readme, route);
  }
});
