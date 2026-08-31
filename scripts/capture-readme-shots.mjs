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
// Captures per pass (dark theme via colorScheme):
//   rollups-dark.png      worktree listing (rollups + M/A badges) with the
//                         side-by-side diff of a changed file
//   history-dropdown.png  commit selected in the dropdown, snapshot tree,
//                         binary diff card
//   preview-markdown.png  rendered markdown: task lists, table, highlighted
//                         fence, mermaid in a sealed frame
//   preview-source.png    syntax-highlighted source
//   preview-image.png     image rendered inline
//   preview-html.png      HTML rendered in the sealed iframe
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

  // The demo image: a 480x300 gradient card (also the inline-image capture).
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
      const m = d.toString().match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !settled) { settled = true; clearTimeout(timer); res({ port: Number(m[1]), stop }); }
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
  en: { locale: "en-US", addWs: "Add workspace", open: "Open", send: "Send message", filesTab: "Files" },
  zh: { locale: "zh-CN", addWs: "添加工作区", open: "打开", send: "发送消息", filesTab: "文件" },
};

async function openSession(browser, { url, workspace, lang, viewport = { width: 1400, height: 900 }, scale = 1 }) {
  const L = LABELS[lang];
  const context = await browser.newContext({ viewport, colorScheme: "dark", locale: L.locale, deviceScaleFactor: scale });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[${lang} pageerror]`, String(e).slice(0, 300)));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    // "Add workspace" is present on both the initial landing and post-session heroes.
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
    await page.waitForTimeout(3000);
    // A session only gets its conversation pane (with the view tabs) once a
    // turn exists; send one. This is the one real model call per workspace.
    const ta = page.locator("textarea").first();
    await ta.waitFor({ state: "visible", timeout: 15_000 });
    await ta.click();
    await ta.type("hello");
    await page.getByRole("button", { name: L.send }).click();
    await page.waitForFunction((tab) => {
      const tl = document.querySelector('[role="tablist"]');
      return !!tl && [...tl.querySelectorAll('[role="tab"]')].some((t) => t.textContent.includes(tab));
    }, L.filesTab, { timeout: 90_000 });
  } catch (e) {
    await context.close().catch(() => {});
    throw new Error(`openSession(${workspace}, ${lang}): ${e.message}`);
  }
  return { context, page };
}

function ui(page) {
  const root = () => page.locator(".dswFiles_root");
  const rowNames = () => page.locator(".dswFiles_rowName").allTextContents();
  const row = (name) => page.locator(".dswFiles_row", {
    has: page.locator(".dswFiles_rowName", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
  });
  const crumb = (i = 0) => root().locator(".dswFiles_crumb").nth(i);
  const until = async (fn, what, ms = 20_000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${what}`);
      await page.waitForTimeout(250);
    }
  };
  return { page, root, rowNames, row, crumb, until };
}

// ── capture ──────────────────────────────────────────────────────────────────

function clickFilesTab(page, tabLabel) {
  return page.locator('[role="tab"]', { hasText: tabLabel }).click();
}

async function shot(u, name, outDir, pass) {
  const el = join(outDir, name);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(OUT_DIR, pass), { recursive: true });
  await u.page.waitForTimeout(400); // let fonts/renders settle
  await u.root().screenshot({ path: el });
  await u.page.screenshot({ path: join(OUT_DIR, pass, name + ".full.png"), fullPage: true });
  console.log(`capture (${pass}): ${name}`);
}

// Return to the workspace root (the root crumb is disabled while we ARE at
// the root, so only click when a folder crumb exists).
async function toRoot(u, marker) {
  if (await u.root().locator(".dswFiles_crumb").count() > 1) {
    await u.crumb(0).click();
  }
  await u.until(async () => (await u.rowNames()).includes(marker), `back at root (${marker})`);
}

// Navigate to a file by path (list of segments) and select it.
async function openFile(u, segments, marker) {
  await toRoot(u, marker);
  for (const seg of segments) {
    await u.row(seg).click();
    await u.page.waitForTimeout(300);
  }
}

async function captureAll(browser, url, fx, { lang, outDir, pass }) {
  const L = LABELS[lang];
  const { context, page } = await openSession(browser, { url, workspace: fx, lang });
  const u = ui(page);
  await clickFilesTab(page, L.filesTab);
  await u.root().waitFor({ state: "visible", timeout: 15_000 });
  const sel = u.root().locator(".dswFiles_statusSelect");
  await u.until(async () => (await sel.count()) > 0, "jj status line");

  // 0. hero (zh pass only): the whole GUI with the Files tab open, for the
  //    zh README's hero image. The EN README keeps its existing hero.png.
  if (pass === "zh") {
    await u.page.waitForTimeout(400);
    await u.page.screenshot({ path: join(outDir, "hero.png"), fullPage: true });
    console.log(`capture (${pass}): hero.png (full GUI)`);
  }

  // 1. rollups: root listing with badges/rollups + diff of README.md (M).
  await u.row("README.md").click();
  await u.until(async () => (await u.root().locator(".dswFiles_diffHead").count()) > 0, "diff head rendered");
  await u.page.waitForTimeout(600);
  await shot(u, "rollups-dark.png", outDir, pass);

  // 1b. collapse-nav: the header toggle hides the file list, giving the diff
  //     the full width of the tab. Re-expand before the next shot (it needs
  //     the tree listing).
  const collapseBtn = u.root().locator(".dswFiles_collapseBtn");
  await collapseBtn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 0, "left pane collapsed");
  await shot(u, "collapse-nav.png", outDir, pass);
  await collapseBtn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 1, "left pane expanded");

  // 2. history-dropdown: pick "initial import" (tree = README.md + img/,
  //    binary card on logo.png), capture the snapshot view.
  const opts = await sel.evaluate((s) => Array.from(s.options).map((o) => [o.value, o.textContent]));
  console.log(`dropdown options (${pass}):\n` + opts.map(([v, t]) => `  ${v}  ${t}`).join("\n"));
  const initOpt = opts.find(([, t]) => (t || "").includes("initial import"));
  if (!initOpt) throw new Error("no 'initial import' option in the dropdown");
  await sel.selectOption(initOpt[0]);
  await u.until(async () => (await u.rowNames()).includes("img"), "snapshot tree listed");
  await u.until(async () => !(await u.rowNames()).includes("site"), "site/ gone in this commit");
  await u.row("img").click();
  await u.page.waitForTimeout(300);
  await u.row("logo.png").click();
  await u.until(async () =>
    (await u.root().locator(".dswFiles_diffBinaryRow").count()) > 0 ||
    ((await u.root().locator(".dswFiles_previewPane").innerText().catch(() => "")) ?? "").toLowerCase().includes("binary"),
    "binary card rendered");
  await u.page.waitForTimeout(600);
  await shot(u, "history-dropdown.png", outDir, pass);

  // Back to the worktree for the preview shots. Select the worktree FIRST:
  // the snapshot tree has no scratch.txt, so the root wait only succeeds
  // after the live tree is restored (the path may be retained or reset by
  // the rev switch; toRoot handles both).
  await sel.selectOption("worktree");
  await toRoot(u, "scratch.txt");

  // 3. preview-markdown: docs/notes.md renders by default (clean markdown).
  await openFile(u, ["docs", "notes.md"], "scratch.txt");
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
  await openFile(u, ["app", "util.py"], "scratch.txt");
  const pre = u.root().locator(".dswFiles_previewText");
  await u.until(async () => (await pre.count()) > 0 && (await pre.locator(".hljs-keyword").count()) > 0, "highlighted source");
  await u.page.waitForTimeout(300);
  await shot(u, "preview-source.png", outDir, pass);

  // 5. preview-image: img/logo.png inline.
  await openFile(u, ["img", "logo.png"], "scratch.txt");
  const img = u.root().locator(".dswFiles_previewImage");
  await u.until(async () => (await img.count()) > 0, "inline image");
  await img.first().waitFor({ state: "visible" });
  await u.page.waitForTimeout(300);
  await shot(u, "preview-image.png", outDir, pass);

  // 6. preview-html: site/index.html, raw by default, then Preview (sealed).
  await openFile(u, ["site", "index.html"], "scratch.txt");
  await u.until(async () => ((await u.root().locator(".dswFiles_previewText").innerText().catch(() => "")) ?? "").includes("<!doctype"), "raw html default");
  await u.root().locator(".dswFiles_paneToggleBtn", { hasText: lang === "zh" ? /^预览$/ : /^Preview$/ }).first().click();
  const iframe = u.root().locator(".dswFiles_previewHtml");
  await iframe.waitFor({ state: "visible", timeout: 15_000 });
  await u.until(async () => {
    const f = await (await iframe.elementHandle()).contentFrame();
    return f ? f.evaluate("document.querySelector('.card') !== null").catch(() => false) : false;
  }, "sealed page rendered in the frame");
  await u.page.waitForTimeout(600);
  await shot(u, "preview-html.png", outDir, pass);

  await context.close();
}

async function main() {
  const root = join(tmpdir(), `filestab-shots-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  let dsh = null, browser = null;
  try {
    const home = makeScratchHome(root);
    const fx = makeFixture(root);
    console.log(`fixture: ${fx}`);
    dsh = await bootDsh(home);
    const url = `http://127.0.0.1:${dsh.port}`;
    console.log(`dsh web on ${url}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

    await captureAll(browser, url, fx, { lang: "en", outDir: join(REPO_ROOT, "assets"), pass: "en" });
    await captureAll(browser, url, fx, { lang: "zh", outDir: join(REPO_ROOT, "assets", "zh"), pass: "zh" });
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

// Reused by scripts/hero-experiments.mjs for README hero candidates.
export { makeFixture, makeScratchHome, bootDsh, findChrome, openSession, ui, clickFilesTab, openFile, toRoot };
