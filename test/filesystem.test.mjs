import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { listDirectory, mimeFor, DEFAULT_LIST_CAP } from "../dist/filesystem.js";

const base = await mkdtemp(join(tmpdir(), "filez-fs-"));
const ws = join(base, "ws");
await mkdir(join(ws, "sub", "nested"), { recursive: true });
await writeFile(join(ws, "a.txt"), "hello world");
await writeFile(join(ws, ".hidden"), "secret");
await mkdir(join(ws, ".hiddendir"), { recursive: true });
await writeFile(join(ws, "big.txt"), "x".repeat(1024));
await writeFile(join(ws, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

{
  const r = await listDirectory(ws, "");
  eq(r.error, undefined, "root list ok");
  eq(r.truncated, false, "not truncated");
  const names = r.entries.map((e) => e.name);
  eq(names, ["sub", "a.txt", "big.txt", "pic.png"], "dirs first, hidden omitted: " + JSON.stringify(names));
  eq(r.entries[0].path, "sub", "dir rel path");
  eq(r.entries[0].isDirectory, true, "dir flag");
}
{
  const r = await listDirectory(ws, "", { showHidden: true });
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes(".hidden") && names.includes(".hiddendir"), "hidden included: " + JSON.stringify(names));
  n++;
}
{
  const r = await listDirectory(ws, "sub");
  eq(r.entries.map((e) => e.name), ["nested"], "sub listing");
  eq(r.entries[0].path, "sub/nested", "nested child rel path");
}
// Per-entry lstat (BUG-008): size + mtime ride the entry; a symlink is its
// OWN link (lstat, not stat) — even a broken one still reports.
{
  const r = await listDirectory(ws, "");
  const a = r.entries.find((e) => e.name === "a.txt");
  eq(a.size, 11, "file size = its own bytes ('hello world')");
  assert.ok(typeof a.mtime === "number" && a.mtime > 0, "file mtime = ms since epoch");
  const sub = r.entries.find((e) => e.name === "sub");
  assert.ok(typeof sub.size === "number" && typeof sub.mtime === "number", "directory entries carry their own stat too (the client ignores dir meta)");
  n++;
}
{
  await symlink(join(base, "gone"), join(ws, "dangle"));
  const r = await listDirectory(ws, "");
  const d = r.entries.find((e) => e.name === "dangle");
  assert.ok(d && d.isDirectory === false, "broken symlink still listed");
  assert.ok(typeof d.size === "number" && typeof d.mtime === "number", "broken symlink carries its own link stat (lstat never follows)");
  n++;
}
{
  const r = await listDirectory(ws, "sub/nested");
  eq(r.entries, [], "empty dir");
}
{
  eq((await listDirectory(ws, "a.txt")).error, "not-a-directory", "file → not-a-directory");
  eq((await listDirectory(ws, "nope")).error, "not-found", "missing → not-found");
}
eq(mimeFor("x.rs"), "application/octet-stream", "unknown source ext → octet-stream (the NUL heuristic in finishFileShow decides text vs binary)");
eq(mimeFor("noext"), "application/octet-stream", "no ext");
eq(mimeFor("a.md"), "text/markdown", "markdown renderer gate (client keys on this exact type)");
eq(mimeFor("a.svg"), "image/svg+xml", "svg has no magic signature — the table is its only route to image/*");
eq(mimeFor("a.ico"), "image/x-icon", "ico has no magic signature");
eq(mimeFor("X.PNG"), "image/png", "case-insensitive");

// Nested jj/git repos are VCS boundaries: they must not appear in the
// workspace listing, at any depth, whether or not hidden entries are shown.
await mkdir(join(ws, "child-jj", "src"), { recursive: true });
await writeFile(join(ws, "child-jj", ".jj"), "");
await writeFile(join(ws, "child-jj", "src", "x.ts"), "x");
await mkdir(join(ws, "child-git", "src"), { recursive: true });
await writeFile(join(ws, "child-git", ".git"), "gitdir: /elsewhere");
await mkdir(join(ws, "sub", "child-git-deep"), { recursive: true });
await mkdir(join(ws, "sub", "child-git-deep", ".git"), { recursive: true });
{
  const r = await listDirectory(ws, "");
  const names = r.entries.map((e) => e.name);
  assert.ok(!names.includes("child-jj") && !names.includes("child-git"),
    "nested repos hidden at root: " + JSON.stringify(names));
  n++;
  const r2 = await listDirectory(ws, "sub");
  assert.ok(!r2.entries.map((e) => e.name).includes("child-git-deep"),
    "nested repos hidden at depth: " + JSON.stringify(r2.entries));
  n++;
}
{
  const r = await listDirectory(ws, "", { showHidden: true });
  const names = r.entries.map((e) => e.name);
  assert.ok(!names.includes("child-jj") && !names.includes("child-git"),
    "nested repos hidden even with showHidden: " + JSON.stringify(names));
  n++;
}
// A directory merely NAMED .jj with no repo markers inside is not a boundary.
await mkdir(join(ws, "plain", ".jj"), { recursive: true });
{
  const r = await listDirectory(ws, "plain", { showHidden: true });
  eq(r.entries.map((e) => e.name), [".jj"], "directory named .jj without markers is listed");
  n++;
}

await rm(base, { recursive: true, force: true });
console.log(`filesystem: ${n} assertion-groups passed (list cap=${DEFAULT_LIST_CAP})`);
