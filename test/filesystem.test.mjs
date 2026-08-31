import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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

await rm(base, { recursive: true, force: true });
console.log(`filesystem: ${n} assertion-groups passed (list cap=${DEFAULT_LIST_CAP})`);
