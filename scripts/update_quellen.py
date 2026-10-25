#!/usr/bin/env python3
"""
update_quellen.py – zieht die Stammdaten frisch von den Quellen und gleicht
unsere eigenen Tabellen damit ab.

Zwei Ebenen:
  data/quellen/*      Rohdaten 1:1 von der Quelle, werden bei jedem Lauf überschrieben.
  data/baeder.csv     Unsere Tabelle: Quellspalten werden aktualisiert, eigene Spalten
  data/badestellen.csv  (id, slug, alles Angereicherte) bleiben erhalten.

Regeln (wie bei den anderen Projekten):
  - IDs sind stabil (Deep-Link-Anker) und werden nie neu vergeben oder aufgefüllt.
  - Neuer Eintrag in der Quelle  -> wird angehängt, bekommt max(id)+1.
  - Eintrag fehlt in der Quelle  -> bleibt stehen, in_quelle = "nein".
  - Abgleich über die Spalte quelle_key (= Name in der SWM-Liste). Benennt die
    Quelle etwas um, erscheint es als neu + alt "nein" -> dann quelle_key von Hand
    beim alten Eintrag nachziehen und den neuen löschen.

Aufruf: python3 scripts/update_quellen.py   (Ausgabe: was sich geändert hat)
"""
import csv
import io
import json
import os
import ssl
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUELLEN = ROOT / "data" / "quellen"
UA = "muenchenbadet.de/0.1 (Open-Data-Projekt; heiko@bielinski.de)"

WFS = ("https://geoportal.muenchen.de/geoserver/rku_wfs/ows?service=WFS&version=1.1.0"
       "&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&typeName=")

SOURCES = {
    "swm_schwimmbaeder.csv": "https://opendata.muenchen.de/dataset/b9965c5b-3468-4bf8-ab24-79d7aa2e5bc7/resource/dd6dd857-3c1c-46cb-a837-ca77b23ae314/download/schwimmbaeder.csv",
    "badezonen.geojson":     WFS + "rku_wfs:isar_baden",
    "gefahrenstellen.geojson": WFS + "rku_wfs:isar_gefahrenstellen",
}

# Spalten, die aus der SWM-Quelle kommen (werden überschrieben)
BAEDER_QUELLSPALTEN = ["name", "strasse", "plz", "ort", "art", "latitude", "longitude", "beschreibung",
                       "oeffnungszeiten_bad", "sauna_vorhanden", "oeffnungszeiten_sauna",
                       "informationen", "echtzeitauslastung"]

# Eigene Merkmal-Spalten (ja/nein) – werden nur bei neuen Bädern aus "art" vorbelegt.
# naturbad/wellenbad stehen nicht in "art" und bleiben dann "nein".
MERKMAL_AUS_ART = {"hallenbad": "hallenbad", "freibad": "freibad", "winter_warmfreibad": "winter-warmfreibad",
                   "sauna": "sauna", "fitness": "fitness", "eisstadion": "eisstadion",
                   "naturbad": "naturbad", "wellenbad": "wellenbad"}


def fetch(url: str) -> bytes:
    # python.org-Python auf dem Mac findet die System-CAs nicht (wie bei openbibmuc)
    ctx = ssl.create_default_context()
    if os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
        return r.read()


def round_coords(c):
    return [round_coords(x) for x in c] if isinstance(c[0], list) else [round(c[0], 5), round(c[1], 5)]


def slugify(name: str) -> str:
    s = name.lower()
    for a, b in {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "`": "", "'": "", "’": "", " / ": "-", " ": "-"}.items():
        s = s.replace(a, b)
    return s


def read_csv(path: Path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        return list(r), r.fieldnames


def write_csv(path: Path, rows, fields):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def update_rohdaten():
    for fn, url in SOURCES.items():
        data = fetch(url)
        if fn.endswith(".geojson"):
            d = json.loads(data)
            for feat in d["features"]:
                feat["geometry"]["coordinates"] = round_coords(feat["geometry"]["coordinates"])
            d = {"type": "FeatureCollection", "features": d["features"]}
            (QUELLEN / fn).write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            print(f"  {fn}: {len(d['features'])} Features")
        else:
            (QUELLEN / fn).write_bytes(data)
            print(f"  {fn}: {len(data)} Bytes")


def abgleich_baeder():
    src, _ = read_csv(QUELLEN / "swm_schwimmbaeder.csv")
    src = {r["name"]: {k: ("" if v == "NA" else v) for k, v in r.items()} for r in src}

    path = ROOT / "data" / "baeder.csv"
    rows, fields = read_csv(path)
    for col in ("quelle_key", "in_quelle"):
        if col not in fields:
            fields.insert(2, col)
    by_key = {r.get("quelle_key") or r["name"]: r for r in rows}

    changes = []
    for key, s in src.items():
        r = by_key.get(key)
        if r is None:
            new_id = max(int(x["id"]) for x in rows) + 1
            r = {"id": new_id, "slug": slugify(key), "quelle_key": key}
            # Merkmale grob aus "art" vorbelegen, danach von Hand prüfen (swm_*-IDs bleiben leer)
            art = (s.get("art") or "").lower()
            for col, wort in MERKMAL_AUS_ART.items():
                if col in fields:
                    r[col] = "ja" if wort in art else "nein"
            rows.append(r)
            changes.append(f"NEU {new_id} {key} – Merkmale + swm_*-Zähler-IDs von Hand prüfen")
        for col in BAEDER_QUELLSPALTEN:
            if r.get(col, "") != s.get(col, ""):
                if col in r:  # nur bestehende Einträge als Änderung melden
                    changes.append(f"  {r['id']} {key}: {col} geändert")
                r[col] = s.get(col, "")
        r["quelle_key"] = key
        r["in_quelle"] = "ja"

    for r in rows:
        if (r.get("quelle_key") or r["name"]) not in src:
            if r.get("in_quelle") != "nein":
                changes.append(f"FEHLT IN QUELLE {r['id']} {r['name']}")
            r["in_quelle"] = "nein"

    rows.sort(key=lambda r: int(r["id"]))
    write_csv(path, rows, fields)
    print(f"  baeder.csv: {len(rows)} Einträge")
    for c in changes:
        print("   ", c)


def check_badestellen():
    """Badestellen sind kuratiert (keine Quelle) – hier nur prüfen, ob die
    referenzierten Badezonen-IDs nach dem Update noch existieren."""
    zonen = json.loads((QUELLEN / "badezonen.geojson").read_text(encoding="utf-8"))
    ids = {f["id"]: f["properties"].get("badeverbot") for f in zonen["features"]}
    rows, _ = read_csv(ROOT / "data" / "badestellen.csv")
    ok = True
    for r in rows:
        z = r["badezone_id"]
        if z not in ids:
            print(f"   WARNUNG: Badestelle {r['id']} {r['name']}: Zone {z} gibt es nicht mehr")
            ok = False
        elif ids[z] != "erlaubt":
            print(f"   WARNUNG: Badestelle {r['id']} {r['name']}: Zone {z} ist jetzt '{ids[z]}'")
            ok = False
    print(f"  badestellen.csv: {len(rows)} Einträge, Zonen-Referenzen {'ok' if ok else 'PRÜFEN'}")


def _clip(ring, lat, keep_above):
    """Sutherland-Hodgman: Ring an einer Breitengrad-Linie abschneiden."""
    inside = (lambda p: p[1] >= lat) if keep_above else (lambda p: p[1] <= lat)
    out = []
    for i, cur in enumerate(ring):
        prev = ring[i - 1]
        if inside(cur):
            if not inside(prev):
                t = (lat - prev[1]) / (cur[1] - prev[1])
                out.append([round(prev[0] + t * (cur[0] - prev[0]), 5), lat])
            out.append(cur)
        elif inside(prev):
            t = (lat - prev[1]) / (cur[1] - prev[1])
            out.append([round(prev[0] + t * (cur[0] - prev[0]), 5), lat])
    return out


def build_umgriffe():
    """data/badestellen.geojson: pro Badestelle der Ausschnitt ihrer Badezone
    zwischen umgriff_lat_sued und umgriff_lat_nord (Spalten in badestellen.csv,
    von Hand anpassbar). Wird bei jedem Lauf aus der aktuellen Zone neu erzeugt."""
    zonen = json.loads((QUELLEN / "badezonen.geojson").read_text(encoding="utf-8"))
    zonen = {f["id"]: f for f in zonen["features"]}
    rows, _ = read_csv(ROOT / "data" / "badestellen.csv")
    feats = []
    for r in rows:
        z = zonen.get(r["badezone_id"])
        if not z or not r.get("umgriff_lat_sued"):
            continue
        sued, nord = float(r["umgriff_lat_sued"]), float(r["umgriff_lat_nord"])
        polys = []
        for poly in z["geometry"]["coordinates"]:
            rings = []
            for ring in poly:
                c = _clip(_clip(ring, sued, True), nord, False)
                if len(c) >= 3:
                    rings.append(c + [c[0]] if c[0] != c[-1] else c)
            if rings:
                polys.append(rings)
        if polys:
            feats.append({"type": "Feature",
                          "properties": {"id": int(r["id"]), "slug": r["slug"], "name": r["name"]},
                          "geometry": {"type": "MultiPolygon", "coordinates": polys}})
    out = ROOT / "data" / "badestellen.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  badestellen.geojson: {len(feats)} Umgriffe")


if __name__ == "__main__":
    print("Rohdaten:")
    update_rohdaten()
    print("Abgleich:")
    abgleich_baeder()
    check_badestellen()
    build_umgriffe()
