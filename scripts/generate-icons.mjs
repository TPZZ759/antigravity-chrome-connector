import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, "..", "extension", "icons");
fs.mkdirSync(ICONS_DIR, { recursive: true });

// Pure-Node PNG encoder (RGBA)
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size * 0.46;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Normalized coords in [-1, 1]
      const nx = (x - cx) / r;
      const ny = (y - cy) / r;
      const dist = Math.hypot(nx, ny);

      // Rounded squircle background
      const sq = Math.pow(Math.abs(nx), 4) + Math.pow(Math.abs(ny), 4);
      if (sq > 1.08) {
        buf[idx + 3] = 0;
        continue;
      }

      // Indigo -> Deep Navy gradient
      const t = Math.min(1, Math.max(0, (nx + ny + 2) / 4));
      let R = Math.round(79 * (1 - t) + 17 * t);
      let G = Math.round(70 * (1 - t) + 24 * t);
      let B = Math.round(229 * (1 - t) + 58 * t);
      let A = sq > 0.92 ? Math.round(255 * Math.max(0, (1.08 - sq) / 0.16)) : 255;

      // Glowing orbit ring
      const ringDist = Math.abs(dist - 0.66);
      if (ringDist < 0.11) {
        const glow = 1 - ringDist / 0.11;
        R = Math.round(R + (56 - R) * glow * 0.85);
        G = Math.round(G + (189 - G) * glow * 0.85);
        B = Math.round(B + (248 - B) * glow * 0.85);
      }

      // Stylized "A" chevron pointing upward (antigravity lift)
      const inLeftLeg =
        ny > -0.45 && ny < 0.42 && Math.abs(nx + (ny + 0.45) * 0.48) < 0.11;
      const inRightLeg =
        ny > -0.45 && ny < 0.42 && Math.abs(nx - (ny + 0.45) * 0.48) < 0.11;
      const inBar = ny > 0.04 && ny < 0.18 && Math.abs(nx) < 0.28;
      if (inLeftLeg || inRightLeg || inBar) {
        R = 248;
        G = 250;
        B = 252;
      }

      buf[idx] = R;
      buf[idx + 1] = G;
      buf[idx + 2] = B;
      buf[idx + 3] = A;
    }
  }

  return encodePng(size, size, buf);
}

for (const sz of [16, 32, 48, 128]) {
  const out = path.join(ICONS_DIR, `icon${sz}.png`);
  fs.writeFileSync(out, renderIcon(sz));
  console.log(`Generated ${out}`);
}
