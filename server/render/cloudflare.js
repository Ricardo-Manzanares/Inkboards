// Tráfico de Cloudflare: tarjeta compacta con una fila por dominio (últimas 6 h) y detalle por dominio y rango.
// La vista de detalle es "cloudflare-<n.º de dominio>-<rango>", p. ej. cloudflare-1-24h; los botones la cambian.
import { mdiCloudOutline, mdiShieldAlertOutline, mdiShieldCheckOutline } from '@mdi/js';
import { C, div, row, col, text, icon, card, stat, sparkline, hbar, divider, trend, message, hitArea } from './ui.js';
import { num, compact, pct, bytes as rawBytes, delta, when, ago, truncate } from './format.js';

// Con un decimal desde los MB: 7,7 MB dice más que 8 MB.
const bytes = (n) => (n >= 1024 ** 2 ? rawBytes(n).replace(/^(\d+) (MB)$/, (_, v, u) => `${num(n / 1024 ** 2, { decimals: 1 })} ${u}`) : rawBytes(n));
import { fresh, errorLine } from './cards.js';

const RANGES = [
  { key: '6h', label: '6 h' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' },
];
const DEFAULT_RANGE = '6h';
const MAX_ROWS = 3; // dominios que caben en la tarjeta compacta

export const cfView = (zone, range) => `cloudflare-${zone}-${range}`;

// Desde la vista, qué dominio y qué rango se muestran; si no existen, el primero y 6 h.
function parse(view, zones) {
  const [, z, r] = String(view || '').split('-');
  const zone = Number.isInteger(Number(z)) && Number(z) >= 0 && Number(z) < zones.length ? Number(z) : 0;
  const range = RANGES.some((x) => x.key === r) ? r : DEFAULT_RANGE;
  return { zone, range };
}

const cachePct = (t) => (t?.requests ? (t.cacheHits / t.requests) * 100 : null);
const rangeLabel = (key) => RANGES.find((r) => r.key === key)?.label || key;

// Lo marcado como sospechoso: bloqueado o desafiado por Cloudflare y peticiones a rutas de sondeo.
function shield(s, size = 26) {
  const alert = s && s.blocked + s.probes > 0;
  return icon(alert ? mdiShieldAlertOutline : mdiShieldCheckOutline, size);
}

// --- tarjeta ---------------------------------------------------------------------------------------

const COLS = { name: 205, requests: 135, visits: 110, bytes: 125, security: 250 };
const head = (str, width) => text(str, { width, fontSize: 18, color: C.dim, fontWeight: 600 });

function zoneRow(z) {
  const r = z.ranges?.[DEFAULT_RANGE];
  const t = r?.totals;
  const s = r?.security;
  if (!t) {
    return row({ gap: 16 }, text(truncate(z.name, 20), { width: COLS.name, fontSize: 22, fontWeight: 700 }), message(z.error ? `Error: ${truncate(z.error, 60)}` : 'Sin datos aún'));
  }
  const value = (v, width, change) =>
    col({ width, gap: 0 }, text(v, { fontSize: 30, fontWeight: 800, lineHeight: 1.1 }), trend(change, { size: 17 }) || text(' ', { fontSize: 17 }));
  return row(
    { gap: 16, alignItems: 'center' },
    col(
      { width: COLS.name },
      // Los dominios largos bajan de tamaño en lugar de pisar la columna siguiente (Inter 700: ~0,6 em por carácter).
      text(truncate(z.name, 26), { fontSize: Math.max(16, Math.min(23, Math.floor(COLS.name / (z.name.length * 0.6)))), fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden' }),
      text(`caché ${cachePct(t) === null ? '–' : pct(cachePct(t), 0)}${z.error ? ' · error' : ''}`, { fontSize: 17, color: C.dim }),
    ),
    value(compact(t.requests), COLS.requests, delta(t.requests, r.previous?.requests)),
    value(compact(t.visits), COLS.visits, delta(t.visits, r.previous?.visits)),
    value(bytes(t.bytes), COLS.bytes, delta(t.bytes, r.previous?.bytes)),
    row(
      { width: COLS.security, gap: 8 },
      shield(s),
      col(
        { gap: 0 },
        text(`${num(s.blocked)} bloq. · ${num(s.probes)} sondeos`, { fontSize: 18, fontWeight: 700, whiteSpace: 'nowrap' }),
        text(`${num(s.bots)} bots · ${num(s.forbidden)} × 403`, { fontSize: 16, color: C.dim, whiteSpace: 'nowrap' }),
      ),
    ),
    div({ flexGrow: 1, justifyContent: 'flex-end' }, sparkline(r.series, { width: 100, height: 40, stroke: 3 })),
  );
}

export function cloudflareCard(src) {
  const zones = src?.data?.zones || [];
  return card(
    {
      id: 'cloudflare',
      iconPath: mdiCloudOutline,
      title: 'Cloudflare',
      subtitle: zones.length ? `últimas 6 h vs 6 h anteriores · ${zones.length} ${zones.length === 1 ? 'dominio' : 'dominios'}` : null,
      status: fresh(src),
    },
    !zones.length
      ? message('Configura CF_API_TOKEN y CF_ZONES')
      : [
          row(
            { gap: 16 },
            head('Dominio', COLS.name),
            head('Solicitudes', COLS.requests),
            head('Visitas', COLS.visits),
            head('Datos', COLS.bytes),
            head('Bloqueado / bots', COLS.security),
          ),
          col({ gap: 10 }, zones.slice(0, MAX_ROWS).map((z, i) => [i > 0 && divider(), zoneRow(z)])),
          zones.length > MAX_ROWS && text(`+${zones.length - MAX_ROWS} dominios más en el detalle`, { fontSize: 18, color: C.dim }),
        ],
    errorLine(src),
  );
}

// --- detalle ---------------------------------------------------------------------------------------

// Botón de dominio o de rango: el seleccionado en tinta. La zona de toque sobresale para acertar con el dedo.
const pill = (str, selected, view) =>
  div(
    {
      position: 'relative',
      padding: '8px 22px',
      borderRadius: 999,
      fontSize: 23,
      fontWeight: 700,
      background: selected ? C.ink : C.card,
      color: selected ? C.onInk : C.ink,
      border: `3px solid ${C.ink}`,
      whiteSpace: 'nowrap',
    },
    str,
    !selected && hitArea(`go:${view}`, { radius: 999, inset: -8 }),
  );

function kpi(name, value, change, before, width) {
  return col(
    { gap: 2, width },
    text(name, { fontSize: 22, color: C.dim, fontWeight: 600 }),
    text(value, { fontSize: 48, fontWeight: 800, lineHeight: 1.1 }),
    trend(change, { size: 22 }) || text(' ', { fontSize: 22 }),
    text(before ? `antes ${before}` : ' ', { fontSize: 19, color: C.dim }),
  );
}

// Tabla de "principales": etiqueta, barra proporcional y número, como en el panel de Cloudflare.
function table(title, rows, width, { rows: n = 4, size = 21 } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const chars = Math.floor((width - 170) / (size * 0.55));
  return col(
    { width, gap: 6 },
    text(title, { fontSize: 21, color: C.dim, fontWeight: 600 }),
    rows.length === 0
      ? text('Sin datos', { fontSize: size, color: C.dim })
      : rows.slice(0, n).map((r) =>
          row(
            { gap: 12 },
            text(truncate(String(r.key || '(vacío)'), chars), { flexGrow: 1, fontSize: size, fontWeight: 600 }),
            hbar(r.count / max, { width: 90, height: 10 }),
            text(num(r.count), { width: 60, fontSize: size, justifyContent: 'flex-end' }),
          ),
        ),
  );
}

const STATUS_TEXT = { 200: 'OK', 204: 'No Content', 206: 'Partial', 301: 'Moved', 302: 'Found', 304: 'Not Modified', 307: 'Temp. Redirect', 308: 'Perm. Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Not Allowed', 429: 'Too Many', 499: 'Client Closed', 500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable', 520: 'Unknown', 521: 'Down', 522: 'Timeout', 524: 'Timeout' };
const CACHE_TEXT = { hit: 'Acierto', miss: 'Fallo', dynamic: 'Dinámico', none: 'Ninguno', revalidated: 'Revalidado', expired: 'Caducado', bypass: 'Bypass', stale: 'Obsoleto', updating: 'Actualizando' };

export function cloudflareDetail(src, view, { detail, label, W }) {
  const zones = src?.data?.zones || [];
  const { zone, range } = parse(view, zones);
  const z = zones[zone];
  const r = z?.ranges?.[range];
  const t = r?.totals;
  const p = r?.previous;
  const s = r?.security;
  const half = (W - 40) / 2;
  const rl = rangeLabel(range);

  return detail(
    {
      iconPath: mdiCloudOutline,
      title: 'Cloudflare',
      subtitle: !r ? null : r.partial ? `${z.name} · desde ${when(r.start)} (límite del plan)` : p?.requests ? `${z.name} · últimas ${rl} vs ${rl} anteriores` : `${z.name} · últimas ${rl} · sin datos previos`,
      status: z?.ranges?.[range] ? ago(r.fetchedAt) : fresh(src),
    },
    !zones.length
      ? message('Configura CF_API_TOKEN y CF_ZONES')
      : [
          row(
            { justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 },
            row({ gap: 12, flexWrap: 'wrap', flexShrink: 1 }, zones.map((x, i) => pill(x.name, i === zone, cfView(i, range)))),
            row({ gap: 10, flexShrink: 0 }, RANGES.map((x) => pill(x.label, x.key === range, cfView(zone, x.key)))),
          ),
          !r
            ? message(z?.error ? `Error: ${truncate(z.error, 90)}` : 'Sin datos aún para este rango')
            : [
                row(
                  { justifyContent: 'space-between', alignItems: 'flex-start' },
                  kpi('Solicitudes', num(t.requests), delta(t.requests, p?.requests), p?.requests ? num(p.requests) : null, 230),
                  kpi('Visitas', num(t.visits), delta(t.visits, p?.visits), p?.visits ? num(p.visits) : null, 210),
                  kpi('Transferencia', bytes(t.bytes), delta(t.bytes, p?.bytes), p?.bytes ? bytes(p.bytes) : null, 250),
                  kpi('Caché', cachePct(t) === null ? '–' : pct(cachePct(t)), null, null, 190),
                ),
                col(
                  { gap: 4 },
                  row(
                    { justifyContent: 'space-between' },
                    label(`Solicitudes cada ${r.step >= 3600 ? 'hora' : `${r.step / 60} min`}`),
                    text(`máximo ${num(Math.max(0, ...r.series))}`, { fontSize: 21, color: C.dim }),
                  ),
                  sparkline(r.series, { width: W, height: 90, stroke: 4 }),
                  row({ justifyContent: 'space-between' }, text(when(r.start), { fontSize: 18, color: C.dim }), text('ahora', { fontSize: 18, color: C.dim })),
                ),
                col(
                  { gap: 8, border: `3px solid ${C.ink}`, borderRadius: 20, padding: '12px 20px' },
                  row({ gap: 10 }, shield(s, 30), label('Tráfico bloqueado / bots')),
                  row(
                    { justifyContent: 'space-between', alignItems: 'flex-start' },
                    stat('Bloqueado por Cloudflare', num(s.blocked), t.requests ? pct((s.blocked / t.requests) * 100) : null, { size: 34 }),
                    stat('Sondeos', num(s.probes), 'wp-*, .env, .git…', { size: 34 }),
                    stat('403 Forbidden', num(s.forbidden), null, { size: 34 }),
                    stat('Bots declarados', num(s.bots), `${num(s.unknownBrowser)} sin navegador`, { size: 34 }),
                  ),
                  s.probePaths.length > 0 &&
                    text(`Más sondeadas: ${s.probePaths.slice(0, 3).map((x) => `${truncate(x.key, 30)} (${num(x.count)})`).join(' · ')}`, { fontSize: 18, color: C.dim }),
                ),
                row({ gap: 40, alignItems: 'flex-start' }, table('Rutas principales', r.paths, half), table('Países', r.countries, half)),
                row({ gap: 40, alignItems: 'flex-start' }, table('IPs de cliente', r.ips, half), table('Hosts', r.hosts, half)),
                row(
                  { gap: 40, alignItems: 'flex-start' },
                  table('Códigos de estado', r.statuses.map((x) => ({ key: `${x.key} ${STATUS_TEXT[x.key] || ''}`, count: x.count })), half),
                  table('Estado de caché', r.cache.map((x) => ({ key: CACHE_TEXT[x.key] || x.key, count: x.count })), half),
                ),
              ],
        ],
    z?.error && r ? text(`Error en la última lectura: ${truncate(z.error, 70)} (${ago(z.errorAt)})`, { fontSize: 18, color: C.dim }) : errorLine(src),
  );
}
