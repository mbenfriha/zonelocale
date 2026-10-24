// ZoneLocale — diagnostic gratuit côté navigateur (aucune donnée envoyée à nos serveurs)
const $ = (s) => document.querySelector(s);
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
let DATA = null, selected = null, running = false;

// Quand le lien de paiement existe (Stripe / Polar), le coller ici : il remplace le mailto partout.
const PAYMENT_URL = ""; // ex. "https://buy.stripe.com/xxxxxxxx"

const fmt = (n) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
const eur = (n) => fmt(n) + " €";
const dist = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
};

async function init() {
  DATA = await getJSON("assets/data.json");
  const sel = $("#sector");
  sel.innerHTML = DATA.sectors.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  // adresse passée en paramètre ?addr=...&sector=...
  const p = new URLSearchParams(location.search);
  if (p.get("addr")) { $("#addr").value = p.get("addr"); }
  if (p.get("sector")) { sel.value = p.get("sector"); }
  if (p.get("addr") && p.get("run") === "1") { $("#form").requestSubmit(); }
}

// ---------- autocomplete adresse ----------
let tmr = null;
$("#addr").addEventListener("input", () => {
  selected = null;
  clearTimeout(tmr);
  const q = $("#addr").value.trim();
  const box = $("#suggest");
  if (q.length < 4) { box.hidden = true; return; }
  tmr = setTimeout(async () => {
    try {
      const r = await getJSON("https://api-adresse.data.gouv.fr/search/?limit=5&q=" + encodeURIComponent(q));
      const rows = r.features || [];
      if (!rows.length) { box.hidden = true; return; }
      box.innerHTML = rows.map((f, i) =>
        `<div data-i="${i}">${f.properties.label}</div>`).join("");
      box.hidden = false;
      box.querySelectorAll("div").forEach((el) => el.addEventListener("click", () => {
        const f = rows[+el.dataset.i];
        selected = { label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
                     citycode: f.properties.citycode, city: f.properties.city };
        $("#addr").value = f.properties.label;
        box.hidden = true;
      }));
    } catch (e) { box.hidden = true; }
  }, 260);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".addr")) $("#suggest").hidden = true;
});

// ---------- overpass ----------
async function overpass(query) {
  const body = "data=" + encodeURIComponent(query);
  let last;
  for (const ep of OVERPASS) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 45000);
      const r = await fetch(ep, { method: "POST", body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last || new Error("Overpass indisponible");
}

function buildQuery(lat, lon, sector, radius) {
  const parts = [];
  sector.osm.forEach(([k, v]) => parts.push(`nwr(around:${radius},${lat},${lon})["${k}"~"${v}"];`));
  parts.push(`nwr(around:${radius},${lat},${lon})["shop"~"^(supermarket|department_store)$"];`);
  parts.push(`nwr(around:${radius},${lat},${lon})["public_transport"~"^(station|stop_position)$"];`);
  parts.push(`nwr(around:${radius},${lat},${lon})["amenity"~"^(school|marketplace)$"];`);
  return `[out:json][timeout:40];(${parts.join("")});out center tags;`;
}

function status(msg) {
  $("#go").textContent = msg;
}

async function analyse(ev) {
  ev.preventDefault();
  if (running) return;
  running = true;
  $("#go").disabled = true;
  status("Géocodage…");
  try {
    let g = selected;
    if (!g) {
      const r = await getJSON("https://api-adresse.data.gouv.fr/search/?limit=1&q=" + encodeURIComponent($("#addr").value));
      if (!r.features || !r.features.length) throw new Error("Adresse introuvable. Ajoutez le code postal.");
      const f = r.features[0];
      g = { label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
            citycode: f.properties.citycode, city: f.properties.city };
    }
    const sector = DATA.sectors.find((s) => s.id === $("#sector").value);

    status("Population…");
    const com = await getJSON(`https://geo.api.gouv.fr/communes/${g.citycode}?fields=nom,population,surface,codeDepartement`);

    status("Concurrents… (10 à 25 s)");
    const t0 = Date.now();
    const res = await overpass(buildQuery(g.lat, g.lon, sector, 1000));
    const secs = Math.round((Date.now() - t0) / 1000);

    const compRx = sector.osm.map(([k, v]) => [k, new RegExp(v)]);
    const comps = [], anchors = { supermarche: 0, transport: 0, ecole: 0, marche: 0 };
    (res.elements || []).forEach((e) => {
      const t = e.tags || {};
      const plat = e.lat ?? e.center?.lat, plon = e.lon ?? e.center?.lon;
      if (plat == null || plon == null) return;
      const d = dist([g.lat, g.lon], [plat, plon]);
      if (compRx.some(([k, rx]) => t[k] && rx.test(t[k]))) {
        comps.push({ name: t.name || t.brand || "", d, type: t.amenity || t.shop || "" });
      } else if (t.shop === "supermarket" || t.shop === "department_store") anchors.supermarche++;
      else if (t.public_transport) anchors.transport++;
      else if (t.amenity === "school") anchors.ecole++;
      else if (t.amenity === "marketplace") anchors.marche++;
    });
    comps.sort((a, b) => a.d - b.d);

    const popC = com.population || 0, surfKm2 = (com.surface || 0) / 100;
    const dens = surfKm2 ? popC / surfKm2 : 0;
    // en tissu peu dense, on considère que le rayon 1 km dessert au moins le bourg (plafonné à 2 500 hab.)
    const pop1k = Math.max(Math.min(popC, dens * Math.PI), Math.min(popC, 2500));
    const tension = pop1k > 0 ? comps.length / pop1k * 1000 : null;
    const ratio = tension != null && sector.density_fr ? tension / sector.density_fr : null;

    const market = pop1k * sector.visit_per_month * 12 * sector.ticket;
    let boost = 1 + Math.min(0.25, anchors.transport * 0.03) + Math.min(0.2, anchors.supermarche * 0.05);
    const ca = market / (comps.length + 1) * boost;

    let score = 62;
    if (ratio != null) score -= Math.min(38, Math.max(0, (ratio - 1.2) * 11));
    if (pop1k >= 40000) score += 10; else if (pop1k >= 15000) score += 5; else if (pop1k < 4000) score -= 12;
    score += Math.min(8, anchors.transport * 0.8) + Math.min(4, anchors.supermarche * 1.5);
    score = Math.max(5, Math.min(95, Math.round(score)));

    render({ g, sector, com, comps, anchors, pop1k, dens, tension, ratio, ca, score, secs, popC });
    $("#result").hidden = false;
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    alert("L'analyse a échoué : " + (e.message || e) + "\n\nRéessayez dans quelques secondes, ou choisissez une adresse dans la liste de suggestions.");
  } finally {
    running = false;
    $("#go").disabled = false;
    status("Analyser la zone");
  }
}

function render(o) {
  const { g, sector, comps, anchors, pop1k, tension, ratio, ca, score, secs } = o;
  $("#r-addr").textContent = g.label + " · rayon 1 km · " + sector.label;
  $("#r-title").textContent = o.com.nom + " — " + o.com.population.toLocaleString("fr-FR") + " habitants";
  $("#r-score").querySelector("span").textContent = score;
  $("#r-score small").textContent = "indice de zone";

  const verdict = score >= 75 ? "Zone porteuse" : score >= 55 ? "Zone sous conditions" : "Zone difficile";
  $("#r-kpis").innerHTML = `
    <div class="kpi"><b>${comps.length}</b><span>concurrents à moins de 1 km</span></div>
    <div class="kpi"><b>${fmt(pop1k)}</b><span>habitants estimés à 1 km</span></div>
    <div class="kpi"><b>${ratio != null ? ratio.toFixed(1) + "×" : "—"}</b><span>densité vs moyenne France</span></div>
    <div class="kpi"><b>${eur(ca)}</b><span>CA annuel atteignable (estimation)</span></div>`;

  const rows = comps.slice(0, 6).map((c) =>
    `<tr><td>${c.name || "(sans nom)"}</td><td class="d">${fmt(c.d)} m</td></tr>`).join("");
  $("#r-comps").querySelector("tbody").innerHTML = rows || `<tr><td>Aucun établissement comparable trouvé à 1 km.</td></tr>`;
  $("#r-comps-note").textContent = comps.length > 6
    ? `+ ${comps.length - 6} autres établissements dans le dossier complet. Analyse en ${secs} s.`
    : `Analyse en ${secs} s.`;

  const parts = [];
  if (ratio != null) parts.push(`<b>${ratio.toFixed(1)}×</b> la densité nationale du secteur (${sector.density_fr} pour 1 000 habitants).`);
  parts.push(`<b>${verdict}.</b> ` + (score >= 75
    ? "Le rapport entre population et concurrence laisse de la place à un nouvel entrant, à condition de tenir le loyer."
    : score >= 55
      ? "La zone peut fonctionner, mais pas avec la même offre que tout le monde : le positionnement fait la différence."
      : "La concurrence est déjà dense par rapport à la population. Il faut une raison très forte d'y aller."));
  if (ratio != null && ratio > 2 && anchors.transport >= 5 && score >= 55) {
    parts.push(" Cette adresse est en zone de passage : la clientèle de non-résidents peut compenser une partie de la densité, ce que ces chiffres ne mesurent pas.");
  }
  $("#r-verdict").innerHTML = parts.join(" ");
  $("#r-anchors").innerHTML = [
    [anchors.supermarche, "supermarché(s) — génèrent un passage quotidien"],
    [anchors.transport, "arrêt(s) de transport en commun"],
    [anchors.ecole, "établissement(s) scolaire(s)"],
    [anchors.marche, "marché(s)"]
  ].map(([n, l]) => `<li><b>${n}</b> ${l}</li>`).join("");

  const subject = encodeURIComponent(`Commande dossier ZoneLocale — ${sector.label} — ${g.label}`);
  const body = encodeURIComponent(`Bonjour,\n\nJe souhaite le dossier complet pour :\n- Adresse : ${g.label}\n- Secteur : ${sector.label}\n\nMerci de m'envoyer le lien de paiement (89 € TTC).\n`);
  const href = PAYMENT_URL || `mailto:benfriha.mohamed@gmail.com?subject=${subject}&body=${body}`;
  ["#buy", "#buy2"].forEach((s) => { const el = $(s); if (el) el.href = href; });
}

$("#form").addEventListener("submit", analyse);
init().catch((e) => console.error(e));

// si un lien de paiement est configuré, il remplace aussi le mailto du bloc tarif
if (PAYMENT_URL) {
  const b = document.querySelector("#buy2");
  if (b) b.href = PAYMENT_URL;
}
