import assert from "node:assert";
import { sniff, labelFor } from "../dist/magic.js";

let n = 0;
const check = (head, wantType, msg) => {
  const got = sniff(head).type;
  assert.strictEqual(got, wantType, msg + ` (got ${got})`);
  n++;
};

check(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "PNG");
check(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "JPEG");
check(Buffer.from("GIF89a" + "x".repeat(8)), "image/gif", "GIF89a");
check(Buffer.from("GIF87a" + "x".repeat(8)), "image/gif", "GIF87a");
check(Buffer.from("%PDF-1.7\n"), "application/pdf", "PDF");
check(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), "application/zip", "ZIP");
check(Buffer.from([0x1f, 0x8b, 0x08, 0x00]), "application/gzip", "GZIP");
check(Buffer.from([0x1f, 0x8b, 0x00]), null, "1F 8B with a non-deflate CM byte → null");
check(Buffer.concat([Buffer.from("BM"), Buffer.from([0x36, 0, 0, 0]), Buffer.alloc(4), Buffer.from([0x0e, 0, 0, 0])]), "image/bmp", "BMP (real header: reserved words zero)");
check(Buffer.concat([Buffer.from("BM"), Buffer.from("x".repeat(12))]), null, "BM-prefixed junk is NOT bmp (reserved words nonzero)");
check(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]), "application/x-elf", "ELF");
check(Buffer.from([0x00, 0x00, 0x01, 0x00]), "image/x-icon", "ICO");
check(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from("avif")]), "image/avif", "AVIF (ftyp brand)");
check(Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("fmt ")]), "audio/vnd.wave", "RIFF/WAV");
check(Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("VP8 ")]), "image/webp", "RIFF/WebP");
check(Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("AVI "), Buffer.from("hdrl")]), "video/vnd.avi", "RIFF/AVI");
check(Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("XXXX")]), "application/octet-stream", "RIFF unknown form → binary");
check(Buffer.from("ID3\x03\x00\x00\x00\x00"), "audio/mpeg", "MP3 (ID3, short head → guess)");
check(Buffer.concat([Buffer.from("ID3\x03\x00\x00"), Buffer.from([0, 0, 0, 10]), Buffer.alloc(10), Buffer.from([0xff, 0xe2])]), "audio/mpeg", "MP3 (ID3 tag + frame sync)");
check(Buffer.concat([Buffer.from("ID3\x03\x00\x00"), Buffer.from([0, 0, 0, 10]), Buffer.alloc(10), Buffer.from([0x7f, 0x46])]), null, "ID3-tagged non-MP3 → null");
check(Buffer.concat([Buffer.from("ID3\x03\x00\x00"), Buffer.from([0x7f, 0, 0, 0]), Buffer.from("xx")]), "audio/mpeg", "MP3 (ID3 tag runs past head → guess)");
check(Buffer.from([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg", "MP3 (frame sync)");

// no match → null: sniff is best-effort; the caller falls back to the extension
check(Buffer.from("hello world, this is plain text"), null, "plain text → null");
check(Buffer.alloc(0), null, "empty → null");
check(Buffer.from([0x00, 0x01, 0x02, 0x03]), null, "arbitrary bytes → null");
check(Buffer.from([0x89, 0x50]), null, "truncated PNG (too short) → null");

assert.strictEqual(labelFor("image/png"), "PNG image", "label png"); n++;
assert.strictEqual(labelFor("application/pdf"), "PDF document", "label pdf"); n++;
assert.strictEqual(labelFor("text/markdown"), "Markdown", "label md"); n++;
assert.strictEqual(labelFor("application/octet-stream"), "binary", "label octet → binary"); n++;
assert.strictEqual(labelFor("application/x-something-odd"), "application/x-something-odd", "label unknown → the type"); n++;
assert.strictEqual(labelFor("application/zip"), "ZIP archive", "label zip"); n++;
assert.strictEqual(labelFor("audio/vnd.wave"), "WAV audio", "label wav"); n++;
assert.strictEqual(labelFor("image/avif"), "AVIF image", "label avif"); n++;

console.log(`magic: ${n} assertions passed`);
