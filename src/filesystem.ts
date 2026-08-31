// Workspace-scoped, read-only FS operations for filestab: directory listings
// (listDirectory) and MIME guessing (mimeFor). The code resolves every input
// path through resolveInWorkspace before FS access. That step guarantees
// containment. File-content reads are NOT here. src/snapshot.ts owns them.

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolveInWorkspace } from "./containment.js";

export const DEFAULT_LIST_CAP = 2000;

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hidden: boolean;
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
  return { root: workspaceRoot, relPath, entries: entries.slice(0, cap), truncated };
}
