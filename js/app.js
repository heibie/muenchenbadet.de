// muenchenbadet.de – Prototyp
// Daten: data/live.json (Cron: Isar + Bäder-Auslastung), data/*.csv (Stammdaten),
// data/quellen/*.geojson (Stadt München), Wetter direkt von Open-Meteo.

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
const MUC = [48.137, 11.575];

const WETTER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=48.137&longitude=11.575'
  + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,is_day'
  + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum'
  + '&past_days=2&forecast_days=3&timezone=Europe%2FBerlin';

// Vorläufige eigene Schwelle unterhalb von Meldestufe 1 (240 cm) – noch mit Erfahrungswerten abgleichen
const PEGEL_ERHOEHT = 150;

// Wassertemperatur-Einordnung: [ab °C, Label, Farbe]
const KATEGORIEN = [
  [-99, 'Eisbaden',      '#2c5fa8'],
  [5,   'Sehr kalt',     '#3a7bbf'],
  [10,  'Kalt',          '#1b8aa6'],
  [15,  'Frisch',        '#1e9c8a'],
  [18,  'Angenehm',      '#1e8a52'],
  [21,  'Warm',          '#d99a00'],
];

const WETTERCODES = {
  0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt', 45: 'Nebel', 48: 'Reifnebel',
  51: 'leichter Niesel', 53: 'Niesel', 55: 'starker Niesel', 61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen',
  66: 'gefrierender Regen', 67: 'gefrierender Regen', 71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall',
  77: 'Schneegriesel', 80: 'Regenschauer', 81: 'Regenschauer', 82: 'heftige Schauer', 85: 'Schneeschauer', 86: 'Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Gewitter mit Hagel',
};

// Wettericons: Meteocons von Bas Milius (MIT), lokal unter img/wetter/
const ICON = name => `img/wetter/${name}.svg`;
function wetterIcon(code, tag = true) {
  if (code <= 1) return tag ? 'clear-day' : 'clear-night';
  if (code === 2) return tag ? 'partly-cloudy-day' : 'partly-cloudy-night';
  if (code === 3) return tag ? 'overcast-day' : 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code === 66 || code === 67) return 'sleet';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code === 95) return 'thunderstorms-rain';
  if (code === 96 || code === 99) return 'hail';
  return 'rain';
}
const beaufort = kmh => [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118].filter(g => kmh >= g).length;
const uvIcon = uv => `uv-index-${Math.min(11, Math.max(1, Math.round(uv)))}`;

const fmt = (n, d = 1) => n == null ? '–' : n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const zeit = iso => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const uhr = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const $ = id => document.getElementById(id);
const clean = s => String(s ?? '').replace(/&nbsp;/g, ' ').replace(/`/g, '’');
const esc = s => clean(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const csv = url => fetch(url).then(r => r.text()).then(t => Papa.parse(t, { header: true, skipEmptyLines: true }).data);
const json = url => fetch(url).then(r => r.json());

function kategorie(t) {
  let k = KATEGORIEN[0];
  for (const c of KATEGORIEN) if (t >= c[0]) k = c;
  return k;
}

function auslastungFarbe(p) {
  return p < 0.4 ? 'var(--ok)' : p < 0.75 ? 'var(--warn)' : 'var(--bad)';
}

// ---------- Isar ----------
// Wert vor n Stunden aus einer Stundenserie [[iso, wert], …]
const vorStunden = (serie, n) => serie?.length > n ? serie[serie.length - 1 - n][1] : null;

function tendenz(jetzt, vorher, schwelle) {
  if (jetzt == null || vorher == null) return '';
  return jetzt > vorher + schwelle ? '↗ steigend' : jetzt < vorher - schwelle ? '↘ fallend' : '→ gleichbleibend';
}

// Mini-Kurve als Inline-SVG
function sparkline(serie, farbe) {
  const w = (serie ?? []).map(p => p[1]).filter(v => v != null);
  if (w.length < 2) return '';
  const min = Math.min(...w), max = Math.max(...w), span = max - min || 1;
  const pts = w.map((v, i) => `${(i / (w.length - 1) * 100).toFixed(2)},${(38 - (v - min) / span * 34).toFixed(2)}`).join(' ');
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="0,40 ${pts} 100,40" fill="${farbe}" opacity=".12"/>
      <polyline points="${pts}" fill="none" stroke="${farbe}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

function pegelSkala(wert, ms) {
  const max = ms[4] * 1.1, pos = v => Math.min(100, v / max * 100);
  const zonen = [
    [0, PEGEL_ERHOEHT, 'var(--ok)'], [PEGEL_ERHOEHT, ms[1], 'var(--warn)'],
    [ms[1], ms[2], '#e07a5f'], [ms[2], ms[3], '#d1495b'], [ms[3], ms[4], 'var(--bad)'], [ms[4], max, '#7a1418'],
  ];
  return `<div class="zonen">${zonen.map(([a, b, c]) => `<i style="width:${pos(b) - pos(a)}%;background:${c};opacity:.75"></i>`).join('')}</div>
    ${[1, 2, 3, 4].map(i => `<span class="tick" style="left:${pos(ms[i])}%">MS ${i}</span>`).join('')}
    <span class="marker" style="left:${pos(wert)}%" title="${wert} cm"></span>`;
}

function renderIsar(live) {
  const wt = live.isar?.wassertemperatur;
  if (wt) {
    const [, label, farbe] = kategorie(wt.wert);
    $('wt').innerHTML = `${fmt(wt.wert)}<small> °C</small>`;
    $('wt-kat').textContent = label;
    $('wt-kat').style.background = farbe;

    const v24 = vorStunden(wt.serie, 24);
    const werte = (wt.serie ?? []).map(p => p[1]);
    const diff = v24 == null ? '' : `<b>${wt.wert - v24 >= 0 ? '+' : '−'}${fmt(Math.abs(wt.wert - v24))} °C</b> seit gestern · `;
    $('wt-trend').innerHTML = werte.length
      ? `${diff}7 Tage: ${fmt(Math.min(...werte))}–${fmt(Math.max(...werte))} °C`
      : '';
    $('wt-spark').innerHTML = sparkline(wt.serie, '#1b8aa6')
      + '<div class="achse"><span>vor 7 Tagen</span><span>jetzt</span></div>';
    $('wt-zeit').textContent = `Messstelle München · Stand ${zeit(wt.zeit)}`;
  } else {
    $('wt').textContent = 'k. A.';
  }

  const ws = live.isar?.wasserstand, af = live.isar?.abfluss;
  if (ws) {
    let farbe = 'var(--ok)', text = 'Normaler Wasserstand';
    if (ws.meldestufe > 0) { farbe = 'var(--bad)'; text = `Hochwasser – Meldestufe ${ws.meldestufe}`; }
    else if (ws.wert >= PEGEL_ERHOEHT) { farbe = 'var(--warn)'; text = 'Erhöhter Wasserstand'; }
    $('pegel-dot').style.background = farbe;
    $('pegel-text').textContent = text;
    $('pegel-wert').innerHTML = `${ws.wert}<small> cm</small>`;
    $('pegel-skala').innerHTML = pegelSkala(ws.wert, ws.meldestufen);

    // Tendenz: Vergleich mit dem Wert 6 Stunden vorher
    const tWs = tendenz(ws.wert, vorStunden(ws.serie, 6), 3);
    const tAf = af ? tendenz(af.wert, vorStunden(af.serie, 6), 1) : '';
    $('pegel-kv').innerHTML = `
      <dt>Tendenz (6 h)</dt><dd>${tWs || '–'}</dd>
      <dt>Abfluss</dt><dd><b>${af ? fmt(af.wert) + ' m³/s' : '–'}</b>${tAf ? ' ' + tAf : ''}</dd>
      <dt>Meldestufe 1</dt><dd>ab ${ws.meldestufen[1]} cm (noch ${Math.max(0, ws.meldestufen[1] - ws.wert)} cm)</dd>`;
    $('pegel-spark').innerHTML = sparkline(ws.serie, '#0e4f63')
      + '<div class="achse"><span>vor 7 Tagen</span><span>jetzt</span></div>';
    $('pegel-zeit').textContent = `Messstelle München · Stand ${zeit(ws.zeit)}`;
  }
}

// ---------- Wetter ----------
function renderWetter(w) {
  const c = w.current, d = w.daily, heute = 2; // past_days=2 -> Index 2 = heute
  const regen48 = (d.precipitation_sum[0] ?? 0) + (d.precipitation_sum[1] ?? 0);
  const bft = beaufort(c.wind_speed_10m);
  const chip = (icon, label, wert) => `<div class="wx-chip"><img src="${ICON(icon)}" alt=""><div><span class="label">${label}</span><b>${wert}</b></div></div>`;
  const tagName = i => i === heute ? 'Heute' : i === heute + 1 ? 'Morgen'
    : new Date(d.sunrise[i]).toLocaleDateString('de-DE', { weekday: 'long' });

  $('wetter').innerHTML = `
    <div class="wx-jetzt">
      <img class="wx-gross" src="${ICON(wetterIcon(c.weather_code, c.is_day))}" alt="${esc(WETTERCODES[c.weather_code] ?? '')}">
      <div>
        <div class="display wx-temp">${fmt(c.temperature_2m)}<small> °C</small></div>
        <div class="muted">${WETTERCODES[c.weather_code] ?? ''} · gefühlt ${fmt(c.apparent_temperature)} °C</div>
      </div>
    </div>
    <div class="wx-chips">
      ${chip(`wind-beaufort-${bft}`, 'Wind', `${fmt(c.wind_speed_10m, 0)} km/h`)}
      ${chip(uvIcon(d.uv_index_max[heute]), 'UV max.', fmt(d.uv_index_max[heute], 0))}
      ${chip('sunrise', 'Aufgang', uhr(d.sunrise[heute]))}
      ${chip('sunset', 'Untergang', uhr(d.sunset[heute]))}
      ${chip('raindrops', 'Regen 48 h', `${fmt(regen48)} mm`)}
      ${chip('thermometer-celsius', 'Heute', `${fmt(d.temperature_2m_min[heute], 0)}–${fmt(d.temperature_2m_max[heute], 0)} °C`)}
    </div>
    <div class="wx-tage">
      ${[heute, heute + 1, heute + 2].map(i => `<div class="wx-tag">
        <span class="label">${tagName(i)}</span>
        <img src="${ICON(wetterIcon(d.weather_code[i]))}" alt="${esc(WETTERCODES[d.weather_code[i]] ?? '')}" title="${esc(WETTERCODES[d.weather_code[i]] ?? '')}">
        <b>${fmt(d.temperature_2m_min[i], 0)}° / ${fmt(d.temperature_2m_max[i], 0)}°</b>
        <span class="muted">${d.precipitation_sum[i] > 0 ? fmt(d.precipitation_sum[i]) + ' mm' : 'trocken'}</span>
      </div>`).join('')}
    </div>`;
}

// ---------- Hinweise ----------
// Nur Pegel-Hinweise; ohne Hinweis wird der Kasten ausgeblendet
function renderHinweise(live) {
  const h = [];
  const ws = live.isar?.wasserstand;

  if (ws?.meldestufe > 0) h.push(['bad', `Hochwasser (Meldestufe ${ws.meldestufe}): Baden in der Isar ist lebensgefährlich und kann von der Stadt verboten werden.`, 'extreme']);
  else if (ws && ws.wert >= PEGEL_ERHOEHT) h.push(['warn', 'Erhöhter Wasserstand: stärkere Strömung, Kiesbänke teils überflutet.', 'raindrops']);

  $('hinweise-box').hidden = !h.length;
  $('hinweise').innerHTML = h.map(([cls, txt, icon]) => `<div class="hinweis ${cls}">
    ${icon && icon !== 'extreme' ? `<img src="${ICON(icon)}" alt="">` : '<span class="hinweis-x">⚠</span>'}<span>${esc(txt)}</span></div>`).join('');
}

// ---------- Karte ----------
let map, markers = {}, aktivMarker = null;
// Marker-Icons (weißer Strich auf farbigem Kreis, Farben siehe .pin-* in index.html)
// s = Isar-Badestelle (Schwimmer im Fluss), b = Bad geöffnet, z = Bad geschlossen (Dach über Becken)
const PIN_WELLE = '<path d="M3 19c2 0 2-1.5 4.5-1.5S10 19 12 19s2-1.5 4.5-1.5S19 19 21 19"/>';
const PIN_ICONS = {
  s: '<circle cx="16.5" cy="6.5" r="2"/><path d="M4 14l5-3.5 3.5 3L17 11"/>' + PIN_WELLE,
  b: '<path d="M2.5 10.5 12 4l9.5 6.5"/><rect x="5" y="12.5" width="14" height="7.5" rx="1.5"/><path d="M7.5 16.5c1.1 0 1.1-.9 2.25-.9s1.15.9 2.25.9 1.1-.9 2.25-.9 1.15.9 2.25.9"/>',
};
PIN_ICONS.z = PIN_ICONS.b;
// Gefahrenstelle: gelbes Warndreieck mit Ausrufezeichen
const GEFAHR_ICON = L.divIcon({
  className: 'pin-wrap gefahr-pin', iconSize: [20, 18], iconAnchor: [10, 12], popupAnchor: [0, -10],
  html: '<svg viewBox="0 0 20 18" aria-hidden="true"><path d="M10 1.2 19 16.8H1Z" fill="#f2b705" stroke="#10262e" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 6.5v5" stroke="#10262e" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1.1" fill="#10262e"/></svg>',
});
const pinIcon = typ => L.divIcon({
  className: 'pin-wrap', iconSize: [26, 26], iconAnchor: [13, 13], tooltipAnchor: [12, 0],
  html: `<div class="pin pin-${typ}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIN_ICONS[typ]}</svg></div>`,
});

function renderKarte(zonen, gefahren) {
  map = L.map('map').setView([48.125, 11.57], 12);
  L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);

  L.geoJSON(zonen, {
    style: f => f.properties.badeverbot === 'erlaubt'
      ? { color: '#1b8aa6', weight: 1, fillColor: '#1b8aa6', fillOpacity: .45 }
      : { color: '#e5a3a6', weight: 1, fillColor: '#e5a3a6', fillOpacity: .35 },
    onEachFeature: (f, l) => l.bindTooltip(f.properties.badeverbot === 'erlaubt' ? 'Baden erlaubt' : 'Baden verboten'),
  }).addTo(map);

  // Gefahrenstellen sind keine eigenen Einträge -> bleiben als kleines Popup
  L.geoJSON(gefahren, {
    pointToLayer: (f, ll) => L.marker(ll, { icon: GEFAHR_ICON, keyboard: false }),
    onEachFeature: (f, l) => l.bindPopup(`<b>⚠ ${esc(f.properties.lage)}</b><br>${esc(f.properties.hinweis)}`),
  }).addTo(map);

  // Umgriffe der Badestellen (Ausschnitt der erlaubten Zone, data/badestellen.geojson)
  L.geoJSON(DATA.umgriffe, {
    style: UMGRIFF,
    onEachFeature: (f, l) => {
      const key = `s-${f.properties.slug}`;
      umgriffe[key] = l;
      l.options.bubblingMouseEvents = false;   // Klick soll nicht als Karten-Klick (-> Liste) durchgehen
      l.bindTooltip(esc(f.properties.name), { sticky: true });
      l.on('click', () => zeigeSteckbrief(key));
    },
  }).addTo(map);

  for (const b of DATA.badestellen) addMarker('s', b, +b.lat, +b.lon);
  for (const b of DATA.baeder) if (b.latitude) addMarker(badStatus(b).offen ? 'b' : 'z', b, +b.latitude, +b.longitude);
}

function addMarker(typ, eintrag, lat, lon) {
  const key = `${typ === 'z' ? 'b' : typ}-${eintrag.slug}`;
  const m = L.marker([lat, lon], { icon: pinIcon(typ), bubblingMouseEvents: false, keyboard: false })
    .bindTooltip(esc(eintrag.name))
    .on('click', () => zeigeSteckbrief(key))
    .addTo(map);
  markers[key] = m;
}

const UMGRIFF = { color: '#0e4f63', weight: 1.5, dashArray: '4 3', fillColor: '#0e4f63', fillOpacity: .12 };
const UMGRIFF_AKTIV = { color: '#0e4f63', weight: 3, dashArray: null, fillColor: '#0e4f63', fillOpacity: .4 };
let umgriffe = {};

function setAktivMarker(key) {
  if (aktivMarker) { aktivMarker.getElement()?.firstChild.classList.remove('aktiv'); aktivMarker.setZIndexOffset(0); }
  Object.values(umgriffe).forEach(l => l.setStyle(UMGRIFF));
  aktivMarker = key ? markers[key] : null;
  if (aktivMarker) { aktivMarker.getElement()?.firstChild.classList.add('aktiv'); aktivMarker.setZIndexOffset(1000); }
  if (key && umgriffe[key]) umgriffe[key].setStyle(UMGRIFF_AKTIV);
}

// ---------- Bäder-Status ----------
// Geschlossen = keine Live-Auslastung, keine Öffnungszeiten oder gerade niemand gezählt.
// (Betrifft v. a. Freibäder außerhalb der Saison und Bäder in Sanierung.)
function badStatus(b) {
  const a = DATA.live.baeder?.[b.slug];
  if (!a) return { offen: false, grund: /freibad/i.test(b.art) && !/hallenbad/i.test(b.art) ? 'Saisonpause' : 'derzeit geschlossen' };
  if (!b.oeffnungszeiten_bad) return { offen: false, grund: 'derzeit geschlossen' };
  if (Object.values(a).every(v => v.besucher === 0)) return { offen: false, grund: 'derzeit geschlossen' };
  return { offen: true, a };
}

// Kleine Strich-Icons je Bereich (Inline-SVG, Farbe über currentColor)
const WELLEN = '<path d="M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2-1.5 4.5-1.5S19 17 21 17"/><path d="M3 21c2 0 2-1.5 4.5-1.5S10 21 12 21s2-1.5 4.5-1.5S19 21 21 21"/>';
const BEREICH_ICONS = {
  hallenbad: '<path d="M3 11 12 4l9 7"/>' + WELLEN,
  freibad:   '<circle cx="12" cy="8" r="3"/><path d="M12 2v1.5M5.5 4.5l1 1M18.5 4.5l-1 1M4 9h1.5M18.5 9H20"/>' + WELLEN,
  winter:    '<path d="M12 2v10M7.7 4.5l8.6 5M16.3 4.5l-8.6 5"/>' + WELLEN,
  sauna:     '<path d="M8 3c-1.2 1.5 1.2 3 0 4.5M12 3c-1.2 1.5 1.2 3 0 4.5M16 3c-1.2 1.5 1.2 3 0 4.5"/><path d="M3 12h18M5 12v8M19 12v8M3 16h18"/>',
  fitness:   '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>',
  naturbad:  '<path d="M12 13V8M12 8c0-3 2.5-5 6-5 0 3.5-2.5 5-6 5ZM12 10c0-2.5-2-4-5-4 0 3 2 4 5 4Z"/>' + WELLEN,
  eisstadion:'<path d="M5 4h5v7c3 0 7 1 9 3v2H5Z"/><path d="M3 20h18M7 16v4M17 16v4"/>',
  wellenbad: '<path d="M2 15c3 0 4-9 9-9 3 0 4 2 4 4-2-1-4 0-4 2 0 3 3 3 5 3h6"/>' + WELLEN.split('/>')[1] + '/>',
};
const iconSvg = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BEREICH_ICONS[key]}</svg>`;
function bereichIcon(name) {
  const n = name.toLowerCase();
  return iconSvg(n.includes('sauna') ? 'sauna' : n.includes('winter') ? 'winter' : n.includes('freibad') ? 'freibad' : 'hallenbad');
}

// ---------- Seitenleiste: Liste ----------
let aktuellerTab = 'baeder';

// Filter über die Merkmal-Spalten in data/baeder.csv (ja/nein); mehrere aktive Filter = UND
const FILTER = [
  ['hallenbad', 'Hallenbad', 'hallenbad'], ['freibad', 'Freibad', 'freibad'],
  ['winter_warmfreibad', 'Winter-Warmfreibad', 'winter'], ['sauna', 'Sauna', 'sauna'],
  ['fitness', 'Fitness', 'fitness'], ['naturbad', 'Naturbad', 'naturbad'],
  ['eisstadion', 'Eisstadion', 'eisstadion'], ['wellenbad', 'Wellenbad', 'wellenbad'],
];
const aktiveFilter = new Set();
const passtFilter = b => [...aktiveFilter].every(f => b[f] === 'ja');

// Bäder-Marker auf der Karte an den Filter anpassen
function filterMarker() {
  for (const b of DATA.baeder) {
    const m = markers[`b-${b.slug}`];
    if (!m) continue;
    if (passtFilter(b)) m.addTo(map); else m.remove();
  }
}

function listeBaeder() {
  const chips = `<div class="filter">${FILTER.map(([f, label, icon]) =>
    `<button type="button" data-filter="${f}" class="${aktiveFilter.has(f) ? 'on' : ''}" aria-pressed="${aktiveFilter.has(f)}">${iconSvg(icon)}${label}</button>`).join('')}</div>`;
  const rows = DATA.baeder.filter(passtFilter).map(b => {
    const st = badStatus(b);
    const becken = st.offen && (st.a.Hallenbad || st.a['Winter-Warmfreibad'] || st.a.Freibad);
    return { b, st, p: becken ? becken.besucher / becken.max : null };
  });
  const offen = rows.filter(r => r.st.offen).sort((x, y) => (x.p ?? 1) - (y.p ?? 1));
  const zu = rows.filter(r => !r.st.offen).sort((x, y) => x.b.name.localeCompare(y.b.name, 'de'));

  const zeile = ({ b, st }) => {
    if (!st.offen) return `<div class="ort zu" data-key="b-${b.slug}">
      <span class="name">${esc(b.name)}</span><span class="muted">${esc(st.grund)}</span></div>`;
    // Ein Mini-Balken je Bereich, in dem gerade gezählt wird (Freibad im Winter mit 0 entfällt)
    const bereiche = Object.entries(st.a).filter(([, v]) => v.besucher > 0).map(([k, v]) => {
      const q = v.besucher / v.max;
      return `<span class="bm-icon" title="${esc(k)}">${bereichIcon(k)}</span>
        <div class="bar" title="${esc(k)}: ${v.besucher} / ${v.max}"><i style="width:${Math.max(2, q * 100)}%;background:${auslastungFarbe(q)}"></i></div>
        <span class="bm-wert">${frei(v)} % frei</span>`;
    }).join('');
    return `<div class="ort" data-key="b-${b.slug}">
      <span class="name">${esc(b.name)}</span><span class="muted">${esc(b.art)}</span>
      <div class="bm">${bereiche}</div></div>`;
  };
  if (!rows.length) return chips + '<p class="muted">Kein Bad passt zu dieser Auswahl.</p>';
  return chips
    + (offen.length ? `<div class="gruppe">Geöffnet · ${offen.length}</div>${offen.map(zeile).join('')}` : '')
    + (zu.length ? `<div class="gruppe">Derzeit geschlossen · ${zu.length}</div>${zu.map(zeile).join('')}` : '');
}

function listeBadestellen() {
  const wt = DATA.live.isar?.wassertemperatur?.wert;
  return DATA.badestellen.map(b => `<div class="ort" data-key="s-${b.slug}">
      <span class="name">${esc(b.name)}</span><span class="muted">${fmt(wt)} °C</span>
      <span class="meta">Isar${b.fkk === 'ja' ? ' · FKK in der Nähe' : ''}${b.wasserwacht ? ' · Wasserwacht' : ''}</span></div>`).join('');
}

// Mobil (≤ 720px): Seitenleiste ist ein Bottom-Sheet über der Karte (CSS in index.html)
const istMobil = () => window.matchMedia('(max-width: 720px)').matches;
const sheet = auf => $('seitenleiste').classList.toggle('sheet-open', auf);
// Peek-Höhe so, dass die ersten zwei Einträge der Liste sichtbar sind
function setPeek() {
  if (!istMobil()) return;
  const s = $('seitenleiste'), orte = $('liste').querySelectorAll('.ort');
  const letzter = orte[Math.min(1, orte.length - 1)];
  if (!letzter) return;
  const h = letzter.getBoundingClientRect().bottom - s.getBoundingClientRect().top + 8;
  s.style.setProperty('--peek', `${Math.round(Math.min(h, s.offsetHeight))}px`);
}
const peekPx = () => parseFloat(getComputedStyle($('seitenleiste')).getPropertyValue('--peek')) || 340;

function zeigeListe(tab = aktuellerTab) {
  aktuellerTab = tab;
  setAktivMarker(null);
  $('tabs').hidden = false;
  $('liste').innerHTML = `<div class="orte">${tab === 'baeder' ? listeBaeder() : listeBadestellen()}</div>`;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('liste').scrollTop = 0;
  setPeek();
  if (location.hash) history.replaceState(null, '', location.pathname);
}

// ---------- Seitenleiste: Steckbrief ----------
const frei = v => Math.max(0, Math.round(100 - v.besucher / v.max * 100));

function zeigeSteckbrief(key, { zoom = true } = {}) {
  const [typ, slug] = [key[0], key.slice(2)];
  const eintrag = (typ === 'b' ? DATA.baeder : DATA.badestellen).find(x => x.slug === slug);
  if (!eintrag) return zeigeListe();

  aktuellerTab = typ === 'b' ? 'baeder' : 'badestellen';
  $('tabs').hidden = true;
  $('liste').innerHTML = (typ === 'b' ? steckbriefBad(eintrag) : steckbriefBadestelle(eintrag));
  $('liste').scrollTop = 0;

  setAktivMarker(key);
  if (istMobil()) sheet(false);   // Steckbrief im Peek zeigen, Karte bleibt oben sichtbar
  const m = markers[key];
  // Mobil verdeckt das Sheet den unteren Teil der Karte -> Ziel im freien oberen Teil zeigen
  const unten = istMobil() ? peekPx() : 0;
  const pad = { paddingTopLeft: [30, 30], paddingBottomRight: [30, 30 + unten] };
  if (zoom && umgriffe[key]) map.fitBounds(umgriffe[key].getBounds(), { ...pad, maxZoom: 16 });
  else if (m && zoom) map.fitBounds(L.latLngBounds([m.getLatLng(), m.getLatLng()]), { ...pad, maxZoom: Math.max(map.getZoom(), 14) });

  // Deep-Link: #bad/<slug> bzw. #badestelle/<slug>
  history.replaceState(null, '', `#${typ === 'b' ? 'bad' : 'badestelle'}/${slug}`);

  // Tablet: Karte und Leiste stehen untereinander -> zum Steckbrief scrollen (Handy: Sheet, s.o.)
  if (!istMobil() && window.matchMedia('(max-width: 860px)').matches) $('seitenleiste').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fakt(label, value) {
  return `<div><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function steckbriefBad(b) {
  const st = badStatus(b), a = st.a;
  const auslastung = !st.offen
    ? `<div class="zu-hinweis">Geschlossen · ${esc(st.grund)}</div><p class="muted">Keine Öffnungszeiten bzw. keine Live-Auslastung von den SWM – das Bad ist gerade nicht in Betrieb.</p>`
    : Object.entries(a).map(([k, v]) => {
        const p = v.besucher / v.max;
        return `<div class="bereich">
          <div class="bereich-kopf"><span>${esc(k)}</span><span><b>${frei(v)} % frei</b> · ${v.besucher} / ${v.max}</span></div>
          <div class="bar"><i style="width:${Math.max(2, p * 100)}%;background:${auslastungFarbe(p)}"></i></div>
        </div>`;
      }).join('');

  return `
    <button class="back-link" data-back>← Alle Bäder</button>
    <h2 class="display name">${esc(b.name)}</h2>
    <div class="typ">${esc(b.art)} · ${esc(b.strasse)}, ${esc(b.plz)} ${esc(b.ort)}</div>

    <div class="section-label">Auslastung jetzt</div>
    ${auslastung}
    ${a ? `<div class="muted" style="margin-top:4px">Stand ${zeit(DATA.live.updated)}</div>` : ''}

    <div class="facts">
      ${fakt('Sauna', esc(b.sauna_vorhanden || '–'))}
      ${fakt('Typ', esc(b.art || '–'))}
    </div>

    ${b.oeffnungszeiten_bad ? `<div class="section-label">Öffnungszeiten Bad</div><p class="text">${esc(b.oeffnungszeiten_bad)}</p>` : ''}
    ${b.oeffnungszeiten_sauna && b.oeffnungszeiten_sauna !== '/' ? `<div class="section-label">Öffnungszeiten Sauna</div><p class="text">${esc(b.oeffnungszeiten_sauna)}</p>` : ''}
    ${b.informationen ? `<p style="margin-top:12px"><a class="extlink" href="${esc(b.informationen)}" target="_blank" rel="noopener">Infos &amp; Preise bei den SWM ↗</a></p>` : ''}
  `;
}

function steckbriefBadestelle(b) {
  const live = DATA.live;
  const wt = live.isar?.wassertemperatur, ws = live.isar?.wasserstand, af = live.isar?.abfluss;
  const kat = wt ? kategorie(wt.wert) : null;
  const ll = L.latLng(+b.lat, +b.lon);

  // Gefahrenstellen im Umkreis von 1,5 km
  const gefahren = DATA.gefahren.features
    .map(f => ({ f, d: ll.distanceTo(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0])) }))
    .filter(x => x.d < 1500).sort((x, y) => x.d - y.d);

  // Nächstes Bad
  const naechstesBad = DATA.baeder.filter(x => x.latitude)
    .map(x => ({ x, d: ll.distanceTo(L.latLng(+x.latitude, +x.longitude)) }))
    .sort((p, q) => p.d - q.d)[0];
  const km = d => d < 1000 ? `${Math.round(d / 50) * 50} m` : `${fmt(d / 1000)} km`;

  return `
    <button class="back-link" data-back>← Alle Badestellen</button>
    <h2 class="display name">${esc(b.name)}</h2>
    <div class="typ">${esc(b.gewaesser)} · Badebereich laut Stadt München erlaubt</div>

    ${wt ? `<div class="wt-klein"><span class="display">${fmt(wt.wert)} °C</span>
      <span class="badge" style="background:${kat[2]}">${kat[1]}</span></div>` : ''}

    <div class="facts">
      ${fakt('Wasserstand', ws ? `${ws.wert} cm` : '–')}
      ${fakt('Abfluss', af ? `${fmt(af.wert)} m³/s` : '–')}
      ${fakt('FKK', b.fkk === 'ja' ? 'Bereich in der Nähe' : '–')}
      ${fakt('Wasserwacht', esc(b.wasserwacht || '–'))}
    </div>
    <p class="muted">Temperatur und Pegel stammen von der Messstelle München (${esc(b.messstelle_gkd)}) und gelten für den ganzen Stadtabschnitt.</p>

    <div class="section-label">Gefahrenstellen in der Nähe</div>
    ${gefahren.length
      ? gefahren.map(({ f, d }) => `<div class="gefahr"><b>⚠ ${esc(f.properties.lage)}</b> <span class="muted">· ${km(d)}</span><br><span class="text">${esc(f.properties.hinweis)}</span></div>`).join('')
      : '<p class="muted">Keine im Umkreis von 1,5 km.</p>'}

    ${naechstesBad ? `<div class="section-label">Nächstes Schwimmbad</div>
      <p><a href="#bad/${naechstesBad.x.slug}" data-key="b-${naechstesBad.x.slug}">${esc(naechstesBad.x.name)}</a> <span class="muted">· ${km(naechstesBad.d)} Luftlinie</span></p>` : ''}

    <p class="muted" style="margin-top:14px">Die Lage des Punkts ist noch grob und wird verfeinert.</p>
  `;
}

function renderSeitenleiste() {
  $('tabs').addEventListener('click', e => { if (e.target.dataset.tab) { zeigeListe(e.target.dataset.tab); } });
  $('sheet-griff').addEventListener('click', () => $('seitenleiste').classList.toggle('sheet-open'));
  window.addEventListener('resize', () => { if (!$('tabs').hidden) setPeek(); });
  $('liste').addEventListener('click', e => {
    if (e.target.closest('[data-back]')) return zeigeListe();
    const fb = e.target.closest('[data-filter]');
    if (fb) {
      const f = fb.dataset.filter;
      aktiveFilter.has(f) ? aktiveFilter.delete(f) : aktiveFilter.add(f);
      filterMarker();
      return zeigeListe('baeder');
    }
    const el = e.target.closest('[data-key]');
    if (!el) return;
    e.preventDefault();
    zeigeSteckbrief(el.dataset.key);
  });
  // Klick in die leere Karte -> zurück zur Liste, mobil Sheet auf Peek
  map.on('click', () => { if ($('tabs').hidden) zeigeListe(); sheet(false); });

  const m = location.hash.match(/^#(bad|badestelle)\/(.+)$/);
  if (m) zeigeSteckbrief(`${m[1] === 'bad' ? 'b' : 's'}-${decodeURIComponent(m[2])}`);
  else zeigeListe('baeder');
}

// ---------- Start ----------
const DATA = {};

(async function init() {
  const [live, baeder, badestellen, zonen, gefahren, umgriffeGeo] = await Promise.all([
    json('data/live.json'), csv('data/baeder.csv'), csv('data/badestellen.csv'),
    json('data/quellen/badezonen.geojson'), json('data/quellen/gefahrenstellen.geojson'),
    json('data/badestellen.geojson'),
  ]);
  Object.assign(DATA, { live, badestellen, gefahren, umgriffe: umgriffeGeo, baeder: baeder.filter(b => b.in_quelle !== 'nein') });

  renderIsar(live);
  renderKarte(zonen, gefahren);
  renderSeitenleiste();

  let wetter = null;
  try {
    wetter = await json(WETTER_URL);
    renderWetter(wetter);
  } catch (e) {
    $('wetter').innerHTML = '<p class="muted">Wetter gerade nicht verfügbar.</p>';
  }
  renderHinweise(live);
})();
