import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const playwrightVersion = "1.62.1";
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

export async function buildPlaywrightAriaSnapshot() {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [
      "third_party/playwright/safari-browser-use-entry.ts"
    ],
    bundle: true,
    format: "iife",
    globalName: "SBUPlaywrightAriaSnapshot",
    platform: "browser",
    target: "safari26",
    minify: true,
    treeShaking: true,
    write: false,
    tsconfig: "third_party/playwright/tsconfig.json",
    legalComments: "inline",
    banner: {
      js: [
        "/**",
        ` * Built from Microsoft Playwright v${playwrightVersion}.`,
        " * Safari Browser Use retains data-testid metadata and includes",
        " * same-origin iframe content available to page JavaScript.",
        " * Playwright is licensed under Apache-2.0; see",
        " * third_party/playwright/LICENSE and NOTICE.",
        " */"
      ].join("\n")
    }
  });

  return result.outputFiles[0].text;
}
