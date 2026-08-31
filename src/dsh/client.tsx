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
  "view.files": "文件", "files.showHidden": "显示隐藏文件", "files.items": "个项目",
  "files.reload": "重新加载", "files.loading": "加载中…", "files.empty": "（空）", "files.fetchStuck": "目录请求未完成 —— 请点“重新加载”",
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
  "files.collapseNav": "隐藏文件列表", "files.expandNav": "显示文件列表",
  "files.type.png": "PNG 图像", "files.type.jpeg": "JPEG 图像", "files.type.gif": "GIF 图像",
  "files.type.bmp": "BMP 图像", "files.type.webp": "WebP 图像", "files.type.svg": "SVG 图像",
  "files.type.avif": "AVIF 图像", "files.type.icon": "图标",
  "files.type.pdf": "PDF 文档", "files.type.zip": "ZIP 压缩包", "files.type.gzip": "GZIP 文件",
  "files.type.elf": "ELF 二进制文件", "files.type.binary": "二进制文件", "files.type.markdown": "Markdown",
  "files.type.mp3": "MP3 音频", "files.type.wav": "WAV 音频", "files.type.avi": "AVI 视频",
  "files.pdfFrameTitle": "PDF 预览", "files.htmlFrameTitle": "HTML 预览",
  "files.mermaidFrameTitle": "mermaid 图表", "files.renderFailed": "渲染失败：",
};
const en: Record<string, string> = {
  "view.files": "Files", "files.showHidden": "Show hidden files", "files.items": "items",
  "files.reload": "Reload", "files.loading": "Loading…", "files.empty": "(empty)", "files.fetchStuck": "the list request did not complete — press Reload",
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
  "files.collapseNav": "Hide file list", "files.expandNav": "Show file list",
  "files.type.png": "PNG image", "files.type.jpeg": "JPEG image", "files.type.gif": "GIF image",
  "files.type.bmp": "BMP image", "files.type.webp": "WebP image", "files.type.svg": "SVG image",
  "files.type.avif": "AVIF image", "files.type.icon": "icon",
  "files.type.pdf": "PDF document", "files.type.zip": "ZIP archive", "files.type.gzip": "GZIP file",
  "files.type.elf": "ELF binary", "files.type.binary": "binary file", "files.type.markdown": "Markdown",
  "files.type.mp3": "MP3 audio", "files.type.wav": "WAV audio", "files.type.avi": "AVI video",
  "files.pdfFrameTitle": "PDF preview", "files.htmlFrameTitle": "HTML preview",
  "files.mermaidFrameTitle": "mermaid diagram", "files.renderFailed": "Render failed:",
};

// CSS adapted from dsh-client-ui-directory-picker-browse, re-prefixed to dswFiles_.
const css = [
  ".dswFiles_root{display:flex;flex-direction:column;height:100%;min-height:0}",
  ".dswFiles_header{border-bottom:1px solid var(--dsw-alias-border-l3);flex-direction:row;flex:none;align-items:center;gap:8px;padding:12px 14px 8px 16px;display:flex}",
  // Left-pane collapse toggle. The button lives in the header (not the
  // browse pane) because it must stay reachable WHILE the pane is hidden.
  ".dswFiles_collapseBtn{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;align-items:center;padding:2px 4px;display:inline-flex}",
  ".dswFiles_collapseBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
  ".dswFiles_crumbBar{box-sizing:border-box;border:1px solid #0000;border-radius:8px;align-items:center;gap:4px;min-height:24px;margin-left:-6px;padding:0 8px;display:flex;flex-wrap:wrap}",
  ".dswFiles_crumbBar:has(.dswFiles_crumbEditZone:enabled:hover),.dswFiles_crumbBar:has(.dswFiles_crumbEditZone:focus-visible),.dswFiles_crumbBar:has(.dswFiles_pathInput){border-color:var(--dsw-alias-border-l2)}",
  ".dswFiles_crumbTrail{scrollbar-width:none;flex:0 auto;align-items:center;gap:4px;min-width:0;display:flex;overflow-x:auto}",
  ".dswFiles_crumbSeat{flex:none;align-items:center;gap:4px;min-width:0;display:inline-flex}",
  ".dswFiles_crumb{text-overflow:ellipsis;white-space:nowrap;max-width:160px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}",
  ".dswFiles_crumb:hover{color:var(--dsw-alias-label-primary)}",
  ".dswFiles_crumb:disabled{color:var(--dsw-alias-label-primary);cursor:default}",
  ".dswFiles_crumbChevron{color:var(--dsw-alias-label-tertiary);flex:none}",
  ".dswFiles_crumbEditZone{cursor:text;background:0 0;border:none;outline:none;flex:0 0 22px;justify-content:flex-end;align-items:center;min-width:22px;height:20px;padding:0;display:flex}",
  ".dswFiles_crumbEditGlyph{color:var(--dsw-alias-label-tertiary);flex:none}",
  ".dswFiles_crumbEditZone:enabled:hover .dswFiles_crumbEditGlyph{color:var(--dsw-alias-label-primary)}",
  ".dswFiles_pathInput{box-sizing:border-box;min-width:0;width:100%;height:20px;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;font-size:13px;line-height:20px;padding:0}",
  // The divider is a DRAGGABLE handle. FilesView writes --filez-left on this
  // element during the drag, with no re-render per pointermove.
  ".dswFiles_body{flex:1 1 0;align-items:stretch;min-height:0;padding:4px 16px 8px 16px;display:flex;--filez-left:340px}",
  ".dswFiles_browsePane{flex-direction:column;flex:0 1 var(--filez-left);gap:2px;min-width:220px;padding-right:8px;display:flex;overflow-y:auto;overflow-x:hidden}",
  ".dswFiles_divider{position:relative;flex:none;width:6px;cursor:col-resize;touch-action:none;user-select:none}",
  ".dswFiles_divider::before{content:'';position:absolute;top:0;bottom:0;left:50%;width:1px;transform:translateX(-50%);background:var(--dsw-alias-border-l3)}",
  ".dswFiles_divider:hover::before,.dswFiles_dividerActive::before{background:var(--dsw-alias-state-business-primary)}",
  ".dswFiles_previewPane{flex-direction:column;flex:1 1 0;min-width:320px;padding-left:8px;display:flex;overflow:auto}",
  ".dswFiles_rowSeat{flex:none;display:flex}",
  ".dswFiles_row{text-align:left;cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;align-items:center;gap:6px;width:100%;height:28px;padding:4px 6px;display:flex}",
  ".dswFiles_row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dswFiles_rowSelected,.dswFiles_rowSelected:hover{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}",
  ".dswFiles_row:disabled{cursor:default;opacity:.7}",
  ".dswFiles_rowIcon{color:var(--dsw-alias-label-secondary);flex:none}",
  ".dswFiles_rowIconSpacer{flex:none;width:16px}",
  ".dswFiles_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);flex:1 1 0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}",
  ".dswFiles_rowChevron{color:var(--dsw-alias-label-tertiary);flex:none}",
  ".dswFiles_status{padding:4px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".dswFiles_previewEmpty{padding:20px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_previewImageWrap{flex:1 1 0;justify-content:center;align-items:center;min-height:0;display:flex;overflow:auto}",
  ".dswFiles_previewImage{max-width:100%;max-height:100%;object-fit:contain;display:block}",
  ".dswFiles_previewPdf{flex:1 1 0;width:100%;min-height:320px;border:none}",
  ".dswFiles_previewText{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:18px;margin:0;padding:8px;overflow:auto}",
  ".dswFiles_previewNote{position:sticky;left:0;padding:4px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_previewCard{padding:16px;display:flex;flex-direction:column;gap:4px}",
  ".dswFiles_previewCardName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;word-break:break-all}",
  ".dswFiles_previewCardMeta{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}",
  ".dswFiles_previewCardHint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}",
  // Markdown preview typography at GitHub's scale (base 16px/1.6), to match
  // the test/md GFM reference. Colors stay on the theme tokens.
  ".dswFiles_previewMarkdown{color:var(--dsw-alias-label-primary);padding:8px;font-size:16px;line-height:1.6;overflow:auto}",
  ".dswFiles_previewMarkdown h1,.dswFiles_previewMarkdown h2,.dswFiles_previewMarkdown h3,.dswFiles_previewMarkdown h4,.dswFiles_previewMarkdown h5,.dswFiles_previewMarkdown h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25}",
  ".dswFiles_previewMarkdown h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid var(--dsw-alias-border-l2)}",
  ".dswFiles_previewMarkdown h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--dsw-alias-border-l2)}",
  ".dswFiles_previewMarkdown h3{font-size:1.25em}",
  ".dswFiles_previewMarkdown h4{font-size:1em}",
  ".dswFiles_previewMarkdown h5{font-size:.875em}",
  ".dswFiles_previewMarkdown h6{font-size:.85em;color:var(--dsw-alias-label-secondary)}",
  ".dswFiles_previewMarkdown p{margin:0 0 16px}",
  ".dswFiles_previewMarkdown strong{font-weight:600}",
  ".dswFiles_previewMarkdown code{background:var(--dsw-alias-bg-tertiary,rgba(128,128,128,.14));border-radius:6px;padding:.2em .4em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:85%}",
  ".dswFiles_previewMarkdown pre{background:var(--dsw-alias-bg-tertiary,rgba(128,128,128,.14));border-radius:6px;padding:16px;overflow:auto;font-size:85%;line-height:1.45}",
  ".dswFiles_previewMarkdown pre code{background:0 0;padding:0;font-size:100%}",
  ".dswFiles_previewMarkdown ul,.dswFiles_previewMarkdown ol{margin:0 0 16px;padding-left:2em}",
  ".dswFiles_previewMarkdown li{margin:.25em 0}",
  ".dswFiles_previewMarkdown blockquote{border-left:.25em solid var(--dsw-alias-border-l2);margin:0 0 16px;padding:0 1em;color:var(--dsw-alias-label-secondary)}",
  ".dswFiles_previewMarkdown a{color:var(--dsw-alias-button-info-fill)}",
  ".dswFiles_previewMarkdown img{max-width:100%}",
  ".dswFiles_previewMarkdown hr{border:none;height:.25em;background:var(--dsw-alias-border-l2);margin:24px 0}",
  ".dswFiles_previewMarkdown table{border-spacing:0;border-collapse:collapse;margin:0 0 16px;display:block;max-width:100%;overflow:auto}",
  ".dswFiles_previewMarkdown th,.dswFiles_previewMarkdown td{padding:6px 13px;border:1px solid var(--dsw-alias-border-l2)}",
  ".dswFiles_previewMarkdown th{font-weight:600;background:var(--dsw-alias-bg-tertiary,rgba(128,128,128,.14))}",
  ".dswFiles_previewMarkdown tr{background:var(--dsw-alias-bg-base,transparent);border-top:1px solid var(--dsw-alias-border-l2)}",
  ".dswFiles_previewMarkdown li.task-list-item{list-style:none;margin-left:-1.4em}",
  ".dswFiles_previewMarkdown li.task-list-item input{margin:0 .35em 0 0;vertical-align:middle}",
  // Mermaid fences render as sealed sandbox iframes (see buildMermaidDoc).
  // The frame styles like a code block. The frame's postMessage report
  // drives its height.
  ".dswFiles_mermaidFrame{display:block;width:100%;border:none;border-radius:6px;background:var(--dsw-alias-bg-tertiary,rgba(128,128,128,.14));margin:0 0 16px}",
   // Syntax highlighting: the GitHub token palette (light, plus dark). The
   // dark theme keys on body[data-ds-dark-theme], the attribute the dsh theme
   // presenter applies from the RESOLVED user preference (light/dark/system).
   // A raw prefers-color-scheme media query sees only the OS scheme. It
   // drifts from an explicit setting.
  ".dswFiles_previewMarkdown pre .hljs-comment,.dswFiles_previewText .hljs-comment,.dswFiles_previewMarkdown pre .hljs-quote{color:#6e7781}",
  ".dswFiles_previewMarkdown pre .hljs-keyword,.dswFiles_previewText .hljs-keyword,.dswFiles_previewMarkdown pre .hljs-doctag,.dswFiles_previewText .hljs-doctag,.dswFiles_previewMarkdown pre .hljs-formula{color:#cf222e}",
  ".dswFiles_previewMarkdown pre .hljs-string,.dswFiles_previewText .hljs-string,.dswFiles_previewMarkdown pre .hljs-regexp,.dswFiles_previewText .hljs-regexp,.dswFiles_previewMarkdown pre .hljs-addition,.dswFiles_previewText .hljs-addition,.dswFiles_previewMarkdown pre .hljs-attribute{color:#0a3069}",
  ".dswFiles_previewMarkdown pre .hljs-attr,.dswFiles_previewText .hljs-attr,.dswFiles_previewMarkdown pre .hljs-variable,.dswFiles_previewText .hljs-variable,.dswFiles_previewMarkdown pre .hljs-type,.dswFiles_previewText .hljs-type,.dswFiles_previewMarkdown pre .hljs-number{color:#953800}",
  ".dswFiles_previewMarkdown pre .hljs-literal{color:#0550ae}",
  ".dswFiles_previewMarkdown pre .hljs-title,.dswFiles_previewText .hljs-title,.dswFiles_previewMarkdown pre .hljs-symbol,.dswFiles_previewText .hljs-symbol,.dswFiles_previewMarkdown pre .hljs-bullet,.dswFiles_previewText .hljs-bullet,.dswFiles_previewMarkdown pre .hljs-link,.dswFiles_previewText .hljs-link,.dswFiles_previewMarkdown pre .hljs-meta{color:#8250df}",
  ".dswFiles_previewMarkdown pre .hljs-title.class_,.dswFiles_previewText .hljs-title.class_,.dswFiles_previewMarkdown pre .hljs-class_{color:#953800;font-weight:600}",
  ".dswFiles_previewMarkdown pre .hljs-strong{font-weight:600}",
  ".dswFiles_previewMarkdown pre .hljs-emphasis{font-style:italic}",
  "body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-comment,.dswFiles_previewText .hljs-comment,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-quote{color:#8b949e}body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-keyword,.dswFiles_previewText .hljs-keyword,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-doctag,.dswFiles_previewText .hljs-doctag,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-formula{color:#ff7b72}body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-string,.dswFiles_previewText .hljs-string,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-regexp,.dswFiles_previewText .hljs-regexp,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-addition,.dswFiles_previewText .hljs-addition,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-attribute{color:#a5d6ff}body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-attr,.dswFiles_previewText .hljs-attr,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-variable,.dswFiles_previewText .hljs-variable,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-type,.dswFiles_previewText .hljs-type,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-number{color:#ffa657}body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-literal{color:#79c0ff}body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-title,.dswFiles_previewText .hljs-title,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-symbol,.dswFiles_previewText .hljs-symbol,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-bullet,.dswFiles_previewText .hljs-bullet,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-link,.dswFiles_previewText .hljs-link,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-meta{color:#d2a8ff}body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-title.class_,.dswFiles_previewText .hljs-title.class_,body[data-ds-dark-theme] .dswFiles_previewMarkdown pre .hljs-class_{color:#ffa657}",
  ".dswFiles_footerBar{border-top:1px solid var(--dsw-alias-border-l3);flex-wrap:wrap;flex:none;align-items:center;gap:8px;padding:10px 16px;display:flex}",
  ".dswFiles_showHiddenToggle{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;align-items:center;gap:4px;padding:0 2px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}",
  ".dswFiles_showHiddenToggle:hover{color:var(--dsw-alias-label-primary)}",
  ".dswFiles_showHiddenToggleActive{color:var(--dsw-alias-label-primary)}",
  ".dswFiles_footerGap{flex:1 1 0}",
  ".dswFiles_footerAction{cursor:pointer;white-space:nowrap;background:0 0;border:none;align-items:center;gap:4px;padding:0 6px;min-width:72px;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary);display:inline-flex}",
  ".dswFiles_footerAction:hover{color:var(--dsw-alias-label-primary)}",
  ".dswFiles_footerAction:disabled{color:var(--dsw-alias-label-caption);cursor:default}",
  ".dswFiles_error{padding:4px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
  // Right-edge fade cue: makes the horizontal overflow discoverable (thin
  // scrollbars are easy to miss), shown only while more content lies to the
  // right of the current scroll position.
  ".dswFiles_diff{position:relative;flex:1 1 0;min-height:0;overflow:auto;display:flex;flex-direction:column;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:18px}",
  ".dswFiles_diffCue{position:absolute;top:0;right:0;bottom:0;width:28px;pointer-events:none;background:linear-gradient(to left,rgba(0,0,0,.16),rgba(0,0,0,0));opacity:0;transition:opacity .15s ease;z-index:2}",
  ".dswFiles_diffCueOn{opacity:1}",
  // sticky on BOTH axes: the head must stay put while the diff scrolls
  // vertically AND while the user traverses the horizontal range (the
  // zero-height spacer).
  ".dswFiles_diffHead{position:sticky;top:0;left:0;z-index:1;background:var(--dsw-alias-bg-base);padding:8px 10px 6px;border-bottom:1px solid var(--dsw-alias-border-l3)}",
  ".dswFiles_diffName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;word-break:break-all}",
  ".dswFiles_diffMeta{padding-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_diffBinaryRow{display:flex;gap:8px;padding:8px;flex:1 1 0;min-height:0}",
  ".dswFiles_diffBinaryPane{flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;gap:4px}",
  ".dswFiles_diffBinaryLabel{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_diffBinaryNone{flex:1 1 0;display:flex;align-items:center;justify-content:center;min-height:48px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_previewHtmlWrap{display:flex;flex-direction:column;min-height:0;flex:1 1 0}",
  ".dswFiles_previewHtmlNote{flex:none;padding:4px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_previewHtml{flex:1 1 0;min-height:0;width:100%;border:0;background:#fff}",
  // One grid for the whole file (per-row grids do not keep the rows aligned).
  // Both text columns overflow their half. They slide via the shared
  // --diff-x (the container's horizontal scrollbar drives it), so both halves
  // scroll in sync with the gutters pinned. The grid sits sticky-left over a
  // zero-height spacer (width = widest line, the effect sets it) that
  // provides the scroll range.
  ".dswFiles_diffGrid{display:grid;position:sticky;left:0;width:100%;grid-template-columns:44px minmax(0,1fr) 44px minmax(0,1fr);white-space:pre;align-content:start}",
  ".dswFiles_diffGridU{grid-template-columns:44px minmax(0,1fr)}",
  ".dswFiles_diffSpacer{flex:none;width:0;height:0}",
  ".dswFiles_diffNo{text-align:right;padding:0 6px 0 2px;color:var(--dsw-alias-label-tertiary);user-select:none;font-variant-numeric:tabular-nums}",
  ".dswFiles_diffNoDel{color:var(--dsw-alias-state-error-primary)}",
  ".dswFiles_diffNoAdd{color:var(--dsw-alias-state-success-primary)}",
  // Each cell is a CLIPPING WINDOW at half the pane width. The inner span
  // carries the line. The shared --diff-x translates it, so both halves
  // reveal their overflow in lockstep. overflow:hidden keeps the halves
  // separate.
  ".dswFiles_diffCell{padding:0 8px 0 0;overflow:hidden}",
  ".dswFiles_diffCellIn{display:block;transform:translateX(var(--diff-x,0px))}",
  ".dswFiles_cellDelO{background:rgba(229,83,75,.16)}",
  ".dswFiles_cellDelN{background:rgba(229,83,75,.07)}",
  ".dswFiles_cellAddO{background:rgba(46,160,67,.07)}",
  ".dswFiles_cellAddN{background:rgba(46,160,67,.16)}",
  // Intra-line change spans inside a mod row: a stronger tint than the
  // row-level cells above, so a few-character edit stands out (BUG-003).
  ".dswFiles_spanDel{background:rgba(229,83,75,.45)}",
  ".dswFiles_spanAdd{background:rgba(46,160,67,.45)}",
  // Theme-aware tints where color-mix exists (the fixed rgba values are the
  // fallback)
  "@supports (background:color-mix(in srgb,red 10%,transparent)){.dswFiles_cellDelO{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}.dswFiles_cellDelN{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}.dswFiles_cellAddO{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent)}.dswFiles_cellAddN{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent)}.dswFiles_spanDel{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}.dswFiles_spanAdd{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}.dswFiles_rollupPillConflict{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}}",
  ".dswFiles_diffGapCell{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}",
  ".dswFiles_diffGapTxt{padding:2px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_diffNN{color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_statusLine{flex:none;padding:2px 6px 4px}",
  ".dswFiles_statusHead{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0}",
  ".dswFiles_statusMarker{color:var(--dsw-alias-label-primary);font-weight:600;flex:none}",
  ".dswFiles_statusId{color:var(--dsw-alias-label-tertiary);flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}",
  ".dswFiles_statusDesc{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
  // Commit-review selector: a native select, keyboard/touch accessible,
  // zero menu code, truncates long option labels.
  ".dswFiles_statusSelect{flex:1 1 auto;min-width:0;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:1px 4px}",
  ".dswFiles_statusCount{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".dswFiles_badge{flex:none;width:14px;text-align:center;font-size:10.5px;font-weight:700;line-height:14px}",
  ".dswFiles_badgeA{color:var(--dsw-alias-state-success-primary)}",
  ".dswFiles_badgeM{color:var(--dsw-alias-state-warn-primary)}",
  ".dswFiles_badgeD{color:var(--dsw-alias-state-error-primary)}",
  ".dswFiles_badgeR{color:var(--dsw-alias-state-business-primary)}",
  ".dswFiles_badgeC{color:var(--dsw-alias-state-error-primary)}",
  ".dswFiles_badgeU{color:var(--dsw-alias-state-success-primary)}",
  // Folder rollup: a count PILL (how GitHub's PR file tree marks changed
  // folders). Error-tinted when the folder has an unresolved conflict.
  ".dswFiles_rollupPill{box-sizing:border-box;flex:none;min-width:14px;text-align:center;font-size:10.5px;font-weight:600;line-height:14px;padding:0 5px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);user-select:none}",
  ".dswFiles_rollupPillConflict{color:var(--dsw-alias-state-error-primary);background:rgba(214,69,69,.12)}",
  ".dswFiles_paneToggle{display:flex;gap:2px;flex:none;padding:6px 8px 0}",
  ".dswFiles_paneToggleBtn{cursor:pointer;background:0 0;border:none;border-radius:5px;padding:1px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".dswFiles_paneToggleBtn:hover{color:var(--dsw-alias-label-primary)}",
  ".dswFiles_paneToggleBtnActive{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}",
].join("\n");

const CSS_TAG = "filestab/Files.module.css";
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

function unwrap<T>(result: unknown): T {
  const r = result as { ok?: boolean; value?: T; error?: { code?: string; message?: string } } | null | undefined;
  if (!r || r.ok !== true) {
    const err = r && r.error;
    throw new Error(err ? (err.code + ": " + (err.message || "")) : "rpc failed");
  }
  return r.value as T;
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
type DirEntry = { name: string; path: string; isDirectory: boolean };
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

// Per-session view state (localStorage): a refresh resets component state
// (the tab ring only restores the active tab), so FilesView restores its
// own directory + selection. The read and write are best-effort and never
// throw (SSR, privacy mode).
const STATE_KEY = (sid: string): string => "filestab/files/" + sid;
type SavedState = { path: string; selected: string | null; leftW: number | null; rev: string | null; collapsed: boolean };
function loadState(sessionId: string | null): SavedState | null {
  try {
    if (typeof localStorage === "undefined" || !sessionId) return null;
    const raw = localStorage.getItem(STATE_KEY(sessionId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Record<string, unknown>;
    return {
      path: typeof s.path === "string" ? s.path : "",
      selected: typeof s.selected === "string" ? s.selected : null,
      leftW: typeof s.leftW === "number" ? s.leftW : null,
      rev: typeof s.rev === "string" ? s.rev : null,
      collapsed: s.collapsed === true,
    };
  } catch (e) { return null; }
}
function saveState(sessionId: string | null, path: string, selected: string | null, leftW: number | null, rev: string | null, collapsed: boolean): void {
  try {
    if (typeof localStorage === "undefined" || !sessionId) return;
    localStorage.setItem(STATE_KEY(sessionId), JSON.stringify({
      path: path || "", selected: selected || null,
      leftW: typeof leftW === "number" ? Math.round(leftW) : null,
      rev: rev || null,
      collapsed: collapsed === true,
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
// Intra-line diff (BUG-003): word-level change spans inside a mod row, like
// GitHub's word diff. Tokens are word runs, whitespace runs, and single
// punctuation characters; a plain LCS over the (short) token lists marks the
// unmatched tokens del/add and the shared ones same. null = no intra-line
// emphasis (identical lines, or a token table too big for the quadratic
// pass — the row tint is enough there).
type IntraSeg = { text: string; cls: "same" | "del" | "add" };
type IntraDiff = { old: IntraSeg[]; nw: IntraSeg[] };
const INTRA_TOKENS = /[A-Za-z0-9_]+|\s+|\S/g;
function intraTokens(text: string): string[] {
  const out: string[] = [];
  INTRA_TOKENS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTRA_TOKENS.exec(text))) out.push(m[0]!);
  return out;
}
function intraLineDiff(oldText: string, newText: string): IntraDiff | null {
  if (oldText === newText) return null;
  const a = intraTokens(oldText), b = intraTokens(newText);
  if (a.length * b.length > 100000) return null; // keep the O(n·m) pass cheap
  const n = a.length, m = b.length, w = m + 1;
  const tab: number[][] = new Array(n + 1);
  for (let i = 0; i <= n; i++) tab[i] = new Array<number>(w).fill(0);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      tab[i]![j] = a[i] === b[j] ? tab[i + 1]![j + 1]! + 1 : Math.max(tab[i + 1]![j]!, tab[i]![j + 1]!);
  const oldSegs: IntraSeg[] = [], nwSegs: IntraSeg[] = [];
  const push = (segs: IntraSeg[], cls: IntraSeg["cls"], text: string): void => {
    const last = segs[segs.length - 1];
    if (last && last.cls === cls) last.text += text;
    else segs.push({ text, cls });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(oldSegs, "same", a[i]!); push(nwSegs, "same", b[j]!); i++; j++; }
    else if (tab[i + 1]![j]! >= tab[i]![j + 1]!) { push(oldSegs, "del", a[i]!); i++; }
    else { push(nwSegs, "add", b[j]!); j++; }
  }
  for (; i < n; i++) push(oldSegs, "del", a[i]!);
  for (; j < m; j++) push(nwSegs, "add", b[j]!);
  return { old: oldSegs, nw: nwSegs };
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
  const noOld = <span key={key + "no"} className={"dswFiles_diffNo" + (d.type === "del" || d.type === "mod" ? " dswFiles_diffNoDel" : "")}>{d.old ? d.old.oldNo : ""}</span>;
  const intra = d.type === "mod" && d.old && d.nw ? intraLineDiff(d.old.text, d.nw.text) : null;
  const cellOld = (
    <span key={key + "co"} className={"dswFiles_diffCell" + (d.type === "ctx" ? "" : d.type === "add" ? " dswFiles_cellAddO" : " dswFiles_cellDelO")}>
      <span className="dswFiles_diffCellIn">{intra ? modSideContent(intra.old, "dswFiles_spanDel", key + "o", d.old!.noNewline) : diffSide(d.old)}</span>
    </span>
  );
  const noNw = <span key={key + "nw"} className={"dswFiles_diffNo" + (d.type === "add" || d.type === "mod" ? " dswFiles_diffNoAdd" : "")}>{d.nw ? d.nw.newNo : ""}</span>;
  const cellNw = (
    <span key={key + "cn"} className={"dswFiles_diffCell" + (d.type === "ctx" ? "" : d.type === "del" ? " dswFiles_cellDelN" : " dswFiles_cellAddN")}>
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
  const no = <span key={key + "no"} className={"dswFiles_diffNo" + (r.k === "del" ? " dswFiles_diffNoDel" : r.k === "add" ? " dswFiles_diffNoAdd" : "")}>{r.k === "add" ? r.newNo : r.oldNo}</span>;
  const marker = r.k === "ctx" ? " " : r.k === "add" ? "+" : "-";
  let content: React.ReactNode = marker + r.text;
  let nnInside = false;
  if (pair) {
    const intra = intraLineDiff(pair.side === "old" ? r.text : pair.other.text, pair.side === "old" ? pair.other.text : r.text);
    if (intra) {
      const isOld = pair.side === "old";
      content = [marker, ...modSideContent(isOld ? intra.old : intra.nw, isOld ? "dswFiles_spanDel" : "dswFiles_spanAdd", key + "u", r.noNewline)];
      nnInside = true;
    }
  }
  const cell = (
    <span key={key + "c"} className={"dswFiles_diffCell" + (r.k === "add" ? " dswFiles_cellAddN" : r.k === "del" ? " dswFiles_cellDelO" : "")}>
      <span className="dswFiles_diffCellIn">{content}{!nnInside && r.noNewline ? <NN /> : null}</span>
    </span>
  );
  return [no, cell];
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
  // Side-by-side needs two panes. The view falls back to unified when the
  // pane is less than ~520px wide.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => {
      const e0 = es && es[0];
      const w = e0 ? e0.contentRect.width : 0;
      if (w > 0) setNarrow(w < 520);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
  const head = (
    <div className="dswFiles_diffHead">
      <div className="dswFiles_diffName">{name}</div>
      {meta.length ? <div className="dswFiles_diffMeta">{meta.join(" · ")}</div> : null}
    </div>
  );

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
  status: VcsChange | null;
  base: string;
  rev: string | null;
  changesetKnown: boolean;
  readAt: (relPath: string, rev: string, signal: AbortSignal) => Promise<FileShowValue>;
  fetchDiff: (relPath: string, base: string, signal: AbortSignal, opts?: { noBinary?: boolean }) => Promise<DiffResponse>;
  readMermaid: () => Promise<{ text: string }>;
  t: TFunc;
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
  // fetch requests it. Later polls pass noBinary. The bytes are
  // history-stable. Without the flag, a 1 MB image's base64 re-crosses the
  // wire every poll.
  const binaryRef = React.useRef<{ key: string; binary: DiffBinary } | null>(null);

  // Diffable: worktree mode = a non-conflict change at a diffable base (a
  // conflict-only file has no worktree diff). Snapshot mode = the commit
  // CHANGED the file. While the changeset is still unknown (its load is
  // pending), the code treats every file as diffable. A changed file's diff
  // then never flashes a preview first. (resolvePaneMode holds the mode
  // reset/pin rules.)
  const isRev = props.base !== "worktree";
  const diffable = isRev && props.changesetKnown === false
    ? !!props.fetchDiff
    : !!(props.status && props.status.base !== "conflict" && props.fetchDiff);
  const [mode, setMode] = React.useState("auto");
  React.useEffect(() => { setMode("auto"); }, [props.relPath, props.base]);
  const effectiveMode = resolvePaneMode(mode, diffable, props.name);
  // The content pane's presentation while a DIFF owns the view. The "no
  // changes in this commit" fall-through shows the file in its own default
  // presentation, not as "diff".
  const contentMode = effectiveMode === "diff"
    ? (renderKindOf(props.name) === "markdown" ? "preview" : "view")
    : effectiveMode;

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
      if (v.binary) binaryRef.current = { key: props.relPath + "@" + props.base, binary: v.binary };
      const binary = binaryRef.current && binaryRef.current.key === props.relPath + "@" + props.base ? binaryRef.current.binary : null;
      if (sameFile && lastPatchRef.current && lastPatchRef.current.base === props.base && lastPatchRef.current.patch === v.patch) return;
      lastPatchRef.current = { base: props.base, patch: v.patch };
      const parsed = parseDiff(v.patch);
      setDiffSt({ status: "diff", for: props.relPath, file: parsed.files[0] || null, truncated: !!v.truncated, base: v.base, binary: binary || null });
    }).catch((e) => {
      if (seq !== diffSeq.current || (e && e.name === "AbortError")) return;
      setDiffSt({ status: "error", for: props.relPath, error: String((e && e.message) || e) });
    });
    return () => { c.abort(); };
  }, [props.relPath, props.status, props.base, effectiveMode]);

  // The preview fallback, one transport in both modes: fileshow over the
  // browse RPC (rev = the selected commit in snapshot mode, "worktree" for
  // the live file). The host containment-checks, caps the read (1 MB) and
  // classifies it. The client slices the display the same way.
  const isSnapshot = !!props.rev;
  React.useEffect(() => {
    if (!props.relPath) { setSt({ status: "empty" }); return; }
    if (effectiveMode === "diff" && diffSt.status !== "none") return; // the diff view owns the pane
    const seq = ++seqRef.current;
    const c = new AbortController();
    setSt({ status: "loading", name: props.name });
    const relPath = props.relPath;
    (async () => {
      try {
        const v = await props.readAt(relPath, isSnapshot ? props.rev! : "worktree", c.signal);
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
        setSt({ status: "error", name: props.name, error: String((err && err.message) || e) });
      }
    })();
    return () => { c.abort(); };
    // Mode is not a dep: content is mode-INDEPENDENT (View/Preview both read
    // st), so a flip must not re-fetch. Flips into or out of the diff view
    // always change diffSt.status, which re-runs this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.relPath, props.rev, isSnapshot, diffSt.status]);

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
    const srcs = st.status === "markdown" && st.text && props.relPath
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

  const toggleModes = paneToggleModes(diffable, props.name);
  const MODE_LABEL: Record<string, string> = { diff: "files.diff", view: "files.view", preview: "files.preview" };
  const toggle = toggleModes.length
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
  >
    {toggle}
    {conflictNote}
    {body}
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

interface FilesViewProps {
  t?: TFunc;
  listDirectory: (relPath: string, signal: AbortSignal, showHidden: boolean, force: boolean, rev: string | null) => Promise<Listing>;
  sessionId: string | null;
  readAt: (relPath: string, rev: string, signal: AbortSignal) => Promise<FileShowValue>;
  fetchDiff: (relPath: string, base: string, signal: AbortSignal, opts?: { noBinary?: boolean }) => Promise<DiffResponse>;
  readMermaid: () => Promise<{ text: string }>;
}
function FilesView(props: FilesViewProps) {
  const t = props.t || ((k: string) => k);
  const listDirectory = props.listDirectory;
  const sessionId = props.sessionId;
  const rootSeg = { name: t("view.files"), path: "" };

  const [saved] = React.useState<SavedState | null>(() => loadState(sessionId));
  const [segments, setSegments] = React.useState(() => segmentsForPath(rootSeg, saved ? saved.path : ""));
  const [listings, setListings] = React.useState<Record<string, Listing>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [selectedFile, setSelectedFile] = React.useState<DirEntry | null>(null);
  // Left pane width (divider drag). null = the CSS default (340px). The
  // value restores from the per-session state, clamped on load.
  const [leftW, setLeftW] = React.useState<number | null>(() =>
    saved && typeof saved.leftW === "number" && saved.leftW >= 220 && saved.leftW <= 2000
      ? Math.round(saved.leftW) : null);
  // Left pane collapsed: the browse pane + divider unmount, so the preview
  // and diff take the full width. leftW is kept so expanding restores the
  // previous width. Restored from the per-session state (default: open).
  const [collapsed, setCollapsed] = React.useState<boolean>(() => saved ? saved.collapsed : false);
  // The commit under review (null = the working copy). A change id stays
  // valid across rebase/amend. Ids are jj's a–z change form or hex commit
  // ids, hence the [0-9a-z] check.
  const [revSel, setRevSel] = React.useState<string | null>(() =>
    saved && typeof saved.rev === "string" && /^[0-9a-z]{6,40}$/.test(saved.rev) ? saved.rev : null);
  // The recent-commit list, PERSISTENT across listing-cache clears.
  const [commitList, setCommitList] = React.useState<VcsCommit[]>([]);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const seqRef = React.useRef(0);
  // The reload button sets this: the next fetch passes force=true, which
  // also invalidates the host's structural jj-failure cache.
  const forceRef = React.useRef(false);
  // The saved selection to re-apply once the restored directory's listing loads.
  const pendingSelRef = React.useRef<string | null>(saved ? saved.selected : null);
  const [focusIdx, setFocusIdx] = React.useState(0);
  const rowRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  // Whether keyboard focus was INSIDE the file list. The focus-restore
  // effect that follows hands focus back after a directory nav, instead of
  // taking it from a mouse user (who never sets it).
  const listHadFocusRef = React.useRef(false);

  const current = segments[segments.length - 1]!;

  // Snapshot mode: the user selected a reviewed commit. The list is that
  // commit's exact tree. The preview reads bytes AT the commit. The code
  // hides worktree badges/rollups. revLive = the persisted selection, if it
  // is still in the commit list. A rewritten-away rev degrades to the
  // working copy.
  const currentListing = listings[current.path] || null;
  const vcsInfo = currentListing && currentListing.vcs && currentListing.vcs.ok === true ? currentListing.vcs : null;
  const commits = vcsInfo && Array.isArray(vcsInfo.commits) ? vcsInfo.commits : [];
  // revLive validates against the PERSISTENT commitList, not the current
  // listing's own block. The rev-change effect clears `listings` on every
  // rev flip. A revLive taken from the just-cleared listing flaps
  // null→rev→null forever (each cycle aborts its own predecessor), the
  // stuck "loading…" tab.
  const revLive = revSel && commitList.some((c) => c.id === revSel) ? revSel : null;
  const snapshotMode = revLive !== null;
  // The change set the nav-pane markers describe: the worktree's set in live
  // mode, the selected commit's own diff (vs its parent) in snapshot mode,
  // the worktree's letters never appear over a frozen tree.
  const commitChanges = snapshotMode && currentListing && Array.isArray(currentListing.commitChanges)
    ? currentListing.commitChanges : null;
  const activeChanges = snapshotMode ? commitChanges : (vcsInfo ? vcsInfo.changes ?? null : null);
  // The code remembers the commit list from a listing that carries one
  // (both worktree and snapshot responses include the worktree jj block).
  const noteCommits = (listing: Listing | null) => {
    if (listing && listing.vcs && listing.vcs.ok === true && Array.isArray(listing.vcs.commits)) {
      setCommitList(listing.vcs.commits);
    }
  };

  // The effect fetches the current directory's listing (the worktree's, or
  // the selected commit's snapshot). The guard makes it a no-op while the
  // entry is cached, so `listings` in the deps is loop-safe.
  React.useEffect(() => {
    const seq = ++seqRef.current;
    if (listings[current.path]) return;
    const c = new AbortController();
    listDirectory(current.path, c.signal, showHidden, forceRef.current === true, revLive).then((listing) => {
      forceRef.current = false;
      if (seq !== seqRef.current) return;
      noteCommits(listing);
      setListings((prev) => (prev[current.path] ? prev : Object.assign({}, prev, { [current.path]: listing })));
      const pend = pendingSelRef.current;
      if (pend) {
        const e = (listing.entries || []).find((en) => en.path === pend);
        if (e) setSelectedFile(e);
        pendingSelRef.current = null;
      }
    }).catch((e) => {
      const err = e as { message?: string };
      if (seq === seqRef.current) setError(err && err.message ? err.message : String(e));
    });
    // Transport guard: a request that never settles (a dead keep-alive
    // socket, a proxy that swallows it, a stale pre-restart connection)
    // leaves "Loading…" as the only visible state forever. The code
    // surfaces it after 30 s so the failure is at least visible.
    const to = setTimeout(() => {
      if (seq === seqRef.current) {
        try { console.warn("filestab list STUCK > 30 s"); } catch { /* no console */ }
        setError(t("files.fetchStuck"));
      }
    }, 30000);
    return () => { c.abort(); clearTimeout(to); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.path, showHidden, listings, revLive]);

  // A reviewed-commit switch is a different TREE. The code clears the
  // listing cache (the other tree's entries poison the paths) and re-applies
  // the current selection if the file exists in the new tree too.
  const lastRevRef = React.useRef(revLive);
  React.useEffect(() => {
    if (lastRevRef.current === revLive) return;
    lastRevRef.current = revLive;
    if (selectedFile) { pendingSelRef.current = selectedFile.path; setSelectedFile(null); }
    setListings({});
  }, [revLive]);

  // jj state changes between visits. The code refreshes the current listing
  // every 5 s (force=false: the host reuses its structural-failure cache). A
  // failed poll keeps the last good listing, so the view never degrades.
  const nowListing = listings[current.path];
  const vcsOk = !!(nowListing && nowListing.vcs && nowListing.vcs.ok === true);
  // Monotonic poll sequence: an in-flight poll's response must not apply
  // once a newer poll (or a re-run of this effect) supersedes it. A stale
  // worktree response clobbers a fresh snapshot listing and rolls the commit
  // dropdown back.
  const pollSeqRef = React.useRef(0);
  React.useEffect(() => {
    if (!vcsOk) return;
    const iv = setInterval(() => {
      const seq = ++pollSeqRef.current;
      const c = new AbortController();
      // Same mode as the fetch effect: the poll keeps the snapshot's tree
      // (and the worktree `jj` block behind the dropdown) fresh.
      listDirectory(current.path, c.signal, showHidden, false, revLive).then((listing) => {
        if (seq !== pollSeqRef.current) return; // superseded
        noteCommits(listing);
        setListings((prev) => (prev[current.path] ? Object.assign({}, prev, { [current.path]: listing }) : prev));
      }).catch(() => {});
    }, 5000);
    return () => { pollSeqRef.current++; clearInterval(iv); }; // invalidate in-flight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.path, showHidden, vcsOk, revLive]);

  React.useEffect(() => {
    if (pendingSelRef.current) return; // do not clobber the not-yet-applied restored selection
    saveState(sessionId, current.path, selectedFile ? selectedFile.path : null, leftW, revSel, collapsed);
  }, [current.path, selectedFile, leftW, revSel, collapsed]);

  // The effect applies the divider position to --filez-left. During an
  // active drag, startDrag writes the var directly (no re-render per
  // pointermove). null (double-click reset) REMOVES the var, so the CSS
  // default applies.
  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (typeof leftW === "number") el.style.setProperty("--filez-left", leftW + "px");
    else el.style.removeProperty("--filez-left");
  }, [leftW]);

  // Divider drag: pointer capture, rAF-coalesced updates, the width clamps
  // between the left pane's min (220px) and the value that leaves the right
  // pane its 320px min.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current, divider = e.currentTarget;
    if (!body || !divider || e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dswFiles_dividerActive");
    const startX = e.clientX;
    const parsed = parseFloat(getComputedStyle(body).getPropertyValue("--filez-left"));
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
        body.style.setProperty("--filez-left", Math.round(clamp(startW + (latestX - startX))) + "px");
      });
    };
    const finish = (ev: PointerEvent) => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      try { divider.releasePointerCapture(ev.pointerId); } catch (err) { /* already released */ }
      divider.classList.remove("dswFiles_dividerActive");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      setLeftW(Math.round(clamp(startW + (ev.clientX - startX))));
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
  };

  const entries = currentListing ? currentListing.entries : null;
  const count = entries ? entries.length : 0;
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

  const pick = (entry: DirEntry) => {
    if (!entry.isDirectory) { setSelectedFile(entry); setError(null); return; }
    setSegments((prev) => prev.concat({ name: entry.name, path: entry.path }));
    setSelectedFile(null);
    setError(null);
  };
  const jumpTo = (index: number) => {
    if (index < 0 || index >= segments.length) return;
    setSegments((prev) => prev.slice(0, index + 1));
    setSelectedFile(null);
    setError(null);
  };
  const startEdit = () => {
    const sep = current.path && current.path.indexOf("\\") >= 0 ? "\\" : "/";
    setDraft(current.path && !/[/\\]$/.test(current.path) ? current.path + sep : current.path);
    setEditing(true);
  };
  const commitEdit = () => {
    const text = draft.trim().replace(/[/\\]+$/, "");
    if (text !== "") setSegments(segmentsForPath(rootSeg, text));
    setSelectedFile(null);
    setError(null);
    setEditing(false);
  };
  React.useEffect(() => {
    const i = selectedFile && entries ? entries.findIndex((en) => en.path === selectedFile.path) : -1;
    const idx = i >= 0 ? i : 0;
    setFocusIdx(idx);
    // A directory nav (crumb click, ←) unmounts the focused row and drops
    // DOM focus to <body>. Keyboard nav then silently dies. The code hands
    // focus back if it was in the list (mouse users never set the flag,
    // nothing is stolen).
    if (listHadFocusRef.current) rowRefs.current[idx]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentListing, selectedFile]);
  // Keyboard nav: ↑/↓/Home/End move the roving focus, ← goes up a level,
  // Enter/Space activate via the native button click (pick). The input guard
  // also covers the path-edit field in case it ever lives inside this subtree.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    const target = listNavTarget(e.key, focusIdx, entries ? entries.length : 0);
    if (target !== null) {
      e.preventDefault();
      setFocusIdx(target);
      const el = rowRefs.current[target];
      if (el) el.focus();
      return;
    }
    if (e.key === "ArrowLeft" && segments.length > 1) { e.preventDefault(); jumpTo(segments.length - 2); }
  };
  const reload = () => { forceRef.current = true; setListings({}); setError(null); };
  const toggleHidden = () => { setListings({}); setShowHidden((v) => !v); };

  const renderRow = (entry: DirEntry, i: number) => {
    const isSelectedFile = !entry.isDirectory && selectedFile && selectedFile.path === entry.path;
    const change = !entry.isDirectory && changeByPath ? changeByPath.get(entry.path) || null : null;
    const rollup = entry.isDirectory
      ? rollupFor(activeChanges ? { ok: true, changes: activeChanges, conflicts: [] } : null, entry.path)
      : null;
    // Files get no icon (less clutter). An invisible 16px spacer keeps the
    // file names aligned with the folder names (which keep a 16px glyph).
    const icon = entry.isDirectory
      ? Icon("IconFolderClose16", { className: "dswFiles_rowIcon" }, "▣")
      : <span className="dswFiles_rowIconSpacer" aria-hidden="true" />;
    return <div key={entry.path} className="dswFiles_rowSeat" role="listitem">
      <button
        ref={(el) => { rowRefs.current[i] = el; }}
        type="button"
        // Roving tabindex: only the focused row is a tab stop. The tab key
        // enters the list once (at the focus) instead of stop-hopping every
        // row. Arrows move from there.
        tabIndex={i === focusIdx ? 0 : -1}
        onFocus={() => { listHadFocusRef.current = true; setFocusIdx(i); }}
        aria-current={isSelectedFile ? "true" : undefined}
        className={isSelectedFile ? "dswFiles_row dswFiles_rowSelected" : "dswFiles_row"}
        onClick={() => pick(entry)}
        title={entry.path}
      >
        {icon}
        <span className="dswFiles_rowName">{entry.name}</span>
        {/* Fixed right slot before the chevron: a folder's rollup pill
            (an empty slot when unchanged, so chevrons stay aligned with
            file rows). A file's change letter. */}
        {entry.isDirectory
          ? (rollupSlot(rollup, t) || <span className="dswFiles_badge" aria-hidden="true">{" "}</span>)
          : <span className={"dswFiles_badge" + (change ? " dswFiles_badge" + change.status : "")}>{change ? change.status : ""}</span>}
        {entry.isDirectory ? Icon("IconChevronRightOutline14", { size: 14, className: "dswFiles_rowChevron" }, "›") : null}
      </button>
    </div>;
  };

  // A failed fetch must not leave "Loading…" as the only visible state. The
  // error renders in the list area itself (the bottom line is easy to miss).
  const browsePane = !currentListing
    ? <div className="dswFiles_browsePane">
        {statusLineEl}
        {error !== null
          ? <div className="dswFiles_error">{error}</div>
          : <div className="dswFiles_status">{t("files.loading")}</div>}
      </div>
    : !entries || entries.length === 0
      ? <div className="dswFiles_browsePane">
          {statusLineEl}
          <div className="dswFiles_status">{t("files.empty")}</div>
        </div>
      : <div className="dswFiles_browsePane" role="list" onKeyDown={onListKeyDown}
          // Focus LEFT the list (Tab to the dropdown/preview, a crumb click):
          // the handler clears the flag so the next nav does not drag focus back.
          onBlur={(e) => { const rt = e.relatedTarget as Node | null; if (rt && !(e.currentTarget as Node).contains(rt)) listHadFocusRef.current = false; }}>
          {statusLineEl}
          {entries.map((entry, i) => renderRow(entry, i))}
        </div>;

  const crumbItems = segments.map((seg, i) =>
    <span key={seg.path + ":" + i} className="dswFiles_crumbSeat">
      {i > 0 ? Icon("IconChevronRightOutline14", { size: 12, className: "dswFiles_crumbChevron" }, "›") : null}
      <button
        type="button"
        className="dswFiles_crumb"
        disabled={i === segments.length - 1}
        onClick={() => jumpTo(i)}
      >{seg.name}</button>
    </span>,
  );
  const crumbTrail = <span className="dswFiles_crumbTrail" role="navigation">{crumbItems}</span>;
  const crumbInput = <input
    className="dswFiles_pathInput"
    value={draft}
    autoFocus
    spellCheck={false}
    onChange={(e) => setDraft(e.target.value)}
    onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); else if (e.key === "Escape") setEditing(false); }}
    onBlur={() => setEditing(false)}
  />;
  const crumbEditZone = <button type="button" className="dswFiles_crumbEditZone" onClick={startEdit} aria-label="edit path">
    {Icon("IconEditOutline16", { size: 14, className: "dswFiles_crumbEditGlyph" }, "✎")}
  </button>;

  return <div className="dswFiles_root">
    <div className="dswFiles_header">
      <button
        type="button"
        className="dswFiles_collapseBtn"
        onClick={() => setCollapsed((v) => !v)}
        aria-label={collapsed ? t("files.expandNav") : t("files.collapseNav")}
        title={collapsed ? t("files.expandNav") : t("files.collapseNav")}
        aria-expanded={!collapsed}
      >
        {Icon("IconPanelLeftOutline16", { size: 16, className: "dswFiles_collapseGlyph" }, "▤")}
      </button>
      <div className="dswFiles_crumbBar">
        {editing ? crumbInput : [crumbTrail, crumbEditZone]}
      </div>
    </div>
    <div className="dswFiles_body" ref={bodyRef}>
      {collapsed ? null : browsePane}
      {collapsed ? null : <div
        className="dswFiles_divider"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("files.resizePanels")}
        onPointerDown={startDrag}
        onDoubleClick={() => setLeftW(null)}
      />}
      <div className="dswFiles_previewPane" role="region" aria-label={t("files.preview")} aria-live="polite">
        <PreviewPane
          name={selectedFile ? selectedFile.name : null}
          relPath={selectedFile ? selectedFile.path : null}
          status={selStatus}
          base={revLive || "worktree"}
          rev={revLive}
          // The commit's changeset is known once the listing loads
          // (then an absent entry = the commit never touched the file).
          changesetKnown={!snapshotMode || !!currentListing}
          readAt={props.readAt}
          fetchDiff={props.fetchDiff}
          readMermaid={props.readMermaid}
          t={t}
        />
      </div>
    </div>
    <div className="dswFiles_footerBar">
      <button
        type="button"
        className={showHidden ? "dswFiles_showHiddenToggle dswFiles_showHiddenToggleActive" : "dswFiles_showHiddenToggle"}
        onClick={toggleHidden}
      >{t("files.showHidden")}</button>
      <span className="dswFiles_status">{count + " " + t("files.items")}</span>
      <div className="dswFiles_footerGap" />
      <button type="button" className="dswFiles_footerAction" onClick={reload}>
        {[Icon("IconRefreshOutline16", { size: 16 }, "⟳"), " " + t("files.reload")]}
      </button>
    </div>
    {error !== null ? <div className="dswFiles_error">{error}</div> : null}
  </div>;
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
interface FilestabContext {
  effect(execute: () => unknown, label?: string): void;
  locale: FilestabLocale;
  connection: FilestabConnection;
  slots: FilestabSlots;
}

function apply(ctx: FilestabContext): void {
  injectCss();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-files: dictionaries");
  const t = ctx.locale.bind(NS);
  const connection = ctx.connection;
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "files",
    order: 20,
    locale: NS,
    label: () => t("view.files"),
    inject: (sessionId: string | null) => ({
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
      // The vendored mermaid renderer bundle. The host serves the
      // package-local dist/mermaid.min.js as text. The client inlines it
      // into the sandbox iframe's srcdoc.
      readMermaid: () =>
        connection.rpc.call(BROWSE_CHANNEL, "mermaid", { sessionId }, undefined)
          .then((v) => unwrap<{ text: string }>(v)),
      t,
    }),
  }, FilesView));
}

export const inject: string[] = ["slots", "locale", "connection"];
export const name = "filestab";
export { apply };
// Test-only seam. The cordis loader ignores it (it reads apply/inject/name
// only). This export exposes the pure preview helpers so
// test/client.test.mjs can unit-test them.
export const __test = { renderMarkdown, renderMarkdownWithImages, markdownImageSrcs, isLocalDocImageSrc, resolveDocImage, rewriteMarkdownImages, highlightSource, buildMermaidDoc, typeLabel, formatBytes, loadState, saveState, segmentsForPath, parseDiff, displayRows, gapAfter, statusAggregate, jjRowLabel, rollupFor, rollupLabel, rollupSlot, DiffView, unifiedCells, unifiedPairs, intraLineDiff, intraTokens, realPathOf, renderKindOf, resolvePaneMode, paneToggleModes, previewContentFor, listNavTarget };
