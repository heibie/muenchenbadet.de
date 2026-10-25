<?php
/**
 * fetch_live.php – holt die Live-Werte für muenchenbadet.de und schreibt
 * data/live.json (für die Seite) + hängt an data/history/*.csv an (eigene Zeitreihe).
 *
 * Quellen:
 *  - Wassertemperatur Isar München (GKD Bayern, Messstelle 16005701, 15-Min-Werte, CC BY 4.0)
 *  - Wasserstand + Abfluss Isar München (HND Bayern, gleiche Messstelle)
 *  - Auslastung SWM-Bäder (inoffizielle JSON-Endpunkte, die swm.de/baeder/auslastung selbst nutzt)
 *
 * Keiner der Bayern-Dienste hat ein API -> HTML-Tabellen werden geparst. Bricht ein
 * Parser, bleibt der jeweilige Block im JSON leer (+ "error"), der Rest läuft weiter.
 *
 * Aufruf lokal:  php cron/fetch_live.php
 * Aufruf live:   https://muenchenbadet.de/cron/fetch_live.php?token=… (Cronjob alle 15 Min).
 *                Token steht in cron/_cfg.php (gitignored, von Hand auf den Server laden,
 *                Vorlage: _cfg.example.php).
 */

date_default_timezone_set('Europe/Berlin');
ini_set('serialize_precision', '-1');   // sonst landet je nach Server-Konfiguration 11.1999… statt 11.2 im JSON

if (PHP_SAPI !== 'cli') {
    header('Content-Type: text/plain; charset=utf-8');
    $cfgFile = __DIR__ . '/_cfg.php';
    $cfg = file_exists($cfgFile) ? require $cfgFile : [];
    $token = $_GET['token'] ?? '';
    if (!$token || !hash_equals((string) ($cfg['cron_token'] ?? ''), $token)) {
        http_response_code(403);
        exit("forbidden\n");
    }
}

const ROOT    = __DIR__ . '/..';
const STATION = '16005701';
const UA      = 'muenchenbadet.de/0.1 (Open-Data-Projekt; heiko@bielinski.de)';

// Meldestufen Pegel München laut HND (Stand 2026-10-10)
const MELDESTUFEN = [1 => 240, 2 => 300, 3 => 380, 4 => 520];

// Welche Zähler gehören zu welchem Bad: Spalten swm_* in data/baeder.csv
// (area_id aus swm.de/.rest/bath/visitorCount, mehrere IDs mit "|", Präfix "ticos:" für
// counter.ticos-systems.cloud). Schlüssel = "slug".
// Saunen: SWM führt (beobachtet am 2026-10-25) je zwei Zähler (alt 9/18/33/…, neu "XX - Sauna" 102–123),
// mal zählt der eine, mal der andere. Bei mehreren IDs gilt der höhere Besucherwert.
// Westbad und Volksbad-Sauna liefen früher über ticos (30199/30207/30204),
// stehen inzwischen aber in visitorCount; ticos liefert dort nur noch 0.
const BEREICH_SPALTEN = [
    'swm_hallenbad'          => 'Hallenbad',
    'swm_winter_warmfreibad' => 'Winter-Warmfreibad',
    'swm_freibad'            => 'Freibad',
    'swm_sauna'              => 'Sauna',
];

function lade_zaehler(string $csv): array {
    $fh = fopen($csv, 'r');
    $kopf = fgetcsv($fh, null, ',', '"', '');
    $map = [];
    while (($z = fgetcsv($fh, null, ',', '"', '')) !== false) {
        $r = array_combine($kopf, $z);
        foreach (BEREICH_SPALTEN as $spalte => $bereich) {
            if (($r[$spalte] ?? '') === '') continue;
            $quellen = [];
            foreach (explode('|', $r[$spalte]) as $id) {
                $quellen[] = str_starts_with($id, 'ticos:') ? ['ticos', (int) substr($id, 6)] : ['swm', (int) $id];
            }
            $map[$r['slug']][$bereich] = $quellen;
        }
    }
    fclose($fh);
    return $map;
}

function http_get(string $url): ?string {
    $ctx = stream_context_create(['http' => [
        'timeout' => 25,
        'header'  => "User-Agent: " . UA . "\r\n",
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) return null;
    $status = $http_response_header[0] ?? '';
    if (!preg_match('/\s2\d\d\s/', $status)) return null;
    return $body;
}

function html_text(string $html): string {
    $t = preg_replace('/<[^>]*>/', ' ', $html);
    $t = html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return preg_replace('/\s+/', ' ', $t);
}

function de_ts(string $d): string {           // "10.10.2026 14:15" -> ISO
    $dt = DateTime::createFromFormat('d.m.Y H:i', $d);
    return $dt ? $dt->format('c') : $d;
}

function de_num(string $n): float {
    return (float) str_replace(',', '.', $n);
}

/** Tabelle "Datum | Wert" parsen -> [[iso, wert], ...] neueste zuerst */
function parse_table(string $text, string $uhr = ''): array {
    $re = '/(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})' . ($uhr ? ' ' . $uhr : '') . ' (-?[\d]+(?:,\d+)?)/';
    preg_match_all($re, $text, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $row) $out[] = [de_ts($row[1]), de_num($row[2])];
    return $out;
}

$live = ['updated' => date('c'), 'station' => STATION];
$errors = [];

// --- Isar: Wassertemperatur (GKD, 15-Min-Werte der letzten 7 Tage) ---
$html = http_get('https://www.gkd.bayern.de/de/fluesse/wassertemperatur/isar/muenchen-' . STATION . '/messwerte/tabelle');
$temp = $html ? parse_table(html_text($html), 'Uhr') : [];
if (!$temp) $errors[] = 'wassertemperatur';

// --- Isar: Wasserstand + Abfluss (HND, Stundenwerte) ---
$html = http_get('https://www.hnd.bayern.de/pegel/isar/muenchen-' . STATION . '/tabelle?methode=wasserstand');
$pegel = $html ? parse_table(html_text($html)) : [];
if (!$pegel) $errors[] = 'wasserstand';

$html = http_get('https://www.hnd.bayern.de/pegel/isar/muenchen-' . STATION . '/tabelle?methode=abfluss');
$abfluss = $html ? parse_table(html_text($html)) : [];
if (!$abfluss) $errors[] = 'abfluss';

$stufe = 0;
if ($pegel) foreach (MELDESTUFEN as $s => $cm) if ($pegel[0][1] >= $cm) $stufe = $s;

// Serien chronologisch (älteste zuerst), Temperatur auf Stundenwerte ausgedünnt
$tempHourly = array_values(array_filter($temp, fn($r) => substr($r[0], 14, 2) === '00'));

$live['isar'] = [
    'wassertemperatur' => $temp ? ['wert' => $temp[0][1], 'zeit' => $temp[0][0], 'serie' => array_reverse($tempHourly)] : null,
    'wasserstand'      => $pegel ? ['wert' => $pegel[0][1], 'zeit' => $pegel[0][0], 'meldestufe' => $stufe, 'meldestufen' => MELDESTUFEN, 'serie' => array_reverse($pegel)] : null,
    'abfluss'          => $abfluss ? ['wert' => $abfluss[0][1], 'zeit' => $abfluss[0][0], 'serie' => array_reverse($abfluss)] : null,
];

// --- Bäder: Auslastung ---
$swm = [];
$json = http_get('https://www.swm.de/.rest/bath/visitorCount');
if ($json && ($d = json_decode($json, true)) && ($d['return_code'] ?? '') === 'success') {
    foreach ($d['data'] as $loc) foreach ($loc['area_list'] as $a) {
        $swm[$a['area_id']] = [(int) $a['customer_amount'], (int) $a['customer_amount_max']];
    }
} else {
    $errors[] = 'swm';
}

$baeder = [];
foreach (lade_zaehler(ROOT . '/data/baeder.csv') as $bad => $bereiche) {
    foreach ($bereiche as $bereich => $quellen) {
        $val = null;
        foreach ($quellen as [$src, $id]) {
            $v = null;
            if ($src === 'swm') {
                $v = $swm[$id] ?? null;
            } else {
                $j = http_get('https://counter.ticos-systems.cloud/api/gates/counter?organizationUnitIds=' . $id);
                $r = $j ? (json_decode($j, true)[0] ?? null) : null;
                if ($r) $v = [(int) $r['personCount'], (int) $r['maxPersonCount']];
                else $errors[] = "ticos-$id";
            }
            if ($v && ($val === null || $v[0] > $val[0])) $val = $v;
        }
        if ($val) $baeder[$bad][$bereich] = ['besucher' => $val[0], 'max' => $val[1]];
    }
}
$live['baeder'] = $baeder;
$live['errors'] = $errors;

file_put_contents(ROOT . '/data/live.json', json_encode($live, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

// --- Eigene Zeitreihe fortschreiben (eine Zeile pro Lauf, Monatsdateien) ---
if (!is_dir(ROOT . '/data/history')) mkdir(ROOT . '/data/history', 0755, true);
$month = date('Y-m');
$now = date('c');

$f = ROOT . "/data/history/isar-$month.csv";
$new = !file_exists($f);
$fh = fopen($f, 'a');
if ($new) fputcsv($fh, ['abruf', 'wassertemperatur_c', 'wassertemperatur_zeit', 'wasserstand_cm', 'abfluss_m3s', 'pegel_zeit'], ',', '"', '');
fputcsv($fh, [$now, $temp[0][1] ?? '', $temp[0][0] ?? '', $pegel[0][1] ?? '', $abfluss[0][1] ?? '', $pegel[0][0] ?? ''], ',', '"', '');
fclose($fh);

$f = ROOT . "/data/history/baeder-$month.csv";
$new = !file_exists($f);
$fh = fopen($f, 'a');
if ($new) fputcsv($fh, ['abruf', 'bad', 'bereich', 'besucher', 'max'], ',', '"', '');
foreach ($baeder as $bad => $bereiche) foreach ($bereiche as $bereich => $v) {
    fputcsv($fh, [$now, $bad, $bereich, $v['besucher'], $v['max']], ',', '"', '');
}
fclose($fh);

echo "ok " . $now . ($errors ? ' – Fehler: ' . implode(', ', $errors) : '') . "\n";
