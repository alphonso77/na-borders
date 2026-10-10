import {
  MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre runs tile parsing in a module worker; let Vite bundle it as a standalone file.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { registerSW } from 'virtual:pwa-register';
import './style.css';

// ---------- Data ----------

type BBox = [number, number, number, number];

interface Region {
  name: string;
  country: string;
  kind: string;
  bbox: BBox;
  neighbors: string[];
}

interface Country {
  name: string;
  bbox: BBox;
}

interface RegionIndex {
  countries: Record<string, Country>;
  regions: Record<string, Region>;
}

type Selection = { type: 'region' | 'country'; id: string } | null;
type Focus = 'all' | 'USA' | 'CAN' | 'MEX';

// Free, key-less vector basemap.
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const DATA = '/data';

const COLORS = {
  accent: '#9A2B1E',
  water: '#CBD9DC',
  land: '#E3E4DA',
  countryLine: '#2F3D35',
  admin1Line: '#6F7E74',
  hover: '#D7DFD2',
  dimmed: '#E4E6DE',
  otherCountry: '#ECEDE6',
  base: { USA: '#F2F0E6', CAN: '#EBEEE3', MEX: '#F1EADF' } as Record<string, string>,
};

// Lighten a hex colour towards white by t (0–1).
function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

const SELECTED_FILL = tint(COLORS.accent, 0.55);
const NEIGHBOR_FILL = tint(COLORS.accent, 0.86);

const ALL_BOUNDS: LngLatBoundsLike = [
  [-170, 7],
  [-50, 72],
];

// The US bbox spans Alaska and Hawaii, so focus on the lower 48 instead.
const FOCUS_BOUNDS: Partial<Record<Focus, LngLatBoundsLike>> = {
  all: ALL_BOUNDS,
  USA: [
    [-125, 24],
    [-66.5, 49.5],
  ],
};

const COUNTRY_PHRASE: Record<string, string> = {
  USA: 'the United States',
  CAN: 'Canada',
  // "State of Mexico" is itself a state's name, so use the formal country name.
  MEX: 'the United Mexican States',
};

// ---------- DOM ----------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const details = $<HTMLElement>('#details');
const tooltip = $<HTMLDivElement>('#tooltip');
const searchInput = $<HTMLInputElement>('#search');
const searchResults = $<HTMLUListElement>('#search-results');
const toggleCountries = $<HTMLInputElement>('#toggle-countries');
const toggleAdmin1 = $<HTMLInputElement>('#toggle-admin1');
const toggleLabels = $<HTMLInputElement>('#toggle-labels');
const segments = [...document.querySelectorAll<HTMLButtonElement>('.segments button')];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Map ----------

const index: RegionIndex = await fetch(`${DATA}/regions.json`).then((r) => r.json());

setWorkerUrl(workerUrl);

const map = new MapLibreMap({
  container: 'map',
  style: BASEMAP_STYLE,
  bounds: ALL_BOUNDS,
  fitBoundsOptions: { padding: 24 },
  minZoom: 1.5,
  maxZoom: 12,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();

map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

let selection: Selection = null;
let hovered: Selection = null;
let focus: Focus = 'all';
let labelLayerIds: string[] = [];

const state = (sel: Selection) =>
  sel && { source: sel.type === 'region' ? 'admin1' : 'countries', id: sel.id };

function setState(sel: Selection, values: Record<string, boolean>) {
  const target = state(sel);
  if (target && map.getSource(target.source)) map.setFeatureState(target, values);
}

const fs = (key: string): ExpressionSpecification => ['boolean', ['feature-state', key], false];

map.on('load', () => {
  // Restyle the basemap to the app's palette and drop its own borders; ours replace them.
  const style = map.getStyle();
  for (const layer of style.layers) {
    if ('source-layer' in layer && layer['source-layer'] === 'boundary') {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }
  map.setPaintProperty('background', 'background-color', COLORS.land);
  if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', COLORS.water);
  labelLayerIds = style.layers.filter((l) => l.type === 'symbol').map((l) => l.id);
  const firstLabel = labelLayerIds[0];

  map.addSource('countries', { type: 'geojson', data: `${DATA}/countries.geojson`, promoteId: 'id' });
  map.addSource('country-lines', { type: 'geojson', data: `${DATA}/country-lines.geojson` });
  map.addSource('admin1', { type: 'geojson', data: `${DATA}/admin1.geojson`, promoteId: 'id' });
  map.addSource('admin1-lines', { type: 'geojson', data: `${DATA}/admin1-lines.geojson` });

  const baseFill: ExpressionSpecification = [
    'match',
    ['get', 'id'],
    ...Object.entries(COLORS.base).flat(),
    COLORS.otherCountry,
  ] as unknown as ExpressionSpecification;

  map.addLayer(
    {
      id: 'countries-fill',
      type: 'fill',
      source: 'countries',
      paint: {
        'fill-color': [
          'case',
          fs('selected'), SELECTED_FILL,
          fs('hover'), COLORS.hover,
          fs('dimmed'), COLORS.dimmed,
          baseFill,
        ],
        'fill-opacity': ['case', fs('dimmed'), 0.75, 0.9],
      },
    },
    firstLabel,
  );

  // Transparent unless highlighted; still clickable because hit-testing is geometric.
  map.addLayer(
    {
      id: 'admin1-fill',
      type: 'fill',
      source: 'admin1',
      paint: {
        'fill-color': [
          'case',
          fs('selected'), SELECTED_FILL,
          fs('hover'), COLORS.hover,
          fs('neighbor'), NEIGHBOR_FILL,
          'rgba(0, 0, 0, 0)',
        ],
      },
    },
    firstLabel,
  );

  map.addLayer(
    {
      id: 'admin1-lines',
      type: 'line',
      source: 'admin1-lines',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': COLORS.admin1Line,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 6, 1.4, 10, 2],
        'line-dasharray': [3, 2],
      },
    },
    firstLabel,
  );

  map.addLayer(
    {
      id: 'country-lines',
      type: 'line',
      source: 'country-lines',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': COLORS.countryLine,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 6, 2.2, 10, 3],
      },
    },
    firstLabel,
  );

  for (const [id, source] of [
    ['countries-selected', 'countries'],
    ['admin1-selected', 'admin1'],
  ] as const) {
    map.addLayer(
      {
        id,
        type: 'line',
        source,
        filter: ['==', ['get', 'id'], ''],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': COLORS.accent, 'line-width': 2.6 },
      },
      firstLabel,
    );
  }

  applyToggles();
  applyFocus(false);
  const fromHash = selectionFromHash();
  if (fromHash) select(fromHash, { zoom: true });
  else renderDetails();
});

// ---------- Layer toggles ----------

function setVisible(layerId: string, visible: boolean) {
  if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

function applyToggles() {
  setVisible('country-lines', toggleCountries.checked);
  // With state borders hidden, clicks fall through to the country underneath.
  for (const id of ['admin1-lines', 'admin1-fill', 'admin1-selected']) setVisible(id, toggleAdmin1.checked);
  for (const id of labelLayerIds) setVisible(id, toggleLabels.checked);
}

toggleCountries.addEventListener('change', applyToggles);
toggleLabels.addEventListener('change', applyToggles);
toggleAdmin1.addEventListener('change', () => {
  applyToggles();
  if (!toggleAdmin1.checked && selection?.type === 'region') {
    select({ type: 'country', id: index.regions[selection.id].country });
  }
});

// ---------- Country focus ----------

function applyFocus(animate = true) {
  for (const btn of segments) btn.setAttribute('aria-pressed', String(btn.dataset.focus === focus));
  for (const id of Object.keys(index.countries)) {
    setState({ type: 'country', id }, { dimmed: focus !== 'all' && id !== focus });
  }
  const bounds = FOCUS_BOUNDS[focus] ?? (index.countries[focus].bbox as LngLatBoundsLike);
  map.fitBounds(bounds, { padding: 32, animate: animate && !reduceMotion, duration: 700 });
}

for (const btn of segments) {
  btn.addEventListener('click', () => {
    focus = btn.dataset.focus as Focus;
    applyFocus();
  });
}

// ---------- Selection ----------

function regionAt(e: MapMouseEvent): Selection {
  const layers = ['admin1-fill', 'countries-fill'].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  const [feature]: MapGeoJSONFeature[] = map.queryRenderedFeatures(e.point, { layers });
  if (!feature) return null;
  const id = String(feature.properties.id);
  return { type: feature.source === 'admin1' ? 'region' : 'country', id };
}

const same = (a: Selection, b: Selection) => a?.type === b?.type && a?.id === b?.id;

function setHover(next: Selection) {
  if (same(next, hovered)) return;
  setState(hovered, { hover: false });
  hovered = next;
  setState(hovered, { hover: true });
}

function zoomTo(sel: NonNullable<Selection>) {
  const bbox = sel.type === 'region' ? index.regions[sel.id].bbox : index.countries[sel.id].bbox;
  const bounds = sel.type === 'country' && FOCUS_BOUNDS[sel.id as Focus] ? FOCUS_BOUNDS[sel.id as Focus]! : (bbox as LngLatBoundsLike);
  map.fitBounds(bounds, { padding: 60, maxZoom: 7.5, animate: !reduceMotion, duration: 800 });
}

function select(next: Selection, opts: { zoom?: boolean } = {}) {
  if (selection) {
    setState(selection, { selected: false });
    if (selection.type === 'region') {
      for (const n of index.regions[selection.id].neighbors) setState({ type: 'region', id: n }, { neighbor: false });
    }
  }

  selection = next && (next.type === 'region' ? index.regions[next.id] : index.countries[next.id]) ? next : null;

  if (selection) {
    // Picking a state (from search, a chip or the URL) brings the state layer back.
    if (selection.type === 'region' && !toggleAdmin1.checked) {
      toggleAdmin1.checked = true;
      applyToggles();
    }
    setState(selection, { selected: true });
    if (selection.type === 'region') {
      for (const n of index.regions[selection.id].neighbors) setState({ type: 'region', id: n }, { neighbor: true });
    }
    if (opts.zoom) zoomTo(selection);
  }

  map.setFilter('admin1-selected', ['==', ['get', 'id'], selection?.type === 'region' ? selection.id : '']);
  map.setFilter('countries-selected', ['==', ['get', 'id'], selection?.type === 'country' ? selection.id : '']);

  // Keep the selection in the URL so it can be shared; replaceState doesn't fire hashchange.
  history.replaceState(null, '', selection ? `#${selection.id}` : location.pathname + location.search);
  renderDetails();
}

function selectionFromHash(): Selection {
  const id = decodeURIComponent(location.hash.slice(1));
  if (index.regions[id]) return { type: 'region', id };
  if (index.countries[id]) return { type: 'country', id };
  return null;
}

window.addEventListener('hashchange', () => select(selectionFromHash(), { zoom: true }));

map.on('click', (e) => select(regionAt(e)));

map.on('mousemove', (e) => {
  const hit = regionAt(e);
  setHover(hit);
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
  if (hit) {
    const { name, countryName } = describe(hit);
    tooltip.innerHTML = `${escapeHtml(name)}${countryName && hit.type === 'region' ? `<small>${escapeHtml(countryName)}</small>` : ''}`;
    const w = map.getContainer().clientWidth;
    tooltip.style.left = `${Math.min(e.point.x + 16, w - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${Math.max(e.point.y - 44, 8)}px`;
    tooltip.hidden = false;
  } else {
    tooltip.hidden = true;
  }
});

map.getCanvas().addEventListener('mouseleave', () => {
  setHover(null);
  tooltip.hidden = true;
});

// ---------- Side panel ----------

function describe(sel: NonNullable<Selection>) {
  if (sel.type === 'region') {
    const r = index.regions[sel.id];
    const countryName = index.countries[r.country]?.name ?? r.country;
    return { name: r.name, countryName, kind: `${r.kind} of ${COUNTRY_PHRASE[r.country] ?? countryName}` };
  }
  const c = index.countries[sel.id];
  return { name: c.name, countryName: c.name, kind: 'Country' };
}

const CLOSE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function renderDetails() {
  if (!selection) {
    const n = Object.keys(index.regions).length;
    details.innerHTML = `
      <h2 class="prompt">Pick a place</h2>
      <p>Click any of the ${n} states, provinces and territories on the map, or any country, or search for one by name.</p>`;
    return;
  }

  const sel = selection;
  const { name, countryName, kind } = describe(sel);
  let facts = '';
  let neighbors = '';

  if (sel.type === 'region') {
    const r = index.regions[sel.id];
    facts = `
      <div><dt>Country</dt><dd>${escapeHtml(countryName)}</dd></div>
      <div><dt>ISO 3166-2</dt><dd>${escapeHtml(sel.id)}</dd></div>`;
    const chips = r.neighbors
      .map((id) => {
        const n = index.regions[id];
        const foreign = n.country !== r.country ? `<small>${escapeHtml(index.countries[n.country]?.name ?? n.country)}</small>` : '';
        return `<button type="button" class="chip" data-region="${escapeHtml(id)}">${escapeHtml(n.name)}${foreign}</button>`;
      })
      .join('');
    neighbors = `
      <div>
        <div class="sub-label">${r.neighbors.length ? 'Shares a border with' : 'No land borders with other states or provinces'}</div>
        ${chips ? `<div class="chips">${chips}</div>` : ''}
      </div>`;
  } else {
    const count = Object.values(index.regions).filter((r) => r.country === sel.id).length;
    facts = `
      <div><dt>ISO 3166-1</dt><dd>${escapeHtml(sel.id)}</dd></div>
      ${count ? `<div><dt>States &amp; provinces</dt><dd>${count}</dd></div>` : ''}`;
  }

  details.innerHTML = `
    <div class="details-head">
      <div>
        <h2>${escapeHtml(name)}</h2>
        <div class="kind">${escapeHtml(kind)}</div>
      </div>
      <button type="button" class="icon-btn" data-action="clear" aria-label="Clear selection">${CLOSE_ICON}</button>
    </div>
    <dl class="facts">${facts}</dl>
    ${neighbors}
    <button type="button" class="primary" data-action="zoom">Zoom to ${escapeHtml(name)}</button>`;
  details.closest('.panel')!.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

details.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!target) return;
  if (target.dataset.action === 'clear') select(null);
  else if (target.dataset.action === 'zoom' && selection) zoomTo(selection);
  else if (target.dataset.region) select({ type: 'region', id: target.dataset.region });
});

details.addEventListener('mouseover', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-region]');
  setHover(chip ? { type: 'region', id: chip.dataset.region! } : null);
});
details.addEventListener('mouseleave', () => setHover(null));

// ---------- Search ----------

interface SearchEntry {
  sel: NonNullable<Selection>;
  name: string;
  context: string;
  key: string;
}

const searchEntries: SearchEntry[] = [
  ...Object.entries(index.regions).map(([id, r]) => ({
    sel: { type: 'region' as const, id },
    name: r.name,
    context: index.countries[r.country]?.name ?? r.country,
    key: normalize(r.name),
  })),
  ...Object.entries(index.countries).map(([id, c]) => ({
    sel: { type: 'country' as const, id },
    name: c.name,
    context: 'Country',
    key: normalize(c.name),
  })),
];

let results: SearchEntry[] = [];
let active = -1;

function renderResults() {
  const q = normalize(searchInput.value.trim());
  if (!q) {
    searchResults.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    results = [];
    return;
  }
  results = searchEntries
    .filter((e) => e.key.includes(q))
    .sort((a, b) => a.key.indexOf(q) - b.key.indexOf(q) || a.name.localeCompare(b.name))
    .slice(0, 7);
  active = Math.min(active, results.length - 1);

  searchResults.innerHTML = results.length
    ? results
        .map(
          (r, i) =>
            `<li role="option" id="result-${i}" data-index="${i}" aria-selected="${i === active}"><span>${escapeHtml(r.name)}</span><span class="small muted">${escapeHtml(r.context)}</span></li>`,
        )
        .join('')
    : '<li class="empty" role="option" aria-disabled="true">No country, state or province matches that name.</li>';
  searchResults.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  if (active >= 0) searchInput.setAttribute('aria-activedescendant', `result-${active}`);
  else searchInput.removeAttribute('aria-activedescendant');
}

function choose(entry: SearchEntry | undefined) {
  if (!entry) return;
  searchInput.value = '';
  active = -1;
  renderResults();
  select(entry.sel, { zoom: true });
}

searchInput.addEventListener('input', () => {
  active = -1;
  renderResults();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    active = (active + step + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(results[Math.max(active, 0)]);
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    renderResults();
  }
});

// mousedown rather than click so the choice lands before the input blurs.
searchResults.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
  if (!li) return;
  e.preventDefault();
  choose(results[Number(li.dataset.index)]);
});

searchInput.addEventListener('blur', () => {
  searchResults.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
});
searchInput.addEventListener('focus', renderResults);

// Fill the panel straight away; a selection from the URL is applied once the map loads.
renderDetails();

// ---------- PWA ----------

registerSW({ immediate: true });
