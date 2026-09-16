// src/dsh/client.tsx, filestab web client: the read-only "Files" tab with an
// in-pane preview.
//
// This file is a plain ES module (TSX). The dsh web shell loads a CJS
// `factory`/`require` closure. The tsdown banner (tsdown.config.ts) adds
// that wrapper, not this file. The web shell's frozen platform seed answers
// the externals (react, react/jsx-runtime, the optional ui-primitives)
// through the injected `require`.
//
// The preview reads file bytes via the fileshow RPC (rev "worktree" for the
// live file, a change/commit id for a snapshot). It renders the bytes in the
// pane. No HTTP file route exists, so a workspace file is never a
// same-origin document.

import * as React from "react";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/core";
import jsLang from "highlight.js/lib/languages/javascript";
import tsLang from "highlight.js/lib/languages/typescript";
import pyLang from "highlight.js/lib/languages/python";
import bashLang from "highlight.js/lib/languages/bash";
import jsonLang from "highlight.js/lib/languages/json";
import cssLang from "highlight.js/lib/languages/css";
import xmlLang from "highlight.js/lib/languages/xml";
import mdLang from "highlight.js/lib/languages/markdown";
import goLang from "highlight.js/lib/languages/go";
import rustLang from "highlight.js/lib/languages/rust";
import yamlLang from "highlight.js/lib/languages/yaml";
import sqlLang from "highlight.js/lib/languages/sql";
import { css } from "./files-css.generated.js";

// The optional ui-primitives package loads at RUNTIME via the injected CJS
// `require`, inside a try/catch. The package can be ABSENT from the web
// shell's module table (a minimal profile). A static import fails the whole
// bundle when the package is missing, so this code MUST stay a runtime
// require.
let P: Record<string, unknown> | null = null;
try { P = require("@deepseek-ai/dsh-client-ui-primitives") as Record<string, unknown>; } catch { P = null; }

const BROWSE_CHANNEL = "/filez-browse";
const NS = "files";
const TEXT_PREVIEW_CAP = 1024 * 1024;   // ~1 MB of text or markdown, shown in the pane

const zh: Record<string, string> = {
  "view.files": "文件", "view.workspace": "工作区", "files.showHidden": "显示隐藏文件", "files.items": "个项目",
  "files.reload": "重新加载", "files.loading": "加载中…", "files.empty": "（空）", "files.truncated": "条目太多，只显示了一部分。",
  "files.fetchStuck": "目录请求未完成 —— 请点“重新加载”",
  "files.sessionGone": "会话已不可用（服务端重启或会话已结束）—— 点“重新加载”重试",
  "files.pathGone": "文件夹已不存在",
  "files.previewEmpty": "选择文件以预览", "files.previewLoading": "正在加载预览…",
  "files.previewTruncated": "已截断（大文件）",
  "files.previewError": "无法预览此文件",
  "files.diffLoading": "正在加载 diff…", "files.diffError": "无法加载 diff", "files.noChanges": "无变更",
  "files.diffNew": "新文件", "files.diffDeleted": "已删除", "files.diffRenamedFrom": "重命名自",
  "files.diffBinary": "二进制文件（内容不同）", "files.diffBinaryOld": "旧版（父提交）", "files.diffBinaryNew": "新版（此提交）", "files.diffBinaryNone": "（无）",
  "files.diffNoNewline": "文件末尾无换行",
  "files.diffTruncatedPatch": "diff 已截断（过大）", "files.diffTruncatedRows": "已截断（行数过多）",
  "files.selectCommit": "选择要查看的提交", "files.diffAtRev": "提交", "files.noChangeAtRev": "此提交未修改该文件", "files.worktreeRow": "工作树",
  "files.emptyCommit": "（空）", "files.noDescription": "（未设置描述）",
  "files.snapshotOf": "快照", "files.binaryFile": "二进制文件",
  "files.conflict": "个冲突", "files.conflicts": "个冲突",
  "files.view": "查看", "files.diff": "diff", "files.preview": "预览",
  "files.htmlSandboxed": "沙盒渲染 — 脚本运行在隔离的框架中：无网络、无法访问本应用；相对/外部文件不会加载",
  "files.htmlPreviewTitle": "在密封沙盒中渲染（脚本无法访问应用或网络）",
  "files.conflictNote": "存在未解决冲突（冲突标记在文件内容中可见）",
  "files.resizePanels": "拖动调整面板宽度（双击恢复默认）",
  "files.hideNav": "隐藏文件列表", "files.restoreNav": "恢复文件列表",
  "files.guideTitle": "工作区文件", "files.guideDescription": "浏览会话工作区的文件",
  "files.refAdd": "把引用添加到聊天", "files.refCopy": "复制引用", "files.refCopyText": "复制引用＋文本", "files.refCopyContext": "复制引用＋上下文", "files.refCopied": "已复制", "files.copyFile": "复制文件", "files.copySelection": "复制所选内容", "files.copyPath": "复制路径", "files.openLocal": "在本地打开", "files.openFailed": "无法在桌面打开该文件",
  "files.ageNow": "刚刚", "files.ageMin": "{n} 分钟", "files.ageHour": "{n} 小时", "files.ageDay": "{n} 天",
  "files.type.png": "PNG 图像", "files.type.jpeg": "JPEG 图像", "files.type.gif": "GIF 图像",
  "files.type.bmp": "BMP 图像", "files.type.webp": "WebP 图像", "files.type.svg": "SVG 图像",
  "files.type.avif": "AVIF 图像", "files.type.icon": "图标",
  "files.type.pdf": "PDF 文档", "files.type.zip": "ZIP 压缩包", "files.type.gzip": "GZIP 文件",
  "files.type.elf": "ELF 二进制文件", "files.type.binary": "二进制文件", "files.type.markdown": "Markdown",
  "files.type.mp3": "MP3 音频", "files.type.wav": "WAV 音频", "files.type.avi": "AVI 视频",
  "files.pdfFrameTitle": "PDF 预览", "files.htmlFrameTitle": "HTML 预览",
  "files.mermaidFrameTitle": "mermaid 图表", "files.renderFailed": "渲染失败：",
  "files.external": "外部文件", "files.openFile": "打开文件…",
  "files.externalPlaceholder": "绝对路径，例如 /tmp/file.md",
  "files.externalInvalid": "路径必须是绝对路径（以 / 开头）",
  "files.externalFailed": "无法打开",
};
const en: Record<string, string> = {
  "view.files": "Files", "view.workspace": "Workspace", "files.showHidden": "Show hidden files", "files.items": "items",
  "files.reload": "Reload", "files.loading": "Loading…", "files.empty": "(empty)", "files.truncated": "Too many entries, showing only some of them.",
  "files.fetchStuck": "the list request did not complete — press Reload",
  "files.sessionGone": "session is no longer available (server restarted or session ended) — press Reload to retry",
  "files.pathGone": "the folder no longer exists",
  "files.previewEmpty": "Select a file to preview", "files.previewLoading": "Loading preview…",
  "files.previewTruncated": "truncated (large file)",
  "files.previewError": "Couldn't preview this file",
  "files.diffLoading": "Loading diff…", "files.diffError": "Couldn't load diff", "files.noChanges": "no changes",
  "files.diffNew": "new file", "files.diffDeleted": "deleted", "files.diffRenamedFrom": "renamed from",
  "files.diffBinary": "binary file (content differs)", "files.diffBinaryOld": "old (parent)", "files.diffBinaryNew": "new (this commit)", "files.diffBinaryNone": "(none)",
  "files.diffNoNewline": "no newline at end of file",
  "files.diffTruncatedPatch": "diff truncated (large)", "files.diffTruncatedRows": "truncated (too many rows)",
  "files.selectCommit": "select commit to review", "files.diffAtRev": "commit", "files.noChangeAtRev": "no changes to this file in this commit", "files.worktreeRow": "Working Tree",
  "files.emptyCommit": "(empty)", "files.noDescription": "(no description set)",
  "files.snapshotOf": "snapshot of", "files.binaryFile": "binary file",
  "files.conflict": "conflict", "files.conflicts": "conflicts",
  "files.view": "View", "files.diff": "Diff", "files.preview": "Preview",
  "files.htmlSandboxed": "sandboxed render — scripts run in an isolated frame with no network and no access to this app; relative and external files are not loaded",
  "files.htmlPreviewTitle": "render in a sealed sandbox (scripts can't reach the app or the network)",
  "files.conflictNote": "unresolved conflict — markers visible in the file",
  "files.resizePanels": "Drag to resize the panels (double-click to reset)",
  "files.hideNav": "Hide file list", "files.restoreNav": "Restore file list",
  "files.guideTitle": "Workspace files", "files.guideDescription": "Browse files in this session's workspace",
  "files.refAdd": "Add ref to chat", "files.refCopy": "Copy ref", "files.refCopyText": "Copy ref + text", "files.refCopyContext": "Copy ref + context", "files.refCopied": "Copied", "files.copyFile": "Copy file", "files.copySelection": "Copy selection", "files.copyPath": "Copy path", "files.openLocal": "Open locally", "files.openFailed": "couldn't open the file on the desktop",
  "files.ageNow": "now", "files.ageMin": "{n}m", "files.ageHour": "{n}h", "files.ageDay": "{n}d",
  "files.type.png": "PNG image", "files.type.jpeg": "JPEG image", "files.type.gif": "GIF image",
  "files.type.bmp": "BMP image", "files.type.webp": "WebP image", "files.type.svg": "SVG image",
  "files.type.avif": "AVIF image", "files.type.icon": "icon",
  "files.type.pdf": "PDF document", "files.type.zip": "ZIP archive", "files.type.gzip": "GZIP file",
  "files.type.elf": "ELF binary", "files.type.binary": "binary file", "files.type.markdown": "Markdown",
  "files.type.mp3": "MP3 audio", "files.type.wav": "WAV audio", "files.type.avi": "AVI video",
  "files.pdfFrameTitle": "PDF preview", "files.htmlFrameTitle": "HTML preview",
  "files.mermaidFrameTitle": "mermaid diagram", "files.renderFailed": "Render failed:",
  "files.external": "External", "files.openFile": "Open file…",
  "files.externalPlaceholder": "absolute path, e.g. /tmp/file.md",
  "files.externalInvalid": "the path must be absolute (start with /)",
  "files.externalFailed": "couldn't open",
};

const CSS_TAG = "filestab/Files.css";
function injectCss(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]')) return;
  const el = document.createElement("style");
  el.setAttribute("data-plugin", "filestab");
  el.setAttribute("data-plugin-css", CSS_TAG);
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}

function Icon(name: string, props: { className?: string; size?: number } | undefined, fallback: string): React.ReactElement {
  const C = P ? (P[name] as unknown) : null;
  if (typeof C === "function") return React.createElement(C as React.ComponentType<{ className?: string; size?: number }>, props);
  return React.createElement("span", { className: props ? props.className : undefined, "aria-hidden": "true" }, fallback);
}
// The nav column's state-pair glyph: a double chevron (» / «). The host's
// icon set has only single chevrons (IconChevron*Outline14), and a lone » is
// ambiguous in a button row (it reads as disclosure), so the pane toggle
// ships its own inline glyph. It points at the nav while it hides (right)
// and back at the gap it leaves while it restores (left).
function NavChevron(props: { size?: number; className?: string; dir?: "left" | "right" }): React.ReactElement {
  const right = props.dir !== "left";
  return React.createElement("svg", {
    width: props.size || 14, height: props.size || 14, viewBox: "0 0 14 14", fill: "none",
    className: props.className, "aria-hidden": "true", xmlns: "http://www.w3.org/2000/svg",
  }, React.createElement("path", {
    d: right ? "M3.25 3.5 L7.25 7 L3.25 10.5 M6.75 3.5 L10.75 7 L6.75 10.5"
             : "M10.75 3.5 L6.75 7 L10.75 10.5 M7.25 3.5 L3.25 7 L7.25 10.5",
    stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
  }));
}
// The colored file-type icon (ui-primitives), or null when the package is
// absent (the caller falls back to the invisible spacer).
function fileTypeIconOf(name: string): React.ReactElement | null {
  if (!P) return null;
  const fti = P.FileTypeIcon, cft = P.classifyFileType;
  if (typeof fti !== "function" || typeof cft !== "function") return null;
  return React.createElement(fti as React.ComponentType<{ kind: string; size: number; className: string }>,
    { kind: (cft as (n: string) => string)(name), size: 16, className: "dswFiles_rowIconSpacer" });
}

// A rejected RPC carries the host's error code alongside its message so
// callers can branch on the code rather than string-matching the text. The
// message keeps the "code: message" shape the panes used to show verbatim.
class RpcError extends Error {
  readonly code: string;
  /** The host's details object (the closed envelope carries a per-code shape, e.g. details.path). */
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message || code);
    this.name = "RpcError";
    this.code = code;
    this.details = details;
  }
}
function unwrap<T>(result: unknown): T {
  const r = result as { ok?: boolean; value?: T; error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null | undefined;
  if (!r || r.ok !== true) {
    const err = r && r.error;
    // .code always carries a code for branching; the "rpc-failed" fallback is
    // a synthetic marker, not a host code, so it is never shown in the text.
    const code = typeof err?.code === "string" && err.code ? err.code : "rpc-failed";
    const msg = err && typeof err.message === "string" ? err.message : "";
    const shown = code === "rpc-failed"
      ? (msg || "rpc failed")
      : (msg ? code + ": " + msg : code);
    // details rides along (callers can branch on it — BUG-009's recovery
    // reads details.path) while the text keeps the code + message shape.
    const details = (err?.details && typeof err.details === "object") ? err.details : undefined;
    throw new RpcError(code, shown, details);
  }
  return r.value as T;
}
// The host tears a session down (server restart, session closed) while this
// view still holds its id, so every RPC for it fails with session-not-found.
// That is a distinct, terminal condition for this view — not a transient read
// hiccup — so callers branch on it specifically.
function isSessionGone(e: unknown): boolean {
  return (e as { code?: unknown } | null | undefined)?.code === "session-not-found";
}
// Human text for a rejected RPC. session-not-found gets a friendly localized
// line (never the raw code + UUID); anything else passes its message through.
function rpcErrorText(e: unknown, t: TFunc): string {
  if (isSessionGone(e)) return t("files.sessionGone");
  // A vanished listing directory (BUG-009): the localized note names the
  // dead path from details.path — never the raw "internal: not-found" string.
  if ((e as { code?: unknown } | null | undefined)?.code === "directory-unreadable") {
    const path = (e as { details?: { path?: unknown } } | null | undefined)?.details?.path;
    return t("files.pathGone") + (typeof path === "string" && path ? " (" + path + ")" : "");
  }
  const m = (e as { message?: string } | null | undefined)?.message;
  return m ? m : String(e);
}

// Markdown preview: markdown-it (MIT), bundled at build time and configured
// to keep the preview safe by construction. html:false escapes raw HTML, so
// file content stays inert. The markdown-it default link validator rejects
// javascript:/data:/vbscript: URLs. breaks:false renders soft line breaks as
// spaces (the GitHub file-view behavior). Explicit hard breaks stay <br>.
// linkify adds GFM autolinks, with fuzzyLink so the www form links too. The
// result matches GitHub.
// Task lists come from the markdown-it-task-lists plugin (disabled checkboxes).
// highlight.js (BSD-3) highlights the code fences (core + a curated language
// set, the same engine family GitHub's blob view uses). Tagged fences use
// their language (aliases like js/sh resolve). Untagged fences auto-detect.
// They stay plain unless the guess scores >= HLJS_AUTO_MIN_RELEVANCE
// (GitHub's threshold). Unknown tags fall through to the same detection.
hljs.registerLanguage("javascript", jsLang);
hljs.registerLanguage("typescript", tsLang);
hljs.registerLanguage("python", pyLang);
hljs.registerLanguage("bash", bashLang);
hljs.registerLanguage("json", jsonLang);
hljs.registerLanguage("css", cssLang);
hljs.registerLanguage("xml", xmlLang);
hljs.registerLanguage("markdown", mdLang);
hljs.registerLanguage("go", goLang);
hljs.registerLanguage("rust", rustLang);
hljs.registerLanguage("yaml", yamlLang);
hljs.registerLanguage("sql", sqlLang);
const HLJS_AUTO_MIN_RELEVANCE = 5;
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  }
  const auto = hljs.highlightAuto(code);
  return auto.relevance >= HLJS_AUTO_MIN_RELEVANCE ? auto.value : "";
}
const mdEngine = new MarkdownIt({ html: false, linkify: true, breaks: false, highlight: highlightCode });
mdEngine.linkify.set({ fuzzyLink: true });
mdEngine.use(taskLists);
// Preview links must not navigate the app: the preview renders into the top
// document (dangerouslySetInnerHTML), so a bare <a href> click navigates the
// dsh session's tab to the URL, replacing the session (BUG-012). Both
// [text](url) and linkify autolinks flow through the link_open rule, so one
// override covers both: every preview link opens in a new tab, and
// rel="noopener" keeps that tab from reaching window.opener.
const mdLinkOpenDefault = mdEngine.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
mdEngine.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token !== void 0) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return mdLinkOpenDefault(tokens, idx, options, env, self);
};
function renderMarkdown(md: unknown): string {
  return mdEngine.render(String(md));
}

// Local images in the Markdown preview: a workspace file is never a
// same-origin document (no HTTP file route exists), so a document-relative
// <img src> like "assets/hero.png" can never load. The code resolves each
// resolvable local src against the markdown file's own directory, fetches
// the bytes over the fileshow RPC (the transport the image/PDF preview
// already uses), and rewrites the src to a data: URL (which the CSP allows)
// before the HTML is rendered.

// Only document-relative local paths qualify. Scheme URLs (http:, https:,
// data:, mailto:, …), root-absolute paths, and empty srcs are left as-is:
// the browser's broken-img fallback is the pre-existing behavior.
function isLocalDocImageSrc(src: string): boolean {
  const s = String(src || "").trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) return false; // a scheme
  if (s.startsWith("/") || s.startsWith("\\")) return false; // absolute
  return true;
}

// Resolve a document-relative src against the markdown file's own directory
// ("docs/sub/note.md" + "../img/x.png" → "docs/img/x.png"). "." segments are
// dropped; a ".." that climbs past the workspace root invalidates the ref.
function resolveDocImage(mdRelPath: string, src: string): string {
  const parts = String(mdRelPath || "").split(/[/\\]/).filter(Boolean);
  parts.pop(); // drop the md file's own name
  for (const seg of String(src || "").split(/[/\\]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (parts.length === 0) return ""; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}

// The image srcs the render actually emits as <img> tokens, in document
// order. markdown-it has already validated the URLs (javascript: et al. are
// rejected) and applied linkify, so this is authoritative for what renders.
// Both the block-level `image` token and inline `image_inline` carry the src
// attribute; block tokens can nest inside container tokens (lists,
// blockquotes), hence the recursive walk.
function markdownImageSrcs(md: string): string[] {
  const out: string[] = [];
  const walk = (tokens: ReturnType<typeof mdEngine["parse"]>): void => {
    for (const t of tokens) {
      if (t.type === "image" || t.type === "image_inline") {
        const s = t.attrGet("src");
        if (s != null) out.push(String(s));
      }
      if (t.children) walk(t.children);
    }
  };
  walk(mdEngine.parse(String(md), {}));
  return out;
}

function htmlUnescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

// In rendered markdown, swap the src attribute of any <img> whose unescaped
// value is a key in the map (src → data: URL) for that data URL. Unmapped
// srcs (a missing file, an unreadable one, a non-image, a remote URL) are
// left untouched: the browser's broken-img fallback, as today.
function rewriteMarkdownImages(html: string, map: Record<string, string> | null | undefined): string {
  const src = String(html || "");
  if (!src || !map) return src;
  const keys = Object.keys(map);
  if (!keys.length) return src;
  return src.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/src=(["']?)([^\s"'<>]*)\1/i);
    if (!m) return tag;
    const dataUrl = map[htmlUnescapeAttr(m[2]!)];
    return dataUrl ? tag.replace(m[0]!, "src=" + m[1]! + dataUrl + m[1]!) : tag;
  });
}

function renderMarkdownWithImages(md: string, imgMap: Record<string, string>): string {
  return rewriteMarkdownImages(renderMarkdown(md), imgMap);
}

// Source-file view: the same hljs set highlights a text file by its
// extension (the client has no other language source). Unknown extensions
// auto-detect, but only under HLJS_AUTO_MAX (highlightAuto's cost grows
// with size) and only at the same relevance threshold as untagged markdown
// fences. Returns highlighted (escaped) HTML, or null for a plain render.
const SRC_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", sh: "bash", bash: "bash", zsh: "bash",
  json: "json", jsonc: "json",
  css: "css", scss: "css", less: "css",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown",
  go: "go", rs: "rust",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
};
const HLJS_AUTO_MAX = 256 * 1024;
function highlightSource(text: string, name: string | null): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  const lang = m ? SRC_LANG[m[1]!.toLowerCase()] : undefined;
  if (lang) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  if (text.length <= HLJS_AUTO_MAX) {
    const auto = hljs.highlightAuto(text);
    if (auto.relevance >= HLJS_AUTO_MIN_RELEVANCE) return auto.value;
  }
  return null;
}

// Mermaid fences: the one place file content becomes SCRIPT. It runs in a
// sealed sandbox iframe, the same trust level as the .html preview
// (sandbox="allow-scripts" only: opaque origin, no network, no reach to
// this app, never the GUI's own origin). markdown-it renders a ```mermaid
// fence as an inert <pre><code class="language-mermaid"> block. A
// PreviewPane effect swaps each block for a srcdoc iframe. The frame
// document inlines the diagram source plus the vendored mermaid bundle.
// The host "mermaid" endpoint serves that bundle, but the sandboxed frame
// cannot fetch it itself, so the client inlines it into the srcdoc.
// securityLevel "antiscript" blocks script embedded in a diagram. A syntax
// error shows the raw source plus the error text inside the frame.
function buildMermaidDoc(bundle: string, source: string, theme: string, renderFailed?: string): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // The localized "render failed" prefix, as a JS string literal for the srcdoc.
  const rf = JSON.stringify(renderFailed ?? "Render failed:");
  // Guards against a future bundle that contains the literal tag sequence
  // (in a JS string literal `\/` is `/`, so the code's value is unchanged).
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'\">" +
    "<style>html{color-scheme:" + (theme === "dark" ? "dark" : "light") + "}html,body{margin:0}body{padding:8px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.err{white-space:pre-wrap;font-size:12.5px;color:#cf222e}</style>" +
    "</head><body>" +
    "<script>" + bundle.split("</script>").join("<\\/script>") + "</script>" +
    // AFTER the pre: a synchronous script runs at parse time, so it must come
    // after the element it reads (querySelector returns null before that).
    "<pre class=\"mermaid\">" + esc(source) + "</pre>" +
    "<script>var done=function(){parent.postMessage({filestabMermaid:document.body.scrollHeight+16},\"*\");};mermaid.initialize({startOnLoad:false,securityLevel:\"antiscript\",theme:" + JSON.stringify(theme) + "});var node=document.querySelector(\"pre.mermaid\");mermaid.render(\"filestab-md-1\",node.textContent).then(function(res){document.body.innerHTML=res.svg;done();}).catch(function(e){node.textContent=node.textContent+\"\\n\\n\"+" + rf + "+String((e&&e.message)||e);done();});</script>" +
    "</body></html>";
}
// The bundle is ~3.5 MB. The client fetches it once per page and shares it
// across every fence. A failure (a missing vendored file) degrades to plain
// code blocks.
let mermaidBundle: Promise<string | null> | null = null;
function getMermaidBundle(read: () => Promise<{ text: string }>): Promise<string | null> {
  if (mermaidBundle === null) {
    mermaidBundle = read()
      .then((r) => (typeof r?.text === "string" && r.text.length > 0 ? r.text : null))
      .catch(() => null);
  }
  return mermaidBundle;
}
function makeMermaidFrame(bundle: string, source: string, dark: boolean, frames: Map<HTMLIFrameElement, string>, title: string, renderFailed: string): HTMLIFrameElement {
  // The frame bakes mermaid's palette into the SVG at render time. The
  // caller thus passes the GUI's resolved dark state
  // (body[data-ds-dark-theme], which the dsh theme presenter applies from
  // the user preference). A raw prefers-color-scheme check drifts from an
  // explicit setting. The frame reports its natural height via postMessage
  // (320px placeholder).
  const f = document.createElement("iframe");
  f.className = "dswFiles_mermaidFrame";
  f.sandbox = "allow-scripts";
  f.title = title;
  f.style.height = "320px";
  f.srcdoc = buildMermaidDoc(bundle, source, dark ? "dark" : "default", renderFailed);
  frames.set(f, source);
  return f;
}

function formatBytes(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "";
  const v0 = Number(n);
  if (!isFinite(v0)) return "";
  if (v0 < 1024) return v0 + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = v0, u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const rounded = Math.round(v * 10) / 10;
  return (rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1)) + " " + (units[u] || "");
}
// Relative age for the nav row meta (BUG-008): compact while recent
// ("now", "5m", "3h", "2d"), then a browser-locale calendar date (a date
// needs no dictionary entry). The units are keys ({n} interpolated); the
// row slot is ~60px at the default pane width, so the short forms stay.
// A FUTURE mtime (clock skew, a restored timestamp) is not "-1m" — it gets
// the calendar date too.
function formatAge(mtime: number, t: TFunc): string {
  const age = Date.now() - mtime;
  if (!Number.isFinite(age) || age < 0) return new Date(mtime).toLocaleDateString();
  if (age < 60_000) return t("files.ageNow");
  const min = Math.floor(age / 60_000);
  if (min < 60) return t("files.ageMin").replace("{n}", String(min));
  const h = Math.floor(min / 60);
  if (h < 24) return t("files.ageHour").replace("{n}", String(h));
  const d = Math.floor(h / 24);
  if (d < 7) return t("files.ageDay").replace("{n}", String(d));
  return new Date(mtime).toLocaleDateString();
}
// The file row's compact meta, or null (BUG-008, scope: FILES ONLY —
// directory rows keep their rollup badge unchanged). A snapshot listing
// (a past VCS tree has no on-disk stat) omits size/mtime → null. The
// `title` is the full detail the row tooltip shows.
function fileRowMeta(entry: DirEntry, t: TFunc): { label: string; title: string } | null {
  if (entry.isDirectory || typeof entry.size !== "number" || typeof entry.mtime !== "number") return null;
  return {
    label: formatBytes(entry.size) + " · " + formatAge(entry.mtime, t),
    title: entry.path + " — " + formatBytes(entry.size) + " — " + new Date(entry.mtime).toLocaleString(),
  };
}
// Client-side file-type labels. The host sends the sniffed/derived MIME type
// (plus an English label it no longer displays); the displayed label comes
// from the active locale dictionary so it follows the user's language.
// Unknown types fall back to the raw MIME string (a technical token, identical
// in every language); a missing type falls back to the localized "binary file".
const TYPE_LABEL_KEYS: Record<string, string> = {
  "image/png": "files.type.png", "image/jpeg": "files.type.jpeg", "image/gif": "files.type.gif",
  "image/bmp": "files.type.bmp", "image/webp": "files.type.webp", "image/svg+xml": "files.type.svg",
  "image/avif": "files.type.avif", "image/x-icon": "files.type.icon",
  "application/pdf": "files.type.pdf", "application/zip": "files.type.zip", "application/gzip": "files.type.gzip",
  "application/x-elf": "files.type.elf", "application/octet-stream": "files.type.binary",
  "text/markdown": "files.type.markdown", "audio/mpeg": "files.type.mp3", "audio/vnd.wave": "files.type.wav",
  "video/vnd.avi": "files.type.avi",
};
function typeLabel(type: string | undefined, t: TFunc): string {
  const key = type ? TYPE_LABEL_KEYS[type] : undefined;
  return key ? t(key) : type ? type : t("files.type.binary");
}

// ---- Section references ("refer this selection to the chat") ----
//
// The reference a selection produces is the shortest string that points at
// one section of one file such that BOTH readers resolve it: the user,
// reading it back in the draft, and the agent, which follows the
// "@-prefixed paths are files explicitly referenced by the user" rule and
// calls read with offset/limit. It is therefore always a canonical dsh
// `@path` mention (the ref degrades to a plain file ref if the fragment is
// ignored), optionally a GitHub-style line fragment, optionally the
// selected text quoted.
//
// The generated string is a fixed-ASCII technical token, NOT UI copy — it is
// never localized. Only the button labels/tooltips around it are.
//
// Shapes (all workspace-relative, VS Code-style `path:line-line`; the
// `@path` core is dsh's native mention, so the ref degrades to a plain file
// ref if a model ignores the fragment):
//   view pane              @src/foo.ts:12          @src/foo.ts:12-40
//   diff, new side         @src/foo.ts:12-16       (numbers = worktree lines)
//   diff, old side only    @src/foo.ts "deleted…"  (no numbers: those lines
//                                            no longer exist in the worktree,
//                                            so the quoted snippet is the only
//                                            reliable anchor)
//   snapshot (commit rev)  @src/foo.ts@abc123:12-40
//   preview (rendered)     @docs/notes.md "first selected line…" (rendered
//                                            markdown has no stable source
//                                            line numbers → snippet anchor)
//   path with a space      @"my dir/foo.ts":12-40  (dsh quoted-mention)
// When a quoted snippet is present it follows the fragment, whitespace-
// separated: `@path:12-40 "…text…"`.

// The quote cap: the full selection at or below it, otherwise the head plus
// the ellipsis (the section's beginning is the identifying part).
const REF_TEXT_MAX = 200;

function mentionOf(path: string): string {
  const p = String(path || "");
  if (!p) return "@";
  // Whitespace, a double quote, or a control char forces the dsh quoted
  // grammar (`@"path"`); the grammar cannot represent those inside, so they
  // are dropped (a workspace path containing them degrades best-effort).
  if (/[ \s"\u0000-\u001f\u007f-\u009f]/.test(p)) {
    const clean = p.replace(/[\u0000-\u001f\u007f-\u009f"]/g, "");
    return clean ? '@"' + clean + '"' : "@";
  }
  return "@" + p;
}

// One builder for both copy variants: the line-range ref is the input
// without `text`, the snippet ref the same input with it. A missing range is
// the snippet-only shape (deleted diff lines, rendered preview, an
// unresolvable selection) — the quote is the anchor then.
interface RefInput {
  path: string;
  /** 1-based inclusive line range; absent → no fragment. */
  start?: number;
  end?: number;
  /** The commit under review (snapshot mode): `@rev` before the fragment. */
  rev?: string;
  /** The selected text (quoted after the fragment when non-blank). */
  text?: string;
}
function buildFileRef(inp: RefInput): string {
  let out = mentionOf(inp.path);
  // @rev applies to the ref as a whole (the file AND the quoted text are the
  // state at that commit) — but the caller must not pass it for old-side diff
  // lines, which belong to the commit's PARENT, not to it.
  if (inp.rev) out += "@" + inp.rev;
  if (typeof inp.start === "number" && inp.start >= 1) {
    let s = inp.start;
    let e = typeof inp.end === "number" ? inp.end : s;
    if (e < s) { const t = s; s = e; e = t; } // ranges can arrive out of order
    const nums = s === e ? String(s) : s + "-" + e;
    out += ":" + nums;
  }
  // The selection quote: double quotes inside become single (the delimiters
  // must stay unambiguous), trimmed ends, capped with the ellipsis.
  const sel = (inp.text || "").replace(/"/g, "'").trim();
  if (sel) {
    const body = sel.length <= REF_TEXT_MAX ? sel : sel.slice(0, REF_TEXT_MAX).replace(/\s+$/, "") + "…";
    out += ' "' + body + '"';
  }
  return out;
}

// Label for the primary "copy the ref" action. Two shapes coexist: a
// numbers ref with a separate "+ text" variant (the plain button stays
// "Copy ref"), and a snippet-only ref (old side, rendered preview) whose
// plain form ALREADY carries the line text — the button then says
// "+ context" so the label is honest about what lands on the clipboard.
function refCopyLabel(t: TFunc, hasTextVariant: boolean, context: boolean): string {
  return hasTextVariant || !context ? t("files.refCopy") : t("files.refCopyContext");
}

// Char offsets at which each line begins (line 1 starts at 0). Used to map a
// selection's char offset in the view pane to a 1-based line number.
function lineStartsOf(text: string): number[] {
  const t = String(text || "");
  const starts = [0];
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

// Scroll a loaded text pre so that `line` (1-based) sits near the top. The
// pre's text content is byte-identical to the fetched text (hljs only wraps
// spans), so the line's char offset maps onto the DOM text nodes: walk them,
// place a one-char range at the offset, and scroll the pre's own box (the
// text view's scrollport). Wrapped lines make line-height math wrong, which
// is why the mapping goes through the DOM instead.
function scrollToTextLine(pre: HTMLElement, text: string, line: number): void {
  if (line < 1) return;
  const starts = lineStartsOf(text);
  if (line > starts.length) return;
  const first = starts[line - 1];
  if (typeof first !== "number") return;
  let off = first;
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.nodeValue ? node.nodeValue.length : 0;
    if (off <= len) break;
    off -= len;
    node = walker.nextNode() as Text | null;
  }
  if (!node) return;
  const len = node.nodeValue ? node.nodeValue.length : 0;
  const range = document.createRange();
  range.setStart(node, off);
  range.setEnd(node, Math.max(off, Math.min(off + 1, len)));
  const rect = range.getBoundingClientRect();
  const box = pre.getBoundingClientRect();
  if (rect.height === 0) return;
  pre.scrollTop = Math.max(0, pre.scrollTop + rect.top - box.top - 24);
}

// ---- selection → reference (DOM side; the pure shaping is above) ----
//
// The view pane renders ONE <pre> (hljs spans may cross line breaks — a block
// comment, a multi-line string — so the text is NOT line-segmented in the
// DOM). The mapping instead goes through char offsets: the pre's text content
// is byte-identical to the fetched text (hljs only wraps spans, it never
// alters the characters), so a selection's char offset within the pre maps
// onto lineStartsOf(st.text) directly.
//
// The diff grid IS line-segmented (one cell per row per side, the gutters are
// user-select:none), so its cells carry data-dl/data-dn and a selection is a
// plain intersectsNode scan.

// Char offset of a text node + in-node offset within root (−1 when the node
// is not under root). O(text nodes) — runs only on selectionchange, never on
// render.
function textNodeOffset(root: Node, text: Text, offset: number): number {
  if (!root.contains(text)) return -1;
  let count = 0;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = tw.nextNode() as Text | null;
  while (node) {
    if (node === text) return count + offset;
    count += node.length;
    node = tw.nextNode() as Text | null;
  }
  return -1;
}
// 1-based line of a char offset (the last line start ≤ offset).
function lineOfOffset(offset: number, lineStarts: number[]): number {
  let lo = 0, hi = lineStarts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans + 1;
}
// The 1-based inclusive line range a live selection spans inside a <pre>.
// null when there is no usable text selection (collapsed, element-anchored —
// browsers report element anchors for whole-node selections, the offset math
// would be guesswork — or outside the pre).
function viewSelRange(pre: HTMLElement, lineStarts: number[]): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const a = sel.anchorNode, f = sel.focusNode;
  if (!a || !f || a.nodeType !== Node.TEXT_NODE || f.nodeType !== Node.TEXT_NODE) return null;
  const aOff = textNodeOffset(pre, a as Text, sel.anchorOffset);
  const fOff = textNodeOffset(pre, f as Text, sel.focusOffset);
  if (aOff < 0 || fOff < 0) return null;
  const lo = Math.min(aOff, fOff), hi = Math.max(aOff, fOff);
  return { start: lineOfOffset(lo, lineStarts), end: lineOfOffset(hi - 1, lineStarts) };
}
// The line range + text a live selection covers over the diff cells tagged
// with `attr` (data-dl = old side, data-dn = new side). The per-side scan is
// what keeps a mod-row selection clean: the ref quotes ONE side's text.
function diffSelRange(root: HTMLElement, attr: string): { min: number; max: number; text: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  let min = Infinity, max = -1;
  const parts: string[] = [];
  const els = root.querySelectorAll<HTMLElement>("[" + attr + "]");
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    const n = Number(el.getAttribute(attr));
    if (!Number.isFinite(n)) continue;
    if (!range.intersectsNode(el)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
    const t = (el.textContent || "").trim();
    if (t) parts.push(t);
  }
  if (max < 0) return null;
  return { min, max, text: parts.join("\n") };
}

type TFunc = (key: string) => string;
type DiffRow = { k: string; text: string; oldNo: number | null; newNo: number | null; noNewline: boolean };
type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; rows: DiffRow[] };
type DiffFile = {
  oldPath: string | null; newPath: string | null;
  isNew: boolean; isDeleted: boolean; isBinary: boolean;
  modeFrom: string | null; modeTo: string | null;
  renameFrom: string | null; renameTo: string | null;
  hunks: DiffHunk[];
};
type DisplayRow = { type: string; old: DiffRow | null; nw: DiffRow | null };
// The file's real path. Deleted files carry the /dev/null placeholder in
// newPath (new files carry it in oldPath). Using the placeholder for
// identity or display collides every deleted file (and prints "/dev/null"
// as the name).
function realPathOf(m: DiffFile): string {
  if (m.newPath && m.newPath !== "/dev/null") return m.newPath;
  return m.oldPath && m.oldPath !== "/dev/null" ? m.oldPath : "";
}
type Gap = { old: [number, number] | null; new: [number, number] | null };
type VcsChange = { path: string; status: string; oldPath?: string | null; base?: string };
type VcsCommit = { id: string; empty?: boolean; description: string };
type VcsHead = { id: string; description: string; marker: string };
type VcsInfo = {
  ok: boolean;
  backend?: string;
  head?: VcsHead;
  changes?: VcsChange[];
  conflicts?: string[];
  commits?: VcsCommit[];
  // Failure block (ok === false): the host sends {ok:false, code, message}.
  code?: string;
  message?: string;
};
type DirEntry = { name: string; path: string; isDirectory: boolean; size?: number; mtime?: number };
type DiffBinarySide = { kind: string; size?: number; type?: string; label?: string; data?: string };
type DiffBinary = { new: DiffBinarySide | null; old: DiffBinarySide | null };

// The host computes the patch (jj diff --git). This module only parses it.
// Safety contract:
//   - the parser skips unrecognized header lines (never fatal)
//   - the parser trusts no hunk count: line numbers follow the lines
//     actually present, so a patch truncated mid-hunk (the host 1 MB cap)
//     cannot desync them
//   - the parser degrades an unknown line inside a hunk to context (never
//     crash)
//   - the parser reads `---`/`+++` only BEFORE the first hunk: a deleted
//     line whose text starts with `-- ` must stay a del row
function parseDiff(patch: unknown): { files: DiffFile[] } {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null, h: DiffHunk | null = null;
  let oldNo = 0, newNo = 0, lastDel: DiffRow | null = null, lastAdd: DiffRow | null = null;
  const lines = String(patch).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing-newline artifact, not a row
  for (const raw of lines) {
    const line = raw; // keep \r (CRLF files). white-space:pre renders it
    if (line.indexOf("diff --git ") === 0) {
      const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      f = { oldPath: m ? m[1]! : null, newPath: m ? m[2]! : null, isNew: false, isDeleted: false, isBinary: false, modeFrom: null, modeTo: null, renameFrom: null, renameTo: null, hunks: [] };
      files.push(f); h = null; oldNo = 0; newNo = 0; lastDel = lastAdd = null;
      continue;
    }
    if (f === null) continue; // preamble before the first section
    let m;
    // `diff --git` is authoritative for the paths (clean, no a/ b/ prefix).
    // `---`/`+++` only contribute the /dev/null → new/deleted detection.
    if (h === null && line.indexOf("--- ") === 0) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") { f.isNew = true; f.oldPath = "/dev/null"; }
      continue;
    }
    if (h === null && line.indexOf("+++ ") === 0) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") { f.isDeleted = true; f.newPath = "/dev/null"; }
      continue;
    }
    if ((m = line.match(/^rename from (.+)$/))) { f.renameFrom = m[1]!; continue; }
    if ((m = line.match(/^rename to (.+)$/))) { f.renameTo = m[1]!; continue; }
    if ((m = line.match(/^new file mode (\S+)$/))) { f.isNew = true; f.modeTo = m[1]!; continue; }
    if ((m = line.match(/^deleted file mode (\S+)$/))) { f.isDeleted = true; f.modeFrom = m[1]!; continue; }
    if ((m = line.match(/^old mode (\S+)$/))) { f.modeFrom = m[1]!; continue; }
    if ((m = line.match(/^new mode (\S+)$/))) { f.modeTo = m[1]!; continue; }
    if (line.indexOf("Binary files ") === 0) { f.isBinary = true; continue; }
    if (line.charAt(0) === "@" && (m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) {
      h = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
            newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), rows: [] };
      f.hunks.push(h);
      oldNo = h.oldStart; newNo = h.newStart; lastDel = lastAdd = null;
      continue;
    }
    if (h !== null) {
      const c = line.charAt(0);
      if (c === "\\") { if (lastDel) lastDel.noNewline = true; else if (lastAdd) lastAdd.noNewline = true; continue; }
      if (c === "+") { const row: DiffRow = { k: "add", text: line.slice(1), oldNo: null, newNo: newNo++, noNewline: false }; h.rows.push(row); lastAdd = row; lastDel = null; continue; }
      if (c === "-") { const row: DiffRow = { k: "del", text: line.slice(1), oldNo: oldNo++, newNo: null, noNewline: false }; h.rows.push(row); lastDel = row; lastAdd = null; continue; }
      const row: DiffRow = { k: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++, noNewline: false };
      h.rows.push(row); lastDel = lastAdd = null;
    }
    // outside a hunk: unrecognized header line → skip (contract)
  }
  return { files };
}

// The line ranges the patch omits between hunk i and i+1, per side (null
// when the patch omits nothing). Zero-count hunks anchor at a phantom line
// 0, so the code clamps the end to 1.
function gapAfter(prev: DiffHunk | null, next: DiffHunk | null): Gap | null {
  if (!prev || !next) return null;
  const oldEnd = Math.max(prev.oldStart + prev.oldCount, 1);
  const newEnd = Math.max(prev.newStart + prev.newCount, 1);
  const oldRange: [number, number] | null = next.oldStart > oldEnd ? [oldEnd, next.oldStart - 1] : null;
  const newRange: [number, number] | null = next.newStart > newEnd ? [newEnd, next.newStart - 1] : null;
  return oldRange || newRange ? { old: oldRange, new: newRange } : null;
}

// Pair each contiguous del run with the contiguous add run that FOLLOWS it,
// in order, up to the shorter (surplus rows keep a blank opposite cell).
// In-order pairing prevents the `-a -b +c` mis-pair.
function displayRows(hunk: DiffHunk): DisplayRow[] {
  const out: DisplayRow[] = [];
  let i = 0;
  while (i < hunk.rows.length) {
    const r = hunk.rows[i]!;
    if (r.k === "ctx") { out.push({ type: "ctx", old: r, nw: null }); i++; continue; }
    const dels: DiffRow[] = [];
    while (i < hunk.rows.length && hunk.rows[i]!.k === "del") { dels.push(hunk.rows[i]!); i++; }
    const adds: DiffRow[] = [];
    while (i < hunk.rows.length && hunk.rows[i]!.k === "add") { adds.push(hunk.rows[i]!); i++; }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) out.push({ type: "mod", old: dels[p]!, nw: adds[p]! });
    for (let p = pairs; p < dels.length; p++) out.push({ type: "del", old: dels[p]!, nw: null });
    for (let p = pairs; p < adds.length; p++) out.push({ type: "add", old: null, nw: adds[p]! });
  }
  return out;
}

// Status-line aggregate: the working-copy change letters (jj: `@` vs `@-`,
// git: worktree vs HEAD, never past commits) + the conflict count. "No
// changes" is the expected state right after `jj commit`.
function statusAggregate(vcsInfo: VcsInfo | null, t: TFunc): string {
  if (!vcsInfo || !vcsInfo.ok) return "";
  const letters: Record<string, number> = {};
  for (const c of (vcsInfo.changes || [])) letters[c.status] = (letters[c.status] || 0) + 1;
  const letterParts = ["A", "M", "D", "R", "C", "U"].filter((s) => letters[s]).map((s) => s + letters[s]);
  const nconf = (vcsInfo.conflicts || []).length;
  const conf = nconf ? nconf + (nconf === 1 ? " " + t("files.conflict") : " " + t("files.conflicts")) : "";
  if (letterParts.length && conf) return letterParts.join(" ") + " · " + conf;
  if (letterParts.length) return letterParts.join(" ");
  if (conf) return conf;
  return t("files.noChanges");
}
// A jj dropdown row label. It mirrors jj's OWN rendering: `jj log`/`jj
// status` show `(empty)` for an empty commit and `(no description set)` for
// a missing description. The dropdown thus reads identically to the
// terminal. Git rows do not use this (they keep the bare `<id> <subject>`).
function jjRowLabel(id: string, { empty, description }: { empty?: boolean; description?: string }, t: TFunc): string {
  let s = id || "…";
  if (empty) s += " " + t("files.emptyCommit");
  s += description ? " " + description : " " + t("files.noDescription");
  return s;
}

// Changed files beneath dirPath (prefix match, the listing is flat, so this
// counts through nested subdirectories too). Returns count + conflict count
// and both subsets (the tooltip reuses statusAggregate). "" = workspace root.
function rollupFor(vcsInfo: VcsInfo | null, dirPath: string): { count: number; conflictCount: number; changes: VcsChange[]; conflicts: string[] } {
  if (!vcsInfo || !vcsInfo.ok) return { count: 0, conflictCount: 0, changes: [], conflicts: [] };
  const prefix = dirPath ? String(dirPath) + "/" : "";
  const changes = (vcsInfo.changes || []).filter((e) => e.path.indexOf(prefix) === 0);
  const conflicts = (vcsInfo.conflicts || []).filter((p) => p.indexOf(prefix) === 0);
  return { count: changes.length, conflictCount: conflicts.length, changes: changes, conflicts: conflicts };
}
// A count over 99 widens the row slot. The code caps the label. The
// tooltip keeps the truth.
const rollupLabel = (n: number): string => (n > 99 ? "99+" : String(n));
// A folder row's count pill, or null when unchanged (renderRow substitutes an
// empty slot so the chevrons stay aligned with the file rows).
function rollupSlot(rollup: { count: number; conflictCount: number; changes: VcsChange[]; conflicts: string[] } | null, t: TFunc): React.ReactElement | null {
  if (!rollup || rollup.count <= 0) return null;
  const title = statusAggregate({ ok: true, changes: rollup.changes, conflicts: rollup.conflicts }, t);
  return React.createElement("span", {
    className: "dswFiles_rollupPill" + (rollup.conflictCount > 0 ? " dswFiles_rollupPillConflict" : ""),
    title: title,
  }, rollupLabel(rollup.count));
}

// Display order for one directory's entries: directories first, then
// everything else, each group by natural name (so `file2` precedes `file10`).
// The host's order is a listing fact; this is the reader's.
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function orderEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.isDirectory) - Number(left.isDirectory);
    return group !== 0 ? group : byName.compare(left.name, right.name);
  });
}
// Split a path for display (the header's root path): the directories through
// the last separator, and the final segment. A separator-only or empty path
// is all name. Both `/` and `\` separate.
function pathPartsOf(path: string): { directory: string; name: string } {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed === "") return { directory: "", name: path };
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1;
  return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) };
}
// The parent directory's relPath ("" = root; a root-level entry → "").
function parentPathOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? ROOT_PATH : path.slice(0, i);
}

// Per-session view state (localStorage): a refresh resets component state
// (the tab ring only restores the active tab), so FilesView restores its
// own expanded set + selection. The read and write are best-effort and never
// throw (SSR, privacy mode).
const STATE_KEY = (sid: string): string => "filestab/files/" + sid;
type SavedState = {
  expanded: string[]; path: string; selected: string | null; navW: number | null; rev: string | null; collapsed: boolean;
  /** The pinned out-of-workspace (External section) files, absolute paths. */
  external: string[];
  /** The selected External file (mutually exclusive with `selected`). */
  selectedExternal: string | null;
};
/** The root's relPath: "" is always an expanded path. */
const ROOT_PATH = "";
function expandedFromPath(path: string): string[] {
  return [ROOT_PATH, ...String(path || "").split("/").filter(Boolean).reduce<string[]>((acc, _seg, i, segs) => {
    acc.push(segs.slice(0, i + 1).join("/"));
    return acc;
  }, [])];
}
// Reconstruct the absolute path behind a workspace-relative open whose
// workspace resolution failed — the dsh 0.1.5 out-of-workspace addressing
// loss: fileAddressFor strips the workspace root from an INSIDE path, and
// sends an OUTSIDE absolute path with its leading separator dropped (the
// "/" is indistinguishable from the address's own separator). A POSIX
// outside file /tmp/x.md therefore arrives as "tmp/x.md", and the exact
// original is "/" + that text. Windows forms survive the encoding as
// segments (a drive letter "C:" is a non-empty first segment; UNC keeps
// its slashes), so they pass through untouched. The HOST stat-verifies the
// candidate before it is pinned; a wrong guess simply fails.
function toAbsoluteCandidate(path: string): string | null {
  const p = String(path || "").trim();
  if (!p) return null;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("//") || p.startsWith("/")) return p;
  return "/" + p;
}
function loadState(sessionId: string | null): SavedState | null {
  try {
    if (typeof localStorage === "undefined" || !sessionId) return null;
    const raw = localStorage.getItem(STATE_KEY(sessionId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Record<string, unknown>;
    // The tree model saves an expanded set; the pre-tree model saved a single
    // directory. Migrate: that directory's ancestor chain is the expanded set.
    const expanded = Array.isArray(s.expanded)
      ? (s.expanded as unknown[]).filter((p): p is string => typeof p === "string")
      : expandedFromPath(typeof s.path === "string" ? s.path : "");
    return {
      expanded: expanded.includes(ROOT_PATH) ? expanded : [ROOT_PATH, ...expanded],
      path: typeof s.path === "string" ? s.path : "",
      selected: typeof s.selected === "string" ? s.selected : null,
      navW: typeof s.navW === "number" ? s.navW : null,
      rev: typeof s.rev === "string" ? s.rev : null,
      collapsed: s.collapsed === true,
      external: Array.isArray(s.external)
        ? (s.external as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
        : [],
      selectedExternal: typeof s.selectedExternal === "string" ? s.selectedExternal : null,
    };
  } catch (e) { return null; }
}
function saveState(
  sessionId: string | null, expanded: string[], selected: string | null, navW: number | null,
  rev: string | null, collapsed: boolean, external: string[], selectedExternal: string | null,
): void {
  try {
    if (typeof localStorage === "undefined" || !sessionId) return;
    localStorage.setItem(STATE_KEY(sessionId), JSON.stringify({
      expanded: [ROOT_PATH, ...expanded], selected: selected || null,
      navW: typeof navW === "number" ? Math.round(navW) : null,
      rev: rev || null,
      collapsed: collapsed === true,
      external: external, selectedExternal: selectedExternal || null,
    }));
  } catch (e) { /* storage full / privacy mode, best-effort */ }
}
function segmentsForPath(rootSeg: { name: string; path: string }, path: string | null | undefined): { name: string; path: string }[] {
  const segs = String(path || "").split(/[/\\]/).filter(Boolean);
  const out = [rootSeg];
  for (let i = 0; i < segs.length; i++) out.push({ name: segs[i]!, path: segs.slice(0, i + 1).join("/") });
  return out;
}
const MAX_DIFF_ROWS = 5000; // client render cap (the host caps patch BYTES)

const NN = () => <span className="dswFiles_diffNN" aria-hidden="true">⏎</span>;
function diffSide(row: DiffRow | null): string | [string, React.ReactElement] {
  if (!row) return "";
  return row.noNewline ? [row.text, <NN key="nn" />] : row.text;
}
// Intra-line diff (BUG-003, reworked per BUG-010 after checking how the
// established renderers do it):
//   - git's xdiff word-diff: the alignment runs over WORD tokens only
//     ([[:isalnum:]]+); a changed span is ONE contiguous stretch of the
//     original line from the first to the last changed word, so the
//     whitespace BETWEEN changed words is part of the span (verified on a
//     real change: git renders `{+-rotate 90+}` — the inner space rides in).
//     A whitespace-ONLY change shows no marker at all.
//   - diff-highlight (diff-so-fancy, the ancestor of GitHub's intra-line
//     highlight): common prefix/suffix, then ONE contiguous span per side
//     covering everything in between — plus an "interesting" gate: skip the
//     intra-line highlight when the changed region is the whole line
//     ("otherwise the highlighting is just useless noise").
//   - jsdiff's diffWords (documented): "each word and each punctuation mark
//     as a token. Whitespace is ignored when computing the diff (but
//     preserved as far as possible in the final change objects)."
// All three agree: a changed region is contiguous and its internal
// whitespace is highlighted with it; none post-processes the alignment to
// un-highlight changed whitespace. (The old BUG-004 rule did exactly that
// and is what made a changed space look unchanged — BUG-010.)
// Tokens here: word runs [A-Za-z0-9_]+ plus single punctuation (jsdiff's
// "word and each punctuation mark", with underscore/digits kept in the word
// so identifiers stay whole). null = no intra-line emphasis (identical
// lines, whitespace-only change, a token table too big for the quadratic
// pass, or a line pair too dissimilar for the spans to help — the gate
// below, the same family as diff-highlight's "interesting" rule; the row
// tint is enough in all four cases).
type IntraSeg = { text: string; cls: "same" | "del" | "add" };
type IntraDiff = { old: IntraSeg[]; nw: IntraSeg[] };
const INTRA_TOKENS = /[A-Za-z0-9_]+|\s+|\S/g;
// Similarity gate: at least this fraction of the SHORTER line's word tokens
// must be shared (in order, the LCS), or the mod row falls back to the plain
// row tint. A heavily rewritten line is a whole-line change — a span would
// cover the line and read as noise (diff-highlight's "interesting" gate is
// the coarse form of this: it highlights only when a non-whitespace prefix
// OR suffix survives).
const INTRA_MIN_SHARED_FRACTION = 0.5;
type IntraTok = { text: string; start: number; end: number };
function intraTokenize(text: string): IntraTok[] {
  const out: IntraTok[] = [];
  INTRA_TOKENS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTRA_TOKENS.exec(text))) out.push({ text: m[0]!, start: m.index, end: m.index + m[0]!.length });
  return out;
}
function intraTokens(text: string): string[] {
  return intraTokenize(text).map((t) => t.text);
}
function intraLineDiff(oldText: string, newText: string): IntraDiff | null {
  if (oldText === newText) return null;
  // The alignment sees ONLY non-whitespace tokens. A whitespace run never
  // matches a whitespace run at another position (that skew is what let the
  // old alignment pair the wrong dashes and break a changed phrase into
  // word islands), and a whitespace-only change yields no changed tokens →
  // no span (git shows no word-diff marker for it either; the row tint
  // marks the line).
  const a = intraTokenize(oldText).filter((t) => !/^\s+$/.test(t.text));
  const b = intraTokenize(newText).filter((t) => !/^\s+$/.test(t.text));
  if (a.length * b.length > 100000) return null; // keep the O(n·m) pass cheap
  const n = a.length, m = b.length, w = m + 1;
  const tab: number[][] = new Array(n + 1);
  for (let i = 0; i <= n; i++) tab[i] = new Array<number>(w).fill(0);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      tab[i]![j] = a[i]!.text === b[j]!.text ? tab[i + 1]![j + 1]! + 1 : Math.max(tab[i + 1]![j]!, tab[i]![j + 1]!);
  // Legibility gate: the LCS length is tab[0][0]. Fewer than half the
  // shorter line's word tokens are shared → a whole-line rewrite in effect.
  if (tab[0]![0]! * 2 < Math.min(n, m)) return null;
  // Backtrack to the matched flags. On a TIE, prefer skipping the NEW token
  // (the add): the old token stays free to match at its own position, so a
  // word that merely shifted right stays "same" instead of being flagged
  // deleted (the alignment that keeps the most recognizable tokens shared).
  const matchedA: boolean[] = new Array<boolean>(n).fill(false);
  const matchedB: boolean[] = new Array<boolean>(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i]!.text === b[j]!.text) { matchedA[i] = true; matchedB[j] = true; i++; j++; }
    else if (tab[i]![j + 1]! >= tab[i + 1]![j]!) j++;
    else i++;
  }
  if (matchedA.every(Boolean) && matchedB.every(Boolean)) return null; // whitespace-only change
  // Segments: a maximal run of consecutive UNMATCHED word tokens (consecutive
  // = no matched word token between them — whitespace in between never
  // breaks a run) becomes ONE span whose text is the original line VERBATIM
  // from the run's first token to its last: the whitespace inside the run is
  // part of the change and renders with it. Boundary whitespace (before the
  // first / after the last changed token) stays plain context, exactly as in
  // git's `{+-rotate 90+}` rendering.
  const build = (line: string, toks: IntraTok[], matched: boolean[], cls: "del" | "add"): IntraSeg[] => {
    const segs: IntraSeg[] = [];
    const push = (c: IntraSeg["cls"], text: string): void => {
      if (text === "") return;
      const last = segs[segs.length - 1];
      if (last && last.cls === c) last.text += text;
      else segs.push({ text, cls: c });
    };
    let cur = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]!;
      if (matched[k]!) { push("same", line.slice(cur, t.end)); cur = t.end; continue; }
      let e = k;
      while (e + 1 < toks.length && !matched[e + 1]!) e++;
      push("same", line.slice(cur, t.start));
      push(cls, line.slice(t.start, toks[e]!.end));
      cur = toks[e]!.end;
      k = e;
    }
    push("same", line.slice(cur));
    return segs;
  };
  return { old: build(oldText, a, matchedA, "del"), nw: build(newText, b, matchedB, "add") };
}
// One side of a mod row: unchanged tokens stay plain text (the row tint
// shows through), changed tokens get the stronger span class. The no-newline
// marker rides at the end of the line, as in diffSide.
function modSideContent(segs: IntraSeg[], spanCls: string, keyBase: string, noNewline: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    out.push(s.cls === "same" ? s.text : <span key={keyBase + i} className={spanCls}>{s.text}</span>);
  }
  if (noNewline) out.push(<NN key={keyBase + "nn"} />);
  return out;
}
function sideBySideCells(d: DisplayRow, key: number): React.ReactElement[] {
  // data-dl/data-dn carry the real file line numbers on the cells AND the
  // gutters, so a selection OR a right-click anywhere on the row resolves to
  // the line(s) the ref should point at.
  const noOld = <span key={key + "no"} className={"dswFiles_diffNo" + (d.type === "del" || d.type === "mod" ? " dswFiles_diffNoDel" : "")} data-dl={d.old && d.old.oldNo != null ? d.old.oldNo : undefined}>{d.old ? d.old.oldNo : ""}</span>;
  const intra = d.type === "mod" && d.old && d.nw ? intraLineDiff(d.old.text, d.nw.text) : null;
  const cellOld = (
    <span key={key + "co"} className={"dswFiles_diffCell" + (d.type === "ctx" ? "" : d.type === "add" ? " dswFiles_cellAddO" : " dswFiles_cellDelO")}
      data-dl={d.old && d.old.oldNo != null ? d.old.oldNo : undefined}>
      <span className="dswFiles_diffCellIn">{intra ? modSideContent(intra.old, "dswFiles_spanDel", key + "o", d.old!.noNewline) : diffSide(d.old)}</span>
    </span>
  );
  const noNw = <span key={key + "nw"} className={"dswFiles_diffNo" + (d.type === "add" || d.type === "mod" ? " dswFiles_diffNoAdd" : "")} data-dn={d.nw && d.nw.newNo != null ? d.nw.newNo : undefined}>{d.nw ? d.nw.newNo : ""}</span>;
  const cellNw = (
    <span key={key + "cn"} className={"dswFiles_diffCell" + (d.type === "ctx" ? "" : d.type === "del" ? " dswFiles_cellDelN" : " dswFiles_cellAddN")}
      data-dn={d.nw && d.nw.newNo != null ? d.nw.newNo : undefined}>
      <span className="dswFiles_diffCellIn">{intra ? modSideContent(intra.nw, "dswFiles_spanAdd", key + "n", d.nw!.noNewline) : diffSide(d.nw)}</span>
    </span>
  );
  return [noOld, cellOld, noNw, cellNw];
}
function gapCells(gap: Gap, key: number): React.ReactElement[] {
  const txt = (rg: [number, number] | null) => (rg ? "… " + rg[0] + "–" + rg[1] + " …" : "");
  return [
    <span key={key + "no"} className="dswFiles_diffNo dswFiles_diffGapCell" />,
    <span key={key + "o"} className="dswFiles_diffGapTxt">{txt(gap.old)}</span>,
    <span key={key + "nw"} className="dswFiles_diffNo dswFiles_diffGapCell" />,
    <span key={key + "n"} className="dswFiles_diffGapTxt">{txt(gap.new)}</span>,
  ];
}
function gapCellsU(gap: Gap, key: number): React.ReactElement[] {
  const txt = (rg: [number, number] | null) => (rg ? "… " + rg[0] + "–" + rg[1] + " …" : "");
  return [
    <span key={key + "no"} className="dswFiles_diffNo dswFiles_diffGapCell" />,
    <span key={key + "c"} className="dswFiles_diffGapTxt dswFiles_diffGapCell">{txt(gap.new || gap.old)}</span>,
  ];
}
// The mod pairing for the unified (narrow) view: which del row pairs with
// which add row — the same in-order pairing displayRows uses for the
// side-by-side view. Raw row order is kept (del run before add run); the
// pairing only supplies the opposite line for the intra-line spans.
function unifiedPairs(hunk: DiffHunk): Map<DiffRow, { other: DiffRow; side: "old" | "new" }> {
  const map = new Map<DiffRow, { other: DiffRow; side: "old" | "new" }>();
  let i = 0;
  while (i < hunk.rows.length) {
    if (hunk.rows[i]!.k === "ctx") { i++; continue; }
    const dels: DiffRow[] = [], adds: DiffRow[] = [];
    while (i < hunk.rows.length && hunk.rows[i]!.k === "del") { dels.push(hunk.rows[i]!); i++; }
    while (i < hunk.rows.length && hunk.rows[i]!.k === "add") { adds.push(hunk.rows[i]!); i++; }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      map.set(dels[p]!, { other: adds[p]!, side: "old" });
      map.set(adds[p]!, { other: dels[p]!, side: "new" });
    }
  }
  return map;
}
function unifiedCells(r: DiffRow, key: number, pair?: { other: DiffRow; side: "old" | "new" }): React.ReactElement[] {
  // Gutter carries the same numbers as the cell so a right-click on the line
  // NUMBER resolves to a ref, not just a right-click on the line content.
  const no = <span key={key + "no"} className={"dswFiles_diffNo" + (r.k === "del" ? " dswFiles_diffNoDel" : r.k === "add" ? " dswFiles_diffNoAdd" : "")}
    data-dl={r.k !== "add" && r.oldNo != null ? r.oldNo : undefined}
    data-dn={r.k !== "del" && r.newNo != null ? r.newNo : undefined}>{r.k === "add" ? r.newNo : r.oldNo}</span>;
  // The +/−/space marker sits INSIDE the cell in the unified view (unlike
  // side-by-side), so it is a span: the context menu's snippet excludes it.
  const marker = <span key={key + "mk"} className="dswFiles_diffMark" aria-hidden="true">{r.k === "ctx" ? " " : r.k === "add" ? "+" : "-"}</span>;
  let content: React.ReactNode = [marker, r.text];
  let nnInside = false;
  if (pair) {
    const intra = intraLineDiff(pair.side === "old" ? r.text : pair.other.text, pair.side === "old" ? pair.other.text : r.text);
    if (intra) {
      const isOld = pair.side === "old";
      content = [marker, ...modSideContent(isOld ? intra.old : intra.nw, isOld ? "dswFiles_spanDel" : "dswFiles_spanAdd", key + "u", r.noNewline)];
      nnInside = true;
    }
  }
  // Unified view: a "del" row carries only the old number, an "add" row only
  // the new number, a "ctx" row both (the ref prefers the new side).
  const cell = (
    <span key={key + "c"} className={"dswFiles_diffCell" + (r.k === "add" ? " dswFiles_cellAddN" : r.k === "del" ? " dswFiles_cellDelO" : "")}
      data-dl={r.k !== "add" && r.oldNo != null ? r.oldNo : undefined}
      data-dn={r.k !== "del" && r.newNo != null ? r.newNo : undefined}>
      <span className="dswFiles_diffCellIn">{content}{!nnInside && r.noNewline ? <NN /> : null}</span>
    </span>
  );
  return [no, cell];
}

// The two 44px number gutters of the split grid (the
// grid-template-columns of .dswFiles_diffGrid) — keep in sync with Files.css.
const DIFF_GUTTER_PX = 44;
// The file width the layout decision uses, in columns — FIXED, not the
// file's actual line width: a file whose lines run wider than a split side
// scrolls horizontally within that side, so measuring the real width would
// keep the view unified no matter how wide the pane gets. The fixed
// reference makes the cutoff predictable: side-by-side once each side can
// show DIFF_LAYOUT_FRACTION_PCT of it (≈66 columns) at the pane's font.
const DIFF_LAYOUT_COLS = 100;
// The fraction of the reference width each split side must be able to show
// for side-by-side to be worth it (0.66, in percent — integer math keeps
// the boundary exact where 0.66 would float).
const DIFF_LAYOUT_FRACTION_PCT = 66;
// Unified or side-by-side? The split grid shows (paneW - 2 gutters) / 2 of
// the reference file width on each side. Unified wins when that is LESS
// than the fraction of it — i.e. `100×(paneW - 2 gutters) < 2×66×fileW`.
function diffLayoutNarrow(paneW: number, fileW: number): boolean {
  if (paneW <= 0) return true;
  return 100 * (paneW - 2 * DIFF_GUTTER_PX) < 2 * DIFF_LAYOUT_FRACTION_PCT * fileW;
}
// The reference file width in px: DIFF_LAYOUT_COLS columns at the grid's
// own font (monospace, so the column width comes from any single glyph).
function diffLayoutFileWidth(grid: HTMLElement): number {
  const first = grid.querySelector(".dswFiles_diffCellIn");
  if (!first) return 0;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = getComputedStyle(first).font;
  return Math.ceil(ctx.measureText("0".repeat(DIFF_LAYOUT_COLS)).width);
}

interface DiffViewProps {
  model: DiffFile;
  truncated?: boolean;
  t: TFunc;
  baseLabel: string | null;
  binary: DiffBinary | null;
}
function DiffView(props: DiffViewProps) {
  const t = props.t;
  const model = props.model;
  const ref = React.useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = React.useState(false);
  // Unified or side-by-side is decided from PANE WIDTH against a fixed
  // 100-column file reference (the spacer's measure below sets it from
  // diffLayoutNarrow): unified when a split side would show less than
  // 66% of it (≈66 columns). False until the first measurement, so the
  // first paint is side-by-side.
  const cueRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current, cue = cueRef.current;
    if (!el || !cue) return;
    const update = () => {
      cue.classList.toggle("dswFiles_diffCueOn",
        el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    update();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(update); ro.observe(el); }
    el.addEventListener("scroll", update, { passive: true });
    return () => { if (ro) ro.disconnect(); el.removeEventListener("scroll", update); };
  }, []);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const spacerRef = React.useRef<HTMLDivElement>(null);
  // The code resets scroll only when the file or review base changes. The
  // 5 s poll refreshes the same view with a fresh model object (the reader
  // is mid-diff). A reset keyed on model identity yanks the view to the top
  // every cycle.
  const fileKey = (props.baseLabel ? props.baseLabel + "\u0000" : "") + realPathOf(model);
  const lastFileRef = React.useRef(fileKey);
  React.useEffect(() => {
    if (lastFileRef.current === fileKey) return;
    lastFileRef.current = fileKey;
    const el = ref.current, grid = gridRef.current;
    if (!el || !grid) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    grid.style.setProperty("--diff-x", "0px");
  }, [fileKey]);
  // The effect sizes the zero-height spacer to provide the horizontal scroll
  // RANGE. The grid itself never overflows (100% wide, the cells clip), so
  // this effect synthesizes the range: `clientW + (maxW - windowW)`, maxW =
  // widest rendered cell, windowW = its clipping window
  // (scrollWidth/clientWidth). maxW alone under-provisions a line wider than
  // its half but shorter than the container.
  React.useEffect(() => {
    const el = ref.current, grid = gridRef.current, spacer = spacerRef.current;
    if (!el || !grid || !spacer) return;
    const measure = () => {
      const clientW = el.clientWidth;
      if (clientW <= 0) return;
      let maxW = 0;
      const inners = grid.querySelectorAll(".dswFiles_diffCellIn");
      for (let i = 0; i < inners.length; i++) {
        const w = inners[i]!.scrollWidth;
        if (w > maxW) maxW = w;
      }
      const windowW = inners.length ? inners[0]!.clientWidth : 0;
      const over = maxW - windowW;
      spacer.style.width = (over > 0 ? clientW + Math.ceil(over) : clientW) + "px";
      // Layout decision from the fixed 100-column reference at this font
      // (see diffLayoutFileWidth). setNarrow is a no-op on an unchanged
      // value; the effect's [model, narrow] deps re-measure after any flip.
      setNarrow(diffLayoutNarrow(clientW, diffLayoutFileWidth(grid)));
    };
    measure();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => { if (ro) ro.disconnect(); };
  }, [model, narrow]);
  React.useEffect(() => {
    const el = ref.current, grid = gridRef.current;
    if (!el || !grid) return;
    const onScroll = () => grid.style.setProperty("--diff-x", (-el.scrollLeft) + "px");
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const cue = <div className="dswFiles_diffCue" ref={cueRef} aria-hidden="true" />;

  const name = realPathOf(model);
  const meta: string[] = [];
  // The review-commit tag (commit mode): this patch is the file's state at
  // that commit, not the worktree's.
  if (props.baseLabel) meta.push(props.baseLabel);
  if (model.isNew) meta.push(t("files.diffNew"));
  if (model.isDeleted) meta.push(t("files.diffDeleted"));
  if (model.renameFrom && model.renameFrom !== model.newPath) meta.push(t("files.diffRenamedFrom") + " " + model.renameFrom);
  if (model.modeFrom && model.modeTo && model.modeFrom !== model.modeTo) meta.push(model.modeFrom + " → " + model.modeTo);
  // The file's name lives in the pane's general header (PreviewPane); this
  // sticky head keeps only the diff-specific meta and vanishes without it.
  const head = meta.length
    ? <div className="dswFiles_diffHead">
        <div className="dswFiles_diffMeta">{meta.join(" · ")}</div>
      </div>
    : null;

  // A binary patch has no text rows. A side that came back WITH its bytes
  // (a displayable image/PDF) renders old|new like the text split. The
  // absent side (a new or deleted file) gets a "(none)" slot. A side
  // without bytes (over the cap, not displayable) shows its card meta.
  // jj's rename diff has no "Binary files" marker (isBinary stays false),
  // so an attached binary block switches the view to the image row too.
  const b = props.binary || null;
  const binHasData = !!(b && ((b.new && b.new.data) || (b.old && b.old.data)));
  if (model.isBinary || b) {
    const side = (v: DiffBinarySide | null, label: string) => {
      const bytes = v && v.data && v.type ? "data:" + v.type + ";base64," + v.data : null;
      return (
        <div className="dswFiles_diffBinaryPane">
          <div className="dswFiles_diffBinaryLabel">{label}</div>
          {bytes
            ? <div className="dswFiles_previewImageWrap"><img className="dswFiles_previewImage" src={bytes} alt={name} /></div>
            : <div className="dswFiles_diffBinaryNone">{v ? [typeLabel(v.type, t), v.size ? formatBytes(v.size) : null].filter(Boolean).join(" · ") : t("files.diffBinaryNone")}</div>}
        </div>
      );
    };
    if (!binHasData) {
      return (
        <div className="dswFiles_diff" ref={ref}>
          {head}
          <div className="dswFiles_previewCard">
            <div className="dswFiles_previewCardName">{name}</div>
            <div className="dswFiles_previewCardMeta">{t("files.diffBinary")}</div>
          </div>
          {cue}
        </div>
      );
    }
    return (
      <div className="dswFiles_diff" ref={ref}>
        {head}
        <div className="dswFiles_diffBinaryRow">
          {side(b.old, t("files.diffBinaryOld"))}
          {side(b.new, t("files.diffBinaryNew"))}
        </div>
        {cue}
      </div>
    );
  }

  const flat: { kind: "gap" | "row"; gap: Gap; r: DiffRow; d: DisplayRow; pair: { other: DiffRow; side: "old" | "new" } | null }[] = [];
  for (let hi = 0; hi < model.hunks.length; hi++) {
    const h = model.hunks[hi]!;
    if (hi > 0) { const g = gapAfter(model.hunks[hi - 1]!, h); if (g) flat.push({ kind: "gap", gap: g, r: h as unknown as DiffRow, d: h as unknown as DisplayRow, pair: null }); }
    if (narrow) {
      const pairs = unifiedPairs(h);
      for (const r of h.rows) flat.push({ kind: "row", gap: null as unknown as Gap, r: r, d: h as unknown as DisplayRow, pair: pairs.get(r) ?? null });
    }
    else { for (const d of displayRows(h)) flat.push({ kind: "row", gap: null as unknown as Gap, r: d as unknown as DiffRow, d: d, pair: null }); }
  }
  const clipped = flat.length > MAX_DIFF_ROWS;
  const cells: React.ReactElement[] = [];
  for (let i = 0; i < flat.length && i < MAX_DIFF_ROWS; i++) {
    const item = flat[i]!;
    if (item.kind === "gap") cells.push(...(narrow ? gapCellsU(item.gap, i) : gapCells(item.gap, i)));
    else cells.push(...(narrow ? unifiedCells(item.r, i, item.pair ?? undefined) : sideBySideCells(item.d, i)));
  }
  const notes: string[] = [];
  if (props.truncated) notes.push(t("files.diffTruncatedPatch"));
  if (clipped) notes.push(t("files.diffTruncatedRows"));

  return (
    <div className="dswFiles_diff" ref={ref}>
      {head}
      {cells.length
        ? <div ref={gridRef} className={narrow ? "dswFiles_diffGrid dswFiles_diffGridU" : "dswFiles_diffGrid"}>{cells}</div>
        : <div className="dswFiles_previewNote">{t("files.noChanges")}</div>}
      {/* Zero-height spacer that provides the horizontal scroll range
          (width = widest line, the spacer sizing effect sets it). The grid
          and head stick to the left edge while the user traverses it. */}
      {cells.length ? <div ref={spacerRef} className="dswFiles_diffSpacer" aria-hidden="true" /> : null}
      {notes.length ? <div className="dswFiles_previewNote">{notes.join(" · ")}</div> : null}
      {cue}
    </div>
  );
}

// Pane modes: diff | view (raw) | preview (rendered). Only markdown and
// HTML have a rendered form distinct from raw text. For every other type,
// View ≡ Preview, so the Preview button appears only for those two.
const MD_RE = /\.(md|markdown)$/i;
const HTML_RE = /\.html?$/i;
function renderKindOf(name: string | null): "markdown" | "html" | null {
  const n = String(name || "");
  return MD_RE.test(n) ? "markdown" : HTML_RE.test(n) ? "html" : null;
}
// "auto" (a new selection or new commit resets to this) picks diff for a
// diffable file, preview for markdown (safe by default: renderMarkdown is
// our own escape-first renderer, no script execution), the RAW view for
// HTML (rendering executes its scripts, an explicit opt-in), and view for
// everything else. A pinned "diff" falls back to view when the file is no
// longer diffable.
function resolvePaneMode(mode: string, diffable: boolean, name: string | null): string {
  if (mode === "auto") {
    if (diffable) return "diff";
    return renderKindOf(name) === "markdown" ? "preview" : "view";
  }
  if (mode === "diff" && !diffable) return "view";
  return mode;
}
function paneToggleModes(diffable: boolean, name: string | null): string[] {
  const modes: string[] = [];
  if (diffable) modes.push("diff");
  if (diffable || renderKindOf(name)) { modes.push("view"); if (renderKindOf(name)) modes.push("preview"); }
  return modes;
}
// A no-network CSP, prepended to a srcdoc preview. It is defense in depth
// under the sandbox attribute: even sandboxed scripts get no
// fetch/XHR/WebSocket, no external CDNs, no image-beacon exfil. Inline
// scripts/styles and data: assets still work, so self-contained mockups
// run.
const HTML_CSP_META = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; object-src 'none'\">\n";

// The pane's render switch for a fetched file (st): content mode "view" =
// raw, "preview" = rendered.
function previewContentFor(st: PreviewState, contentMode: string, name: string | null, t: TFunc, imgMap: Record<string, string> = {}): React.ReactElement | null {
  const rawText = st.text !== undefined
    ? (
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 0" }}>
        {st.highlighted
          ? <pre className="dswFiles_previewText" dangerouslySetInnerHTML={{ __html: st.highlighted }} />
          : <pre className="dswFiles_previewText">{st.text}</pre>}
        {st.truncated ? <div className="dswFiles_previewNote">{t("files.previewTruncated")}</div> : null}
      </div>
    )
    : null;
  return st.status === "empty" ? <div className="dswFiles_previewEmpty">{t("files.previewEmpty")}</div>
    : st.status === "loading" ? <div className="dswFiles_previewEmpty">{t("files.previewLoading")}</div>
    : st.status === "image" ? <div className="dswFiles_previewImageWrap"><img className="dswFiles_previewImage" src={st.url} alt={st.name || ""} /></div>
    : st.status === "pdf" ? <iframe className="dswFiles_previewPdf" src={st.url} title={st.name || t("files.pdfFrameTitle")} />
    : st.status === "markdown" && renderKindOf(name) === "markdown" && contentMode === "preview"
      ? <div className="dswFiles_previewMarkdown" dangerouslySetInnerHTML={{ __html: renderMarkdownWithImages(st.text ?? "", imgMap) }} />
      : st.status === "text" && renderKindOf(name) === "html" && contentMode === "preview"
        ? (
          <div className="dswFiles_previewHtmlWrap">
            <div className="dswFiles_previewHtmlNote">{t("files.htmlSandboxed")}</div>
            {/* The sealed render: sandbox="allow-scripts" ONLY, no
                allow-same-origin (opaque origin: the scripts cannot reach
                the app's DOM, storage, or cookies), no navigation, popups,
                forms, modals, or downloads. HTML_CSP_META adds the
                no-network layer. On unmount, React kills the iframe's
                scripts. */}
            <iframe
              className="dswFiles_previewHtml"
              sandbox="allow-scripts"
              // `srcdoc` stays lowercase on purpose: test/client.test.mjs
              // asserts the prop key verbatim, and the spread keeps the
              // non-standard key off the iframe's typed props.
              {...{ srcdoc: HTML_CSP_META + st.text }}
              title={st.name || t("files.htmlFrameTitle")}
            />
          </div>
        )
        : st.status === "text" ? rawText
        : st.status === "markdown" ? rawText
        : st.status === "binary" ? (
          <div className="dswFiles_previewCard">
            <div className="dswFiles_previewCardName">{st.name || ""}</div>
            <div className="dswFiles_previewCardMeta">{[typeLabel(st.type, t), st.size ? formatBytes(st.size) : null].filter(Boolean).join(" · ")}</div>
            <div className="dswFiles_previewCardHint">{t("files.binaryFile")}</div>
          </div>
        )
        : <div className="dswFiles_previewEmpty">{t("files.previewError") + (st.error ? " — " + st.error : "")}</div>;
}

type FileShowText = { kind: "text"; text: string; size: number; truncated: boolean; type: string; label: string };
type FileShowBinary = { kind: "binary"; size: number; type: string; label: string; data?: string };
type FileShowValue = FileShowText | FileShowBinary;
type DiffResponse = { patch: string; truncated?: boolean; base: string; binary?: DiffBinary };
type Listing = {
  root: string;
  relPath: string;
  entries: DirEntry[];
  /** The host capped the listing (DEFAULT_LIST_CAP entries). */
  truncated?: boolean;
  vcs?: VcsInfo;
  commitChanges?: VcsChange[];
};

type PreviewState = {
  status: string;
  url?: string;
  text?: string;
  name?: string | null;
  size?: number | string | null;
  type?: string;
  truncated?: boolean;
  error?: string;
  highlighted?: string | null;
};
type DiffState = {
  status: string;
  for?: string | null;
  base?: string;
  file?: DiffFile | null;
  truncated?: boolean;
  binary?: DiffBinary | null;
  error?: string;
};

interface PreviewPaneProps {
  name: string | null;
  relPath: string | null;
  /** The pinned out-of-workspace file (the External section), by ABSOLUTE
      path. Set: this pane shows that file (view/preview only — no diff, no
      section refs), read through readAtAbs. Mutually exclusive with relPath. */
  absPath?: string | null;
  /** The host's absolute workspace root (every listing carries it). The loopback-only "copy path" action builds the absolute path from it. */
  wsRoot?: string | null;
  /** dsh's native-open capability probe (BUG-005): the deployment can reach a native desktop. */
  openCapable?: boolean;
  status: VcsChange | null;
  base: string;
  rev: string | null;
  changesetKnown: boolean;
  readAt: (relPath: string, rev: string, signal: AbortSignal) => Promise<FileShowValue>;
  /** The External section's read: a live file by absolute path (fileshow-abs). Absent in a minimal profile. */
  readAtAbs?: ((path: string, signal: AbortSignal) => Promise<FileShowValue>) | null;
  /** A transient failure note (an external open that could not be verified). */
  notice?: string | null;
  fetchDiff: (relPath: string, base: string, signal: AbortSignal, opts?: { noBinary?: boolean }) => Promise<DiffResponse>;
  readMermaid: () => Promise<{ text: string }>;
  t: TFunc;
  /**
   * Session standard kit (composer): the live-draft selector hook and the
   * public draft write path. Absent in a minimal profile — the section-ref
   * affordance then degrades to copy-only (the copy buttons always work).
   */
  useInput?: ((sel: (s: { draft: string }) => string) => string) | null;
  inputActions?: { setDraft(text: string): void } | null;
  /** The nav column's collapsed state and toggle: the state-pair's RESTORE
      control lives in this pane's view bar (right end) while the nav is
      hidden; the HIDE control lives in the nav's own header. Both flip
      FilesView's collapsed state. navId names the nav column region for
      aria-controls (unique per session: files tabs can coexist). */
  navCollapsed: boolean;
  onToggleNav: () => void;
  navId: string;
  /** The line an external open asked for (a redirected resource open's
      params.line), keyed to the path it belongs to: the scroll applies only
      to that file's loaded text. null = no pending line. */
  lineTarget?: { path: string; line: number } | null;
}

// The origin that justifies exposing a LOCAL absolute path (BUG-006):
// loopback only. The GUI's own trusted-host fence also admits a deployment's
// --trusted-host, so this client-side gate is strictly narrower. Node (the
// test harness) has no location → the action is never offered.
function isLoopbackOrigin(): boolean {
  if (typeof location === "undefined") return false;
  return /^(127\.0\.0\.1|localhost|\[?::1\]?)$/.test(location.hostname);
}
// The file's absolute path for "copy path": the host's workspace root (it
// rides in every listing's `root`) + the relPath the pane already holds.
// The relPath is always "/"-separated (host-side childPath); the trailing
// slash of the root, whatever the platform separator, is trimmed.
function absolutePathOf(root: string, relPath: string): string {
  return String(root).replace(/[/\\]+$/, "") + "/" + String(relPath);
}

// ---- dsh host API transport (BUG-005, BUG-013) ----------------------------
// "Open locally" reuses the MECHANISM dsh itself uses for the produced-files
// links in the conversation: the dsh web app's own unary host methods,
// served with the deployment's trusted-host fence. filestab registers
// nothing — the client speaks the four-quadrant client-request envelope
// dsh's own client (dsh-client-connection callUnary) POSTs to
// /api/<method>. The host side spawns the OS default app (xdg-open
// hand-off); the capability probe says whether the deployment can reach a
// desktop at all (a headless service environment answers false → the
// action is simply not offered).
//
// The method names MOVED between dsh 0.1.1 and 0.1.2 (BUG-013):
//   0.1.1  host.describe  (→ { canOpenPath })  /  host.openPath  (→ { opened })
//          served by dsh-host-apiproxy's `host` domain
//   0.1.2  session/canOpenWorkspacePath  (→ boolean)
//          session/openWorkspacePath  (request { path } → { opened })
//          served by the session controller's typert remotes, which the
//          gateway validates with a wrapped payload: { args: { request: {…} } }
//          (a no-parameter method sends { args: {} }).
// The response envelope (server-response / ok-error result) is identical in
// both. An UNKNOWN method answers HTTP 404 — the fallback signal: the probe
// and the open try the 0.1.2 names first (the version this build is
// verified against), and a 404 retries once on the 0.1.1 names. Only a 404
// falls back; every other failure (transport, host error) propagates to the
// caller, which degrades to hiding the action.
class HostMethodAbsent extends Error {
  constructor(method: string) {
    super("host method absent: /api/" + method);
    this.name = "HostMethodAbsent";
  }
}
function hostEnvelope(method: string, payload: Record<string, unknown>, rpcId: string): string {
  return JSON.stringify({ type: "client-request", rpcId, method, payload });
}
// Parse a /api/<method> response: verifies the rpcId echo, then the closed
// ok/error result. Never throws on a well-formed error envelope (the caller
// maps it); only a malformed frame / rpcId mismatch is a host-error.
function parseHostResponse(
  full: unknown, rpcId: string,
): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
  const f = full as { rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } } | null;
  if (!f || f.rpcId !== rpcId) return { ok: false, code: "host-error", message: "rpcId mismatch" };
  const r = f.result;
  if (r && r.ok === true) return { ok: true, value: r.value };
  const err = r && r.error ? r.error : {};
  const code = typeof err.code === "string" && err.code ? err.code : "host-error";
  const message = typeof err.message === "string" ? err.message : "";
  return { ok: false, code, message };
}
async function hostApi(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const rpcId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "dsh-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  const res = await fetch("/api/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: hostEnvelope(method, payload, rpcId),
    signal,
  });
  if (!res.ok) {
    if (res.status === 404) throw new HostMethodAbsent(method);
    throw new Error("transport failure for /api/" + method + ": HTTP " + res.status);
  }
  const parsed = parseHostResponse(await res.json(), rpcId);
  if (!parsed.ok) throw new RpcError(parsed.code, parsed.message ? parsed.code + ": " + parsed.message : parsed.code);
  return parsed.value;
}
// The deployment's native-open capability (one-shot per view mount).
async function hostDescribe(signal?: AbortSignal): Promise<{ canOpenPath?: boolean }> {
  try {
    // dsh ≥ 0.1.2: the session controller's no-parameter probe.
    const can = await hostApi("session/canOpenWorkspacePath", { args: {} }, signal);
    return { canOpenPath: can === true };
  } catch (e) {
    if (!(e instanceof HostMethodAbsent)) throw e;
    // dsh 0.1.1: the host domain's describe carries canOpenPath.
    return (await hostApi("host.describe", {}, signal)) as { canOpenPath?: boolean };
  }
}
async function hostOpenPath(path: string, signal?: AbortSignal): Promise<{ opened: true }> {
  try {
    // dsh ≥ 0.1.2: the session controller's open (request { path }).
    return (await hostApi("session/openWorkspacePath", { args: { request: { path } } }, signal)) as { opened: true };
  } catch (e) {
    if (!(e instanceof HostMethodAbsent)) throw e;
    // dsh 0.1.1: the host domain's open.
    return (await hostApi("host.openPath", { path }, signal)) as { opened: true };
  }
}
// The full gate for offering "open locally" (BUG-005): a concrete file (a
// workspace file with a known root, OR an External file, which IS absolute),
// the host's canOpenPath probe, AND a loopback origin (same privacy rule as
// copy path — the action hands a local path to a local desktop; a
// --trusted-host remote client never sees it).
function canOfferOpenLocal(a: { relPath: string | null; absPath?: string | null; wsRoot: string | null; openCapable: boolean }): boolean {
  return !!(a.openCapable && isLoopbackOrigin() && (a.absPath || (a.relPath && a.wsRoot)));
}
// Clipboard write with the classic fallback (execCommand) for contexts
// where the async clipboard API is unavailable or denied.
function copyRefText(text: string): void {
  const fallback = (): void => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch (e) { /* best-effort */ }
  };
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(fallback);
    return;
  }
  fallback();
}

// Appends the ref to the composer draft. It subscribes to the live draft
// through the session kit (useInput) so keystrokes in the composer re-render
// this tiny leaf only, never the file panes. The trailing space lets the
// user keep typing; a leading space is inserted only when the draft does not
// already end in whitespace.
function AddToChatBtn(props: {
  refText: string;
  useInput: ((sel: (s: { draft: string }) => string) => string) | null;
  inputActions: { setDraft(text: string): void };
  t: TFunc;
  /** Row styling (the pane toolbar vs the context menu). */
  className?: string;
  /** Close the host (the context menu) after the append lands. */
  onDone?: () => void;
}): React.ReactElement {
  const { t } = props;
  const draft = props.useInput ? props.useInput((s) => s.draft) : "";
  const onClick = () => {
    const sep = draft && !/\s$/.test(draft) ? " " : "";
    props.inputActions.setDraft(draft + sep + props.refText + " ");
    if (props.onDone) props.onDone();
  };
  return (
    <button type="button" className={props.className || "dswFiles_refBtn"} title={props.refText}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {Icon("IconPlus16", { size: 14 }, "+")} {t("files.refAdd")}
    </button>
  );
}

// The preview pane: a view of the selected file. Diff mode shows the
// file's diff at props.base, "worktree" (the default) or a change id (that
// commit's patch for this file). An empty patch is a STATE, not an error.
// Worktree mode falls back to the plain preview. Commit mode shows a "no
// changes in this commit" note above the preview.
function PreviewPane(props: PreviewPaneProps) {
  const t = props.t;
  const seqRef = React.useRef(0);
  const [st, setSt] = React.useState<PreviewState>({ status: "empty" });
  const diffSeq = React.useRef(0);
  const [diffSt, setDiffSt] = React.useState<DiffState>({ status: "idle", for: null });
  // The last patch actually shown, per file. A background refresh that comes
  // back UNCHANGED must not touch state (no re-render, no scroll jump).
  // Otherwise the 5 s poll makes the open diff visibly "refresh" every few
  // seconds.
  const lastPatchRef = React.useRef<{ base: string; patch: string } | null>(null);
  // The binary payload (old|new bytes), kept per (file, base). The first
  // fetch requests it. Later polls pass noBinary — without the flag, a
  // 1 MB image's base64 re-crosses the wire every poll. Committed bytes
  // are history-stable; a worktree/commit edit shows up as a changed
  // patch, which drops the cache (see the fetch handler below).
  const binaryRef = React.useRef<{ key: string; binary: DiffBinary } | null>(null);

  // Diffable: worktree mode = a non-conflict change at a diffable base (a
  // conflict-only file has no worktree diff). Snapshot mode = the commit
  // CHANGED the file. While the changeset is still unknown (its load is
  // pending), the code treats every file as diffable. A changed file's diff
  // then never flashes a preview first. (resolvePaneMode holds the mode
  // reset/pin rules.)
  const isRev = props.base !== "worktree";
  // An External (out-of-workspace) file has no VCS status and no base: the
  // pane offers view/preview modes only — never a diff.
  const external = !!props.absPath;
  const diffable = !external && (isRev && props.changesetKnown === false
    ? !!props.fetchDiff
    : !!(props.status && props.status.base !== "conflict" && props.fetchDiff));
  const [mode, setMode] = React.useState("auto");
  React.useEffect(() => { setMode("auto"); }, [props.relPath, props.absPath, props.base]);
  const effectiveMode = resolvePaneMode(mode, diffable, props.name);
  // The content pane's presentation while a DIFF owns the view. The "no
  // changes in this commit" fall-through shows the file in its own default
  // presentation, not as "diff".
  const contentMode = effectiveMode === "diff"
    ? (renderKindOf(props.name) === "markdown" ? "preview" : "view")
    : effectiveMode;
  // BUG-005: the transient open-failure note (the success is silent — the
  // native app took the path). The host's message can be a multi-line
  // xdg-open dump; only its first line earns a slot in the pane.
  const [openNote, setOpenNote] = React.useState<string | null>(null);
  const openTimerRef = React.useRef(0);
  React.useEffect(() => () => window.clearTimeout(openTimerRef.current), []);
  const openLocal = () => {
    // An External file IS an absolute path; a workspace file builds one from
    // the host's root.
    const abs = props.absPath
      || (props.wsRoot && props.relPath ? absolutePathOf(props.wsRoot, props.relPath) : null);
    if (!abs) return;
    hostOpenPath(abs).catch((e) => {
      const msg = String((e as { message?: string } | null)?.message || "");
      const first = msg.split("\n")[0] || "";
      setOpenNote(t("files.openFailed") + (first ? " — " + first : ""));
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = window.setTimeout(() => setOpenNote(null), 6000);
    });
  };

  // The diff fetch, only while the diff view is live for this file. The 5 s
  // poll hands us a FRESH status object every cycle, so this re-runs every
  // cycle. It must stay invisible when nothing changed: no loading flash,
  // no state update for a byte-identical patch.
  React.useEffect(() => {
    if (!diffable || !props.relPath || effectiveMode !== "diff") { setDiffSt({ status: "idle", for: null }); lastPatchRef.current = null; binaryRef.current = null; return; }
    const seq = ++diffSeq.current;
    const c = new AbortController();
    // Same file AND same base = the same view (the 5 s poll's refresh). A
    // base switch (commit → worktree, commit → commit) is a NEW view even
    // for the same file: allow the loading note + full scroll reset.
    const sameFile = diffSt.for === props.relPath && diffSt.base === props.base;
    if (!sameFile) { lastPatchRef.current = null; binaryRef.current = null; }
    if (!sameFile || diffSt.status === "error") setDiffSt({ status: "loading", for: props.relPath, base: props.base });
    const haveBinary = !!(binaryRef.current && binaryRef.current.key === props.relPath + "@" + props.base);
    props.fetchDiff(props.relPath, props.base, c.signal, haveBinary ? { noBinary: true } : undefined).then((v) => {
      if (seq !== diffSeq.current) return;
      if (!v || v.patch === "") { lastPatchRef.current = { base: props.base, patch: "" }; setDiffSt({ status: "none", for: props.relPath, base: props.base }); return; }
      if (v.binary) {
        binaryRef.current = { key: props.relPath + "@" + props.base, binary: v.binary };
      } else if (sameFile && lastPatchRef.current
          && lastPatchRef.current.base === props.base
          && lastPatchRef.current.patch !== v.patch) {
        // This poll went out noBinary (a warm cache) and came back with a
        // CHANGED patch: the worktree/commit bytes the cache holds may be
        // stale (a live edit). Drop them — the next poll's cold cache
        // re-fetches with bytes (≤5 s of card, then the fresh images).
        binaryRef.current = null;
      }
      const binary = binaryRef.current && binaryRef.current.key === props.relPath + "@" + props.base ? binaryRef.current.binary : null;
      if (sameFile && lastPatchRef.current && lastPatchRef.current.base === props.base && lastPatchRef.current.patch === v.patch) return;
      lastPatchRef.current = { base: props.base, patch: v.patch };
      const parsed = parseDiff(v.patch);
      setDiffSt({ status: "diff", for: props.relPath, file: parsed.files[0] || null, truncated: !!v.truncated, base: v.base, binary: binary || null });
    }).catch((e) => {
      if (seq !== diffSeq.current || (e && e.name === "AbortError")) return;
      setDiffSt({ status: "error", for: props.relPath, error: rpcErrorText(e, t) });
    });
    return () => { c.abort(); };
  }, [props.relPath, props.status, props.base, effectiveMode]);

  // The preview fallback, one transport in both modes: fileshow over the
  // browse RPC (rev = the selected commit in snapshot mode, "worktree" for
  // the live file). The host containment-checks, caps the read (1 MB) and
  // classifies it. The client slices the display the same way.
  const isSnapshot = !!props.rev;
  React.useEffect(() => {
    if (!props.relPath && !props.absPath) { setSt({ status: "empty" }); return; }
    if (external && !props.readAtAbs) { setSt({ status: "error", name: props.name, error: t("files.previewError") }); return; }
    if (effectiveMode === "diff" && diffSt.status !== "none") return; // the diff view owns the pane
    const seq = ++seqRef.current;
    const c = new AbortController();
    setSt({ status: "loading", name: props.name });
    const relPath = props.relPath;
    (async () => {
      try {
        // An External file reads by absolute path (fileshow-abs); a workspace
        // file by rev (the commit in snapshot mode, the worktree otherwise).
        const v = external
          ? await props.readAtAbs!(props.absPath!, c.signal)
          : await props.readAt(relPath!, isSnapshot ? props.rev! : "worktree", c.signal);
        if (seq !== seqRef.current) return;
        if (!v) throw new Error("no data");
        if (v.kind === "text") {
          if (v.type === "text/markdown") {
            setSt({ status: "markdown", text: v.text, name: props.name, size: v.size, highlighted: highlightSource(v.text, props.name) });
            return;
          }
          let text = v.text;
          const truncated = !!v.truncated || text.length > TEXT_PREVIEW_CAP;
          if (text.length > TEXT_PREVIEW_CAP) text = text.slice(0, TEXT_PREVIEW_CAP);
          setSt({ status: "text", text, name: props.name, size: v.size, truncated, highlighted: highlightSource(text, props.name) });
          return;
        }
        // A displayable binary under the cap comes back WITH its bytes
        // (base64) → a data: URL the <img>/<iframe> branches render.
        if (v.kind === "binary" && v.data && v.type
            && (v.type === "application/pdf" || v.type.startsWith("image/"))) {
          setSt({ status: v.type === "application/pdf" ? "pdf" : "image",
                  url: "data:" + v.type + ";base64," + v.data, name: props.name });
          return;
        }
        setSt({ status: "binary", name: props.name, size: v.size, type: v.type || "" });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (seq !== seqRef.current || (err && err.name === "AbortError")) return;
        setSt({ status: "error", name: props.name, error: rpcErrorText(e, t) });
      }
    })();
    return () => { c.abort(); };
    // Mode is not a dep: content is mode-INDEPENDENT (View/Preview both read
    // st), so a flip must not re-fetch. Flips into or out of the diff view
    // always change diffSt.status, which re-runs this effect. readAtAbs is
    // not a dep (the parent recreates the closure every render, as above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.relPath, props.absPath, props.rev, isSnapshot, diffSt.status]);

  // Local images in the markdown preview. A document-relative src cannot
  // load (no HTTP file route: the workspace is not a web root), so for a
  // loaded markdown file the code fetches each resolvable image over the
  // same fileshow transport as the image/PDF preview and maps src → data:
  // URL for the render. A src that does not resolve (missing file, not
  // readable, not an image, over the 1 MB cap) is simply absent from the
  // map, so the render keeps the src as-is (the broken-img fallback).
  // readAt is deliberately not a dep (the parent recreates the closure
  // every render, as in the mermaid effect).
  const [imgMap, setImgMap] = React.useState<Record<string, string>>({});
  const imgSeq = React.useRef(0);
  React.useEffect(() => {
    // Workspace documents only: an External markdown's local images would
    // resolve outside the workspace, and the contained readAt cannot see them
    // (the render keeps the src as-is, the broken-img fallback).
    const srcs = st.status === "markdown" && st.text && props.relPath && !props.absPath
      ? [...new Set(markdownImageSrcs(st.text).filter(isLocalDocImageSrc))]
      : [];
    if (srcs.length === 0) { setImgMap({}); return; }
    const seq = ++imgSeq.current;
    const c = new AbortController();
    Promise.all(srcs.map(async (s): Promise<[string, string] | null> => {
      const rel = props.relPath ? resolveDocImage(props.relPath, s) : "";
      if (!rel) return null;
      try {
        const v = await props.readAt(rel, isSnapshot ? props.rev! : "worktree", c.signal);
        if (v && v.kind === "binary" && v.data && typeof v.type === "string" && v.type.startsWith("image/")) {
          return [s, "data:" + v.type + ";base64," + v.data];
        }
      } catch { /* not found / not readable / not an image → leave the src as-is */ }
      return null;
    })).then((pairs) => {
      if (seq !== imgSeq.current) return;
      const m: Record<string, string> = {};
      for (const p of pairs) if (p) m[p[0]] = p[1];
      setImgMap(m);
    });
    return () => { c.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.status, st.text, props.relPath, props.rev, isSnapshot]);

  // Mermaid fences: markdown-it emits them as inert <pre><code
  // class="language-mermaid"> blocks (highlight.js has no mermaid grammar, so
  // they stay plain text). This effect swaps each block for a sealed sandbox
  // iframe that renders the diagram. The swap is DOM-level. React's
  // innerHTML reset on a content change unmounts the frame and kills its
  // scripts, so no manual teardown is needed. readMermaid is deliberately
  // not a dep (as in the fetch effect). The parent re-creates the closure
  // every render. The bundle is cached module-wide, so a stale closure is
  // equivalent.
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // frame -> diagram source, so a theme flip can rebuild every live frame.
  const mermaidFramesRef = React.useRef<Map<HTMLIFrameElement, string>>(new Map());
  // The GUI's resolved dark state: the dsh theme presenter applies
  // body[data-ds-dark-theme] from the user preference (light/dark/system,
  // system resolved via the OS scheme). Mermaid bakes the palette into the
  // SVG at render time, so the code tracks it and rebuilds the frames when
  // it flips.
  const [darkTheme, setDarkTheme] = React.useState<boolean>(
    () => typeof document !== "undefined" && !!document.body && document.body.hasAttribute("data-ds-dark-theme"),
  );
  React.useEffect(() => {
    const check = () => setDarkTheme(document.body.hasAttribute("data-ds-dark-theme"));
    const mo = new MutationObserver(check);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    check();
    return () => mo.disconnect();
  }, []);
  React.useEffect(() => {
    // A content change already unmounted the old frames (React's innerHTML
    // reset kills their scripts). The code drops the dead entries, then
    // builds: fresh code blocks (content change) or the live frames (theme
    // flip).
    for (const [f] of [...mermaidFramesRef.current]) if (!f.isConnected) mermaidFramesRef.current.delete(f);
    const root = bodyRef.current;
    if (!root) return;
    const codes = Array.from(root.querySelectorAll<HTMLElement>("pre > code.language-mermaid"));
    const stale: Array<[HTMLIFrameElement, string]> =
      codes.length === 0 ? [...mermaidFramesRef.current] : [];
    if (codes.length === 0 && stale.length === 0) return;
    let cancelled = false;
    getMermaidBundle(props.readMermaid).then((bundle) => {
      if (cancelled || !bundle || !root.isConnected) return;
      for (const code of codes) {
        const pre = code.parentElement;
        if (!pre || !pre.isConnected) continue;
        const src = code.textContent || "";
        pre.replaceWith(makeMermaidFrame(bundle, src, darkTheme, mermaidFramesRef.current, t("files.mermaidFrameTitle"), t("files.renderFailed")));
      }
      for (const [f, src] of stale) {
        if (!f.isConnected) continue;
        mermaidFramesRef.current.delete(f);
        f.replaceWith(makeMermaidFrame(bundle, src, darkTheme, mermaidFramesRef.current, t("files.mermaidFrameTitle"), t("files.renderFailed")));
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.text, contentMode, darkTheme]);
  // Frames report their natural height (the srcdoc document is taller than
  // the 320px placeholder for big diagrams). The match is by message source,
  // because a sandboxed frame has an opaque origin to compare against.
  // (Frames are NOT unregistered here: the registry doubles as the set of
  // live frames a theme flip must rebuild. Dead frames fall out via the
  // isConnected prune in the swap effect.)
  React.useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { filestabMermaid?: unknown } | null;
      if (!d || typeof d.filestabMermaid !== "number") return;
      for (const f of mermaidFramesRef.current.keys()) {
        if (f.contentWindow === ev.source) {
          f.style.height = Math.max(120, Math.floor(d.filestabMermaid)) + "px";
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The pane's key under the file it shows: the workspace relPath, or the
  // absolute path for an External file.
  const viewedKey = props.absPath || props.relPath;
  // An external open's line (a redirected resource open): once this file's
  // text is up in the RAW view, scroll the line into place. The target is
  // keyed to its path, so a later manual selection never re-applies a stale
  // line. The pre only exists in the raw (view) mode, so the markdown
  // preview and the diff view simply never scroll. An External file is
  // keyed by its ABSOLUTE path (FilesView re-keys the target when it pins
  // the file).
  React.useEffect(() => {
    const lt = props.lineTarget || null;
    if (!lt || lt.path !== viewedKey || !st.text) return;
    const root = bodyRef.current;
    const pre = root ? (root.querySelector("pre.dswFiles_previewText") as HTMLElement | null) : null;
    if (pre) scrollToTextLine(pre, st.text, lt.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lineTarget, viewedKey, st.text, contentMode]);

  const previewBody = previewContentFor(st, contentMode, props.name, t, imgMap);

  // The diff wins the pane while it is live for THIS file. Its state can
  // still be "idle"/"loading" for one frame, so the code shows the loading
  // note, never the stale preview of the previous selection.
  const mineDiff = diffSt.for === props.relPath && effectiveMode === "diff";
  const body =
    mineDiff && diffSt.status === "diff"
      ? (diffSt.file
          ? <DiffView model={diffSt.file} truncated={diffSt.truncated} t={t} baseLabel={isRev ? t("files.diffAtRev") + " " + props.base : null} binary={diffSt.binary || null} />
          : <div className="dswFiles_previewNote">{t("files.noChanges")}</div>)
      : mineDiff && diffSt.status === "error"
        ? <div className="dswFiles_error">{t("files.diffError") + (diffSt.error ? " — " + diffSt.error : "")}</div>
        : mineDiff && diffSt.status !== "none"
          ? <div className="dswFiles_previewEmpty">{t("files.diffLoading")}</div>
          // Commit mode + empty patch: the file is unchanged in this commit,
          // say so, then show the file itself (its exact content at the snapshot).
          : mineDiff && isRev
            ? <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 0" }}>
                <div className="dswFiles_previewNote">{t("files.noChangeAtRev")}</div>
                {previewBody}
              </div>
            : previewBody;

  // ---- Section ref: selection in this pane → a short @path ref the user
  // can append to the chat prompt (or copy). See the builder at the top of
  // the file for the exact shapes. Recomputed on selectionchange (rAF-
  // throttled) and whenever the pane's content or mode changes. null = no
  // usable selection (collapsed, outside this pane, or binary card).
  const [selRef, setSelRef] = React.useState<{ plain: string; withText: string; context: boolean } | null>(null);
  const [refCopied, setRefCopied] = React.useState(false);
  const refCopyTimer = React.useRef(0);
  const lineStartsRef = React.useRef<number[]>([]);
  React.useEffect(() => { lineStartsRef.current = lineStartsOf(st.text || ""); }, [st.text]);
  // Selection → ref. Shared by the selectionchange effect (the pane toolbar)
  // and the context-menu handler (right-click on a live selection), so both
  // surfaces always agree. `context` = the plain ref already carries the
  // snippet (old-side lines, rendered markdown) — the copy button labels
  // that "Copy ref + context" instead of a bare "Copy ref".
  const computeSelRef = (): { plain: string; withText: string; context: boolean } | null => {
    const root = bodyRef.current;
    const sel = typeof window === "undefined" ? null : window.getSelection();
    if (!root || !props.relPath || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    if (!root.contains(sel.anchorNode)) return null;
    const path = props.relPath;
    const rev = isRev ? props.base : undefined;
    const text = String(sel);
    if (mineDiff && diffSt.status === "diff" && diffSt.file) {
      // Prefer the NEW side (those lines exist in the worktree / at the
      // reviewed commit). Old-side-only selections (deleted lines) have no
      // current-file numbers → snippet anchor only, no rev (the lines
      // belong to the commit's parent).
      const nw = diffSelRange(root, "data-dn");
      if (nw) {
        return { plain: buildFileRef({ path, start: nw.min, end: nw.max, rev }), withText: buildFileRef({ path, start: nw.min, end: nw.max, rev, text: nw.text }), context: false };
      }
      const od = diffSelRange(root, "data-dl");
      if (od) { const s = buildFileRef({ path, text: od.text }); return { plain: s, withText: s, context: (od.text || "").trim() !== "" }; }
      return null;
    }
    if (effectiveMode === "preview" && renderKindOf(props.name) === "markdown") {
      // Rendered markdown has no stable source line numbers → snippet.
      if (!text.trim()) return null;
      const s = buildFileRef({ path, rev, text });
      return { plain: s, withText: s, context: true };
    }
    // Raw view: map the selection onto the pre's char offsets.
    const pre = root.querySelector("pre.dswFiles_previewText") as HTMLElement | null;
    const lr = pre ? viewSelRange(pre, lineStartsRef.current) : null;
    if (lr) {
      return { plain: buildFileRef({ path, start: lr.start, end: lr.end, rev }), withText: buildFileRef({ path, start: lr.start, end: lr.end, rev, text }), context: false };
    }
    const s = buildFileRef({ path, text });
    return { plain: s, withText: s, context: text.trim() !== "" };
  };
  React.useEffect(() => {
    let raf = 0;
    const onSel = (): void => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; setSelRef(computeSelRef()); }); };
    document.addEventListener("selectionchange", onSel);
    onSel();
    return () => { document.removeEventListener("selectionchange", onSel); if (raf) cancelAnimationFrame(raf); };
  }, [props.relPath, props.base, props.name, effectiveMode, mineDiff, diffSt.status, diffSt.file, st.status, st.text]);

  const copyRef = (text: string): void => {
    copyRefText(text);
    setRefCopied(true);
    window.clearTimeout(refCopyTimer.current);
    refCopyTimer.current = window.setTimeout(() => setRefCopied(false), 1200);
  };
  React.useEffect(() => () => window.clearTimeout(refCopyTimer.current), []);

  // ---- Right-click context menu ----
  // Web content CANNOT extend the browser's native context menu (there is no
  // platform API for it), so the standard pattern is preventDefault + a
  // custom DOM menu. The interception is deliberately narrow: a right-click
  // resolves to a menu only when it lands on (a) a live selection in this
  // pane (the menu carries the selection's ref) or (b) a resolvable line
  // (a diff cell/gutter, a preview block, or a text position in the view
  // pre). Everything else (the toggle row, grid gaps, a deleted line with
  // no text) shows the native menu unchanged.
  // selText: the live selection's raw text, when the menu was opened on a
  // selection (the "Copy selection" item); null for a plain line right-click
  // (then the "Copy file" item offers the whole file text instead, when the
  // text is loaded — the diff view skips the text fetch, so not always).
  // external: an External file's menu — the head shows its absolute path
  // and the section-ref items are dropped (refs are workspace-scoped); the
  // copy actions remain.
  const [ctxRef, setCtxRef] = React.useState<{ x: number; y: number; plain: string; withText: string | null; context: boolean; selText: string | null; external?: boolean } | null>(null);
  React.useEffect(() => {
    if (!ctxRef) return;
    const close = (): void => setCtxRef(null);
    const onDown = (ev: MouseEvent): void => {
      const t = ev.target as Element | null;
      if (t && t.closest && t.closest(".dswFiles_ctxMenu")) return; // item clicks close via their own handler
      close();
    };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Escape") close(); };
    const onScroll = (): void => close();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [ctxRef]);
  const onPreviewContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const root = bodyRef.current;
    const sel = typeof window === "undefined" ? null : window.getSelection();
    if (!root) return;
    // An External file: no section refs (they are workspace-scoped) — the
    // head shows the absolute path, and the menu keeps the copy actions
    // (a live selection's text when the menu was opened on one).
    if (external) {
      const selLive = sel && sel.rangeCount > 0 && !sel.isCollapsed && root.contains(sel.anchorNode) ? String(sel) : null;
      e.preventDefault();
      setCtxRef({ x: e.clientX, y: e.clientY, plain: props.absPath!, withText: null, context: false, selText: selLive, external: true });
      return;
    }
    // Past the external branch this is a workspace file: the ref-building
    // below assumes a relPath.
    if (!props.relPath) return;
    // A live selection in this pane: the menu carries the SELECTION's ref.
    // (A right-click inside the selection preserves it; a right-click
    // OUTSIDE it collapses the selection on mousedown — browser behavior —
    // so that case degrades naturally to the plain line ref below.)
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && root.contains(sel.anchorNode)) {
      const sr = computeSelRef();
      if (sr) {
        e.preventDefault();
        setCtxRef({ x: e.clientX, y: e.clientY, plain: sr.plain, withText: sr.withText !== sr.plain ? sr.withText : null, context: sr.context, selText: String(sel) });
      }
      return;
    }
    const path = props.relPath;
    const rev = isRev ? props.base : undefined;
    const target = e.target instanceof Element ? e.target : null;
    // Diff: the cell OR gutter under the pointer carries the line number(s).
    // The new side wins (its lines exist in the worktree / at the rev).
    if (mineDiff && diffSt.status === "diff" && target) {
      const cell = target.closest<HTMLElement>(".dswFiles_diffCell[data-dl],.dswFiles_diffCell[data-dn],.dswFiles_diffNo[data-dl],.dswFiles_diffNo[data-dn]");
      if (cell) {
        const dn = Number(cell.getAttribute("data-dn"));
        const dl = Number(cell.getAttribute("data-dl"));
        let text = "";
        if (cell.classList.contains("dswFiles_diffCell")) {
          text = (cell.textContent || "").trim();
          const mk = cell.querySelector(".dswFiles_diffMark");
          const mt = mk ? (mk.textContent || "") : "";
          if (mt && text.startsWith(mt)) text = text.slice(mt.length).trim();
        }
        if (Number.isFinite(dn) && dn >= 1) {
          e.preventDefault();
          setCtxRef({ x: e.clientX, y: e.clientY, plain: buildFileRef({ path, start: dn, rev }), withText: text ? buildFileRef({ path, start: dn, rev, text }) : null, context: false, selText: null });
          return;
        }
        if (Number.isFinite(dl) && dl >= 1) {
          if (!text) return; // deleted line with no text: nothing to anchor
          const plain = buildFileRef({ path, text });
          e.preventDefault();
          // Old side: the numbers belong to the base revision, so the ref
          // carries the line text as its anchor — label it accordingly.
          setCtxRef({ x: e.clientX, y: e.clientY, plain, withText: null, context: true, selText: null });
          return;
        }
        return;
      }
    }
    // Rendered markdown preview: the rendered DOM has no stable mapping to
    // source lines (the renderer transforms structure), so a right-click
    // anchors the ref to the clicked BLOCK's text — snippet-only, the same
    // policy as old-side diff lines. HTML previews are sandboxed iframes
    // with their own document; their context menus are out of scope.
    if (effectiveMode === "preview" && renderKindOf(props.name) === "markdown") {
      const md = root.querySelector("div.dswFiles_previewMarkdown");
      if (md && target && md.contains(target)) {
        const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,dt,dd";
        let block: Element | null = target.closest(BLOCK);
        if (!block || block === md) {
          // Whitespace or container padding: resolve through the caret point.
          const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
          const r = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(e.clientX, e.clientY) : null;
          const n = r && r.startContainer ? (r.startContainer.nodeType === Node.TEXT_NODE ? r.startContainer.parentElement : r.startContainer) : null;
          if (n instanceof Element) block = n.closest(BLOCK);
        }
        if (block && block !== md) {
          const text = (block.textContent || "").trim();
          if (text) {
            e.preventDefault();
            const s = buildFileRef({ path, rev, text });
            setCtxRef({ x: e.clientX, y: e.clientY, plain: s, withText: null, context: true, selText: null });
          }
        }
      }
      return;
    }
    // Raw view: the caret position under the pointer → char offset → line.
    const pre = root.querySelector("pre.dswFiles_previewText") as HTMLElement | null;
    if (pre) {
      const doc = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null;
      };
      let c: Node | null = null;
      let off = 0;
      if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(e.clientX, e.clientY); if (r) { c = r.startContainer; off = r.startOffset; } }
      if (!c && doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(e.clientX, e.clientY); if (p) { c = p.offsetNode; off = p.offset; } }
      if (c && c.nodeType === Node.TEXT_NODE && pre.contains(c)) {
        const o = textNodeOffset(pre, c as Text, off);
        if (o >= 0) {
          const line = lineOfOffset(o, lineStartsRef.current);
          const ls = lineStartsRef.current;
          const s = ls[line - 1]!;
          const en = line < ls.length ? ls[line]! : (st.text || "").length;
          const lineText = (st.text || "").slice(s, en);
          e.preventDefault();
          setCtxRef({ x: e.clientX, y: e.clientY, plain: buildFileRef({ path, start: line, rev }), withText: lineText.trim() ? buildFileRef({ path, start: line, rev, text: lineText }) : null, context: false, selText: null });
        }
      }
    }
  };
  // The menu is a sibling of the content inside the pane root, so no
  // ancestor transform (the diff grid's) can move it. The click point is
  // re-expressed relative to the root; the clamp keeps it on-screen.
  const ctxMenu = ctxRef && bodyRef.current
    ? (() => {
        const r = bodyRef.current!.getBoundingClientRect();
        const left = Math.max(0, Math.min(ctxRef.x - r.left, r.width - 220));
        const top = Math.max(0, Math.min(ctxRef.y - r.top, r.height - 150));
        return <div className="dswFiles_ctxMenu" role="menu" style={{ left, top }}>
          <div className="dswFiles_ctxHead" title={ctxRef.plain}>{ctxRef.plain.length > 52 ? ctxRef.plain.slice(0, 52) + "…" : ctxRef.plain}</div>
          {/* The ref copy is workspace-scoped: an External file's menu keeps
              its path head and the plain copy actions. */}
          {!ctxRef.external
            ? <button type="button" role="menuitem" className="dswFiles_ctxItem" title={ctxRef.plain}
              onClick={() => { copyRef(ctxRef.plain); setCtxRef(null); }}>
              {Icon("IconCopyOutline16", { size: 14 }, "⧉")} {refCopyLabel(t, !!ctxRef.withText, ctxRef.context)}
            </button>
            : null}
          {ctxRef.withText
            ? (function () {
                const wt = ctxRef.withText;
                return <button type="button" role="menuitem" className="dswFiles_ctxItem" title={wt}
                  onClick={() => { copyRef(wt); setCtxRef(null); }}>
                  {Icon("IconCopyOutline16", { size: 14 }, "⧉")} {t("files.refCopyText")}
                </button>;
              })()
            : null}
          {/* Copy the raw content: the live selection when the menu was
              opened on one, otherwise the whole file (only when the text
              is loaded — the diff view skips the text fetch). */}
          {ctxRef.selText != null
            ? (function () {
                const ct = ctxRef.selText;
                return <button type="button" role="menuitem" className="dswFiles_ctxItem"
                  onClick={() => { copyRef(ct); setCtxRef(null); }}>
                  {Icon("IconCopyOutline16", { size: 14 }, "⧉")} {t("files.copySelection")}
                </button>;
              })()
            : (st.status === "text" || st.status === "markdown")
            ? (function () {
                const ft = st.text || "";
                if (!ft) return null;
                return <button type="button" role="menuitem" className="dswFiles_ctxItem"
                  onClick={() => { copyRef(ft); setCtxRef(null); }}>
                  {Icon("IconCopyOutline16", { size: 14 }, "⧉")} {t("files.copyFile")}
                </button>;
              })()
            : null}
          {/* Copy path (BUG-006): the file's ABSOLUTE path, loopback-only
              (an absolute path is local-machine information — never offered
              when the GUI is reached over the network). Independent of the
              file text being loaded, so it also works in diff mode. An
              External file's absolute path is known directly. */}
          {(props.absPath || (props.wsRoot && props.relPath)) && isLoopbackOrigin()
            ? (function () {
                const abs = props.absPath || absolutePathOf(props.wsRoot!, props.relPath!);
                return <button type="button" role="menuitem" className="dswFiles_ctxItem" title={abs}
                  onClick={() => { copyRef(abs); setCtxRef(null); }}>
                  {Icon("IconCopyOutline16", { size: 14 }, "⧉")} {t("files.copyPath")}
                </button>;
              })()
            : null}
          {/* The chat append takes a section ref: workspace-scoped, so an
              External file's menu omits it. */}
          {!ctxRef.external && props.inputActions
            ? <AddToChatBtn refText={ctxRef.plain} useInput={props.useInput ?? null} inputActions={props.inputActions} t={t}
                className="dswFiles_ctxItem" onDone={() => setCtxRef(null)} />
            : null}
        </div>;
      })()
    : null;

  // Order: the copy actions lead (the primary, always-available affordance);
  // the chat append trails, labeled explicitly "Add REF to chat" so the
  // selection-to-button tie is unambiguous without hovering.
  const refTools = selRef
    ? <span className="dswFiles_refTools">
        <button
          type="button"
          className="dswFiles_refBtn"
          title={selRef.plain}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => copyRef(selRef.plain)}
        >{Icon("IconCopyOutline16", { size: 14 }, "⧉")} {refCopied ? t("files.refCopied") : refCopyLabel(t, selRef.withText !== selRef.plain, selRef.context)}</button>
        {selRef.withText !== selRef.plain
          ? <button
              type="button"
              className="dswFiles_refBtn"
              title={selRef.withText}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => copyRef(selRef.withText)}
            >{Icon("IconCopyOutline16", { size: 14 }, "⧉")} {refCopied ? t("files.refCopied") : t("files.refCopyText")}</button>
          : null}
        {props.inputActions
          ? <AddToChatBtn refText={selRef.plain} useInput={props.useInput ?? null} inputActions={props.inputActions} t={t} />
          : null}
      </span>
    : null;

  const toggleModes = paneToggleModes(diffable, props.name);
  const MODE_LABEL: Record<string, string> = { diff: "files.diff", view: "files.view", preview: "files.preview" };
  // The view bar, rendered only while a file is viewed: mode/openLocal/ref
  // buttons on the left, and — only while the nav is hidden — the state
  // pair's RESTORE control on the right. Disappearing with the selection is
  // safe: FilesView keeps the nav expanded whenever nothing is viewed, so a
  // hidden nav always has a view bar to carry its restore button.
  const offerOpenLocal = canOfferOpenLocal({ relPath: props.relPath, absPath: props.absPath ?? null, wsRoot: props.wsRoot ?? null, openCapable: !!props.openCapable });
  const toggle = props.name
    ? <div className="dswFiles_paneToggle" role="group">
        {toggleModes.map((m) => (
          <button
            key={m}
            type="button"
            className={"dswFiles_paneToggleBtn" + (effectiveMode === m ? " dswFiles_paneToggleBtnActive" : "")}
            onClick={() => setMode(m)}
            title={m === "preview" && renderKindOf(props.name) === "html" ? t("files.htmlPreviewTitle") : undefined}
          >{t(MODE_LABEL[m]!)}</button>
        ))}
        {/* Open locally (BUG-005): hands the file's absolute path to the OS
            default app through dsh's own host.openPath (the produced-files
            mechanism). Gated by canOfferOpenLocal (loopback + canOpenPath).
            A binary-only file has no head at all (no modes, no selectable
            text), so the affordance deliberately doesn't reach it. */}
        {offerOpenLocal
          ? <button
              type="button"
              className="dswFiles_paneToggleBtn"
              title={props.absPath || (props.wsRoot && props.relPath ? absolutePathOf(props.wsRoot, props.relPath) : "")}
              onClick={openLocal}
            >{Icon("IconFolderOpen16", { size: 14 }, "📂")} {t("files.openLocal")}</button>
          : null}
        {refTools}
        {/* The state pair's restore control: present only while the nav is
            hidden, at the view bar's right end (the bar is the still-visible
            region then). The hide control lives in the nav's own header. */}
        {props.navCollapsed
          ? <button
              type="button"
              className="dswFiles_navToggle"
              onClick={props.onToggleNav}
              aria-label={t("files.restoreNav")}
              title={t("files.restoreNav")}
              aria-expanded="false"
              aria-controls={props.navId}
            >
            <NavChevron dir="left" size={14} />
          </button>
          : null}
      </div>
    : null;
  // The conflict note is about the WORKTREE file, suppressed while a past
  // commit is selected (the pane shows that commit's patch, not the
  // conflicted worktree text).
  const conflictNote = !isRev && props.status && props.status.base === "conflict"
    ? <div className="dswFiles_previewNote">{t("files.conflictNote")}</div>
    : null;

  return <div
    ref={bodyRef}
    className="dswFiles_previewBody"
    style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 0" }}
    onContextMenu={onPreviewContextMenu}
  >
    {toggle}
    {/* The selected file's name: shown for every viewed file (diff, view or
        preview mode), so the pane identifies itself in every mode. */}
    {props.name
      ? <div className="dswFiles_paneHead">{props.name}</div>
      : null}
    {conflictNote}
    {openNote ? <div className="dswFiles_previewNote">{openNote}</div> : null}
    {/* A transient failure note from FilesView (an external open that could
        not be verified): visible even with nothing selected, above the
        pane's empty state. */}
    {props.notice ? <div className="dswFiles_error">{props.notice}</div> : null}
    {body}
    {ctxMenu}
  </div>;
}

// Roving-focus target for a key over a list of n rows with the focus at idx
// (null = not an index-move key). ArrowLeft is NOT index math (it goes up a
// level) and Enter/Space activate via the native click, both handled by the
// caller.
function listNavTarget(key: string, idx: number, n: number): number | null {
  if (!n || n <= 0) return null;
  if (key === "ArrowDown") return Math.min(idx + 1, n - 1);
  if (key === "ArrowUp") return Math.max(idx - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

// The right column is a dsh tab system: filestab's page (sidebar://files) is
// one tab, and a file chip opens a SEPARATE resource tab (dsh-resource://file/…).
// dsh keys each tab body by tab id, so switching the active tab unmounts the
// old body and mounts the new one. filestab treats the resource tab as a
// transient frame that redirects into the page, so a chip open runs: page
// unmounts → transient frame → page remounts. React state is lost across that
// remount, so the nav column re-fetches its tree — the visible "refresh".
//
// This module-level cache (it survives the remount within one page load, keyed
// by session) restores the fetched nav state synchronously on mount, so the
// tree stays put and only the preview updates. It is dropped when the session
// is gone. A full page reload starts empty (a fresh fetch is correct then).
interface NavCache {
  levels: Record<string, Listing>;
  levelErr: Record<string, string>;
  commitList: VcsCommit[];
  navScroll: number;
}
const navCache = new Map<string, NavCache>();
const navCacheGet = (sessionId: string | null): NavCache | null =>
  sessionId ? (navCache.get(sessionId) ?? null) : null;
const navCacheSet = (sessionId: string | null, patch: Partial<NavCache>): void => {
  if (!sessionId) return;
  const prev = navCache.get(sessionId) ??
    { levels: {}, levelErr: {}, commitList: [], navScroll: 0 };
  navCache.set(sessionId, { ...prev, ...patch });
};
const navCacheDrop = (sessionId: string | null): void => {
  if (sessionId) navCache.delete(sessionId);
};

interface FilesViewProps {
  t?: TFunc;
  listDirectory: (relPath: string, signal: AbortSignal, showHidden: boolean, force: boolean, rev: string | null) => Promise<Listing>;
  sessionId: string | null;
  readAt: (relPath: string, rev: string, signal: AbortSignal) => Promise<FileShowValue>;
  /** The External section's read (fileshow-abs): a live file by absolute
      path, outside the workspace. Absent in a minimal profile (the section
      then only accepts pins that were persisted before the face lost it —
      selecting one fails to the pane's error state, which is honest). */
  readAtAbs?: ((path: string, signal: AbortSignal) => Promise<FileShowValue>) | null;
  fetchDiff: (relPath: string, base: string, signal: AbortSignal, opts?: { noBinary?: boolean }) => Promise<DiffResponse>;
  readMermaid: () => Promise<{ text: string }>;
  /**
   * Session standard kit (composer): the live-draft selector and the public
   * draft write path, passed through to the preview pane for the section-ref
   * "add to chat" action. Optional — the slot renderer provides them for
   * session-scoped entries, but a test harness or minimal profile may not.
   */
  useInput?: ((sel: (s: { draft: string }) => string) => string) | null;
  inputActions?: { setDraft(text: string): void } | null;
  /** An open from OUTSIDE the list (a file resource redirected into the
      right-column page tab): the workspace-relative file to select, the line
      its preview should scroll to, and the navigation generation (a repeat
      open of the same file re-fires). null = none pending. */
  openRequest?: { path: string; line?: number; revision: number } | null;
}
function FilesView(props: FilesViewProps) {
  const t = props.t || ((k: string) => k);
  const listDirectory = props.listDirectory;
  const sessionId = props.sessionId;
  // The nav column region's id, for the toggle pair's aria-controls. Suffix
  // per session: two files tabs of different sessions can be open at once.
  const navId = "dswFiles_nav" + (sessionId ? "_" + sessionId : "");
  const [saved] = React.useState<SavedState | null>(() => loadState(sessionId));
  // The set of expanded directory paths (the tree model). ROOT_PATH is
  // always expanded; every other entry is one directory's relPath.
  const [expanded, setExpanded] = React.useState<string[]>(() =>
    saved && saved.expanded.length > 0 ? saved.expanded : [ROOT_PATH]);
  // The listings cache, keyed by directory relPath. Restored from the module
  // nav cache on mount so a resource-frame-redirect remount renders the tree
  // from cache instead of re-fetching (the fetch effect skips a ready level).
  const [levels, setLevels] = React.useState<Record<string, Listing>>(
    () => navCacheGet(sessionId)?.levels ?? {});
  // A per-directory fetch failure, rendered as a note row inside that
  // directory (in the list area itself — a bottom-of-pane line is easy to
  // miss). There is no pane-level error state.
  const [levelErr, setLevelErr] = React.useState<Record<string, string>>(
    () => navCacheGet(sessionId)?.levelErr ?? {});
  // True once the host reports this session as gone (server restart / session
  // ended). Every RPC for a dead session fails with session-not-found, so the
  // view latches: it stops the 5 s poll and shows a calm notice instead of the
  // raw code+UUID. Reload clears it to retry (a fresh session may have come up).
  const [sessionGone, setSessionGone] = React.useState(false);
  // BUG-005: the host's native-open capability (the version-tolerant probe
  // below — host.describe on 0.1.1, session/canOpenWorkspacePath on 0.1.2),
  // run once per mount. Any failure → false, which simply hides the action
  // (a headless service environment, or a host without the API, is not an
  // error state for the Files tab).
  const [openCapable, setOpenCapable] = React.useState(false);
  React.useEffect(() => {
    const c = new AbortController();
    hostDescribe(c.signal)
      .then((d) => setOpenCapable(d.canOpenPath === true))
      .catch(() => setOpenCapable(false));
    return () => c.abort();
  }, []);
  const [showHidden, setShowHidden] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [selectedFile, setSelectedFile] = React.useState<DirEntry | null>(null);
  // The External section (files OUTSIDE the workspace, pinned by absolute
  // path). The list is the persisted pin set; the selection is mutually
  // exclusive with the tree's selection and counts as "a file is viewed"
  // (the view bar and the collapse rule key off it, as off the tree's).
  const [external, setExternal] = React.useState<string[]>(() => saved ? saved.external : []);
  const [selectedExternal, setSelectedExternal] = React.useState<string | null>(
    () => saved && saved.selectedExternal ? saved.selectedExternal : null);
  // The manual "open file by absolute path" prompt: open flag + draft.
  const [extOpenPrompt, setExtOpenPrompt] = React.useState(false);
  const [extPrompt, setExtPrompt] = React.useState("");
  // The section's error (validation or a failed open attempt): it stays up
  // while the prompt is open (it is why the attempt failed) and goes with
  // the prompt (close/cancel/success all clear it).
  const [extErr, setExtErr] = React.useState<string | null>(null);
  // A chip open that could not be resolved as a workspace file AND failed
  // its external verification: a transient note in the PREVIEW pane (the
  // section may not be visible at all when it happens).
  const [extNotice, setExtNotice] = React.useState<string | null>(null);
  const extNoticeTimer = React.useRef(0);
  React.useEffect(() => () => window.clearTimeout(extNoticeTimer.current), []);
  // The in-flight external verification (one per pending path): the pending
  // selection's effect re-runs on every listing change, so it must neither
  // re-fire nor clear the selection while the read is outstanding.
  const extAttemptRef = React.useRef<string | null>(null);
  // Nav column width (divider drag). null = the CSS default (340px). The
  // value restores from the per-session state, clamped on load.
  const [navW, setNavW] = React.useState<number | null>(() =>
    saved && typeof saved.navW === "number" && saved.navW >= 220 && saved.navW <= 2000
      ? Math.round(saved.navW) : null);
  // Nav column collapsed: the browse pane + divider unmount, so the preview
  // and diff take the full width. navW is kept so expanding restores the
  // previous width. Restored from the per-session state (default: open). The
  // preference only takes effect while a file is viewed (navHidden) — with
  // nothing to show in the view pane the nav stays expanded, since it is the
  // only way to pick a file.
  const [collapsed, setCollapsed] = React.useState<boolean>(() => saved ? saved.collapsed : false);
  // The commit under review (null = the working copy). A change id stays
  // valid across rebase/amend. Ids are jj's a–z change form or hex commit
  // ids, hence the [0-9a-z] check.
  const [revSel, setRevSel] = React.useState<string | null>(() =>
    saved && typeof saved.rev === "string" && /^[0-9a-z]{6,40}$/.test(saved.rev) ? saved.rev : null);
  // The recent-commit list, PERSISTENT across listing-cache clears.
  const [commitList, setCommitList] = React.useState<VcsCommit[]>(
    () => navCacheGet(sessionId)?.commitList ?? []);
  // The row holding roving keyboard focus (an entry path). null = not
  // focused yet; the first row is the tab stop then.
  const [focusPath, setFocusPath] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  // The nav column's scroll element (`.dswFiles_tree`). Its scrollTop is kept
  // in the module nav cache so a remount restores the tree's scroll position
  // instead of jumping to the top.
  const navScrollRef = React.useRef<HTMLDivElement | null>(null);
  // Per-path fetch generations: an in-flight response must not apply once a
  // newer fetch for the same path supersedes it (or the directory was
  // collapsed away).
  const seqRef = React.useRef<Record<string, number>>({});
  // The reload button sets this: the next fetch passes force=true, which
  // also invalidates the host's structural jj-failure cache.
  const forceRef = React.useRef(false);
  // The selection to re-apply once its containing directory's listing loads
  // (a restored selection, a path-edit target, a rev switch). A restored
  // EXTERNAL selection applies directly (no listing to wait for), so it
  // suppresses the tree restore — the persisted pair is exclusive.
  const pendingSelRef = React.useRef<string | null>(saved && !saved.selectedExternal ? saved.selected : null);
  // The line an external open asked for (openRequest), keyed to its path so a
  // later manual navigation never re-applies a stale line.
  const [lineTarget, setLineTarget] = React.useState<{ path: string; line: number } | null>(null);
  // The row buttons keyed by entry path (roving tabindex, focus restore).
  const rowRefByPath = React.useRef<Record<string, HTMLButtonElement | null>>({});
  // Whether keyboard focus was INSIDE the file list. The focus-restore
  // effect that follows hands focus back after a tree mutation, instead of
  // taking it from a mouse user (who never sets it).
  const listHadFocusRef = React.useRef(false);
  // The header's root-path row (the clip mask is measured on it).
  const pathBoxRef = React.useRef<HTMLDivElement | null>(null);
  const pathTextRef = React.useRef<HTMLSpanElement | null>(null);

  // Snapshot mode: the user selected a reviewed commit. The list is that
  // commit's exact tree. The preview reads bytes AT the commit. The code
  // hides worktree badges/rollups. revLive = the persisted selection, if it
  // is still in the commit list. A rewritten-away rev degrades to the
  // working copy.
  // refListing: the root level when it is ready, else the first ready level
  // (any listing carries the root path and the commit block).
  const refListing = levels[ROOT_PATH] || Object.values(levels)[0] || null;
  const vcsInfo = refListing && refListing.vcs && refListing.vcs.ok === true ? refListing.vcs : null;
  const commits = vcsInfo && Array.isArray(vcsInfo.commits) ? vcsInfo.commits : [];
  // revLive validates against the PERSISTENT commitList, not a listing's
  // own block. The rev-change effect clears `levels` on every rev flip. A
  // revLive taken from the just-cleared listing flaps null→rev→null forever
  // (each cycle aborts its own predecessor), the stuck "loading…" tab.
  const revLive = revSel && commitList.some((c) => c.id === revSel) ? revSel : null;
  const snapshotMode = revLive !== null;
  // The change set the nav-pane markers describe: the worktree's set in live
  // mode, the selected commit's own diff (vs its parent) in snapshot mode,
  // the worktree's letters never appear over a frozen tree.
  const commitChanges = snapshotMode && refListing && Array.isArray(refListing.commitChanges)
    ? refListing.commitChanges : null;
  const activeChanges = snapshotMode ? commitChanges : (vcsInfo ? vcsInfo.changes ?? null : null);
  // Every listing carries the host's absolute workspace root — the header's
  // root path and the source for the loopback-only "copy path" action.
  const rootPath = refListing && typeof refListing.root === "string" ? refListing.root : null;
  const expandedSet = new Set(expanded);
  // The code remembers the commit list from a listing that carries one
  // (both worktree and snapshot responses include the worktree jj block).
  const noteCommits = (listing: Listing | null) => {
    if (listing && listing.vcs && listing.vcs.ok === true && Array.isArray(listing.vcs.commits)) {
      setCommitList(listing.vcs.commits);
    }
  };

  // The effect fetches every expanded directory's listing (the worktree's,
  // or the selected commit's snapshot) that is not yet cached. A directory
  // whose PARENT is not ready waits: the parent's listing is where the
  // child is known to exist, and the effect re-runs as each level settles.
  // A persisted dead path's fetch simply fails into its own note row.
  // A latched dead session skips the fetch entirely (every call would 404
  // the same way).
  React.useEffect(() => {
    if (sessionGone) return;
    const force = forceRef.current === true;
    if (force) forceRef.current = false;
    const paths = expanded.filter((p) =>
      !levels[p] && levelErr[p] === undefined &&
      (p === ROOT_PATH || (levels[parentPathOf(p)] && levelErr[parentPathOf(p)] === undefined)));
    if (paths.length === 0) return;
    const c = new AbortController();
    const stuckTimers: number[] = [];
    for (const p of paths) {
      const seq = (seqRef.current[p] || 0) + 1;
      seqRef.current[p] = seq;
      if (p === ROOT_PATH) {
        // Transport guard: a request that never settles (a dead keep-alive
        // socket, a proxy that swallows it, a stale pre-restart connection)
        // leaves "Loading…" as the only visible state forever. The code
        // surfaces it after 30 s so the failure is at least visible.
        stuckTimers.push(window.setTimeout(() => {
          if (seqRef.current[p] === seq) {
            try { console.warn("filestab list STUCK > 30 s"); } catch { /* no console */ }
            setLevelErr((prev) => (prev[p] !== undefined ? prev : Object.assign({}, prev, { [p]: t("files.fetchStuck") })));
          }
        }, 30000));
      }
      listDirectory(p, c.signal, showHidden, force && p === ROOT_PATH, revLive).then((listing) => {
        if (seqRef.current[p] !== seq) return;
        noteCommits(listing);
        setLevels((prev) => (prev[p] ? prev : Object.assign({}, prev, { [p]: listing })));
        setLevelErr((prev) => { if (prev[p] === undefined) return prev; const n = Object.assign({}, prev); delete n[p]; return n; });
      }).catch((e) => {
        // An aborted fetch (a re-run of this effect superseded it) is not a
        // failure — the re-run re-queues the path.
        if (c.signal.aborted || seqRef.current[p] !== seq) return;
        // A dead session is terminal for this view: latch the flag (it stops
        // the 5 s poll and swaps the pane to the calm notice) rather than
        // leaking the raw "session-not-found: no live session for <uuid>"
        // string.
        if (isSessionGone(e)) { setSessionGone(true); return; }
        setLevelErr((prev) => (prev[p] !== undefined ? prev : Object.assign({}, prev, { [p]: rpcErrorText(e, t) })));
      });
    }
    return () => { c.abort(); for (const to of stuckTimers) window.clearTimeout(to); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, levels, levelErr, showHidden, revLive, sessionGone]);

  // Keep the module nav cache in sync with the fetched state, so a remount from
  // the resource-frame redirect restores the tree synchronously (no re-fetch).
  // A reviewed-commit switch clears `levels` (a different tree) and this writes
  // the cleared set through, which is the correct reset.
  React.useEffect(() => {
    navCacheSet(sessionId, { levels, levelErr, commitList });
  }, [sessionId, levels, levelErr, commitList]);
  // A dead session leaves stale listings behind: drop the cache so a fresh
  // session that reuses the id starts clean.
  React.useEffect(() => {
    if (sessionGone) navCacheDrop(sessionId);
  }, [sessionId, sessionGone]);

  // The path the LAST openRequest (a chip open) asked for: only a chip open
  // is eligible for the external fallback below. A stale RESTORED selection
  // pointing at a deleted file must drop silently (it would otherwise fail
  // an RPC and flash a note on every reload).
  const chipPendingRef = React.useRef<string | null>(null);

  // Pin an absolute path in the External section and select it. Dedupes the
  // pin set. The line target re-keys to the ABSOLUTE path — the pane's key
  // for an external file — so a chip's line scroll still lands.
  const pinExternal = (path: string, line?: number): void => {
    setSelectedExternal(path);
    setSelectedFile(null);
    pendingSelRef.current = null;
    chipPendingRef.current = null;
    setExternal((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setLineTarget(typeof line === "number" ? { path, line } : null);
  };
  // The candidate read failed (not found, not a file, session dead): note it
  // in the preview pane (transient — the section may be invisible at all),
  // never latch.
  const failExternalOpen = (path: string, e: unknown): void => {
    pendingSelRef.current = null;
    chipPendingRef.current = null;
    setExtNotice(t("files.externalFailed") + " " + path + (e ? " — " + rpcErrorText(e, t) : ""));
    window.clearTimeout(extNoticeTimer.current);
    extNoticeTimer.current = window.setTimeout(() => setExtNotice(null), 8000);
  };
  // The openRequest effect expanded the target's ancestor chain BEFORE we
  // knew the file was outside the workspace: those fake directories linger
  // in expanded/levels/levelErr. Remove only the ancestors that DO NOT
  // EXIST in the tree — the chain is contiguous, so walk from the top and
  // stop at the first missing ancestor; a real directory the user had open
  // stays open. Bumping seqRef invalidates any in-flight listing fetch for
  // a removed directory (its stale response must not re-populate the map).
  const cleanupFakeAncestors = (pend: string): void => {
    const chain = expandedFromPath(pend).filter((p) => p !== ROOT_PATH);
    if (chain.length === 0) return;
    let fakeFrom = 0;
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i]!;
      const parListing = levels[parentPathOf(p)];
      if (parListing && (parListing.entries || []).some((en) => en.path === p)) { fakeFrom = i + 1; continue; }
      break;
    }
    const fake = chain.slice(fakeFrom);
    if (fake.length === 0) return;
    for (const p of fake) seqRef.current[p] = (seqRef.current[p] || 0) + 1;
    setExpanded((prev) => prev.filter((p) => !fake.includes(p)));
    setLevels((prev) => {
      let out = prev;
      for (const p of fake) if (p in out) { out = Object.assign({}, out); delete out[p]; }
      return out;
    });
    setLevelErr((prev) => {
      let out = prev;
      for (const p of fake) if (p in out) { out = Object.assign({}, out); delete out[p]; }
      return out;
    });
  };
  // The pending selection's parent listing is settled (or failed) and the
  // entry is not a file in it: this is an OUT-OF-WORKSPACE open — dsh 0.1.5's
  // addressing sends the absolute path with its leading slash lost (see
  // toAbsoluteCandidate). Reconstruct the candidate, VERIFY it with the host
  // read, then pin it in the External section. One attempt per path
  // (extAttemptRef): returns true while the path is in the external flow
  // (in flight or a decision pending), so the caller must not clear the
  // pending selection.
  const tryExternalFallback = (pend: string): boolean => {
    if (extAttemptRef.current === pend) return true; // in flight: keep it pending
    if (chipPendingRef.current !== pend || !props.readAtAbs) return false;
    const candidate = toAbsoluteCandidate(pend);
    if (!candidate) return false;
    extAttemptRef.current = pend;
    const lt = lineTarget;
    const line = lt && lt.path === pend ? lt.line : undefined;
    props.readAtAbs(candidate, new AbortController().signal).then(() => {
      pinExternal(candidate, line);
      cleanupFakeAncestors(pend);
    }).catch((e) => {
      if (isSessionGone(e)) setSessionGone(true);
      else failExternalOpen(candidate, e);
    }).finally(() => {
      if (extAttemptRef.current === pend) extAttemptRef.current = null;
    });
    return true;
  };

  // Manual open by path (the footer/section prompt): validate absoluteness
  // client-side, verify with the same host read, pin. A failed open keeps
  // the prompt OPEN with its draft (the path is what needs correcting) and
  // shows the error in the section.
  const commitExternalOpen = (): void => {
    const p = extPrompt.trim();
    if (!p) { setExtOpenPrompt(false); setExtPrompt(""); return; }
    if (!/^(\/|[A-Za-z]:[\\/]|\/\/)/.test(p)) { setExtErr(t("files.externalInvalid")); return; }
    if (!props.readAtAbs) { setExtErr(t("files.externalFailed") + " " + p); return; }
    setExtErr(null);
    props.readAtAbs(p, new AbortController().signal).then(() => {
      pinExternal(p);
      setExtOpenPrompt(false);
      setExtPrompt("");
    }).catch((e) => {
      setExtErr(t("files.externalFailed") + " " + p + (e ? " — " + rpcErrorText(e, t) : ""));
    });
  };

  // Apply the pending selection once its containing directory is ready. A
  // directory target is dropped (the tree shows it expanded, not selected);
  // a path whose parent failed, or whose parent is not in the expanded set,
  // is dropped too — the ref must never latch and starve the save effect.
  // Before a chip open is dropped (parent failed, or entry absent from a
  // settled listing), the external fallback takes it: the path may be an
  // out-of-workspace file wearing a workspace-relative costume.
  React.useEffect(() => {
    const pend = pendingSelRef.current;
    if (!pend) return;
    const par = parentPathOf(pend);
    if (levelErr[par] !== undefined || (par !== ROOT_PATH && !expandedSet.has(par))) {
      if (tryExternalFallback(pend)) return;
      pendingSelRef.current = null;
      chipPendingRef.current = null;
      return;
    }
    const listing = levels[par];
    if (!listing) return;
    const e = (listing.entries || []).find((en) => en.path === pend);
    if (e && !e.isDirectory) { setSelectedFile(e); setSelectedExternal(null); chipPendingRef.current = null; }
    else if (!e && tryExternalFallback(pend)) return; // not in the listing
    pendingSelRef.current = null;
    chipPendingRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels, levelErr, expanded]);

  // An open from OUTSIDE the list (a file resource redirected into the
  // right-column page): expand the target's ancestor chain and select it
  // through the pending-selection machinery (the parent listing may still be
  // loading), the same path a path jump (commitEdit) takes. A re-open of the
  // ALREADY selected file only re-arms the line scroll.
  const openReq = props.openRequest || null;
  React.useEffect(() => {
    if (!openReq) return;
    const text = openReq.path;
    // A re-open of the ALREADY pinned external file: only the line scroll
    // re-arms — keyed to the absolute path (the pane's key for it), not the
    // mangled relative form. No fake ancestors, no pending, no re-read.
    if (selectedExternal) {
      const c = toAbsoluteCandidate(text);
      if (c === selectedExternal) {
        setLineTarget(typeof openReq.line === "number" ? { path: selectedExternal, line: openReq.line } : null);
        return;
      }
    }
    setExpanded((prev) => {
      const next = [...prev];
      for (const p of expandedFromPath(text)) if (!next.includes(p)) next.push(p);
      return next;
    });
    if (typeof openReq.line === "number") setLineTarget({ path: text, line: openReq.line });
    else setLineTarget(null);
    if (selectedFile && selectedFile.path === text) return;
    pendingSelRef.current = text;
    chipPendingRef.current = text;
    setSelectedFile(null);
    // The open may target a file the listing cache has not seen yet (the
    // model JUST wrote it): drop the parent's cached listing so it refetches
    // and the pending-selection effect applies the entry when it lands.
    const par = parentPathOf(text);
    setLevels((prev) => {
      if (prev[par] === undefined) return prev;
      const n = { ...prev };
      delete n[par];
      return n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq]);

  // A reviewed-commit switch is a different TREE. The code clears the level
  // cache (the other tree's entries poison the paths) and re-applies the
  // current selection if the file exists in the new tree too. The expanded
  // set is KEPT: it is the tree shape the user had open, and a directory the
  // snapshot lacks simply shows its failed note row.
  const lastRevRef = React.useRef(revLive);
  React.useEffect(() => {
    if (lastRevRef.current === revLive) return;
    lastRevRef.current = revLive;
    if (selectedFile) { pendingSelRef.current = selectedFile.path; setSelectedFile(null); }
    setLevels({});
    setLevelErr({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revLive]);

  // jj state changes between visits. The code refreshes every READY expanded
  // directory's listing every 5 s (force=false: the host reuses its
  // structural-failure cache). A failed poll keeps the last good listing, so
  // the view never degrades.
  const vcsOk = !!vcsInfo;
  // A stable key for the poll's target set (ready expanded directories):
  // the interval re-creates only when the set itself changes, not on every
  // listing swap.
  const pollKey = expanded.filter((p) => levels[p] && levelErr[p] === undefined).join("\u0000")
    + "\u0000" + (revLive || "") + "\u0000" + String(showHidden);
  // Monotonic poll sequence: an in-flight poll's response must not apply
  // once a newer poll (or a re-run of this effect) supersedes it. A stale
  // worktree response clobbers a fresh snapshot listing and rolls the commit
  // dropdown back.
  const pollSeqRef = React.useRef(0);
  React.useEffect(() => {
    // A latched dead session has no point polling (every tick would 404 the
    // same way); the flag also re-runs this effect to clear the interval.
    if (!vcsOk || sessionGone) return;
    const iv = setInterval(() => {
      const seq = ++pollSeqRef.current;
      const c = new AbortController();
      const targets = expanded.filter((p) => levels[p] && levelErr[p] === undefined);
      if (targets.length === 0) return;
      // Same mode as the fetch effect: the poll keeps the snapshot's tree
      // (and the worktree `jj` block behind the dropdown) fresh.
      Promise.allSettled(targets.map((p) => listDirectory(p, c.signal, showHidden, false, revLive))).then((results) => {
        if (seq !== pollSeqRef.current || c.signal.aborted) return; // superseded
        const patch: Record<string, Listing> = {};
        const errs: Record<string, string> = {};
        let gone = false;
        results.forEach((r, i) => {
          const p = targets[i]!;
          if (r.status === "rejected") {
            const e = r.reason;
            // A session that died mid-view stops the poll (the last good
            // listings stay on screen).
            if (isSessionGone(e)) { gone = true; return; }
            // A directory that vanished since the last good listing drops
            // its level (the note row takes over); other transient errors
            // keep the last good listing.
            if (e instanceof RpcError && e.code === "directory-unreadable"
                && (e.details as { path?: string } | undefined)?.path === p) {
              errs[p] = rpcErrorText(e, t);
            }
            return;
          }
          patch[p] = r.value;
        });
        if (gone) { setSessionGone(true); return; }
        if (Object.keys(patch).length === 0 && Object.keys(errs).length === 0) return;
        noteCommits(patch[ROOT_PATH] || Object.values(patch)[0] || null);
        setLevels((prev) => {
          let out = prev;
          for (const p of Object.keys(patch)) {
            if (out[p]) out = Object.assign({}, out, { [p]: patch[p]! });
          }
          for (const p of Object.keys(errs)) {
            if (out[p]) { out = Object.assign({}, out); delete out[p]; }
          }
          return out;
        });
        if (Object.keys(errs).length > 0) setLevelErr((prev) => Object.assign({}, prev, errs));
      });
    }, 5000);
    return () => { pollSeqRef.current++; clearInterval(iv); }; // invalidate in-flight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey, vcsOk, sessionGone]);

  React.useEffect(() => {
    if (pendingSelRef.current) return; // do not clobber the not-yet-applied restored selection
    saveState(sessionId, expanded, selectedFile ? selectedFile.path : null, navW, revSel, collapsed, external, selectedExternal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, selectedFile, navW, revSel, collapsed, external, selectedExternal]);

  // The effect applies the divider position to --filez-nav. During an
  // active drag, startDrag writes the var directly (no re-render per
  // pointermove). null (double-click reset) REMOVES the var, so the CSS
  // default applies.
  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (typeof navW === "number") el.style.setProperty("--filez-nav", navW + "px");
    else el.style.removeProperty("--filez-nav");
  }, [navW]);

  // The header's clip mask (the dsh files header's treatment): the effect
  // measures the root-path text against its row and writes the data
  // attribute the mask CSS reads. ResizeObserver is guarded (a test harness
  // without it simply never clips); the title attribute carries the full
  // path.
  React.useEffect(() => {
    const box = pathBoxRef.current, text = pathTextRef.current;
    if (!box || !text) return;
    const measure = () => {
      box.dataset.filesPathClipped = text.scrollWidth > box.clientWidth ? "true" : "false";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(text);
    return () => ro.disconnect();
  }, [rootPath]);

  // Divider drag: pointer capture, rAF-coalesced updates, the width clamps
  // between the nav column's min (220px) and the value that leaves the
  // preview pane its 320px min. The nav column is rightmost, so dragging
  // the divider LEFT grows it (startX - latestX).
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current, divider = e.currentTarget;
    if (!body || !divider || e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dswFiles_dividerActive");
    const startX = e.clientX;
    const parsed = parseFloat(getComputedStyle(body).getPropertyValue("--filez-nav"));
    const startW = isFinite(parsed) && parsed >= 220 ? parsed : 340;
    const minW = 220;
    const maxW = Math.max(minW, body.clientWidth - 16 * 2 - 6 - 320);
    const clamp = (x: number) => Math.max(minW, Math.min(maxW, x));
    let latestX = startX, raf = 0;
    const onMove = (ev: PointerEvent) => {
      latestX = ev.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        body.style.setProperty("--filez-nav", Math.round(clamp(startW + (startX - latestX))) + "px");
      });
    };
    const finish = (ev: PointerEvent) => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      try { divider.releasePointerCapture(ev.pointerId); } catch (err) { /* already released */ }
      divider.classList.remove("dswFiles_dividerActive");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      setNavW(Math.round(clamp(startW + (startX - ev.clientX))));
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
  };

  const count = levels[ROOT_PATH] && levels[ROOT_PATH].entries ? levels[ROOT_PATH].entries.length : 0;
  const selStatus = selectedFile && activeChanges ? activeChanges.find((e) => e.path === selectedFile.path) || null : null;
  const changeByPath = activeChanges ? new Map(activeChanges.map((e) => [e.path, e])) : null;
  const statusLineEl = vcsInfo ? <div className="dswFiles_statusLine">
      <select
        className="dswFiles_statusSelect"
        value={revLive || "worktree"}
        aria-label={t("files.selectCommit")}
        onChange={(e) => { const v = e.target.value; setRevSel(v === "worktree" ? null : v); }}
      >
        <option key="worktree" value="worktree">
          {/* Git: the worktree row is labeled by ROLE ALONE. The tree sits
              ON HEAD, so a repeat of HEAD's id + subject duplicates the
              HEAD commit row that follows (identity lives once, on the
              commit, the gitk/JetBrains convention). jj keeps the @ marker
              + id: its worktree is its own change, so no collision is
              possible. */}
          {vcsInfo.backend === "git"
            ? t("files.worktreeRow")
            // jj: the worktree row mirrors `jj status`'s working-copy line,
            // (empty) when @ has no changes, (no description set) when undescribed.
            : vcsInfo.head!.marker + " " + jjRowLabel(vcsInfo.head!.id, {
                empty: !Array.isArray(vcsInfo.changes) || vcsInfo.changes.length === 0,
                description: vcsInfo.head!.description,
              }, t)}
        </option>
        {commits.map((c, i) => (
          <option key={c.id} value={c.id}>
            {/* The HEAD badge belongs on the commit row: for git the
                newest-listed commit IS HEAD (newest-first, HEAD included). */}
            {(vcsInfo.backend === "git"
              ? c.id + (c.description ? " " + c.description : "")
              : jjRowLabel(c.id, c, t))
            + (vcsInfo.backend === "git" && i === 0 && c.id === vcsInfo.head!.id
                ? " (" + vcsInfo.head!.marker + ")" : "")}
          </option>
        ))}
      </select>
      {snapshotMode
        ? <div className="dswFiles_statusCount" title={t("files.snapshotOf") + " " + revLive}>
            {t("files.snapshotOf") + " " + revLive
            + (commitChanges && commitChanges.length
                ? "  ·  " + statusAggregate({ ok: true, changes: commitChanges, conflicts: [] }, t)
                : "")}
          </div>
        : <div className="dswFiles_statusCount">{statusAggregate(vcsInfo, t)}</div>}
    </div>
    : null;

  // A directory row toggles its level; a file row selects. Re-expanding a
  // directory that has a cached fetch error clears the error so the fetch
  // effect retries (the note row stands for the current attempt only).
  const toggleDir = (path: string) => {
    setExpanded((prev) => prev.includes(path) ? prev.filter((p) => p !== path) : [ROOT_PATH, ...prev, path]);
    setLevelErr((prev) => { if (prev[path] === undefined) return prev; const n = Object.assign({}, prev); delete n[path]; return n; });
  };
  const pick = (entry: DirEntry) => {
    // The selections are mutually exclusive: a tree pick un-pins the pane
    // from the External section.
    if (!entry.isDirectory) { setSelectedFile(entry); setSelectedExternal(null); setLineTarget(null); return; }
    toggleDir(entry.path);
  };
  // The path-edit field opens prefilled with the selected file's parent
  // directory (the workspace root when nothing is selected); the separator
  // follows the workspace root's own convention.
  const startEdit = () => {
    const base = selectedFile ? parentPathOf(selectedFile.path) : ROOT_PATH;
    const sep = (rootPath || "").indexOf("\\") >= 0 ? "\\" : "/";
    setDraft(base && !/[/\\]$/.test(base) ? base + sep : base);
    setEditing(true);
  };
  // A path jump EXPANDS the typed path's ancestor chain (it never replaces
  // the view). If the parent's listing is already ready and the target is a
  // file it is selected at once; otherwise the pending-selection effect
  // applies it once the containing directory is ready.
  const commitEdit = () => {
    setEditing(false);
    const text = draft.trim().replace(/\\/g, "/").replace(/[/]+$/, "");
    if (text === "") return;
    setExpanded((prev) => {
      const next = [...prev];
      for (const p of expandedFromPath(text)) if (!next.includes(p)) next.push(p);
      return next;
    });
    setLineTarget(null);
    const par = parentPathOf(text);
    const listing = levels[par];
    if (listing) {
      const e = (listing.entries || []).find((en) => en.path === text);
      if (e && !e.isDirectory) { pendingSelRef.current = null; setSelectedFile(e); setSelectedExternal(null); return; }
    }
    pendingSelRef.current = text;
    setSelectedFile(null);
  };
  // The reload button clears the level cache and latched dead-session flag
  // so a retry can re-resolve the session (a fresh one may have come up).
  const reload = () => { forceRef.current = true; setSessionGone(false); setLevels({}); setLevelErr({}); };
  const toggleHidden = () => { setLevels({}); setLevelErr({}); setShowHidden((v) => !v); };

  // The rows in render order (the keyboard nav's index space): an expanded
  // directory's children follow it immediately.
  const visibleRows: DirEntry[] = [];
  {
    const walk = (p: string) => {
      const listing = levels[p];
      if (!listing) return;
      for (const e of orderEntries(listing.entries || [])) {
        visibleRows.push(e);
        if (e.isDirectory && expandedSet.has(e.path)) walk(e.path);
      }
    };
    walk(ROOT_PATH);
  }
  const firstRowPath = visibleRows.length > 0 ? visibleRows[0]!.path : null;
  // A focusPath that no longer points at a visible row (a listing swap,
  // an external collapse) is treated as "not focused" for the tab-stop
  // fallback — otherwise no row would be a tab stop at all.
  const focusValid = focusPath !== null && visibleRows.some((r) => r.path === focusPath);

  // A tree mutation (expand/collapse, a listing swap) unmounts or
  // re-renders the focused row and drops DOM focus to <body>. The code hands
  // focus back if the keyboard was in the list — in place when the row
  // re-rendered under us, otherwise to the selected file's row (or the
  // first). Mouse users never set the flag, nothing is stolen.
  React.useEffect(() => {
    if (!listHadFocusRef.current) return;
    if (focusPath !== null && visibleRows.some((r) => r.path === focusPath)) {
      rowRefByPath.current[focusPath]?.focus();
      return;
    }
    const next = selectedFile && visibleRows.some((r) => r.path === selectedFile.path)
      ? selectedFile.path : firstRowPath;
    setFocusPath(next);
    if (next !== null) rowRefByPath.current[next]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels, expanded, selectedFile, focusPath]);
  // Keyboard nav: ↑/↓/Home/End move the roving focus, → expands a collapsed
  // directory, ← collapses one (or moves to its parent), Enter/Space
  // activate via the native button click (pick). The input guard also covers
  // the path-edit field in case it ever lives inside this subtree.
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    const rows = visibleRows;
    if (rows.length === 0) return;
    const idx = focusPath ? rows.findIndex((r) => r.path === focusPath) : -1;
    const target = listNavTarget(e.key, idx >= 0 ? idx : 0, rows.length);
    if (target !== null) {
      e.preventDefault();
      const p = rows[target]!.path;
      setFocusPath(p);
      rowRefByPath.current[p]?.focus();
      return;
    }
    const cur = idx >= 0 ? rows[idx] : null;
    if (cur && cur.isDirectory) {
      if (e.key === "ArrowRight" && !expandedSet.has(cur.path)) {
        e.preventDefault();
        toggleDir(cur.path);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (expandedSet.has(cur.path)) toggleDir(cur.path);
        else {
          // A top-level directory's parent is the workspace root, which has
          // no row of its own (it is the header) — a no-op there.
          const par = parentPathOf(cur.path);
          if (par !== ROOT_PATH) { setFocusPath(par); rowRefByPath.current[par]?.focus(); }
        }
      }
    }
  };

  // One directory's level: its failed note, its loading note, its empty
  // note, or its ordered entries (plus the truncated note when the host
  // clipped the listing).
  const renderLevel = (p: string): React.ReactNode => {
    if (levelErr[p] !== undefined) {
      return <li className="dswFiles_note dswFiles_noteErr" data-files-row="error">{levelErr[p]}</li>;
    }
    const listing = levels[p];
    if (!listing) {
      return <li className="dswFiles_note" data-files-row="loading">{t("files.loading")}</li>;
    }
    const entries = listing.entries || [];
    if (entries.length === 0) {
      return <li className="dswFiles_note" data-files-row="empty">{t("files.empty")}</li>;
    }
    return [
      orderEntries(entries).map(renderEntry),
      listing.truncated
        ? <li key="truncated" className="dswFiles_note" data-files-row="truncated">{t("files.truncated")}</li>
        : null,
    ];
  };

  const renderEntry = (entry: DirEntry): React.ReactElement => {
    const isDir = entry.isDirectory;
    const isExpanded = isDir && expandedSet.has(entry.path);
    const isSelectedFile = !isDir && !!selectedFile && selectedFile.path === entry.path;
    const change = !isDir && changeByPath ? changeByPath.get(entry.path) || null : null;
    const rollup = isDir
      ? rollupFor(activeChanges ? { ok: true, changes: activeChanges, conflicts: [] } : null, entry.path)
      : null;
    // The name's font cue (the VS Code treatment, so the letter is never
    // the only signal): M semibold, A/U/R italic, D faded + struck.
    const cue = !isDir && change
      ? change.status === "M" ? " dswFiles_nameM"
        : change.status === "D" ? " dswFiles_nameD"
        : change.status === "A" || change.status === "U" || change.status === "R" ? " dswFiles_nameAU"
        : ""
      : "";
    // File meta (size · relative age, files only, null for dirs and for the
    // stat-less snapshot listings): the row's title carries the full detail
    // (exact size + the calendar timestamp), not a visible column.
    const meta = fileRowMeta(entry, t);
    const rowTitle = (meta ? meta.title : entry.path) + (change ? " — " + change.status : "");
    // Directory rows keep a folder glyph (open/closed, the dsh treatment).
    // File rows carry the ui-primitives file-type icon when the package is
    // present; the invisible 16px spacer keeps the names aligned with the
    // folder names otherwise.
    const icon = isDir
      ? Icon(isExpanded ? "IconFolderOpen16" : "IconFolderClose16", { className: "dswFiles_rowIcon" }, isExpanded ? "▣" : "▢")
      : (fileTypeIconOf(entry.name) || <span className="dswFiles_rowIconSpacer" aria-hidden="true" />);
    // The change letter (GitHub placement: icon, letter, name) reuses the
    // badge colors; unchanged files render no letter (no slot, so the name
    // sits where an unchanged directory's name would).
    const letter = isDir || !change ? null
      : <span className={"dswFiles_badge dswFiles_badge" + change.status} aria-hidden="true">{change.status}</span>;
    return <li key={entry.path} className="dswFiles_item" data-files-entry={isDir ? "directory" : "file"} data-files-path={entry.path}>
      <button
        ref={(el) => { rowRefByPath.current[entry.path] = el; }}
        type="button"
        // Roving tabindex: only the focused row is a tab stop (or the first
        // row when nothing is focused yet). The tab key enters the list once
        // instead of stop-hopping every row; arrows move from there.
        tabIndex={focusPath === entry.path || (!focusValid && entry.path === firstRowPath) ? 0 : -1}
        onFocus={() => { listHadFocusRef.current = true; setFocusPath(entry.path); }}
        aria-expanded={isDir ? isExpanded : undefined}
        aria-current={isSelectedFile ? "true" : undefined}
        className={isSelectedFile ? "dswFiles_row dswFiles_rowSelected" : "dswFiles_row"}
        onClick={() => pick(entry)}
        title={rowTitle}
      >
        {icon}
        {letter}
        <span className={"dswFiles_name" + cue}>{entry.name}</span>
        {isDir ? rollupSlot(rollup, t) : null}
      </button>
      {isDir && isExpanded
        ? <ul className="dswFiles_level">{renderLevel(entry.path)}</ul>
        : null}
    </li>;
  };

  // The nav column's header: the root path row and the header controls. It
  // is chrome of the NAV COLUMN, so it lives inside the browse pane and
  // unmounts with it when the nav is collapsed — which is why the collapse
  // control (the state pair's HIDE button, ») lives here at the edge it
  // collapses, and the RESTORE control («) lives in the view bar, which is
  // the still-visible region then (present while a file is viewed, which the
  // collapse invariant guarantees). The root path (the dsh files header's
  // text): the directory part dimmed, the final segment full ink; the pane
  // title before the first listing. The clip mask's data attribute is
  // written by the effect above; the title carries the full path.
  const pathParts = rootPath ? pathPartsOf(rootPath) : null;
  const pathRow = editing
    ? <input
        className="dswFiles_pathInput"
        value={draft}
        autoFocus
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); else if (e.key === "Escape") setEditing(false); }}
        onBlur={() => setEditing(false)}
      />
    : <div className="dswFiles_path" data-files-path title={rootPath || undefined} ref={pathBoxRef}>
        <span className="dswFiles_pathText" ref={pathTextRef}>
          {pathParts
            ? <><span className="dswFiles_pathDirectory">{pathParts.directory}</span><span className="dswFiles_pathName">{pathParts.name}</span></>
            : <span className="dswFiles_pathDirectory">{t("view.files")}</span>}
        </span>
      </div>;
  const navHeader = <div className="dswFiles_header">
      {pathRow}
      <button type="button" className="dswFiles_tool" onClick={startEdit} aria-label="edit path" title="edit path">
        {Icon("IconEditOutline16", { size: 14 }, "✎")}
      </button>
      <button type="button" className="dswFiles_tool" onClick={reload} aria-label={t("files.reload")} title={t("files.reload")}>
        {Icon("IconRefreshOutline16", { size: 15 }, "⟳")}
      </button>
      {/* The state pair's HIDE control: the nav's own collapse button, at
          the edge it collapses. Unmounts with the nav; the view bar's
          restore button is its other half. Same styling as the restore
          button so the pair reads as one control across states. */}
      <button
        type="button"
        className="dswFiles_navToggle"
        onClick={() => setCollapsed(true)}
        aria-label={t("files.hideNav")}
        title={t("files.hideNav")}
        aria-expanded="true"
        aria-controls={navId}
      >
        <NavChevron dir="right" size={14} />
      </button>
    </div>;

  // A latched dead session shows the calm notice regardless of any stale
  // cached listing: the list can no longer refresh, so it is not shown.
  // Per-directory loading/empty/failed states live in the tree itself (the
  // note rows), so there is no pane-level loading/error state.
  // An External row: the basename in full ink, the directory part dimmed
  // and clipped, the title carrying the whole absolute path.
  const externalRow = (path: string): React.ReactElement => {
    const { directory, name } = pathPartsOf(path);
    const sel = selectedExternal === path;
    return <li key={path} className="dswFiles_item" data-files-entry="external" data-files-path={path}>
      <button
        type="button"
        aria-current={sel ? "true" : undefined}
        className={sel ? "dswFiles_row dswFiles_rowSelected" : "dswFiles_row"}
        onClick={() => { setSelectedFile(null); setSelectedExternal(path); setLineTarget(null); }}
        title={path}
      >
        {fileTypeIconOf(name) || <span className="dswFiles_rowIconSpacer" aria-hidden="true" />}
        <span className="dswFiles_name">{name}</span>
        <span className="dswFiles_extDir">{directory}</span>
      </button>
    </li>;
  };
  // The External section: the pinned out-of-workspace files, a pinned
  // flex:none band between the tree and the pane's bottom edge (zero space
  // when empty and no prompt is active). The list self-caps (max-height +
  // its own scroll) so a long pin set can never starve the tree. The manual
  // open prompt swaps into the head; the footer's "Open file…" button is the
  // trigger that works while the section is still empty.
  const externalSection = (external.length > 0 || extOpenPrompt)
    ? <div className="dswFiles_extSection">
        <div className="dswFiles_extHead">
          <span className="dswFiles_extTitle">{t("files.external")}</span>
          {extOpenPrompt
            ? <input
                className="dswFiles_extInput"
                value={extPrompt}
                autoFocus
                spellCheck={false}
                placeholder={t("files.externalPlaceholder")}
                onChange={(e) => setExtPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitExternalOpen();
                  else if (e.key === "Escape") { setExtOpenPrompt(false); setExtPrompt(""); setExtErr(null); }
                }}
                onBlur={() => { setExtOpenPrompt(false); setExtPrompt(""); setExtErr(null); }}
              />
            : external.length > 0
              ? <button type="button" className="dswFiles_extAdd" title={t("files.openFile")} aria-label={t("files.openFile")}
                  onClick={() => setExtOpenPrompt(true)}>
                  {Icon("IconPlus16", { size: 14 }, "+")}
                </button>
              : null}
        </div>
        {extErr ? <div className="dswFiles_note dswFiles_noteErr" data-files-ext-err>{extErr}</div> : null}
        {external.length > 0
          ? <ul className="dswFiles_extList" role="list">{external.map(externalRow)}</ul>
          : null}
      </div>
    : null;

  const browsePane = sessionGone
    ? <div className="dswFiles_browsePane" id={navId}>
        {navHeader}
        <div className="dswFiles_error">{t("files.sessionGone")}</div>
      </div>
    : <div className="dswFiles_browsePane" id={navId}>
        {navHeader}
        {statusLineEl}
        <div className="dswFiles_tree" role="list" ref={navScrollRef} onKeyDown={onTreeKeyDown}
          // Focus LEFT the list (Tab to the dropdown/preview): the handler
          // clears the flag so the next nav does not drag focus back.
          onBlur={(e) => { const rt = e.relatedTarget as Node | null; if (rt && !(e.currentTarget as Node).contains(rt)) listHadFocusRef.current = false; }}>
          <ul className="dswFiles_level">{renderLevel(ROOT_PATH)}</ul>
        </div>
        {externalSection}
      </div>;

  // The collapsed preference takes effect only while a file is viewed (or one
  // is still pending apply, so a restored session hides from the first render
  // without a flash): with nothing to show in the view pane, the nav column
  // is the only way to pick a file, so it stays expanded.
  const navHidden = collapsed && (selectedFile !== null || selectedExternal !== null || pendingSelRef.current !== null);

  // Restore the nav column's scroll position (the tree renders from the cached
  // listings) and keep tracking it. Re-runs when the nav column appears or
  // disappears so the listener re-attaches to the freshly rendered scroll
  // element; while hidden the ref is null and this is a no-op.
  React.useEffect(() => {
    const el = navScrollRef.current;
    if (!el) return;
    const cached = navCacheGet(sessionId)?.navScroll ?? 0;
    if (cached > 0) el.scrollTop = cached;
    const onScroll = () => navCacheSet(sessionId, { navScroll: el.scrollTop });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId, navHidden]);

  return <div className="dswFiles_root">
    <div className={"dswFiles_body" + (navHidden ? " dswFiles_bodyNavHidden" : "")} ref={bodyRef}>
      <div className="dswFiles_previewPane" role="region" aria-label={t("files.preview")} aria-live="polite">
        {/* The External selection renders in the same pane, keyed by its
            ABSOLUTE path: no status, no rev, no changeset (it lives outside
            the workspace, so the pane offers view/preview only). */}
        <PreviewPane
          name={selectedExternal ? pathPartsOf(selectedExternal).name : selectedFile ? selectedFile.name : null}
          relPath={selectedExternal ? null : selectedFile ? selectedFile.path : null}
          absPath={selectedExternal || null}
          // Every listing carries the host's absolute workspace root — the
          // source for the loopback-only "copy path" action (BUG-006).
          wsRoot={rootPath}
          openCapable={openCapable}
          status={selectedExternal ? null : selStatus}
          base={selectedExternal ? "worktree" : (revLive || "worktree")}
          rev={selectedExternal ? null : revLive}
          // The commit's changeset is known once any listing loads
          // (then an absent entry = the commit never touched the file).
          changesetKnown={selectedExternal ? false : (!snapshotMode || !!refListing)}
          readAt={props.readAt}
          readAtAbs={props.readAtAbs ?? null}
          notice={extNotice}
          fetchDiff={props.fetchDiff}
          readMermaid={props.readMermaid}
          t={t}
          useInput={props.useInput ?? null}
          inputActions={props.inputActions ?? null}
          navCollapsed={navHidden}
          onToggleNav={() => setCollapsed(!collapsed)}
          navId={navId}
          lineTarget={lineTarget}
        />
      </div>
      {navHidden ? null : <div
        className="dswFiles_divider"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("files.resizePanels")}
        onPointerDown={startDrag}
        onDoubleClick={() => setNavW(null)}
      />}
      {navHidden ? null : browsePane}
    </div>
    <div className="dswFiles_footerBar">
      <button
        type="button"
        className={showHidden ? "dswFiles_showHiddenToggle dswFiles_showHiddenToggleActive" : "dswFiles_showHiddenToggle"}
        onClick={toggleHidden}
      >{t("files.showHidden")}</button>
      <span className="dswFiles_status">{count + " " + t("files.items")}</span>
      <div className="dswFiles_footerGap" />
      {/* Manual External open: the prompt lives in the nav pane, so a click
          while the nav is collapsed re-expands it with the prompt open. */}
      <button
        type="button"
        className="dswFiles_footerAction"
        onClick={() => { if (navHidden) setCollapsed(false); setExtOpenPrompt(true); setExtErr(null); }}
      >{t("files.openFile")}</button>
      <button type="button" className="dswFiles_footerAction" onClick={reload}>
        {[Icon("IconRefreshOutline16", { size: 16 }, "⟳"), " " + t("files.reload")]}
      </button>
    </div>
  </div>;
}

// ── Right column: the dsh sidebar-right takeover ───────────────────────────
// filestab replaces the BUILTIN `files` tab type in the right column. The
// registration takes the extension band — the documented way a type outside
// the product claims a builtin's kind: the claims, the guide, and the body
// and title seats (which the seat finds under THIS definition's id) go to
// filestab until it unregisters, and the builtin resumes if it disappears.
// The guide carries a SINGLE entry, so the column's first seed lands on the
// files page directly (defaultSeed: the sole entry), not on a guide chain.
//
// The builtin's one-tab-per-file behavior does NOT carry over: a
// `dsh-resource://file/…` open (a chat file chip, a "Files changed" row) is
// claimed by the patterns below, and its body is TRANSIENT — it re-opens the
// page with {path, line} navigation params (the page tab dedupes within its
// pane, so the single view is revealed and navigated) and then closes itself.
const FILESTAB_TAB_ID = "filestab";
const FILES_KIND = "files";
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

interface ParsedFileAddress {
  scope: "session";
  sessionId: string;
  path: string;
}
// Read a file address back into its parts. Only the SESSION-scoped shape is
// usable here — the right column is per-session, so an `absolute` address is
// not one this type can browse. Segments are decoded, mirroring how the
// address was built; a malformed address is simply not this type's.
function parseFileAddress(address: string): ParsedFileAddress | null {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return null;
  try {
    const end = address.search(/[?#]/);
    const parts = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split("/");
    if (parts[0] !== "session") return null;
    const id = parts[1];
    const segments = parts.slice(2);
    if (!id || segments.length === 0) return null;
    return { scope: "session", sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join("/") };
  } catch { return null; }
}
function fileAddressBasename(address: string): string {
  const name = address.slice(address.lastIndexOf("/") + 1);
  if (name === "") return address;
  try { return decodeURIComponent(name); } catch { return name; }
}

// The tab information hook the right-column slot framework binds: the live
// record of the tab this body occurrence draws.
interface RightTabRecord {
  contentId: string;
  navigation: { address: string; params: unknown; revision: number };
  signal: AbortSignal;
  actions: {
    openTab(kind: string, options?: { params?: unknown }): void;
    openResource(address: string, options?: { params?: unknown }): void;
    close(): void;
  };
}
type UseTabInfo = () => { tab: RightTabRecord };

// The guide capsule's glyph: the primitives' colored folder sheet (the
// builtin's own choice), read lazily so a bundle without the package still
// registers the type (the guide draws its cube placeholder then).
const FolderGuideGlyph: React.ComponentType<{ size?: number; className?: string }> = (props) => {
  const F = P ? (P.FileTypeIcon as unknown) : null;
  if (typeof F !== "function") return null;
  return React.createElement(F as React.ComponentType<{ kind: string; size?: number; className?: string }>,
    { kind: "folder", size: props.size || 16, className: props.className });
};

interface RightPaneBodyProps {
  useTabInfo: UseTabInfo;
  sessionId: string | null;
  listDirectory: (relPath: string, signal: AbortSignal, showHidden: boolean, force: boolean, rev: string | null) => Promise<Listing>;
  fetchDiff: (relPath: string, base: string, signal: AbortSignal, opts?: { noBinary?: boolean }) => Promise<DiffResponse>;
  readAt: (relPath: string, rev: string, signal: AbortSignal) => Promise<FileShowValue>;
  readAtAbs: (path: string, signal: AbortSignal) => Promise<FileShowValue>;
  readMermaid: () => Promise<{ text: string }>;
  t: TFunc;
}

// One tab of the `files` type. The page (`sidebar://files`) IS the single
// files view: every file open in the column lands here as a navigation with
// {path, line} params. A resource address is the transient frame: it
// redirects into the page and closes itself, rendering nothing meanwhile.
function RightPaneBody(props: RightPaneBodyProps) {
  const { tab } = props.useTabInfo();
  const file = parseFileAddress(tab.navigation.address);
  // Redirect only a resource open of THIS session's files: the page's face is
  // bound to the slot's session, and a cross-session address would read the
  // wrong workspace (chat chips carry their own session's files, so the
  // mismatch is not expected to occur).
  const redirectKey = file !== null && file.sessionId === props.sessionId ? tab.navigation.revision : null;
  const redirectedRef = React.useRef<number | null>(null);
  const params = (tab.navigation.params && typeof tab.navigation.params === "object"
    ? tab.navigation.params : null) as { path?: unknown; line?: unknown } | null;
  const openRequest = React.useMemo(() => {
    if (redirectKey !== null) {
      // The resource frame: derive the open from the resource address itself
      // (the page's params carry the same value after the redirect). Rendering
      // the view here — restored from the nav cache — keeps the pane from
      // flashing blank while the redirect settles.
      const line = params && typeof params.line === "number" ? params.line : undefined;
      return { path: file!.path, ...(line !== undefined ? { line } : {}), revision: tab.navigation.revision };
    }
    if (!params || typeof params.path !== "string") return null;
    return { path: params.path, ...(typeof params.line === "number" ? { line: params.line } : {}), revision: tab.navigation.revision };
  }, [redirectKey, file, params, tab.navigation.revision]);
  React.useEffect(() => {
    if (redirectKey === null || redirectedRef.current === redirectKey) return;
    redirectedRef.current = redirectKey;
    const line = params && typeof params.line === "number" ? params.line : undefined;
    tab.actions.openTab(FILES_KIND, { params: { path: file!.path, ...(line !== undefined ? { line } : {}) } });
    tab.actions.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirectKey]);
  return <FilesView
    sessionId={props.sessionId}
    listDirectory={props.listDirectory}
    fetchDiff={props.fetchDiff}
    readAt={props.readAt}
    readAtAbs={props.readAtAbs}
    readMermaid={props.readMermaid}
    t={props.t}
    openRequest={openRequest}
  />;
}

// A minimal structural view of the cordis client context. The real types
// live in @deepseek-ai/dsh-client-runtime, which the web shell resolves at
// runtime (not a filestab build dependency).
interface FilestabLocale {
  register(ns: string, dicts: Record<string, Record<string, string>>): void;
  bind(ns: string): TFunc;
}
interface FilestabConnection {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> };
}
interface FilestabSlots {
  inject(name: string, cb: () => unknown): void;
  register(meta: Record<string, unknown>, component: unknown): void;
}
interface FilestabSidebarRightTabs {
  register(def: Record<string, unknown>): () => void;
}
interface FilestabContext {
  effect(execute: () => unknown, label?: string): void;
  locale: FilestabLocale;
  connection: FilestabConnection;
  slots: FilestabSlots;
  /** The right column's tab-type registry (dsh 0.1.5+). Present: the column
      is the Files surface and filestab mounts only its right-column page
      (the conversation Files tab is not registered). Absent on a host
      without the column's tab system: the conversation tab alone remains. */
  sidebarRightTabs?: FilestabSidebarRightTabs;
}

function apply(ctx: FilestabContext): void {
  injectCss();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-files: dictionaries");
  const t = ctx.locale.bind(NS);
  const connection = ctx.connection;
  // The browse face, bound to one session id: every RPC payload carries it,
  // and the host containment-checks every path against that session's
  // workspace. The conversation tab (pre-0.1.5 hosts) and the right-column
  // page (0.1.5+ hosts) share it — exactly one of the two is mounted.
  const browseFace = (sessionId: string | null) => ({
    sessionId,
    listDirectory: (relPath: string, signal: AbortSignal, showHidden: boolean, force: boolean, rev: string | null) =>
      connection.rpc.call(BROWSE_CHANNEL, "list", { sessionId, relPath, showHidden, force: force === true, ...(rev ? { rev } : {}) }, signal)
        .then((v) => unwrap<Listing>(v)),
    fetchDiff: (relPath: string, base: string, signal: AbortSignal, opts?: { noBinary?: boolean }) =>
      connection.rpc.call(BROWSE_CHANNEL, "diff", { sessionId, relPath, base, ...(opts && opts.noBinary ? { noBinary: true } : {}) }, signal)
        .then((v) => unwrap<DiffResponse>(v)),
    // File preview: fileshow rev "worktree" reads the live file. A
    // change/commit id reads the bytes at that revision.
    readAt: (relPath: string, rev: string, signal: AbortSignal) =>
      connection.rpc.call(BROWSE_CHANNEL, "fileshow", { sessionId, relPath, rev }, signal)
        .then((v) => unwrap<FileShowValue>(v)),
    // The External section's read: a LIVE file by ABSOLUTE path, outside the
    // workspace (fileshow-abs — the session is the scope, no containment).
    readAtAbs: (path: string, signal: AbortSignal) =>
      connection.rpc.call(BROWSE_CHANNEL, "fileshow-abs", { sessionId, path }, signal)
        .then((v) => unwrap<FileShowValue>(v)),
    // The vendored mermaid renderer bundle. The host serves the
    // package-local dist/mermaid.min.js as text. The client inlines it
    // into the sandbox iframe's srcdoc.
    readMermaid: () =>
      connection.rpc.call(BROWSE_CHANNEL, "mermaid", { sessionId }, undefined)
        .then((v) => unwrap<{ text: string }>(v)),
    t,
  });
  // The conversation Files tab — the surface on hosts without the right
  // column (pre-0.1.5). On 0.1.5+ the column is the Files surface (below),
  // so the tab stays unregistered and only one Files view exists.
  if (!ctx.sidebarRightTabs) {
    ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "files",
      order: 20,
      locale: NS,
      label: () => t("view.files"),
      inject: (sessionId: string | null) => browseFace(sessionId),
    }, FilesView));
  }
  // The right-column takeover (see the section note above): register the
  // type, then the keyed body that serves every tab of the kind.
  if (ctx.sidebarRightTabs) {
    ctx.effect(() => ctx.sidebarRightTabs!.register({
      id: FILESTAB_TAB_ID,
      kind: FILES_KIND,
      patterns: ["dsh-resource://file/**"],
      priority: "extension",
      canOpen: (address: string) => parseFileAddress(address) !== null,
      title: (address: string) => parseFileAddress(address) ? fileAddressBasename(address) : t("view.workspace"),
      guide: [{
        order: 10,
        title: () => t("files.guideTitle"),
        description: () => t("files.guideDescription"),
        icon: FolderGuideGlyph,
      }],
    }), "ui-files: right column type");
    ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
      name: "sidebar.right.pane.tab",
      key: FILESTAB_TAB_ID,
      locale: NS,
      inject: (sessionId: string | null) => browseFace(sessionId),
    }, RightPaneBody)), "ui-files: right column body");
  }
}

export const inject: string[] = ["slots", "locale", "connection", "sidebarRightTabs"];
export const name = "filestab";
export { apply };
// Test-only seam. The cordis loader ignores it (it reads apply/inject/name
// only). This export exposes the pure preview helpers so
// test/client.test.mjs can unit-test them.
export const __test = { renderMarkdown, renderMarkdownWithImages, markdownImageSrcs, isLocalDocImageSrc, resolveDocImage, rewriteMarkdownImages, highlightSource, buildMermaidDoc, typeLabel, formatBytes, formatAge, fileRowMeta, loadState, saveState, segmentsForPath, orderEntries, parseDiff, displayRows, gapAfter, statusAggregate, jjRowLabel, rollupFor, rollupLabel, rollupSlot, DiffView, unifiedCells, unifiedPairs, intraLineDiff, intraTokens, realPathOf, renderKindOf, resolvePaneMode, paneToggleModes, previewContentFor, listNavTarget, unwrap, isSessionGone, rpcErrorText, isLoopbackOrigin, absolutePathOf, toAbsoluteCandidate, hostEnvelope, parseHostResponse, hostApi, hostDescribe, hostOpenPath, HostMethodAbsent, canOfferOpenLocal, buildFileRef, mentionOf, lineStartsOf, lineOfOffset, REF_TEXT_MAX, scrollToTextLine, parseFileAddress, fileAddressBasename, diffLayoutNarrow, RightPaneBody, PreviewPane };
