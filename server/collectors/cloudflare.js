// Tráfico de las zonas de Cloudflare (GraphQL Analytics API, dataset httpRequestsAdaptiveGroups).
// Por cada dominio y rango (6 h, 24 h, 7 d) guarda totales, el periodo anterior, la serie y los desgloses.
import { config } from '../config.js';
import { getState } from '../store.js';

const API = 'https://api.cloudflare.com/client/v4';

export const CF_RANGES = [
  { key: '6h', label: '6 h', seconds: 6 * 3600, bucket: 'datetimeFiveMinutes', step: 300 },
  { key: '24h', label: '24 h', seconds: 24 * 3600, bucket: 'datetimeFifteenMinutes', step: 900 },
  { key: '7d', label: '7 d', seconds: 7 * 86400, bucket: 'datetimeHour', step: 3600 },
];

// Si la API no deja leer los límites del plan, se asumen los del plan Free.
const DEFAULT_LIMITS = { maxDuration: 86400, notOlderThan: 8 * 86400, maxPageSize: 10000 };

// Desgloses: alias -> dimensión y cuántas filas pedir. Rutas y navegadores piden muchas para contar sondeos y bots.
const GROUPS = {
  paths: ['clientRequestPath', 1000],
  countries: ['clientCountryName', 20],
  ips: ['clientIP', 20],
  hosts: ['clientRequestHTTPHost', 20],
  statuses: ['edgeResponseStatus', 50],
  cache: ['cacheStatus', 20],
  browsers: ['userAgentBrowser', 50],
  os: ['userAgentOS', 20],
  actions: ['securityAction', 20],
};

const BOT_BROWSER = /bot|crawl|spider|slurp|preview|monitor|headless/i;
const CACHE_HIT = new Set(['hit', 'stale', 'revalidated', 'updating']);
const BLOCKED_ACTION = /block|challenge|close/i;
const PASSED_ACTION = /solved|bypass/i;

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.cloudflare.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (!res.ok) throw new Error(`Cloudflare GraphQL ${res.status}`);
  return body.data;
}

// "dominio" o "dominio=zoneId". Sin id se busca por nombre (el token necesita Zone → Zone → Read).
const zoneIds = new Map();
async function zoneId(entry) {
  const [name, id] = entry.split('=').map((s) => s.trim());
  if (id) return { name, id };
  if (!zoneIds.has(name)) {
    const res = await fetch(`${API}/zones?name=${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${config.cloudflare.token}` } });
    const body = await res.json().catch(() => ({}));
    const found = body.result?.[0]?.id;
    if (!found) throw new Error(`zona ${name} no encontrada (da el id en CF_ZONES o añade Zone → Zone → Read al token)`);
    zoneIds.set(name, found);
  }
  return { name, id: zoneIds.get(name) };
}

async function limits(zoneTag) {
  try {
    const data = await graphql(
      `query($zoneTag: string) { viewer { zones(filter: { zoneTag: $zoneTag }) { settings { httpRequestsAdaptiveGroups { maxDuration notOlderThan maxPageSize } } } } }`,
      { zoneTag },
    );
    const s = data.viewer.zones[0]?.settings?.httpRequestsAdaptiveGroups;
    return s ? { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) } : DEFAULT_LIMITS;
  } catch {
    return DEFAULT_LIMITS;
  }
}

// Una consulta por tramo: totales, serie y todos los desgloses como alias del mismo dataset.
function chunkQuery(bucket, buckets, pageSize) {
  const node = (alias, limit, dims, order) =>
    `${alias}: httpRequestsAdaptiveGroups(limit: ${Math.min(limit, pageSize)}, filter: $f${order ? `, orderBy: [${order}]` : ''}) { count sum { edgeResponseBytes visits }${dims ? ` dimensions { ${dims} }` : ''} }`;
  return `query($zoneTag: string, $f: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject) { viewer { zones(filter: { zoneTag: $zoneTag }) {
    ${node('totals', 1)}
    ${node('series', buckets, bucket, `${bucket}_ASC`)}
    ${Object.entries(GROUPS).map(([alias, [dim, limit]]) => node(alias, limit, dim, 'count_DESC')).join('\n    ')}
  } } }`;
}

const totalsQuery = (n) =>
  `query($zoneTag: string, ${Array.from({ length: n }, (_, i) => `$f${i}: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject`).join(', ')}) { viewer { zones(filter: { zoneTag: $zoneTag }) {
    ${Array.from({ length: n }, (_, i) => `p${i}: httpRequestsAdaptiveGroups(limit: 1, filter: $f${i}) { count sum { edgeResponseBytes visits } }`).join('\n    ')}
  } } }`;

// Parte [start, end) en tramos que no pasen de la duración máxima de una consulta.
function chunks(start, end, max) {
  const out = [];
  for (let t = start; t < end; t += max * 1000) out.push([t, Math.min(end, t + max * 1000)]);
  return out;
}

const filter = ([a, b]) => ({ datetime_geq: new Date(a).toISOString(), datetime_lt: new Date(b).toISOString() });
const sumRow = (r) => ({ requests: r?.count || 0, bytes: r?.sum?.edgeResponseBytes || 0, visits: r?.sum?.visits || 0 });
const addTotals = (a, b) => ({ requests: a.requests + b.requests, bytes: a.bytes + b.bytes, visits: a.visits + b.visits });
const ZERO = { requests: 0, bytes: 0, visits: 0 };

function merge(lists, dim) {
  const by = new Map();
  for (const rows of lists) for (const r of rows || []) {
    const key = String(r.dimensions?.[dim] ?? '');
    by.set(key, (by.get(key) || 0) + r.count);
  }
  return [...by].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

const regionName = (() => {
  let names;
  try { names = new Intl.DisplayNames(['es'], { type: 'region' }); } catch { names = null; }
  return (code) => {
    if (!code || code.length !== 2 || code === 'XX' || code === 'T1') return code === 'T1' ? 'Tor' : 'Desconocido';
    try { return names?.of(code) || code; } catch { return code; }
  };
})();

async function collectRange(zoneTag, range, lim, now) {
  const end = Math.floor(now / (range.step * 1000)) * range.step * 1000 + range.step * 1000;
  const oldest = now - lim.notOlderThan * 1000;
  const start = Math.max(end - range.seconds * 1000, oldest);
  const buckets = Math.ceil((end - start) / (range.step * 1000));
  const query = chunkQuery(range.bucket, buckets, lim.maxPageSize);

  const parts = [];
  for (const c of chunks(start, end, lim.maxDuration)) {
    const data = await graphql(query, { zoneTag, f: filter(c) });
    parts.push(data.viewer.zones[0] || {});
  }

  // Periodo anterior, solo si entra entero en la retención del plan.
  let previous = null;
  const prevStart = start - range.seconds * 1000;
  if (start === end - range.seconds * 1000 && prevStart >= oldest) {
    const pc = chunks(prevStart, start, lim.maxDuration);
    const vars = Object.fromEntries(pc.map((c, i) => [`f${i}`, filter(c)]));
    const data = await graphql(totalsQuery(pc.length), { zoneTag, ...vars });
    const z = data.viewer.zones[0] || {};
    previous = pc.reduce((acc, _, i) => addTotals(acc, sumRow(z[`p${i}`]?.[0])), ZERO);
  }

  const totals = parts.reduce((acc, p) => addTotals(acc, sumRow(p.totals?.[0])), ZERO);
  const bucketOf = (iso) => Math.floor((new Date(iso).getTime() - start) / (range.step * 1000));
  const series = Array(buckets).fill(0);
  for (const p of parts) for (const r of p.series || []) {
    const i = bucketOf(r.dimensions[range.bucket]);
    if (i >= 0 && i < buckets) series[i] += r.count;
  }

  const g = Object.fromEntries(Object.entries(GROUPS).map(([alias, [dim]]) => [alias, merge(parts.map((p) => p[alias]), dim)]));
  const probe = new RegExp(config.cloudflare.probePattern, 'i');
  const probePaths = g.paths.filter((p) => probe.test(p.key));
  const statusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const s of g.statuses) {
    const k = `${String(s.key)[0]}xx`;
    if (k in statusClass) statusClass[k] += s.count;
  }
  const count = (list, test) => list.filter(test).reduce((s, x) => s + x.count, 0);
  const top = (list, n = 8) => list.slice(0, n);

  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    partial: start > end - range.seconds * 1000,
    step: range.step,
    totals: { ...totals, cacheHits: count(g.cache, (c) => CACHE_HIT.has(c.key)) },
    previous,
    series,
    statusClass,
    statuses: top(g.statuses),
    cache: top(g.cache),
    paths: top(g.paths),
    countries: top(g.countries).map((c) => ({ key: regionName(c.key), count: c.count })),
    ips: top(g.ips),
    hosts: top(g.hosts),
    browsers: top(g.browsers),
    os: top(g.os),
    security: {
      blocked: count(g.actions, (a) => BLOCKED_ACTION.test(a.key) && !PASSED_ACTION.test(a.key)),
      actions: top(g.actions.filter((a) => a.key && a.key !== 'unknown')),
      forbidden: count(g.statuses, (s) => String(s.key) === '403'),
      bots: count(g.browsers, (b) => BOT_BROWSER.test(b.key)),
      unknownBrowser: count(g.browsers, (b) => !b.key || /unknown|other/i.test(b.key)),
      probes: probePaths.reduce((s, p) => s + p.count, 0),
      probePaths: top(probePaths, 5),
    },
    fetchedAt: new Date(now).toISOString(),
  };
}

// 6 h y 24 h en cada pasada; 7 d como mucho cada CF_WEEK_EVERY_MIN para no gastar consultas.
export async function collectCloudflare() {
  const now = Date.now();
  const before = new Map((getState().cloudflare?.data?.zones || []).map((z) => [z.name, z]));
  const zones = [];
  for (const entry of config.cloudflare.zones) {
    let name = entry.split('=')[0].trim();
    const old = before.get(name);
    try {
      const z = await zoneId(entry);
      name = z.name;
      const lim = await limits(z.id);
      const ranges = {};
      for (const range of CF_RANGES) {
        const prev = old?.ranges?.[range.key];
        const fresh = prev && now - new Date(prev.fetchedAt).getTime() < config.cloudflare.weekEveryMin * 60_000;
        ranges[range.key] = range.key === '7d' && fresh ? prev : await collectRange(z.id, range, lim, now);
      }
      zones.push({ name, ranges, limits: lim });
    } catch (err) {
      // Si un dominio falla se conservan sus últimos datos y el error queda en la zona.
      zones.push({ ...(old || { name, ranges: {} }), error: String(err.message || err), errorAt: new Date(now).toISOString() });
    }
  }
  if (zones.every((z) => z.error && !Object.keys(z.ranges).length)) throw new Error(zones[0]?.error || 'sin zonas');
  return { zones, ranges: CF_RANGES.map(({ key, label }) => ({ key, label })) };
}
