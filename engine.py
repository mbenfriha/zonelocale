#!/usr/bin/env python3
"""ZoneLocale — moteur de dossier d'implantation.

Usage:
  python3 engine.py --address "12 rue Oberkampf 75011 Paris" --sector restaurant \
      --slug demo-restaurant-paris11 --out ../exemples/restaurant-paris-11.html
"""
import argparse, json, math, os, re, sys, time, unicodedata, urllib.parse, urllib.request
from datetime import date

UA = "ZoneLocale/0.2 (dossier d'implantation; donnees ouvertes OSM+INSEE)"
BASE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(BASE, "assets", "data.json"), encoding="utf-8"))

SECTOR = {s["id"]: s for s in DATA["sectors"]}
ANCHORS = DATA["anchors"]


def http_json(url, params=None, timeout=60, retries=2):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + 2 * i)
    raise RuntimeError(f"HTTP KO {url}: {last}")


def overpass(query, timeout=90):
    data = urllib.parse.urlencode({"data": query}).encode()
    endpoints = ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter"]
    last = None
    for ep in endpoints:
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2)
    raise RuntimeError(f"Overpass KO: {last}")


def dist_m(a, b):
    R = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower().strip()


def geocode(address):
    r = http_json("https://api-adresse.data.gouv.fr/search/", {"q": address, "limit": 1})
    if not r.get("features"):
        raise SystemExit("Adresse introuvable : " + address)
    f = r["features"][0]
    lon, lat = f["geometry"]["coordinates"]
    p = f["properties"]
    return {"label": p.get("label"), "lat": lat, "lon": lon, "citycode": p.get("citycode"),
            "city": p.get("city"), "postcode": p.get("postcode"), "score": p.get("score")}


def commune_info(citycode):
    r = http_json(f"https://geo.api.gouv.fr/communes/{citycode}",
                  {"fields": "nom,population,surface,centre,codeDepartement,codeRegion"})
    return r


def catchment(lat, lon, commune, radii=(300, 600, 1000, 3000)):
    """Population estimée par anneau.

    Méthode (documentée dans le dossier) :
    - en deçà du rayon équivalent de la commune : densité communale × surface de l'anneau ;
    - au-delà : population communale entière + 50 % de la population des communes voisines
      dont le centre tombe dans le rayon (approximation de recouvrement partiel).
    """
    code_dept = commune.get("codeDepartement") or "75"
    pop_c = commune.get("population") or 0
    surf_km2 = (commune.get("surface") or 0) / 100.0  # geo.api renvoie des hectares
    dens = (pop_c / surf_km2) if surf_km2 else 0
    equiv_r = math.sqrt(surf_km2 / math.pi) * 1000 if surf_km2 else 0

    communes = http_json(f"https://geo.api.gouv.fr/departements/{code_dept}/communes",
                         {"fields": "nom,population,centre,surface"})
    rings = {}
    for r in radii:
        if equiv_r and r <= equiv_r:
            pop = dens * math.pi * (r / 1000.0) ** 2
            detail = [{"nom": commune.get("nom"), "pop": round(pop), "dist": 0}]
        else:
            pop = pop_c
            detail = [{"nom": commune.get("nom"), "pop": pop_c, "dist": 0}]
            for c in communes:
                ctr = c.get("centre")
                if not ctr or not c.get("population") or c.get("nom") == commune.get("nom"):
                    continue
                d = dist_m((lat, lon), (ctr["coordinates"][1], ctr["coordinates"][0]))
                if d and d <= r:
                    pop += 0.5 * c["population"]
                    detail.append({"nom": c["nom"], "pop": round(0.5 * c["population"]), "dist": round(d)})
        rings[r] = {"pop": round(pop), "communes": sorted(detail, key=lambda x: -x["pop"])[:12]}
    return rings


def fetch_pois(lat, lon, sector, radius=3000):
    parts = []
    for tag, rx in sector["osm"]:
        parts.append(f'  nwr(around:{radius},{lat},{lon})["{tag}"~"{rx}"];')
    for a in ANCHORS:
        tag, rx = a["filter"]
        parts.append(f'  nwr(around:{radius},{lat},{lon})["{tag}"~"{rx}"];')
    q = "[out:json][timeout:120];\n(\n" + "\n".join(parts) + "\n);\nout center tags;"
    res = overpass(q)
    pois = []
    for e in res.get("elements", []):
        t = e.get("tags", {})
        plat = e.get("lat") or (e.get("center") or {}).get("lat")
        plon = e.get("lon") or (e.get("center") or {}).get("lon")
        if plat is None or plon is None:
            continue
        pois.append({"lat": plat, "lon": plon, "tags": t, "d": dist_m((lat, lon), (plat, plon)),
                     "name": t.get("name") or t.get("brand") or ""})
    return pois


def classify(pois, sector):
    comp_rx = [(tag, re.compile(rx)) for tag, rx in sector["osm"]]
    comps, anchors = [], []
    for p in pois:
        t = p["tags"]
        if any(t.get(tag) and rx.search(t[tag]) for tag, rx in comp_rx):
            comps.append(p)
            continue
        for a in ANCHORS:
            tag, rx = a["filter"]
            if t.get(tag) and re.search(rx, t[tag]):
                p["anchor"] = a["key"]
                anchors.append(p)
                break
    comps.sort(key=lambda p: p["d"])
    return comps, anchors


def analyse(address, sector_id, radius=3000):
    sector = SECTOR[sector_id]
    geo = geocode(address)
    com = commune_info(geo["citycode"])
    rings = catchment(geo["lat"], geo["lon"], com)
    t0 = time.time()
    pois = fetch_pois(geo["lat"], geo["lon"], sector, radius)
    comps, anchors = classify(pois, sector)

    def count(d):
        return sum(1 for c in comps if c["d"] <= d)

    bands = {300: count(300), 600: count(600), 1000: count(1000), 3000: count(3000)}

    pop = com.get("population") or 0
    surf = com.get("surface") or 0
    dens = round(pop / (surf / 100.0)) if surf else None

    pop_rings = {}
    prev = 0
    for r in (300, 600, 1000, 3000):
        pop_rings[r] = rings[r]["pop"]
    pop_3k = sum(pop_rings.values())

    # densité concurrentielle pour 1000 habitants — même anneau (1 km) des deux côtés
    tens_local = round(bands[1000] / max(pop_rings[1000], 1) * 1000, 2)
    tens_ratio = round(tens_local / sector["density_fr"], 2) if sector["density_fr"] else None

    # marché théorique : on reste sur l'anneau 1 km, cohérent avec le décompte concurrentiel
    pop_1k = max(pop_rings[1000], min(pop, 2500))
    market = pop_1k * sector["visit_per_month"] * 12 * sector["ticket"]
    market_3k = pop_3k * sector["visit_per_month"] * 12 * sector["ticket"]
    share = market / (bands[1000] + 1)
    anchors_by_key = {}
    for a in anchors:
        if a["d"] <= 1000:
            anchors_by_key[a["anchor"]] = anchors_by_key.get(a["anchor"], 0) + 1
    boost = 1.0
    boost += min(0.25, anchors_by_key.get("transport", 0) * 0.03)
    boost += min(0.20, anchors_by_key.get("supermarche", 0) * 0.05)
    ca_mid = share * boost
    scenarios = {"bas": ca_mid * 0.6, "median": ca_mid, "haut": ca_mid * 1.4}

    score = 62
    if tens_ratio is not None:
        score -= min(38, max(0, (tens_ratio - 1.2) * 11))
    if pop_1k >= 40000:
        score += 10
    elif pop_1k >= 15000:
        score += 5
    elif pop_1k < 4000:
        score -= 12
    score += min(8, anchors_by_key.get("transport", 0) * 0.8)
    score += min(4, anchors_by_key.get("supermarche", 0) * 1.5)
    score = int(max(5, min(95, score)))
    verdict = ("Zone porteuse" if score >= 75 else "Zone à potentiel sous conditions" if score >= 55
               else "Zone difficile — à travailler avant de signer")

    return {
        "generated": date.today().isoformat(),
        "sector": sector, "geo": geo, "commune": {"nom": com.get("nom"), "population": pop,
                                                  "surface_km2": round(surf / 100, 1) if surf else None,
                                                  "densite": dens, "dept": com.get("codeDepartement")},
        "bands": bands, "pop_rings": pop_rings, "pop_3k": pop_3k,
        "rings": rings, "competitors": comps[:400], "anchors": anchors,
        "anchors_by_key": anchors_by_key, "tension_local": tens_local, "tension_ratio": tens_ratio,
        "market": market, "market_3k": market_3k, "pop_1k": pop_1k, "ca": scenarios, "score": score, "verdict": verdict,
        "elapsed": round(time.time() - t0, 1),
        "anchor_labels": {a["key"]: a["label"] for a in ANCHORS},
        "poi_total": len(pois),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--sector", required=True, choices=sorted(SECTOR))
    ap.add_argument("--slug", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--json-out")
    args = ap.parse_args()

    res = analyse(args.address, args.sector)
    if args.json_out:
        json.dump(res, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    from jinja2 import Environment, FileSystemLoader
    env = Environment(loader=FileSystemLoader(os.path.join(BASE, "templates")))
    env.filters["eur"] = lambda v: f"{v:,.0f}".replace(",", " ") + " €"
    env.filters["int"] = lambda v: f"{v:,.0f}".replace(",", " ")
    tpl = env.get_template("dossier.html")
    html = tpl.render(r=res)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    open(args.out, "w", encoding="utf-8").write(html)
    print("OK", args.out, "| score", res["score"], "| concurrents 1km", res["bands"][1000],
          "| pop 3km", res["pop_3k"], "| CA median", round(res["ca"]["median"]), "| secs", res["elapsed"])


if __name__ == "__main__":
    main()
