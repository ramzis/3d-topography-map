# 3D Topography Map

An interactive, exaggerated-relief 3D topographic map — hills, valleys and
rivers rendered from open elevation data with satellite imagery, ward
boundaries, and place names. Terrain and imagery stream in as you move,
Minecraft-chunk style, starting over Vilnius and extending anywhere you fly.

## Run

```bash
npm install
npm run dev   # → http://localhost:8080 (requires internet)
```

Headless tests for the streaming view loader (no browser, no network —
browser APIs are stubbed):

```bash
npm test
```

Tiles are cached in memory (30 min) and by the browser HTTP cache, so
revisited areas appear instantly.

## GitHub Pages

The site is fully static (three.js is vendored in `vendor/`, no build step):

1. Push this repository to GitHub
2. Repo **Settings → Pages → Source: Deploy from a branch**
3. Branch: `master`, folder: `/ (root)`

It will be served at `https://<user>.github.io/<repo>/` — all asset paths
are relative, so the subpath needs no configuration. The `.nojekyll` file
in the repo root keeps GitHub's Jekyll processing off.

## Controls

- **Desktop** — spectator fly camera: click the view to capture the mouse,
  then WASD — move (pitch-following), Space / C — up / down, Shift — sprint,
  mouse wheel — speed, Esc — release the mouse. Ground collision keeps the
  camera above the surface.
- **Touch** — one finger orbit, pinch zoom, two-finger pan. Tap ⚙ for the
  slider.
- **Search & teleport** — type a place name in the search box (OpenStreetMap
  Nominatim geocoding, debounced); clicking a result shows a "✈️ Flying
  to…" overlay with a spinner, teleports the camera there, and stays until
  the destination's terrain chunks with imagery are loaded.
- **Vertical exaggeration** slider, 1×–60× (default 6×).

## How it works

- **Chunks** — one Terrarium z13 elevation tile ≈ 2.83 km of ground per chunk.
  Each chunk is a 37 × 37-vertex mesh (79 m vertex spacing) with absolute
  elevations, so neighboring chunks meet with no seams.
- **Streaming** — the visible ground area is derived by raycasting the
  screen corners onto the terrain plane; up to 60 chunks covering it are
  queued with a 6-request concurrency limit and disposed when far away.
- **Imagery LOD** — satellite texture sharpens automatically as you get
  closer:

  | camera distance to chunk | imagery zoom | resolution | tiles/chunk |
  |---|---|---|---|
  | far | 13 | ~11 m/px | 1 |
  | < 12 km | 15 | ~2.8 m/px | 4 |
  | < 2.5 km | 16 | ~1.4 m/px | 64 |

  The z16 tier applies only to the 3 closest chunks, one upgrade in flight,
  and only while no terrain chunks are loading. Chunks stay hidden until
  their imagery arrives (flat-color fallback only if imagery fails).
- **Elevation decoding** — terrarium tiles are decoded by a dependency-free
  pure-JS PNG decoder (`js/png-decoder.js`) rather than the browser's
  ImageBitmap/canvas path, because color-managed image decoding on
  wide-gamut displays perturbs elevation-encoded RGB values.
- **Overlays** — a name label sits at each Vilnius seniūnija centroid;
  additional place names (cities, towns, villages) stream from OpenStreetMap
  via the Overpass API as you fly. Labels fade out below readable size.
- **Coordinate system** — local mercator meters around the Vilnius center,
  scaled by cos(lat): 1 scene unit ≈ 100 m horizontally and vertically.

`window.__vilniusDebug.counts()` returns
`{wards, labels, chunks, loading, placeNames}`.

## Data sources

- **Elevation**: Mapzen/Tilezen Terrarium tiles, AWS Registry of Open Data.
- **Imagery**: Esri World Imagery (© Esri, Maxar, Earthstar Geographics).
- **Ward boundaries**: Vilniaus miesto savivaldybė / UAB ID Vilnius.
- **Place names**: OpenStreetMap contributors (Overpass API).

## Layout

```
js/geo.js          slippy/mercator math, cached tile fetchers, LOD-ready imagery compositing
js/png-decoder.js  pure-JS PNG decoder for elevation tiles
js/chunks.js       Chunk + ChunkManager (viewport-driven load/dispose, imagery LOD)
js/wards.js        ward boundaries + centroid labels
js/places.js       streaming place names (Overpass)
js/search.js       place search UI (Nominatim geocoding)
js/teleport.js     teleport + "Flying" overlay + arrival detection
js/fly.js          WASD + pointer-lock spectator fly camera
js/labels.js       canvas-texture name sprites
js/analytics.js    consent-gated Google Analytics + 🍪 banner
js/app.js          scene, UI wiring, render loop
```

## Limitations

- A very zoomed-out view is capped at 60 chunks and thus incomplete.
- Terrain elevation uses a fixed zoom level (z13).
- Ward boundary segments crossing chunk borders take their heights from the
  chunk of their midpoint (tiny kinks possible at borders).
