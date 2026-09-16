// scripts/capture-readme-shots.mjs, README screenshot capture (EN + ZH).
//
// Boots a sandboxed dsh web instance (scratch DSH_HOME, free port) with a
// purpose-built jj workspace and drives a headless chromium through the
// "What it looks like" states. Runs the full pass twice:
//   EN (locale en-US) -> assets/<name>.png
//   ZH (locale zh-CN) -> assets/zh/<name>.png
// The dsh GUI and the filestab UI both follow the browser locale, so the ZH
// pass captures the same scenes in the Chinese UI.
//
// dsh 0.1.5: the Files surface is the RIGHT COLUMN (the conversation Files
// tab is gone). A session only gets its right sidebar once a turn exists, so
// each pass sends one "hello" (one real model call) and then opens the column
// via button[data-sidebar-right-expand]; the column's sole guide entry seeds
// the files page (.dswFiles_root) directly. Tree rows are button.dswFiles_row
// with a .dswFiles_name (folders carry aria-expanded); there is no crumb bar.
//
// Captures per pass (dark theme via colorScheme):
//   rollups-dark.png      worktree listing (rollups + M/A badges) with the
//                         unified diff of a changed file (narrow pane)
//   history-dropdown.png  commit selected in the dropdown, snapshot tree,
//                         binary diff card
//   preview-markdown.png  rendered markdown: task lists, highlighted fence,
//                         mermaid in a sealed frame
//   preview-source.png    syntax-highlighted source
//   external-section.png  the External band: a file OUTSIDE the workspace,
//                         pinned by absolute path, selected and previewing
//   diff-side-by-side.png the README.md diff in split mode, LAST — the
//                         column in dsh fullscreen at an 1800px viewport
//                         (the fixed 630px column is below the 66%-per-side
//                         split cutoff of the 100-column reference). A
//                         fullscreen round-trip leaves the host's
//                         Fullscreen button overlaid on the column's first
//                         row, so the other shots must precede it.
//
// Full-page backups land in test/e2e/out/shots/<pass>/ for review.
//
// Prereqs: dsh on PATH at the version the e2e was written against, a
// playwright chromium, ImageMagick (logo.png), filestab dist/ built.
// Run: node scripts/capture-readme-shots.mjs

import { execFileSync, spawn } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_BIN = process.env.E2E_DSH || "dsh";
const OUT_DIR = join(REPO_ROOT, "test", "e2e", "out", "shots");
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── fixtures ─────────────────────────────────────────────────────────────────

// One jj workspace with five described commits plus a dirty worktree, so the
// commit dropdown shows the worktree row and five commits, and the root
// listing shows folder rollups (examples: 3), per-file badges (M, A), and a
// diffable changed file (README.md).
//
// NOTE on jj semantics: `jj new -m X` commits the files written SINCE the
// previous `jj new` into a NEW change described X. So each description below
// is given to the change that receives the NEXT batch of files:
//   "initial import" <- README.md + img/logo.png
//   "add docs"       <- docs/notes.md
//   "add app"        <- app/main.py + app/util.py
//   "add logo"       <- (none; logo.png already committed in "initial import")
//   "add page"       <- site/index.html
//   worktree         <- dirty: README.md (M), scratch.txt (A), examples/ (3 A)
function makeFixture(root) {
  const fx = join(root, "fj");
  mkdirSync(fx, { recursive: true });

  const write = (rel, content) => {
    const p = join(fx, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const jj = (...args) => execFileSync("jj", args, { cwd: fx, stdio: "ignore" });

  execFileSync("jj", ["git", "init"], { cwd: fx, stdio: "ignore" });
  jj("describe", "-m", "initial import");

  // The demo image: a 480x300 gradient card (the binary-diff card in history).
  const logo = join(fx, "img", "logo.png");
  mkdirSync(dirname(logo), { recursive: true });
  execFileSync("magick", [
    "-size", "480x300", "gradient:#0f172a-#334155",
    "-fill", "#38bdf8", "-pointsize", "52", "-gravity", "center",
    "-annotate", "+0-12", "filestab",
    "-fill", "#94a3b8", "-pointsize", "18",
    "-annotate", "+0+30", "inline image preview",
    logo,
  ], { stdio: "ignore" });

  // Committed v1 of the demo file: the working copy modifies line 3 and
  // appends a block, so the hero diff shows both a changed pair and an
  // added run, and is tall enough for a tight crop to clip it mid-way.
  write("README.md",
    "# filestab\n\n" +
    "A read-only Files tab for the dsh web GUI.\n");
  jj("new", "-m", "add docs");

  // Sized so heading + task list + code fence + mermaid diagram all fit in
  // one pane capture (the pane scrolls; the README shot must show all four).
  write("docs/notes.md",
    "# Release notes\n\n" +
    "## Tasks\n\n" +
    "- [x] Build the file browser\n" +
    "- [x] Wire up jj and git change tracking\n" +
    "- [ ] Ship the sealed HTML preview\n\n" +
    "## Snippet\n\n" +
    "```ts\n" +
    "export const statusLine = (cs) => cs.map((c) => c.kind).join(\", \");\n" +
    "```\n\n" +
    "## Flow\n\n" +
    "```mermaid\n" +
    "flowchart LR\n" +
    "  Browse --> Select --> Preview\n" +
    "```\n");
  jj("new", "-m", "add app");

  write("app/main.py",
    "import sys\n" +
    "from pathlib import Path\n\n" +
    "from util import walk\n\n" +
    "\n" +
    "def main(argv: list[str]) -> int:\n" +
    "    root = Path(argv[1]) if len(argv) > 1 else Path(\".\")\n" +
    "    for line in walk(root):\n" +
    "        print(line)\n" +
    "    return 0\n\n" +
    "\n" +
    "if __name__ == \"__main__\":\n" +
    "    sys.exit(main(sys.argv))\n");
  write("app/util.py",
    "from pathlib import Path\n\n" +
    "\n" +
    "def walk(root: Path, depth: int = 0):\n" +
    "    \"\"\"Yield each entry under root, indented by depth.\"\"\"\n" +
    "    for entry in sorted(root.iterdir()):\n" +
    "        if entry.is_dir():\n" +
    "            yield \"    \" * depth + entry.name + \"/\"\n" +
    "            yield from walk(entry, depth + 1)\n" +
    "        else:\n" +
    "            yield \"    \" * depth + entry.name\n");
  jj("new", "-m", "add page");

  write("site/index.html",
    "<!doctype html>\n" +
    "<html>\n" +
    "<head>\n" +
    "<meta charset=\"utf-8\">\n" +
    "<title>demo</title>\n" +
    "<style>\n" +
    "  body { font-family: system-ui, sans-serif; margin: 0;\n" +
    "         display: grid; place-items: center; min-height: 90vh;\n" +
    "         background: #0f172a; color: #e2e8f0; }\n" +
    "  .card { background: #1e293b; border: 1px solid #334155;\n" +
    "          border-radius: 12px; padding: 28px 40px; text-align: center; }\n" +
    "  h1 { font-size: 20px; margin: 0 0 8px; color: #38bdf8; }\n" +
    "  p { margin: 0; font-size: 13px; color: #94a3b8; }\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "  <div class=\"card\">\n" +
    "    <h1>Sealed render</h1>\n" +
    "    <p>This page runs inside a sandboxed, opaque-origin frame.</p>\n" +
    "  </div>\n" +
    "</body>\n" +
    "</html>\n");
  jj("new", "-m", "working copy");

  // Dirty worktree: a modified root file (the diff shot), an added scratch
  // file, and a folder of three additions (the rollup shot).
  write("README.md",
    "# filestab\n\n" +
    "A read-only Files tab, built for dsh.\n\n" +
    "Track jj and git changes live, review any\n" +
    "commit, and preview files inline:\n\n" +
    "- Markdown with task lists and mermaid\n" +
    "- syntax-highlighted source\n" +
    "- images and PDFs\n" +
    "- HTML in a sealed sandbox\n" +
    "- side-by-side diffs with rollups\n\n" +
    "## Safety\n\n" +
    "Read-only: the host half never writes\n" +
    "to the workspace.\n");
  write("scratch.txt", "temporary working file\n");
  write("examples/one.py", "print(\"one\")\n");
  write("examples/two.py", "print(\"two\")\n");
  write("examples/three.py", "print(\"three\")\n");
  return fx;
}

// ── environment (mirrors test/e2e/e2e.test.mjs) ──────────────────────────────

function makeScratchHome(root) {
  const real = process.env.DSH_HOME || join(process.env.HOME, ".dsh");
  const home = join(root, "home");
  mkdirSync(join(home, "profiles"), { recursive: true });
  cpSync(join(real, "profiles", "web"), join(home, "profiles", "web"), { recursive: true });
  const nm = join(home, "profiles", "web", "node_modules");
  const deps = JSON.parse(readFileSync(join(home, "profiles", "web", "package.json"), "utf8")).dependencies ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string" || !spec.startsWith("link:")) continue;
    const link = join(nm, name);
    rmSync(link, { force: true });
    symlinkSync(spec.slice("link:".length), link, "dir");
  }
  if (existsSync(join(real, "settings.yaml"))) {
    cpSync(join(real, "settings.yaml"), join(home, "settings.yaml"));
  }
  return home;
}

function bootDsh(home) {
  return new Promise((res, rej) => {
    const child = spawn(DSH_BIN, ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rej(new Error("dsh boot timeout:\n" + log.join("").slice(-3000)));
    }, 90_000);
    const stop = () => {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => clearTimeout(killer));
    };
    child.stdout.on("data", (d) => {
      log.push(d.toString());
      process.stdout.write(d.toString());
      // 0.1.5 prints the browser URL with a one-time-auth token; the token
      // exchanges for a persistent signed cookie on first load, and a fresh
      // context (no cookie) re-uses the same token, so keep the FULL url.
      const m = d.toString().match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        res({ port: Number(m[1].match(/:(\d+)/)[1]), url: m[1], stop });
      }
    });
    child.stderr.on("data", (d) => { log.push(d.toString()); process.stderr.write(d.toString()); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      rej(new Error(`failed to start ${DSH_BIN}: ${e.message}`));
    });
  });
}

function findChrome() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const cache = join(process.env.HOME, ".cache", "ms-playwright");
  const dirs = existsSync(cache)
    ? readdirSync(cache).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).sort()
    : [];
  for (let i = dirs.length - 1; i >= 0; i--) {
    const p = join(cache, dirs[i], "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("no chromium found: run `npx playwright install chromium` or set E2E_CHROME");
}

// dsh's own UI labels per locale (the filestab UI localizes on its own).
const LABELS = {
  en: { locale: "en-US", addWs: "Add workspace", open: "Open", send: "Send message", openFile: "Open file…" },
  zh: { locale: "zh-CN", addWs: "添加工作区", open: "打开", send: "发送消息", openFile: "打开文件…" },
};

// Open a session AND reveal the filestab (the right column). A fresh session
// has no turns, so the right sidebar (and its expand button) does not exist
// yet: send one "hello" (the single real model call per pass), wait for the
// expand button, open the column, and wait for the seeded files page.
async function openSession(browser, { url, workspace, lang, viewport = { width: 1400, height: 900 }, scale = 1 }) {
  const L = LABELS[lang];
  const context = await browser.newContext({ viewport, colorScheme: "dark", locale: L.locale, deviceScaleFactor: scale });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[${lang} pageerror]`, String(e).slice(0, 300)));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    // "Add workspace" is present on the initial landing.
    await page.getByRole("button", { name: L.addWs }).click({ timeout: 15_000 });
    const dialog = page.locator('[class*="_dialog_"]').first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    // The picker's Miller-columns navigation is slow to script; its crumb-bar
    // path editor jumps straight to an absolute path.
    await dialog.locator(".ZuhsRW_crumbEditZone").click();
    const input = dialog.locator("input").last();
    await input.waitFor({ state: "visible", timeout: 5000 });
    await input.fill(workspace);
    await input.press("Enter");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: L.open, exact: true }).click();
    // The composer is a Lexical contenteditable (.uV2eYG_input); it mounts a
    // beat after the session opens, so wait, focus, then type with the
    // keyboard (real key events the editor registers). The one turn that
    // unlocks the right sidebar.
    await page.waitForTimeout(2500);
    const composer = page.locator(".uV2eYG_input").last();
    await composer.waitFor({ state: "visible", timeout: 15_000 });
    await composer.click();
    await page.waitForTimeout(200);
    await page.keyboard.type("hello");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: L.send }).click();
    // The expand button appears only once a turn exists.
    const expand = page.locator("button[data-sidebar-right-expand]");
    await expand.waitFor({ state: "visible", timeout: 120_000 });
    // Open the right column; its sole guide entry seeds the files page.
    await expand.click();
    await page.locator(".dswFiles_root").waitFor({ state: "visible", timeout: 20_000 });
  } catch (e) {
    await context.close().catch(() => {});
    throw new Error(`openSession(${workspace}, ${lang}): ${e.message}`);
  }
  return { context, page };
}

function ui(page) {
  const root = () => page.locator(".dswFiles_root");
  // Tree rows only (the External band's rows live in .dswFiles_extList,
  // outside .dswFiles_tree, so this excludes them).
  const tree = () => root().locator(".dswFiles_tree");
  const rowNames = () => tree().locator(".dswFiles_name").allTextContents();
  const row = (name) => tree().locator("button.dswFiles_row", {
    has: page.locator(".dswFiles_name", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  }).first();
  const until = async (fn, what, ms = 20_000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${what}`);
      await page.waitForTimeout(250);
    }
  };
  return { page, root, tree, rowNames, row, until };
}

// ── capture ──────────────────────────────────────────────────────────────────

async function shot(u, name, outDir, pass, opts = {}) {
  const el = join(outDir, name);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(OUT_DIR, pass), { recursive: true });
  await u.page.waitForTimeout(400); // let fonts/renders settle
  // cropBottom: end the shot just below the content (the diff grid's full
  // scroll height, or the tree's — whichever reaches lower) instead of
  // capturing the whole column with its empty tail. clip is honored on
  // PAGE screenshots only (element screenshots ignore it), so the crop
  // branch captures the page region of the column instead.
  if (opts.cropBottom) {
    const rootBox = await u.root().boundingBox();
    // Both containers are flex children stretched to the pane, so their own
    // boxes reach the pane bottom — the content bottom is the last ROW's
    // (the grid's last cell, the tree's last row).
    const bottoms = await u.page.evaluate(() => {
      const out = [];
      for (const sel of [".dswFiles_diffGrid", ".dswFiles_tree"]) {
        const n = document.querySelector(sel);
        const last = n && n.lastElementChild;
        if (last) out.push(last.getBoundingClientRect().bottom);
      }
      return out;
    });
    const contentBottom = Math.max(0, ...bottoms);
    const h = Math.max(120, Math.min(contentBottom - rootBox.y + 16, rootBox.height));
    await u.page.screenshot({ path: el, clip: { x: rootBox.x, y: rootBox.y, width: rootBox.width, height: h } });
  } else {
    await u.root().screenshot({ path: el });
  }
  await u.page.screenshot({ path: join(OUT_DIR, pass, name + ".full.png"), fullPage: true });
  console.log(`capture (${pass}): ${name}`);
}

// Navigate to a file by path (list of segments) and select it. Idempotent
// about folder expansion (a rev switch may or may not reset the tree): a
// folder segment is clicked only to expand it, an already-expanded one is
// left alone, and the final segment (the file) is clicked to select it.
async function openFile(u, segments) {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    await u.until(async () => (await u.rowNames()).includes(seg), `row "${seg}" visible`);
    const r = u.row(seg);
    if (isLast) {
      await r.click(); // the file: select it
    } else {
      const expanded = await r.getAttribute("aria-expanded");
      if (expanded !== "true") {
        await r.click(); // a folder: expand it
        await u.page.waitForTimeout(300);
      }
    }
  }
}

async function captureAll(browser, url, fx, outside, { lang, outDir, pass }) {
  const L = LABELS[lang];
  const { context, page } = await openSession(browser, { url, workspace: fx, lang });
  const u = ui(page);
  const sel = u.root().locator(".dswFiles_statusSelect");
  await u.until(async () => (await sel.count()) > 0, "jj status line");

  // 1. rollups: root listing with badges/rollups + the side-by-side diff of
  //    README.md (M).
  await u.row("README.md").click();
  // The diff grid is the render signal: the sticky head (dswFiles_diffHead)
  // now carries only the diff meta and is absent for a plain modification,
  // while the file's name lives in the pane header (dswFiles_paneHead).
  await u.until(async () => (await u.root().locator(".dswFiles_diffGrid").count()) > 0, "diff rendered");
  await u.page.waitForTimeout(600);
  // Crop the empty column tail: the figure is the listing + the diff, and
  // the rest of the column is dead space. In the narrow column (320px pane)
  // the diff is UNIFIED — the 320px pane can't fit 66 of the 100 reference
  // columns per split side.
  await shot(u, "rollups-dark.png", outDir, pass, { cropBottom: true });

  // 2. history-dropdown: pick "initial import" (tree = README.md + img/),
  //    open img/logo.png (the binary diff card).
  const opts = await sel.evaluate((s) => Array.from(s.options).map((o) => [o.value, o.textContent]));
  console.log(`dropdown options (${pass}):\n` + opts.map(([v, t]) => `  ${v}  ${t}`).join("\n"));
  const initOpt = opts.find(([, t]) => (t || "").includes("initial import"));
  if (!initOpt) throw new Error("no 'initial import' option in the dropdown");
  await sel.selectOption(initOpt[0]);
  await u.until(async () => (await u.rowNames()).includes("img"), "snapshot tree listed");
  await u.until(async () => !(await u.rowNames()).includes("site"), "site/ gone in this commit");
  await openFile(u, ["img", "logo.png"]);
  await u.until(async () =>
    (await u.root().locator(".dswFiles_diffBinaryRow").count()) > 0 ||
    ((await u.root().locator(".dswFiles_previewPane").innerText().catch(() => "")) ?? "").toLowerCase().includes("binary"),
    "binary card rendered");
  await u.page.waitForTimeout(600);
  await shot(u, "history-dropdown.png", outDir, pass);

  // Back to the worktree for the preview shots.
  await sel.selectOption("worktree");
  await u.until(async () => (await u.rowNames()).includes("scratch.txt"), "worktree tree restored");

  // 3. preview-markdown: docs/notes.md renders by default (clean markdown).
  await openFile(u, ["docs", "notes.md"]);
  const md = u.root().locator(".dswFiles_previewMarkdown");
  await u.until(async () => (await md.count()) > 0 && (await md.locator("h1").count()) > 0, "markdown rendered");
  await u.until(async () => {
    const frame = u.root().locator(".dswFiles_mermaidFrame");
    if (await frame.count() === 0) return false;
    const f = frame.first().contentFrame();
    return f ? (await f.locator("svg").count().catch(() => 0)) > 0 : false;
  }, "mermaid SVG inside the sealed frame", 30_000);
  await u.page.waitForTimeout(600);
  await shot(u, "preview-markdown.png", outDir, pass);

  // 4. preview-source: app/util.py, highlighted (view mode default).
  await openFile(u, ["app", "util.py"]);
  const pre = u.root().locator(".dswFiles_previewText");
  await u.until(async () => (await pre.count()) > 0 && (await pre.locator(".hljs-keyword").count()) > 0, "highlighted source");
  await u.page.waitForTimeout(300);
  await shot(u, "preview-source.png", outDir, pass);

  // 5. external-section: pin a file OUTSIDE the workspace by absolute path
  //    (the footer's "Open file…"); it lands in the External band, is
  //    selected, and previews in the same pane.
  await page.getByRole("button", { name: L.openFile }).click();
  const extInput = u.root().locator(".dswFiles_extInput");
  await extInput.waitFor({ state: "visible", timeout: 10_000 });
  await extInput.fill(outside);
  await extInput.press("Enter");
  await u.until(async () => (await u.root().locator(".dswFiles_extList button.dswFiles_row").count()) > 0, "external row pinned");
  await u.until(async () => (await u.root().locator(".dswFiles_previewMarkdown").count()) > 0, "external markdown preview");
  await u.page.waitForTimeout(600);
  await shot(u, "external-section.png", outDir, pass);

  // 6. diff-side-by-side: the README.md diff (M) in split mode — taken LAST.
  //    The fixed 630px column is BELOW the split cutoff (a split side must
  //    fit 66% of the 100 reference columns — pane ≈1078px), so the column
  //    goes to dsh FULLSCREEN for this shot. The 1400px viewport's
  //    fullscreen pane (≈1022px) is just under that cutoff too, so the
  //    viewport is widened to 1800 for the shot and restored after (the
  //    column stays a fixed 630px — probed — so only this shot is
  //    affected). The chrome button's aria-label is localized, but its
  //    data attribute is not (probed: data-sidebar-right-mode).
    //    LAST because of the 1800px viewport dance (a later narrower shot
  //    would capture the reflow) and because the exit click parks
  //    headless's virtual mouse on the host's fullscreen button — a
  //    hover-expanded affordance (small icon -> "Fullscreen" label pill)
  //    that stays hover-stuck without a real pointer, leaving the pill
  //    over the nav header's path-edit/reload/hide controls in every
  //    later shot. Manual usage is unaffected (user-confirmed); the
  //    mouse.move after the exit loop resets the hover state anyway.
  // The external pin left the pane on outside-notes.md (preview mode);
  // re-select README.md so the diff grid renders again for the split shot.
  await u.row("README.md").click();
  await u.until(async () => (await u.root().locator(".dswFiles_diffGrid").count()) > 0, "diff rendered");
  await u.page.setViewportSize({ width: 1800, height: 900 });
  const fsBtn = u.page.locator('button[data-sidebar-right-mode="fullscreen"]');
  await fsBtn.first().click();
  await u.until(async () => {
    const cls = (await u.root().locator(".dswFiles_diffGrid").getAttribute("class")) || "";
    return !cls.includes("dswFiles_diffGridU");
  }, "split layout rendered");
  await u.page.waitForTimeout(600);
  await shot(u, "diff-side-by-side.png", outDir, pass, { cropBottom: true });
  // Exit fullscreen: the data attribute again if it persists on the exit
  // button, else the localized aria-labels (en probed; zh guessed).
  let restored = false;
  for (const s of ['button[data-sidebar-right-mode="fullscreen"]',
    'button[aria-label="Exit fullscreen"]', 'button[aria-label="退出全屏"]']) {
    const b = u.page.locator(s);
    if (!(await b.count())) continue;
    await b.first().click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const bb = await u.root().boundingBox();
      if (bb && bb.width < 800) { restored = true; break; }
      await u.page.waitForTimeout(150);
    }
    if (restored) break;
  }
  if (!restored) throw new Error("could not exit dsh fullscreen for the side-by-side shot");
  // Unpark the virtual mouse from the fullscreen button (see the LAST note).
  await u.page.mouse.move(5, 400);
  await u.page.setViewportSize({ width: 1400, height: 900 });

  await context.close();
}

async function main() {
  const root = join(tmpdir(), `filestab-shots-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  let dsh = null, browser = null;
  try {
    const home = makeScratchHome(root);
    const fx = makeFixture(root);
    // The External-section fixture: a markdown file OUTSIDE the jj workspace;
    // the host reads it by absolute path through fileshow-abs.
    const outside = join(root, "outside-notes.md");
    writeFileSync(outside,
      "# Outside the workspace\n\n" +
      "This file lives outside the session's workspace,\n" +
      "pinned into the External section by absolute path:\n\n" +
      "- reconstructed from a dropped leading slash\n" +
      "- read through the `fileshow-abs` endpoint\n");
    console.log(`fixture: ${fx}`);
    dsh = await bootDsh(home);
    const url = dsh.url;
    console.log(`dsh web on ${url}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

    await captureAll(browser, url, fx, outside, { lang: "en", outDir: join(REPO_ROOT, "assets"), pass: "en" });
    await captureAll(browser, url, fx, outside, { lang: "zh", outDir: join(REPO_ROOT, "assets", "zh"), pass: "zh" });
  } catch (e) {
    const pages = browser ? [...browser.contexts().flatMap((c) => c.pages())] : [];
    for (const p of pages) {
      mkdirSync(OUT_DIR, { recursive: true });
      await p.screenshot({ path: join(OUT_DIR, "capture-failure.png"), fullPage: true }).catch(() => {});
    }
    if (pages.length) console.log(`failure screenshot: ${join(OUT_DIR, "capture-failure.png")}`);
    console.error("capture FAIL:", e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dsh) dsh.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

// Reused by the hero-experiment scripts for fixture/boot/launch. `clickFilesTab`
// is a deprecated no-op: 0.1.5 has no conversation Files tab — openSession
// reveals the right column directly.
async function clickFilesTab() { return; }
export { makeFixture, makeScratchHome, bootDsh, findChrome, openSession, ui, openFile, clickFilesTab };
