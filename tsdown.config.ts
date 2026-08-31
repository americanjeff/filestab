/**
 * Client build face: the config bundles src/dsh/client.tsx into
 * dist/dsh/client.js, the dsh clientBundle closure-factory shape. It
 * mirrors modelspoke's tsdown.config.ts client entry, trimmed to
 * filestab's needs. The build inlines no react-dom and runs no CSS
 * pipeline. The pane uses inline plain elements.
 *
 * The bundle hands itself to the web shell's module loader:
 * `window.__ModuleLoader__.load({ id, factory: (require) => { …CJS… } })`.
 * The injected `require` resolves externals through the loader's module
 * table. The bundle can require only the baseline table rows (EXTERNALS
 * below). It MUST inline everything else. A require() the table cannot
 * answer is a guaranteed runtime throw.
 *
 * The node half is pure tsc output (shared dist/), so clean stays off.
 */
import { isBuiltin } from "node:module";
import type { UserConfig } from "tsdown";

/** The row id the bundle registers under (== package name == Cordis row id). */
const ID = "filestab";

/** Baseline module-table rows a client bundle can require without declaring them. */
const EXTERNALS = new Set([
  "react",
  "react/jsx-runtime",
  "@deepseek-ai/dsh-client-ui-primitives",
]);

export default [
  {
    name: "filestab/client",
    entry: { client: "src/dsh/client.tsx" },
    outDir: "dist/dsh",
    format: "cjs",
    platform: "browser",
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) =>
        !isBuiltin(specifier) && !EXTERNALS.has(specifier),
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
] satisfies UserConfig[];
