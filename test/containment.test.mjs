import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { resolveInWorkspace, WorkspacePathError } from "../dist/containment.js";

const base = await mkdtemp(join(tmpdir(), "filez-contain-"));
const ws = join(base, "ws");
const outside = join(base, "outside");
await mkdir(join(ws, "sub"), { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(join(ws, "sub", "a.txt"), "hello");
await writeFile(join(outside, "secret.txt"), "top secret");
await symlink(outside, join(ws, "link"));
await symlink(join(outside, "secret.txt"), join(ws, "badlink"));

let n = 0;
const ok = async (rel) => {
  const p = await resolveInWorkspace(ws, rel);
  assert.ok(p === ws || p.startsWith(ws + "/"), `should stay under ws, got ${p}`);
  n++;
};
const bad = async (rel) => {
  let threw = false;
  try { await resolveInWorkspace(ws, rel); } catch (e) { threw = e instanceof WorkspacePathError; }
  assert.ok(threw, `should reject: ${rel}`);
  n++;
};

await ok("");
await ok("/");                             // root via slash
await ok("sub");
await ok("sub/a.txt");
await ok("sub/./a.txt");
await ok("./sub/../sub/a.txt");            // .. that cancels back inside

await bad("../outside/secret.txt");
await bad("..");
await bad("sub/../../outside/secret.txt"); // .. escaping via a subdir
await bad("/etc/passwd");
await bad("link/secret.txt");             // dir symlink escape
await bad("link");                          // the dir symlink itself
await bad("badlink");                      // file symlink escape
await bad("\u0000");                        // NUL byte → WorkspacePathError, not a raw TypeError
await bad("sub/\u0000.txt");               // NUL byte inside a segment

await rm(base, { recursive: true, force: true });
console.log(`containment: ${n} assertions passed`);
