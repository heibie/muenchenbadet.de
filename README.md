# muenchenbadet.de (Arbeitstitel)

Baden und Schwimmen in München aus offenen Daten: Wassertemperatur und Pegel der Isar, Auslastung der SWM-Bäder, Badestellen und Gefahrenstellen an der Isar, Badewetter.

**Status:** Git-Repo `heibie/muenchenbadet.de`, Deploy per GitHub Actions (seit 2026-10-25).

## Deploy

- Push auf `main` → `.github/workflows/deploy.yml` → rsync auf den Webserver (Zugangsdaten als GitHub-Secrets)
- `data/live.json` und `data/history/` entstehen auf dem Server und werden beim Deploy nicht angefasst
- `cron/fetch_live.php` läuft live als Cronjob per URL mit Token. Den Token liest das Skript aus `cron/_cfg.php` (gitignored, von Hand auf den Server laden; Vorlage `cron/_cfg.example.php`). Ohne gültigen Token antwortet es mit 403
- `scripts/update_quellen.py` läuft lokal, danach committen und pushen

## Lokal starten

```
php cron/fetch_live.php          # Live-Werte holen -> data/live.json + data/history/
python3 scripts/update_quellen.py # Stammdaten von den Quellen aktualisieren
php -S localhost:8091            # http://localhost:8091
```

**Cache-Busting:** `index.html` bindet `js/app.js?v=JJJJ-MM-TT` ein. Bei jeder Änderung an `app.js` das Datum hochziehen, sonst laufen altes JS und neues HTML gegeneinander.

## Daten

| Datei | Inhalt | Herkunft / Update |
|---|---|---|
| `data/quellen/swm_schwimmbaeder.csv` | Rohdaten Bäder | Open-Data-Portal München (SWM), `update_quellen.py` überschreibt |
| `data/quellen/badezonen.geojson` | Baden erlaubt/verboten an der Isar | WFS Geoportal München (`rku_wfs:isar_baden`), `update_quellen.py` |
| `data/quellen/gefahrenstellen.geojson` | Gefahrenstellen Isar | WFS Geoportal München (`rku_wfs:isar_gefahrenstellen`), `update_quellen.py` |
| `data/baeder.csv` | **Unsere** Bädertabelle: stabile `id`/`slug` + Quellspalten + eigene Spalten: Merkmale `hallenbad`, `freibad`, `winter_warmfreibad`, `sauna`, `fitness`, `eisstadion`, `naturbad`, `wellenbad` (ja/nein, für den Filter) Foto `bild_url` (og:image der SWM-Bad-Seite, direkt von swm.de eingebunden, von Hand gepflegt) und Zähler-IDs `swm_location_id`, `swm_hallenbad`, `swm_freibad`, `swm_winter_warmfreibad`, `swm_sauna` (area_id aus visitorCount, mehrere mit `\|`, Präfix `ticos:` möglich). `fetch_live.php` liest die Zuordnung von hier | `update_quellen.py` gleicht über `quelle_key` ab: Quellspalten werden aktualisiert, eigene Spalten bleiben, neue Bäder werden angehängt, fehlende bekommen `in_quelle = nein` |
| `data/badestellen.csv` | Kuratierte Isar-Badestellen, verweisen per `badezone_id` auf eine erlaubte Zone. `umgriff_lat_sued`/`umgriff_lat_nord` legen den Ausschnitt der Zone fest, der zur Badestelle gehört | Von Hand gepflegt. `update_quellen.py` prüft, ob die Zonen-IDs noch existieren und erlaubt sind |
| `data/badestellen.geojson` | Umgriffe der Badestellen (Polygon) | Wird von `update_quellen.py` aus Zone und Breitengrad-Band erzeugt, nicht von Hand bearbeiten |
| `data/live.json` | Aktuelle Werte (Isar + Auslastung) | `cron/fetch_live.php`, nicht im Git |
| `data/history/*.csv` | Eigene Zeitreihe, Monatsdateien | `cron/fetch_live.php` hängt an |
| `data/source-registry.json` | Quellenliste für `daten.html` (Titel, Dateien, Original, Lizenz, Turnus) | Von Hand pflegen, wenn eine Quelle dazukommt oder sich ändert |

**IDs sind stabil** und werden nie neu durchnummeriert.

Live-Quellen (`cron/fetch_live.php`):
- Wassertemperatur: GKD Bayern, Messstelle München 16005701 (HTML-Tabelle, 15-Min-Werte, CC BY 4.0)
- Wasserstand und Abfluss: HND Bayern, gleiche Messstelle (Stundenwerte). Meldestufen 240/300/380/520 cm
- Auslastung: `swm.de/.rest/bath/visitorCount`. Inoffiziell, genau der Endpunkt, den swm.de selbst nutzt. Westbad und Volksbad-Sauna liefen früher über `counter.ticos-systems.cloud`, stehen jetzt ebenfalls in `visitorCount`. Saunen haben dort je zwei Zähler (alt/neu), es zählt der höhere Wert
- Wetter: Open-Meteo, direkt im Browser. Icons: Meteocons (Bas Milius, MIT), lokal in `img/wetter/`

Keine der Bayern-Quellen hat ein API: Wenn sich das HTML ändert, bricht der Parser. Das landet dann in `live.json` unter `errors`.

Bäder gelten als **geschlossen**, wenn keine Live-Auslastung kommt, keine Öffnungszeiten eingetragen sind oder gerade niemand gezählt wird (meist Freibäder außerhalb der Saison).

## Offen

- Koordinaten der Badestellen sind grob (Mitte der Badezone), müssen noch von Hand verfeinert werden
- Schwelle „erhöhter Wasserstand“ (150 cm) ist vorläufig, sie steuert die Pegel-Ampel, die Pegelskala und den Hinweis „Erhöhter Wasserstand“
- Sauna-Zähler: Die SWM führt pro Sauna zwei Zähler (alt/neu, IDs 102–123). `fetch_live.php` nimmt bewusst den höheren Wert (Behelfsregel, Stand 2026-10-25). Falls ein alter Zähler bei einem Wert über 0 einfriert, wird das falsch. Sauberer wäre es, die Zuordnung auf swm.de/baeder/auslastung nachzuschauen und fest einzutragen
- ticos-Abruf in `fetch_live.php` wird von keinem Bad mehr genutzt (Rückfallebene), ggf. entfernen
- Quellen-Check (Status-Spalte wie bei openbibmuc), datapackage.json
- Datenschutz: Leaflet, PapaParse und Google Fonts lokal hosten, dann entfallen drei Drittanbieter im Impressum
