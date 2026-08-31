// src/magic.ts, best-effort file-type identification from magic bytes.
// sniff wins over the file extension: a signature match beats the name.
// On no match sniff returns null. The caller falls back to the
// extension-based type.
//
// Signatures adapted from file-type v16.5.4 (MIT), core.js:
// https://github.com/sindresorhus/file-type/blob/v16.5.4/core.js
// Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

interface SignatureRule {
  bytes: Buffer;
  type: string;
}

const SIGNATURES: SignatureRule[] = [
  { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), type: "image/png" },
  { bytes: Buffer.from([0xff, 0xd8, 0xff]), type: "image/jpeg" },
  { bytes: Buffer.from("GIF"), type: "image/gif" }, // per file-type: 3-byte prefix, covers GIF87a/89a
  { bytes: Buffer.from("%PDF"), type: "application/pdf" }, // per file-type: 4-byte prefix
  { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), type: "application/zip" },
  { bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]), type: "application/zip" }, // empty zip
  { bytes: Buffer.from([0x50, 0x4b, 0x07, 0x08]), type: "application/zip" }, // spanned zip
  { bytes: Buffer.from([0x1f, 0x8b, 0x8]), type: "application/gzip" }, // CM byte must be 8 (deflate)
  { bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), type: "application/x-elf" },
  { bytes: Buffer.from([0x00, 0x00, 0x01, 0x00]), type: "image/x-icon" },
];

const RIFF = Buffer.from("RIFF");
const FTYP = Buffer.from("ftyp");
const ID3 = Buffer.from("ID3");

/**
 * @param head the file's first bytes (the caller passes >= 12).
 * @returns the MIME type, or null for no match.
 */
export function sniff(head: Buffer | Uint8Array): { type: string | null } {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  for (const rule of SIGNATURES) {
    if (b.length >= rule.bytes.length && b.subarray(0, rule.bytes.length).equals(rule.bytes)) {
      return { type: rule.type };
    }
  }
  // ISO base media (file-type): the ftyp box at offset 4 names the brand at
  // bytes 8..12. The 0x60 mask is its "brand is printable" gate.
  if (b.length >= 12 && b.subarray(4, 8).equals(FTYP) && (b[8]! & 0x60) !== 0
      && b.subarray(8, 12).toString("ascii") === "avif") return { type: "image/avif" };
  if (b.length >= 12 && b.subarray(0, 4).equals(RIFF)) {
    const form = b.subarray(8, 12).toString("ascii");
    if (form.startsWith("WAVE")) return { type: "audio/vnd.wave" };
    if (form.startsWith("WEBP")) return { type: "image/webp" };
    if (form.startsWith("AVI")) return { type: "video/vnd.avi" };
    // an unnamed RIFF form is still binary (file-type has no RIFF fallback)
    return { type: "application/octet-stream" };
  }
  if (b.subarray(0, 3).equals(ID3)) {
    // file-type: the code skips the tag (4 sync-safe size bytes at offset 6)
    // and verifies the frame sync. A tag longer than the head is file-type's
    // backward-compat guess.
    if (b.length < 10) return { type: "audio/mpeg" };
    const tagLen = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const at = 10 + tagLen;
    if (at + 2 > b.length) return { type: "audio/mpeg" };
    return mpegFrameAt(b, at) ? { type: "audio/mpeg" } : { type: null }; // an ID3-tagged non-MP3 (e.g. an iTunes-tagged FLAC)
  }
  if (mpegFrameAt(b, 0)) return { type: "audio/mpeg" };
  // file-type: the bare "BM" prefix. The reserved words at offsets 6/8 must
  // be zero, else the code mislabels any file with those two first letters.
  if (b.length >= 14 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt16LE(6) === 0 && b.readUInt16LE(8) === 0) {
    return { type: "image/bmp" };
  }
  return { type: null };
}

// file-type's MPEG audio frame check: sync word 0xFFE. The check excludes
// ADTS (aac) and accepts layer III/II/I.
function mpegFrameAt(b: Buffer, at: number): boolean {
  if (b.length < at + 2) return false;
  if (b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return false;
  if ((b[at + 1]! & 0x16) === 0x10) return false;
  return (b[at + 1]! & 0x06) !== 0;
}

// Human labels for the preview's binary card. They cover sniffed and
// extension-derived types. The code falls back to the type itself. An empty
// type → "binary".
const LABELS: Record<string, string> = {
  "image/png": "PNG image", "image/jpeg": "JPEG image", "image/gif": "GIF image",
  "image/bmp": "BMP image", "image/webp": "WebP image", "image/svg+xml": "SVG image",
  "image/avif": "AVIF image", "image/x-icon": "icon",
  "application/pdf": "PDF document", "application/zip": "ZIP archive",
  "application/gzip": "GZIP file", "application/x-elf": "ELF binary",
  "application/octet-stream": "binary",
  "text/markdown": "Markdown", "audio/mpeg": "MP3 audio", "audio/vnd.wave": "WAV audio",
  "video/vnd.avi": "AVI video",
};

/** @param type a MIME type. @returns a human-readable label. */
export function labelFor(type: string): string {
  return LABELS[type] || (type ? String(type) : "binary");
}
