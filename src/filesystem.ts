// Workspace-scoped, read-only FS operations for filestab: directory listings
// (listDirectory) and MIME guessing (mimeFor). The code resolves every input
// path through resolveInWorkspace before FS access. That step guarantees
// containment. File-content reads are NOT here. src/snapshot.ts owns them.

import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInWorkspace } from "./containment.js";

export const DEFAULT_LIST_CAP = 2000;

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hidden: boolean;
  /** The entry's OWN size in bytes (lstat — a symlink is its link, never its target). Snapshot listings (a past VCS tree has no on-disk state) omit it. */
  size?: number;
  /** The entry's OWN last-modification time, ms since epoch (lstat). Omitted in snapshot listings. */
  mtime?: number;
}

export interface ListingValue {
  root: string;
  relPath: string;
  entries: DirEntry[];
  truncated: boolean;
}

export type ListingResult = ListingValue | { error: string; relPath: string };

// Extension fallback. The code consults this map only when sniff() returns
// null. The code keeps it minimal. It holds only the entries whose extension
// changes behavior: the markdown renderer gate, the images that magic
// sniffing can not detect (svg/avif/ico), and a corrupt-file safety net for
// the types that sniff already covers. Everything else is text or a binary.
// The NUL heuristic in finishFileShow classifies those on its own.
const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown",
  ".svg": "image/svg+xml", ".avif": "image/avif", ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".pdf": "application/pdf", ".zip": "application/zip",
};

export function mimeFor(name: string): string {
  const dot = String(name).lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[String(name).slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function childPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

// A directory that is itself a jj or git repo is a VCS boundary: the
// workspace's jj/git never tracks any file inside it, so its badges,
// diffs, and history would all be silently dead here (verified on jj
// 0.44: nested repos are opaque to the parent's tree). Hiding it makes
// the listing match what the workspace VCS actually tracks. Only child
// entries are probed — the listed directory itself is never hidden, so
// a repo workspace still lists normally. `.git` may be a FILE (a git
// worktree pointer) as well as a directory; both forms count.
async function isRepoBoundary(dir: string): Promise<boolean> {
  for (const marker of [".jj", ".git"]) {
    try {
      await stat(join(dir, marker));
      return true;
    } catch {
      // marker absent; try the next
    }
  }
  return false;
}

/**
 * @returns {{root, relPath, entries, truncated}} for a directory, or
 *          {{error, relPath}} for not-found / not-a-directory.
 */
export async function listDirectory(
  workspaceRoot: string,
  relPath = "",
  { cap = DEFAULT_LIST_CAP, showHidden = false }: { cap?: number; showHidden?: boolean } = {},
): Promise<ListingResult> {
  const abs = await resolveInWorkspace(workspaceRoot, relPath);
  let dirents: Dirent[];
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return { error: "not-found", relPath };
    if (code === "ENOTDIR" || code === "EACCES") return { error: "not-a-directory", relPath };
    throw err;
  }
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith(".")) continue;
    // Drop child jj/git repos: the parent's VCS can not see into them, so
    // listing them would offer files with no working VCS context.
    if (d.isDirectory() && (await isRepoBoundary(join(abs, d.name)))) continue;
    entries.push({
      name: d.name,
      path: childPath(relPath.replace(/\/+$/, ""), d.name),
      isDirectory: d.isDirectory(),
      hidden: d.name.startsWith("."),
    });
  }
  entries.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
  );
  const truncated = entries.length > cap;
  const shown = entries.slice(0, cap);
  // Per-entry lstat (BUG-008): Dirents carry no size/mtime. The pass runs
  // AFTER the cap slice (a truncated tail costs nothing) and is NON-recursive
  // — the listing is re-polled every 5 s, so it must stay cheap. lstat, never
  // stat: a symlink reports its OWN link (a broken one still lists). An
  // entry that races away between readdir and lstat simply omits the fields.
  const meta = await Promise.all(shown.map(async (e) => {
    try {
      const st = await lstat(join(abs, e.name));
      return { size: st.size, mtime: Math.round(st.mtimeMs) };
    } catch {
      return null;
    }
  }));
  for (let i = 0; i < shown.length; i++) {
    const m = meta[i]!;
    if (m) { shown[i]!.size = m.size; shown[i]!.mtime = m.mtime; }
  }
  return { root: workspaceRoot, relPath, entries: shown, truncated };
}
