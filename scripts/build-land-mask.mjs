/**
 * Rasterises Natural Earth's 1:110m land polygons into the checked-in
 * equirectangular land mask the peer globe samples
 * (06-live-test-visualization 6.2).
 *
 * Run: `node scripts/build-land-mask.mjs`
 *
 * The output is committed, so this script never runs in a build, a test, or
 * the browser — there is no production request to Natural Earth or any other
 * map service. Regenerate only when the documented source version changes,
 * and update `app/assets/README.md` when you do.
 *
 * No GDAL, no image library: a scanline fill plus a minimal PNG encoder keeps
 * the whole pipeline reproducible from a stock Node install.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../app/assets/world-land-mask.png");

/** Natural Earth 1:110m Physical Vectors — Land, pinned to release 4.0.0 via
 * the upstream repository's tag so the retrieval is byte-reproducible. */
const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v4.0.0/geojson/ne_110m_land.geojson";
const SOURCE_SHA256 = "58c4f5d673c1ac2c7ddc04817f15e30a124af021bf7a74488c459b91f0f93d6e";

/** 0.25 degrees per pixel. Enough for recognisable coastlines under a dotted
 * globe, small enough that the async room chunk stays cheap. */
const WIDTH = 1440;
const HEIGHT = 720;

/**
 * Every linear ring in the dataset, outer and inner alike. An even-odd
 * scanline fill treats interior rings as holes without needing to know which
 * is which.
 */
function collectRings(geojson) {
  const rings = [];
  const pushPolygon = (polygon) => {
    for (const ring of polygon) rings.push(ring);
  };
  for (const feature of geojson.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon") pushPolygon(geometry.coordinates);
    else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(pushPolygon);
    else throw new Error(`unexpected geometry type: ${geometry.type}`);
  }
  return rings;
}

/** Flat edge list so the inner loop touches numbers rather than nested
 * arrays: [lon0, lat0, lon1, lat1, ...]. */
function buildEdges(rings) {
  const edges = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon0, lat0] = ring[i];
      const [lon1, lat1] = ring[i + 1];
      if (lat0 === lat1) continue; // horizontal edges never cross a scanline
      edges.push(lon0, lat0, lon1, lat1);
    }
  }
  return Float64Array.from(edges);
}

/**
 * One 8-bit greyscale pixel per cell: 255 land, 0 ocean.
 *
 * Row 0 is latitude +90 and column 0 is longitude -180, matching
 * `vectorToUv()` in `app/lib/globe-math.ts` — the two conventions have to
 * agree or the map lands sideways.
 */
function rasterise(edges) {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  const crossings = new Float64Array(256);

  for (let row = 0; row < HEIGHT; row++) {
    const lat = 90 - ((row + 0.5) * 180) / HEIGHT;
    let count = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const lat0 = edges[e + 1];
      const lat1 = edges[e + 3];
      // Half-open comparison: a vertex exactly on the scanline is counted
      // once, not zero or two times.
      if (lat0 > lat !== lat1 > lat) {
        const t = (lat - lat0) / (lat1 - lat0);
        crossings[count++] = edges[e] + t * (edges[e + 2] - edges[e]);
      }
    }
    if (count === 0) continue;

    const spans = crossings.subarray(0, count);
    spans.sort();
    const rowOffset = row * WIDTH;
    for (let i = 0; i + 1 < count; i += 2) {
      // Pixel centres inside [lonStart, lonEnd) are land.
      const from = Math.ceil(((spans[i] + 180) / 360) * WIDTH - 0.5);
      const to = Math.ceil(((spans[i + 1] + 180) / 360) * WIDTH - 0.5);
      for (let x = Math.max(0, from); x < Math.min(WIDTH, to); x++) {
        pixels[rowOffset + x] = 255;
      }
    }
  }
  return pixels;
}

// --- minimal greyscale PNG encoder ------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  // 10..12: deflate / adaptive filtering / no interlace, all zero.

  // Filter type 0 (None) per row. A binary land mask is mostly long runs, so
  // deflate does the real work and a smarter filter buys almost nothing.
  const raw = Buffer.alloc((WIDTH + 1) * HEIGHT);
  for (let row = 0; row < HEIGHT; row++) {
    raw[row * (WIDTH + 1)] = 0;
    Buffer.from(pixels.buffer, row * WIDTH, WIDTH).copy(raw, row * (WIDTH + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- orientation self-check --------------------------------------------------

/** Known points, so a flipped or rotated mask fails here rather than in a
 * screenshot review. */
const PROBES = [
  { name: "Sahara (Algeria)", lat: 25, lon: 3, land: true },
  { name: "Amazon (Brazil)", lat: -5, lon: -60, land: true },
  { name: "Siberia (Russia)", lat: 65, lon: 100, land: true },
  { name: "Central Australia", lat: -25, lon: 133, land: true },
  { name: "Antarctica", lat: -82, lon: 0, land: true },
  { name: "Mid-Pacific", lat: 0, lon: -140, land: false },
  { name: "Mid-Atlantic", lat: 0, lon: -30, land: false },
  { name: "Indian Ocean", lat: -30, lon: 80, land: false },
  { name: "Arctic Ocean", lat: 88, lon: 0, land: false },
];

function verify(pixels) {
  const failures = [];
  for (const probe of PROBES) {
    const x = Math.min(WIDTH - 1, Math.floor(((probe.lon + 180) / 360) * WIDTH));
    const y = Math.min(HEIGHT - 1, Math.floor(((90 - probe.lat) / 180) * HEIGHT));
    const isLand = pixels[y * WIDTH + x] > 127;
    if (isLand !== probe.land) {
      failures.push(`${probe.name}: expected ${probe.land ? "land" : "ocean"}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`land mask orientation check failed:\n  ${failures.join("\n  ")}`);
  }
}

// --- main --------------------------------------------------------------------

const response = await fetch(SOURCE_URL);
if (!response.ok) throw new Error(`fetch failed: ${response.status} ${SOURCE_URL}`);
const sourceBytes = Buffer.from(await response.arrayBuffer());

const digest = createHash("sha256").update(sourceBytes).digest("hex");
if (digest !== SOURCE_SHA256) {
  throw new Error(`source checksum mismatch\n  expected ${SOURCE_SHA256}\n  actual   ${digest}`);
}

const pixels = rasterise(buildEdges(collectRings(JSON.parse(sourceBytes.toString("utf8")))));
verify(pixels);

const png = encodePng(pixels);
writeFileSync(OUT_PATH, png);

const landPixels = pixels.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(1)} KiB`);
console.log(`  land coverage ${((landPixels / pixels.length) * 100).toFixed(1)}%`);
console.log(`  sha256(png) ${createHash("sha256").update(png).digest("hex")}`);
