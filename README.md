# Borders · North America

An installable web app that shows North American country borders and US state / Canadian
province / Mexican state borders as separate, toggleable layers. Click a region (or search
for one) to see its name, type, ISO code and the regions it borders.

Built with Vite, TypeScript and [MapLibre GL JS](https://maplibre.org/). The basemap is
[OpenFreeMap](https://openfreemap.org/) Positron, which is free and needs no API key.

## Develop

```bash
npm install
npm run dev
```

## Data

The boundary files in `public/data/` are committed, so you don't need to rebuild them to run
or deploy the app. To regenerate them from Natural Earth:

```bash
npm run data
```

`scripts/build-data.mjs` downloads the shapefiles into `data-src/` (git-ignored) and uses
mapshaper to filter, clip to North America, simplify and export:

| File | Contents |
| --- | --- |
| `countries.geojson` | Natural Earth 1:50m admin-0, every country Natural Earth places in North America |
| `country-lines.geojson` | Interior country borders only (coastlines come from the basemap) |
| `admin1.geojson` | 96 states, provinces, territories and federal districts of the US, Canada and Mexico |
| `admin1-lines.geojson` | Interior admin-1 borders only |
| `regions.json` | Index of names, types, bounding boxes and neighbors for the side panel and search |

Natural Earth's 1:50m admin-1 layer covers the US and Canada but not Mexico, so Mexico's
states come from the 1:10m layer, simplified to a similar level of detail and clipped to the
1:50m Mexico outline. Everything is clipped at the antimeridian, so the far western Aleutians
are left out.

Neighbors are worked out geometrically: two regions are neighbors when several vertices of
one lie within 4 km of the other's outline. That includes borders across lakes (Michigan and
Ontario, for example) but leaves out single-point touches like Four Corners.

## PWA

`vite-plugin-pwa` generates the manifest and a Workbox service worker. The app shell and the
boundary data are precached, so the borders work offline; basemap tiles you've already viewed
are cached as you browse. Icons are generated from `public/icon.svg`:

```bash
npm run icons
```

## Deploy

`netlify.toml` builds with `npm run build` and publishes `dist/`. Connect the repo in Netlify,
or deploy from the CLI:

```bash
npx netlify deploy --build --prod
```

## Credits

Boundaries: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
Basemap: © [OpenFreeMap](https://openfreemap.org/), © [OpenMapTiles](https://openmaptiles.org/),
data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
