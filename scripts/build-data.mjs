// Builds the simplified North America boundary data in public/data from Natural Earth.
//
//   npm run data
//
// Downloads Natural Earth shapefiles into data-src/ (git-ignored) on first run, then uses
// mapshaper to filter, clip, simplify and export GeoJSON. Also writes regions.json, an index
// of every clickable feature with its bounding box and neighbours, used by the side panel.
//
// Natural Earth's 1:50m admin-1 layer covers the US and Canada but not Mexico, so Mexico's
// states come from the 1:10m layer, simplified to a similar level of detail and clipped to
// the 1:50m Mexico outline so their coastline matches the country layer.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import mapshaper from 'mapshaper';

const SRC = 'data-src';
const TMP = `${SRC}/tmp`;
const OUT = 'public/data';
const NE = 'https://naciscdn.org/naturalearth';

// Western hemisphere box from the Aleutians to Greenland, south to Panama.
const BBOX = '-180,5,-50,84';

const SOURCES = {
  ne_50m_admin_0_countries: `${NE}/50m/cultural/ne_50m_admin_0_countries.zip`,
  ne_50m_admin_1_states_provinces: `${NE}/50m/cultural/ne_50m_admin_1_states_provinces.zip`,
  ne_10m_admin_1_states_provinces: `${NE}/10m/cultural/ne_10m_admin_1_states_provinces.zip`,
};

const COUNTRY_NAMES = { USA: 'United States', CAN: 'Canada', MEX: 'Mexico' };

// Natural Earth names that are out of date or ambiguous.
const RENAME = {
  'MX-DIF': { name: 'Mexico City', kind: 'Federal entity' },
  'MX-MEX': { name: 'State of Mexico' },
};

mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

for (const [name, url] of Object.entries(SOURCES)) {
  if (existsSync(`${SRC}/${name}.shp`)) continue;
  console.log(`Downloading ${url}`);
  const zip = `${SRC}/${name}.zip`;
  execFileSync('curl', ['-sSLf', '-o', zip, url], { stdio: 'inherit' });
  execFileSync('unzip', ['-oq', zip, '-d', SRC], { stdio: 'inherit' });
}

const run = (cmd) => mapshaper.runCommands(cmd.replace(/\s+/g, ' ').trim());

// Countries: every Natural Earth "North America" country, clipped to the box.
await run(`
  -i ${SRC}/ne_50m_admin_0_countries.shp
  -filter "CONTINENT == 'North America'"
  -clip bbox=${BBOX}
  -simplify 35% keep-shapes
  -clean
  -each "id = ADM0_A3, name = NAME_LONG || NAME"
  -filter-fields id,name
  -o ${OUT}/countries.geojson format=geojson precision=0.0001 force
`);

// Interior country borders only; coastlines come from the basemap.
await run(`
  -i ${OUT}/countries.geojson
  -innerlines
  -o ${OUT}/country-lines.geojson format=geojson geojson-type=FeatureCollection precision=0.0001 force
`);

// Mexico outline, used to clip the 1:10m states.
await run(`
  -i ${OUT}/countries.geojson
  -filter "id == 'MEX'"
  -o ${TMP}/mex-outline.json format=geojson force
`);

await run(`
  -i ${SRC}/ne_10m_admin_1_states_provinces.shp
  -filter "adm0_a3 == 'MEX' && name !== ''"
  -simplify interval=2500 keep-shapes
  -clip ${TMP}/mex-outline.json
  -clean
  -filter-fields adm0_a3,name,type_en,iso_3166_2
  -o ${TMP}/mex-states.json format=geojson force
`);

await run(`
  -i ${SRC}/ne_50m_admin_1_states_provinces.shp
  -filter "adm0_a3 == 'USA' || adm0_a3 == 'CAN'"
  -clip bbox=${BBOX}
  -simplify 35% keep-shapes
  -filter-islands min-area=20km2 remove-empty
  -clean
  -filter-fields adm0_a3,name,type_en,iso_3166_2
  -o ${TMP}/us-ca-states.json format=geojson force
`);

// Interior state/province borders. US and Canada share a source (and topology); Mexico is
// separate, but its outer edges are international borders already drawn by country-lines.
for (const name of ['us-ca-states', 'mex-states']) {
  await run(`-i ${TMP}/${name}.json -innerlines -o ${TMP}/${name}-lines.json format=geojson geojson-type=FeatureCollection precision=0.0001 force`);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const admin1 = {
  type: 'FeatureCollection',
  features: [...readJson(`${TMP}/us-ca-states.json`).features, ...readJson(`${TMP}/mex-states.json`).features]
    .map((f) => {
      const p = f.properties;
      const fix = RENAME[p.iso_3166_2] ?? {};
      return {
        type: 'Feature',
        properties: {
          id: p.iso_3166_2,
          name: fix.name ?? p.name,
          country: p.adm0_a3,
          kind: fix.kind ?? p.type_en,
        },
        geometry: f.geometry,
      };
    })
    .sort((a, b) => a.properties.id.localeCompare(b.properties.id)),
};

const countries = readJson(`${OUT}/countries.geojson`);

// ---- Region index: bounding boxes and neighbours ----

function rings(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function bbox(geometry) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings(geometry)) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1].map((n) => Math.round(n * 1000) / 1000);
}

const KM_PER_DEG = 111.32;

// Distance in km from point p to segment ab, using a local equirectangular projection.
function pointSegmentKm(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * KM_PER_DEG;
}

// Two regions are neighbours when several vertices of one lie within TOL_KM of the other's
// outline. The tolerance absorbs the slight mismatch between the 1:50m US and 1:10m Mexico
// borders; requiring more than one vertex skips single-point touches like Four Corners.
const TOL_KM = 4;
const MIN_HITS = 3;

function touches(a, b) {
  const pad = TOL_KM / KM_PER_DEG / 0.3;
  if (a.bbox[0] > b.bbox[2] + pad || b.bbox[0] > a.bbox[2] + pad) return false;
  if (a.bbox[1] > b.bbox[3] + pad || b.bbox[1] > a.bbox[3] + pad) return false;
  const bRings = rings(b.geometry);
  let hits = 0;
  for (const ring of rings(a.geometry)) {
    for (const p of ring) {
      for (const r of bRings) {
        let near = false;
        for (let i = 1; i < r.length; i++) {
          if (pointSegmentKm(p, r[i - 1], r[i]) <= TOL_KM) { near = true; break; }
        }
        if (near) { if (++hits >= MIN_HITS) return true; break; }
      }
    }
  }
  return false;
}

const regions = admin1.features.map((f) => ({ ...f.properties, geometry: f.geometry, bbox: bbox(f.geometry) }));
const neighbours = new Map(regions.map((r) => [r.id, []]));
for (let i = 0; i < regions.length; i++) {
  for (let j = i + 1; j < regions.length; j++) {
    if (touches(regions[i], regions[j]) || touches(regions[j], regions[i])) {
      neighbours.get(regions[i].id).push(regions[j].id);
      neighbours.get(regions[j].id).push(regions[i].id);
    }
  }
}

const index = {
  attribution: 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
  countries: Object.fromEntries(
    countries.features.map((f) => [f.properties.id, { name: COUNTRY_NAMES[f.properties.id] ?? f.properties.name, bbox: bbox(f.geometry) }]),
  ),
  regions: Object.fromEntries(
    regions.map((r) => [
      r.id,
      {
        name: r.name,
        country: r.country,
        kind: r.kind,
        bbox: r.bbox,
        neighbors: neighbours.get(r.id).sort((a, b) => regions.find((x) => x.id === a).name.localeCompare(regions.find((x) => x.id === b).name)),
      },
    ]),
  ),
};

writeFileSync(`${OUT}/admin1.geojson`, JSON.stringify(admin1));
writeFileSync(
  `${OUT}/admin1-lines.geojson`,
  JSON.stringify({
    type: 'FeatureCollection',
    features: ['us-ca-states', 'mex-states'].flatMap((n) => readJson(`${TMP}/${n}-lines.json`).features),
  }),
);
writeFileSync(`${OUT}/regions.json`, JSON.stringify(index));

console.log(`countries: ${countries.features.length}, admin-1 regions: ${admin1.features.length}`);
