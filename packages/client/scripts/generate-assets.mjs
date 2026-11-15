/**
 * Generates the placeholder art for the MVP: a seamless water tile and three
 * top-down ship sprites, all written out as PNG files with **zero dependencies**
 * (Node's built-in zlib + a hand-rolled chunk writer).
 *
 * Why procedural: the brief allows either free kenney.nl art or coloured
 * placeholders, and the sandbox has no outbound access to kenney.nl. Generating
 * the sprites from code keeps the repository free of binary blobs we cannot
 * license, and produces genuinely seamless tiles (the wave frequencies are whole
 * multiples of the tile size, so the pattern wraps perfectly).
 *
 * Run with `pnpm assets:generate` (or `pnpm --filter @warship/client run assets:generate`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'assets');

/* -------------------------------------------------------------------------- */
/*  Minimal PNG encoder (8-bit RGBA, no filtering)                            */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode raw RGBA pixels into a PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // One filter byte (0 = None) per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/*  Colour helpers                                                            */
/* -------------------------------------------------------------------------- */

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)));

/** Smooth 0..1 ramp. */
const smooth = (t) => t * t * (3 - 2 * t);

/** Deterministic value noise, so regenerating always yields identical files. */
function hash2(x, y, seed = 0) {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* -------------------------------------------------------------------------- */
/*  Water tile                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A 256×256 seamless ocean tile.
 *
 * Seamlessness: every sine term uses an integer number of periods across the
 * tile, and the noise lattice wraps with a modulo, so the left edge joins the
 * right edge and the top joins the bottom exactly.
 */
function generateWaterTile(size = 256) {
  const pixels = new Uint8Array(size * size * 4);

  const periods = [
    { kx: 1, ky: 2, amp: 0.3, phase: 0.0 },
    { kx: 3, ky: 1, amp: 0.18, phase: 1.7 },
    { kx: 2, ky: 5, amp: 0.1, phase: 3.1 },
    { kx: 7, ky: 3, amp: 0.06, phase: 0.9 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;

      let wave = 0;
      for (const { kx, ky, amp, phase } of periods) {
        wave += amp * Math.sin(2 * Math.PI * (kx * u + ky * v) + phase);
      }

      // Wrap-safe value noise: sample a 16×16 lattice modulo its own size.
      const lattice = 16;
      const gx = (x / size) * lattice;
      const gy = (y / size) * lattice;
      const x0 = Math.floor(gx) % lattice;
      const y0 = Math.floor(gy) % lattice;
      const x1 = (x0 + 1) % lattice;
      const y1 = (y0 + 1) % lattice;
      const tx = smooth(gx - Math.floor(gx));
      const ty = smooth(gy - Math.floor(gy));
      const n00 = hash2(x0, y0, 7);
      const n10 = hash2(x1, y0, 7);
      const n01 = hash2(x0, y1, 7);
      const n11 = hash2(x1, y1, 7);
      const noise = (n00 * (1 - tx) + n10 * tx) * (1 - ty) + (n01 * (1 - tx) + n11 * tx) * ty;

      const shade = clamp255(255 * (0.5 + wave * 0.5));
      const t = wave * 0.55 + (noise - 0.5) * 0.45;

      // Deep teal → brighter cyan crest.
      const r = 18 + t * 26 + (shade - 128) * 0.05;
      const g = 58 + t * 54;
      const b = 96 + t * 74;

      const index = (y * size + x) * 4;
      pixels[index] = clamp255(r);
      pixels[index + 1] = clamp255(g);
      pixels[index + 2] = clamp255(b);
      pixels[index + 3] = 255;
    }
  }

  return { width: size, height: size, pixels };
}

/* -------------------------------------------------------------------------- */
/*  Ship sprites                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Draw a top-down ship.
 *
 * Each hull is described by a normalised silhouette (bow at the top, stern at the
 * bottom) so all three sprites share shading code and only differ in proportions
 * and deck detail.
 */
function generateShip({ size, hullWidth, hullLength, color, accent, turrets }) {
  const pixels = new Uint8Array(size * size * 4);

  const cx = size / 2;
  const halfLength = (size * hullLength) / 2;
  const halfWidth = (size * hullWidth) / 2;

  /** Is this point inside the hull silhouette? */
  const insideHull = (px, py) => {
    const ny = (py - (size / 2 - halfLength)) / (2 * halfLength); // 0 = bow, 1 = stern
    if (ny < 0 || ny > 1) return false;
    // Taper: full beam amidships, narrow bow, slightly narrow stern.
    const bowTaper = Math.min(1, ny / 0.28); // 0 at bow tip → 1 at 28% aft
    const sternTaper = Math.min(1, (1 - ny) / 0.16);
    const widthScale = Math.sin(Math.PI * Math.min(1, ny * 0.92 + 0.04)) * bowTaper * sternTaper;
    const halfBeam = halfWidth * Math.max(0, widthScale);
    return Math.abs(px - cx) <= halfBeam;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (insideHull(x, y)) {
        // Slight vertical gradient + edge shading for depth.
        const depth = (y - (size / 2 - halfLength)) / (2 * halfLength);
        const edge = 1 - Math.min(1, Math.abs(x - cx) / halfWidth) * 0.55;
        const shade = 0.72 + 0.28 * edge;
        r = color.r * shade;
        g = color.g * shade;
        b = color.b * shade;
        a = 255;

        // Deck stripe down the centreline.
        if (Math.abs(x - cx) < halfWidth * 0.18 && depth > 0.2 && depth < 0.86) {
          r = accent.r;
          g = accent.g;
          b = accent.b;
        }
      }

      pixels[index] = clamp255(r);
      pixels[index + 1] = clamp255(g);
      pixels[index + 2] = clamp255(b);
      pixels[index + 3] = a;
    }
  }

  // Turret rings, drawn as filled discs on top of the deck.
  const paintDisc = (ccx, ccy, radius, rgb, ringRgb) => {
    for (let y = Math.floor(ccy - radius); y <= Math.ceil(ccy + radius); y += 1) {
      for (let x = Math.floor(ccx - radius); x <= Math.ceil(ccx + radius); x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.hypot(x - ccx, y - ccy);
        if (dist > radius) continue;
        const index2 = (y * size + x) * 4;
        const isRing = dist > radius * 0.66;
        const c = isRing ? ringRgb : rgb;
        pixels[index2] = clamp255(c.r);
        pixels[index2 + 1] = clamp255(c.g);
        pixels[index2 + 2] = clamp255(c.b);
        pixels[index2 + 3] = 255;
      }
    }
  };

  const deckTop = size / 2 - halfLength;
  const deckSpan = halfLength * 2;
  for (const turret of turrets) {
    paintDisc(cx, deckTop + deckSpan * turret.at, halfWidth * turret.scale, turret.rgb, accent);
  }

  return { width: size, height: size, pixels };
}

const white = { r: 235, g: 240, b: 245 };
const steel = { r: 150, g: 160, b: 170 };
const gunmetal = { r: 60, g: 66, b: 74 };

const SHIPS = [
  {
    file: 'ship-scout.png',
    size: 64,
    hullWidth: 0.42,
    hullLength: 0.86,
    color: { r: 92, g: 168, b: 132 },
    accent: white,
    turrets: [{ at: 0.3, scale: 0.3, rgb: gunmetal }],
  },
  {
    file: 'ship-destroyer.png',
    size: 96,
    hullWidth: 0.4,
    hullLength: 0.88,
    color: { r: 88, g: 118, b: 158 },
    accent: white,
    turrets: [
      { at: 0.26, scale: 0.28, rgb: gunmetal },
      { at: 0.42, scale: 0.26, rgb: gunmetal },
      { at: 0.78, scale: 0.24, rgb: steel },
    ],
  },
  {
    file: 'ship-battleship.png',
    size: 128,
    hullWidth: 0.46,
    hullLength: 0.9,
    color: { r: 104, g: 96, b: 120 },
    accent: white,
    turrets: [
      { at: 0.2, scale: 0.26, rgb: gunmetal },
      { at: 0.34, scale: 0.26, rgb: gunmetal },
      { at: 0.52, scale: 0.3, rgb: steel },
      { at: 0.86, scale: 0.24, rgb: gunmetal },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/*  Emit                                                                      */
/* -------------------------------------------------------------------------- */

function writeAsset(name, { width, height, pixels }) {
  const filePath = join(OUT_DIR, name);
  writeFileSync(filePath, encodePng(width, height, pixels));
  console.log(`  wrote ${name} (${width}\u00d7${height})`);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log('generating placeholder art into packages/client/public/assets');

writeAsset('water-tile.png', generateWaterTile(256));
for (const ship of SHIPS) {
  writeAsset(ship.file, generateShip(ship));
}

console.log('done');
