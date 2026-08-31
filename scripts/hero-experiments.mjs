// scripts/hero-experiments.mjs — candidate hero shots for the README.
//
// Boots the same sandboxed dsh + fixture as capture-readme-shots.mjs (EN,
// dark), lands on the flagship scene (worktree root, README.md selected,
// diff showing), narrows the file-listing pane by dragging the divider the
// app's own way (pointer events, settles leftW state), then captures
// candidates with different zoom and bottom-crop depths:
//
//   test/e2e/out/hero-alts/<name>.png
//
// Crop: the Files tab element, clipped at (bottom of file listing + pad),
// so the right (diff) pane is cut mid-way: enough to see there is a diff,
// not the whole diff.
//
// One context = one "hello" model call; all variants share the context and
// resize/zoom/drag in place. Writes only to test/e2e/out/hero-alts/; nothing
// is wired into the README until a candidate is picked.
//
// Run: node scripts/hero-experiments.mjs

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  makeFixture, makeScratchHome, bootDsh, findChrome, openSession, clickFilesTab,
} from "./capture-readme-shots.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO_ROOT, "test", "e2e", "out", "hero-alts");

// { name, vw, vh, scale, zoom, navW, cropPad }
// cropPad = px below the file-listing bottom where the image is cut.
const VARIANTS = [
  { name: "r3a-nav240-s2-z115-pad40", vw: 1400, vh: 900, scale: 2, zoom: 1.15, navW: 240, cropPad: 40 },
  { name: "r3b-nav240-s2-z115-pad90", vw: 1400, vh: 900, scale: 2, zoom: 1.15, navW: 240, cropPad: 90 },
  { name: "r3c-nav240-s2-z115-pad140", vw: 1400, vh: 900, scale: 2, zoom: 1.15, navW: 240, cropPad: 140 },
  { name: "r3d-nav240-s2-z100-pad90", vw: 1400, vh: 900, scale: 2, zoom: 1, navW: 240, cropPad: 90 },
];

async function landOnDiff(page, tabLabel = "Files") {
  const root = () => page.locator(".dswFiles_root");
  await clickFilesTab(page, tabLabel);
  await root().waitFor({ state: "visible", timeout: 15_000 });
  await root().locator(".dswFiles_statusSelect").waitFor({ state: "visible", timeout: 20_000 });
  await root().locator(".dswFiles_row", {
    has: page.locator(".dswFiles_rowName", { hasText: /^README\.md$/ }),
  }).click();
  await root().locator(".dswFiles_diffHead").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(500);
}

async function readNavWidth(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".dswFiles_body");
    const w = parseFloat(getComputedStyle(el).getPropertyValue("--filez-left"));
    return Number.isFinite(w) ? w : 340;
  });
}

// Drag the divider the app's way: pointerdown on it, move, pointerup. The
// handler settles leftW state on pointerup, so the width is persisted via
// the real code path (clamped to 220..body-16*2-6-320 by the app itself).
async function setNavWidth(page, target) {
  const cur = await readNavWidth(page);
  if (Math.abs(cur - target) < 1) return cur;
  const box = await page.locator(".dswFiles_divider").boundingBox();
  if (!box) throw new Error("no divider bounding box");
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x0 + (target - cur), y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await readNavWidth(page);
  console.log(`nav width: ${cur} -> ${after} (target ${target})`);
  return after;
}

async function captureVariant(page, v) {
  await page.setViewportSize({ width: v.vw, height: v.vh });
  await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, v.zoom);
  if (typeof v.navW === "number") await setNavWidth(page, v.navW);
  await page.waitForTimeout(500); // reflow settle

  const root = page.locator(".dswFiles_root");
  const box = await root.boundingBox();
  if (!box) throw new Error(`no bounding box for .dswFiles_root (${v.name})`);
  const m = await page.evaluate(() => {
    const root = document.querySelector(".dswFiles_root");
    const rr = root.getBoundingClientRect();
    const rows = [...root.querySelectorAll(".dswFiles_row")];
    const listBottom = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : rr.top;
    return { listBottom, rootTop: rr.top, rootBottom: rr.bottom };
  });
  const h = Math.min(
    Math.max(m.listBottom - m.rootTop + v.cropPad, 100),
    m.rootBottom - m.rootTop,
  );
  const path = join(OUT, v.name + ".png");
  await page.screenshot({ path, clip: { x: box.x, y: box.y, width: box.width, height: h } });
  console.log(`hero-alt: ${v.name}.png`);
}

async function main() {
  const root = join(tmpdir(), `filestab-hero-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  let dsh = null, browser = null;
  try {
    const home = makeScratchHome(root);
    const fx = makeFixture(root);
    dsh = await bootDsh(home);
    const url = `http://127.0.0.1:${dsh.port}`;
    console.log(`dsh web on ${url}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });
    // One context for all variants: same scale and viewport, so one "hello"
    // model call; zoom and nav width are adjusted in place per variant.
    const { context, page } = await openSession(browser, {
      url, workspace: fx, lang: "en",
      viewport: { width: VARIANTS[0].vw, height: VARIANTS[0].vh }, scale: VARIANTS[0].scale,
    });
    try {
      await landOnDiff(page);
      for (const v of VARIANTS) await captureVariant(page, v);
    } finally {
      await context.close();
    }
    console.log(`candidates in ${OUT}`);
  } catch (e) {
    console.error("hero-experiments FAIL:", e);
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

// Reused by scripts/shoot-zh-heroes.mjs.
export { landOnDiff, readNavWidth, setNavWidth };
