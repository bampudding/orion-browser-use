import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, repositoryRoot), "utf8"));
}

test("repository root is an Agent Plugins 1.0 package", async () => {
  const manifest = await readJson("plugin.json");
  const mcp = await readJson("mcp.json");
  const packageManifest = await readJson("package.json");

  assert.equal(
    manifest.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  );
  assert.equal(manifest.name, "safari-browser-use");
  assert.equal(manifest.version, packageManifest.version);
  assert.equal(manifest.license, "MIT");

  assert.equal(
    mcp.$schema,
    "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
  );
  assert.deepEqual(mcp.mcpServers["safari-browser-use"], {
    type: "stdio",
    command: "osascript",
    args: [
      "-l",
      "JavaScript",
      "${PLUGIN_ROOT}/skills/control-safari/scripts/runtime/safari-repl.jxa.js"
    ]
  });

  await access(new URL("skills/control-safari/SKILL.md", repositoryRoot));
  await access(new URL(
    "skills/control-safari/scripts/runtime/safari-repl.jxa.js",
    repositoryRoot
  ));
});

test("WorkBuddy, CodeBuddy, and Qoder expose native plugin manifests", async () => {
  const clients = [
    [".workbuddy-plugin/plugin.json", "CODEBUDDY_PLUGIN_ROOT"],
    [".codebuddy-plugin/plugin.json", "CODEBUDDY_PLUGIN_ROOT"],
    [".qoder-plugin/plugin.json", "QODER_PLUGIN_ROOT"]
  ];
  const packageManifest = await readJson("package.json");

  for (const [path, rootVariable] of clients) {
    const manifest = await readJson(path);

    assert.equal(manifest.name, "safari-browser-use");
    assert.equal(manifest.version, packageManifest.version);
    assert.equal(manifest.skills, "./skills/");
    assert.deepEqual(manifest.mcpServers["safari-browser-use"], {
      command: "/usr/bin/osascript",
      args: [
        "-l",
        "JavaScript",
        `\${${rootVariable}}/skills/control-safari/scripts/runtime/safari-repl.jxa.js`
      ]
    });
  }
});

test("WorkBuddy, CodeBuddy, and Qoder marketplaces publish only the root package", async () => {
  for (const path of [
    ".workbuddy-plugin/marketplace.json",
    ".codebuddy-plugin/marketplace.json",
    ".qoder-plugin/marketplace.json"
  ]) {
    const marketplace = await readJson(path);

    assert.equal(marketplace.name, "vibevibe-labs");
    assert.equal(marketplace.owner.name, "VibeVibe Labs");
    assert.deepEqual(marketplace.plugins.map(plugin => ({
      name: plugin.name,
      source: plugin.source,
      category: plugin.category,
      strict: plugin.strict
    })), [{
      name: "safari-browser-use",
      source: "./",
      category: "Developer Tools",
      strict: true
    }]);
  }
});
