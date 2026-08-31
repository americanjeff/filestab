// Copy the vendored mermaid renderer bundle into dist/ so the host can serve
// it over the "mermaid" RPC endpoint (src/index.ts). mermaid is a build-time
// devDependency only — the published package ships this plain file, keeping
// filestab's zero runtime dependencies.
import { copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "mermaid", "dist", "mermaid.min.js");
const dest = join(root, "dist", "mermaid.min.js");
if (!existsSync(src)) {
  console.error(`copy-mermaid: missing ${src} (run pnpm install first)`);
  process.exit(1);
}
copyFileSync(src, dest);
console.log(`copy-mermaid: wrote ${dest} (${statSync(dest).size} bytes)`);
