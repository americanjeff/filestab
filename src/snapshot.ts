// src/snapshot.ts, a revision's tree + a file's bytes at that revision
// (host side), plus the live worktree read.
//
// jj has no per-revision directory enumeration, so the code SYNTHESIZES a
// single-level snapshot listing from a flat `jj file list -r <rev>` (snapshotDirListing).
// All jj reads are read-only (`--no-integrate-operation`, like everything in jj.ts).

import type { Stats } from "node:fs";
import { stat, open } from "node:fs/promises";
import { jj, jjEscapePath } from "./jj.js";
import { resolveInWorkspace } from "./containment.js";
import { sniff, labelFor } from "./magic.js";
import { mimeFor, type DirEntry } from "./filesystem.js";

// Change/commit ids: jj's friendly 12-char a–z form or a hex full id
// (commit ids and full change ids are hex). Same alphabet the diff endpoint's
// `base` validates, one source for both.
export const REV_RE = /^[0-9a-z]{6,40}$/;

const SNAPSHOT_LIST_CAP = 2000; // the worktree listing's per-directory cap
export const FILE_SHOW_CAP = 1_000_000; // same 1 MB cap as the diff patch

function childPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/**
 * PURE: raw `jj file list` output (cwd-relative paths, one per line) + the
 * directory the user browses → that directory's listing entries. The function
 * mirrors listDirectory's shape/sort/cap.
 */
export function snapshotDirListing(
  fileListText: string | Buffer,
  dir: string,
  { cap = SNAPSHOT_LIST_CAP, showHidden = false }: { cap?: number; showHidden?: boolean } = {},
): { entries: DirEntry[]; truncated: boolean } {
  const d = String(dir ?? "").replace(/\/+$/, "");
  const prefix = d === "" ? "" : d + "/";
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const line of String(fileListText).split("\n")) {
    if (!line) continue;
    if (!line.startsWith(prefix)) continue; // redundant for the live call (jj scopes it). The code keeps it so this pure helper also works on unscoped input
    const rest = line.slice(prefix.length);
    if (!rest) continue;
    const i = rest.indexOf("/");
    if (i < 0) files.add(rest);
    else dirs.add(rest.slice(0, i));
  }
  const visible = (name: string) => showHidden || !name.startsWith(".");
  const entries: DirEntry[] = [];
  for (const name of dirs) if (visible(name))
    entries.push({ name, path: childPath(d, name), isDirectory: true, hidden: name.startsWith(".") });
  for (const name of files) if (visible(name))
    entries.push({ name, path: childPath(d, name), isDirectory: false, hidden: name.startsWith(".") });
  entries.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
  );
  const truncated = entries.length > cap;
  return { entries: entries.slice(0, cap), truncated };
}

export type SnapshotListingResult =
  | { root: string; relPath: string; entries: DirEntry[]; truncated: boolean }
  | { error: string; message?: string; relPath: string };

/**
 * One directory of a commit's snapshot: scoped `jj file list` →
 * snapshotDirListing. A dir that exists only in history still resolves.
 * resolveInWorkspace walks to the deepest EXISTING ancestor. The function
 * returns {error} shapes for jj failures. A containment violation throws
 * WorkspacePathError (the RPC boundary maps it to `forbidden`).
 */
export async function snapshotListing(
  workspaceRoot: string,
  rev: string,
  relPath: string,
  { showHidden = false }: { showHidden?: boolean } = {},
): Promise<SnapshotListingResult> {
  const clean = String(relPath ?? "").replace(/\/+$/, "");
  await resolveInWorkspace(workspaceRoot, clean);
  // `--` before the path (jj must not parse a dash-prefixed filename as a
  // jj option) and jjEscapePath (jj treats a glob-metachar path as a glob without the escape).
  const res = await jj(workspaceRoot, ["file", "list", "-r", rev, ...(clean ? ["--", jjEscapePath(clean)] : [])]);
  if (!res.ok) return { error: res.code, message: res.message, relPath };
  const { entries, truncated } = snapshotDirListing(res.value, clean, { showHidden });
  return { root: workspaceRoot, relPath: clean, entries, truncated };
}

export type FileShowValue =
  | { kind: "text"; text: string; size: number; truncated: boolean; type: string; label: string }
  | { kind: "binary"; size: number; type: string; label: string; data?: string };

export type FileShowResult = FileShowValue | { error: string; message?: string };

/**
 * Shared post-processing for a file byte read (jj fileShow, git gitFileShow,
 * the worktree read). The function attaches `data` (base64) only for a
 * non-truncated displayable binary (image/*, application/pdf). `size` is the
 * true file size when the caller reads less (a capped read).
 */
// Extension binary types win even when the bytes lack a signature and a NUL (a corrupt .png).
// octet-stream is deliberately ABSENT: extensionless text files report it, so they fall to the NUL-byte heuristic.
function isKnownBinaryType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type === "application/pdf" ||
    type === "application/zip" ||
    type === "application/gzip" ||
    type === "application/x-elf"
  );
}

export function finishFileShow(buf: Buffer, name: string, size?: number): FileShowValue {
  const truncated = buf.length > FILE_SHOW_CAP;
  const head = buf.subarray(0, FILE_SHOW_CAP);
  // A magic-signature match is authoritative: a short signature (the 8-byte
  // PNG header) contains NO NUL byte, so a NUL-only heuristic mislabels it as
  // text. Extension binary types are likewise binary. The NUL byte resolves
  // the ambiguous rest (octet-stream, or a lying extension).
  const magicType = sniff(head).type;
  const type = magicType ?? mimeFor(name.split("/").pop() ?? "");
  const label = labelFor(type);
  const binary = magicType !== null || isKnownBinaryType(type) || head.includes(0);
  const fileSize = size ?? buf.length;
  if (binary) {
    let data: string | undefined;
    if (!truncated && (type === "application/pdf" || type.startsWith("image/"))) {
      data = buf.toString("base64");
    }
    return { kind: "binary", size: fileSize, type, label, ...(data ? { data } : {}) };
  }
  return { kind: "text", text: head.toString("utf8"), size: fileSize, truncated, type, label };
}

/**
 * A file's bytes at a revision (jj). Shape rules: see finishFileShow.
 * A path absent at the revision → jj-error ("No such path").
 */
export async function fileShow(workspaceRoot: string, rev: string, relPath: string): Promise<FileShowResult> {
  const clean = String(relPath ?? "").replace(/\/+$/, "");
  await resolveInWorkspace(workspaceRoot, clean);
  // Room to read a little past the cap and slice: only a file far beyond
  // maxBuffer hard-fails (jj-overflow → the client's error note).
  const res = await jj(workspaceRoot, ["file", "show", "-r", rev, "--", jjEscapePath(clean)],
    { encoding: "buffer", maxBuffer: FILE_SHOW_CAP + 4096 });
  if (!res.ok) return { error: res.code, message: res.message };
  const buf = Buffer.isBuffer(res.value) ? res.value : Buffer.from(String(res.value));
  return finishFileShow(buf, clean);
}

/**
 * fileshow with `rev: "worktree"`, the LIVE worktree file on disk:
 * a plain contained read, no VCS subprocess.
 */
export async function worktreeFileShow(workspaceRoot: string, relPath: string): Promise<FileShowResult> {
  const clean = String(relPath ?? "").replace(/\/+$/, "");
  const abs = await resolveInWorkspace(workspaceRoot, clean);
  let st: Stats;
  try { st = await stat(abs); }
  catch { return { error: "not-found", message: "file not found" }; }
  if (!st.isFile()) return { error: "not-a-file", message: "not a regular file" };
  const fh = await open(abs, "r");
  try {
    const want = Math.min(st.size, FILE_SHOW_CAP + 4096);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    return finishFileShow(buf.subarray(0, bytesRead), clean, st.size);
  } finally {
    await fh.close().catch(() => {});
  }
}
