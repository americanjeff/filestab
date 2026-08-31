// Run: node test/md/gen-gfm.mjs [fixture.md] [out.html]
//
// Regenerates the GFM reference rendering for the markdown comparison
// fixture. Uses cmark-gfm (the exact engine GitHub runs) with the GFM
// extensions enabled, then wraps the output in a self-contained
// GitHub-styled page. Defaults:
//   fixture.md = test/md/kitchen-sink.md
//   out.html   = test/md/kitchen-sink.gfm.html
//
// cmark-gfm without --unsafe drops raw HTML and strips dangerous URLs,
// which is GitHub's safe-mode behavior -- the point is to mirror it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = process.argv[2] || join(here, "kitchen-sink.md");
const out = process.argv[3] || join(here, "kitchen-sink.gfm.html");

// No --hardbreaks: cmark-gfm's default soft break -> space is how GitHub
// renders file blobs (it keeps breaks only in issues/comments). filestab
// matches that for files, so the reference uses the spec-pure default.
const body = execFileSync("cmark-gfm", [
  "-e", "table",
  "-e", "strikethrough",
  "-e", "tasklist",
  "-e", "autolink",
  fixture,
], { encoding: "utf8" });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(fixture.split(/[\\/]/).at(-1))} -- cmark-gfm reference rendering</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light}
body{margin:0;background:#fff;color:#1f2328;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.markdown-body{max-width:980px;margin:0 auto;padding:32px 40px 64px;overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid #d0d7de}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid #d0d7de}
h3{font-size:1.25em}
h4{font-size:1em}
h5{font-size:.875em}
h6{font-size:.85em;color:#656d76}
p{margin-top:0;margin-bottom:16px}
a{color:#0969da;text-decoration:none}
a:hover{text-decoration:underline}
strong{font-weight:600}
code{padding:.2em .4em;margin:0;font-size:85%;white-space:nowrap;background:rgba(175,184,193,.2);border-radius:6px;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
pre{padding:16px;overflow:auto;font-size:85%;line-height:1.45;background:rgba(175,184,193,.2);border-radius:6px;margin-top:0;margin-bottom:16px}
pre code{padding:0;background:transparent;white-space:pre;border:0;font-size:100%}
blockquote{margin:0 0 16px;padding:0 1em;color:#656d76;border-left:.25em solid #d0d7de}
blockquote>:first-child{margin-top:0}
blockquote>:last-child{margin-bottom:0}
ul,ol{padding-left:2em;margin:0 0 16px}
li{margin-top:.25em}
.task-list-item,li:has(> input[type="checkbox"]){list-style-type:none;margin-left:-1.4em}
.task-list-item input,li>input[type="checkbox"]{margin:0 .2em .25em 0;vertical-align:middle}
table{border-spacing:0;border-collapse:collapse;margin-top:0;margin-bottom:16px;display:block;max-width:100%;overflow:auto}
th,td{padding:6px 13px;border:1px solid #d0d7de}
th{font-weight:600;background:rgba(175,184,193,.15)}
tr{background:#fff;border-top:1px solid #d8dee4}
td[align="center"],th[align="center"]{text-align:center}
td[align="right"],th[align="right"]{text-align:right}
img{max-width:100%}
hr{height:.25em;padding:0;margin:24px 0;background-color:#d0d7de;border:0}
details{max-width:980px;margin:0 auto;padding:0 40px 40px;color:#656d76}
details pre{white-space:pre-wrap;font-size:12px}
</style>
</head>
<body>
<div class="markdown-body">
${body}
</div>
<details>
<summary>Raw cmark-gfm HTML (source-level comparison with filestab's output)</summary>
<pre>${esc(body)}</pre>
</details>
</body>
</html>
`;

writeFileSync(out, page, "utf8");
console.log(`wrote ${out} (${Buffer.byteLength(page)} bytes)`);
