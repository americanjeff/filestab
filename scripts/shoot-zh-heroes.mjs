// scripts/shoot-zh-heroes.mjs — zh-locale re-shoots of the two reworked
// README scenes, matching the approved EN candidates (hero = hd2, rollups
// = r3a):
//
//   hero    dogfood scene (this repo as the workspace)  -> assets/zh/hero.png
//   rollups fixture scene (worktree root, README.md)    -> assets/zh/rollups-dark.png
//
// Both: 1400x900 viewport, deviceScaleFactor 2, CSS zoom 1.15, the file
// listing dragged to 240px, bottom cut at the list bottom + 40px.
//
// Two contexts = two "hello" model calls.
// Run: node scripts/shoot-zh-heroes.mjs

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  makeFixture, makeScratchHome, bootDsh, findChrome, openSession,
} from "./capture-readme-shots.mjs";
import { landOnDogfood, captureVariant } from "./hero-dogfood-experiments.mjs";
import { landOnDiff } from "./hero-experiments.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ZH = join(REPO_ROOT, "assets", "zh");

const VW = 1400, VH = 900, SCALE = 2, ZOOM = 1.15, NAVW = 240, PAD = 40;

async function main() {
  const root = join(tmpdir(), `filestab-zh-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  let dsh = null, browser = null;
  try {
    const home = makeScratchHome(root);
    const fx = makeFixture(root);
    dsh = await bootDsh(home);
    const url = `http://127.0.0.1:${dsh.port}`;
    console.log(`dsh web on ${url}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

    // Hero: the dogfood scene in the zh locale.
    {
      const { context, page } = await openSession(browser, {
        url, workspace: REPO_ROOT, lang: "zh",
        viewport: { width: VW, height: VH }, scale: SCALE,
      });
      try {
        await landOnDogfood(page, "文件");
        await captureVariant(page, { name: "hero", zoom: ZOOM, navW: NAVW, cropPad: PAD }, ZH);
      } finally {
        await context.close();
      }
    }
    // Rollups: the fixture scene in the zh locale.
    {
      const { context, page } = await openSession(browser, {
        url, workspace: fx, lang: "zh",
        viewport: { width: VW, height: VH }, scale: SCALE,
      });
      try {
        await landOnDiff(page, "文件");
        await captureVariant(page, { name: "rollups-dark", zoom: ZOOM, navW: NAVW, cropPad: PAD }, ZH);
      } finally {
        await context.close();
      }
    }
    console.log(`wrote ${join(ZH, "hero.png")} and ${join(ZH, "rollups-dark.png")}`);
  } catch (e) {
    console.error("shoot-zh-heroes FAIL:", e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dsh) dsh.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

main();
