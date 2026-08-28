/**
 * Runs ESLint with a TypeScript 6 copy in scope, because typescript-eslint
 * cannot yet read TypeScript 7.
 *
 * TypeScript 7 is the native compiler: the package no longer ships
 * `lib/typescript.js`, so the old programmatic API is simply gone. Next.js
 * copes — it spawns the `tsc` CLI (`experimental.useTypeScriptCli`, on by
 * default since 16.3) — but `@typescript-eslint/typescript-estree` still does
 * `require("typescript")` and reaches for the API at import time:
 *
 *     TypeError: undefined is not an object (evaluating 'ts.Extension.Cjs')
 *
 * Its peer range is still `>=4.8.4 <6.1.0` as of 8.68, canary included, so
 * there is no version to upgrade to yet. `typescript-legacy` in the
 * devDependencies is TypeScript 6 under an alias, kept only for this, and the
 * links below put it where Node's resolver finds it *before* the hoisted
 * TypeScript 7 at the root — one link per directory that owns a package
 * loading the compiler, since `<pkg>/node_modules` shadows the root for
 * everything under it.
 *
 * Why a wrapper and not a postinstall hook: this panel updates itself by
 * running the project's own install command, and a postinstall that fails
 * there fails the whole update. Linting is a developer command, so the shim
 * belongs on the developer's path and nowhere near the install.
 *
 * Delete this file, the `typescript-legacy` dependency and the `lint` script's
 * indirection the day typescript-eslint declares support for TypeScript 7.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacy = path.join(root, "node_modules", "typescript-legacy");

// Every directory whose packages call into the compiler API. `@typescript-eslint`
// covers all of its scoped packages at once: the scope directory is on the
// resolution path of each one.
const scopes = [
  path.join(root, "node_modules", "@typescript-eslint"),
  path.join(root, "node_modules", "eslint-plugin-import"),
  path.join(root, "node_modules", "ts-api-utils"),
  path.join(root, "node_modules", "typescript-eslint"),
];

if (!fs.existsSync(legacy)) {
  console.error(
    "typescript-legacy is missing — run the install first (`bun install`).\n" +
      "ESLint needs it: typescript-eslint cannot read TypeScript 7."
  );
  process.exit(1);
}

// Junctions on Windows: they are the one link type an unprivileged account may
// create there. Node resolves through either, so the loaded compiler is the
// same file on every platform.
const linkType = process.platform === "win32" ? "junction" : "dir";

for (const scope of scopes) {
  if (!fs.existsSync(scope)) continue;
  const link = path.join(scope, "node_modules", "typescript");

  if (fs.existsSync(link)) {
    // An install may have put a real directory here, or an older link pointing
    // somewhere else. Only leave it alone when it already is the right one.
    if (fs.realpathSync(link) === fs.realpathSync(legacy)) continue;
    fs.rmSync(link, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(legacy, link, linkType);
}

// Through `package.json`: ESLint 9 does not export its `bin/` path, so asking
// the resolver for the binary directly is refused.
const require_ = createRequire(import.meta.url);
const eslintPkgPath = require_.resolve("eslint/package.json");
const eslintPkg = JSON.parse(fs.readFileSync(eslintPkgPath, "utf8"));
const eslintBin = path.resolve(
  path.dirname(eslintPkgPath),
  typeof eslintPkg.bin === "string" ? eslintPkg.bin : eslintPkg.bin.eslint
);

const child = spawn(process.execPath, [eslintBin, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
