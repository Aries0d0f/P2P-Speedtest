# Checked-in assets

## `world-land-mask.png`

The equirectangular land/ocean mask the peer globe samples to decide which
dots of its point cloud are land (06-live-test-visualization 6.2).

It is committed deliberately. The globe makes **no runtime request** to
Natural Earth, a tile server, or any other map or location service — the only
network work the room page does is signaling, WebRTC, and the existing
best-effort geo lookup for this browser's own address.

### Provenance

| | |
|---|---|
| Dataset | Natural Earth 1:110m Physical Vectors — **Land** |
| Archive identifier | `ne_110m_land` |
| Version | **4.0.0** |
| Dataset page | <https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/> |
| Retrieved from | <https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v4.0.0/geojson/ne_110m_land.geojson> |
| Source file | `ne_110m_land.geojson`, 138,062 bytes |
| Source SHA-256 | `58c4f5d673c1ac2c7ddc04817f15e30a124af021bf7a74488c459b91f0f93d6e` |
| Retrieval date | 2026-07-30 |
| Terms | Public domain — <https://www.naturalearthdata.com/about/terms-of-use/> |

The download comes from the upstream `natural-earth-vector` repository at its
`v4.0.0` tag rather than the CDN, because the CDN serves whichever release is
current and could not be pinned to the version this plan specifies. The
checksum above is verified on every regeneration; a mismatch aborts the build
rather than silently producing a mask from a different release.

### Coordinate and projection assumptions

- Source coordinates are WGS 84 geographic degrees (EPSG:4326).
- The output is a plain equirectangular (plate carrée) grid: **no** projection
  transform, just a linear lon/lat → pixel mapping.
- Row 0 is latitude **+90**, the last row is latitude −90.
- Column 0 is longitude **−180**, the last column is just short of +180.
- The image seams at ±180; the globe shader samples with wrapping in `u` and
  clamping in `v` so the date line has no visible gap.

This is exactly the convention `vectorToUv()` in `app/lib/globe-math.ts`
implements, and `globe-math.test.ts` pins it. If one changes, both must.

### Format

1440 × 720, 8-bit greyscale PNG, ~11 KiB. Binary: 255 = land, 0 = ocean.
0.25° per pixel, which resolves coastlines well past the density of the dot
cloud that samples it.

### Regenerating

```sh
node scripts/build-land-mask.mjs
```

The script downloads the pinned GeoJSON, verifies the checksum above,
scanline-fills the polygons with an even-odd rule (so interior rings become
holes), checks nine known land/ocean probe points to catch a flipped or
rotated result, and writes the PNG. It needs nothing but a stock Node install
— no GDAL, no image library — and it never runs during `build`, `dev`, or
`test`.
