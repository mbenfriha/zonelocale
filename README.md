# ZoneLocale

Étude d'implantation commerciale à partir de données ouvertes.
En ligne : https://mbenfriha.github.io/zonelocale/

## Ce que c'est

- `index.html` + `assets/app.js` : diagnostic gratuit, calculé **dans le navigateur** (aucune donnée
  envoyée à un serveur ZoneLocale). Appelle api-adresse.data.gouv.fr, geo.api.gouv.fr et Overpass (OSM).
- `engine.py` + `templates/dossier.html` : génère le dossier complet (12 pages HTML imprimable) pour une
  commande payée. Une exécution ≈ 40 à 60 s, dominée par Overpass.
- `exemples/` : deux dossiers réels, publics, produits par le moteur.

## Produire un dossier

```
python3 engine.py --address "10 rue Oberkampf 75011 Paris" --sector restaurant \
  --slug <code-commande> --out exemples/<fichier>.html --json-out /tmp/<code>.json
```

Puis commit + push : la page est servie en quelques secondes (GitHub Pages).
Secteurs disponibles : `assets/data.json` (15 secteurs, panier moyen, fréquence, densité nationale).

## Brancher le paiement

Ouvrir `assets/app.js`, remplir `const PAYMENT_URL = ""` avec le lien Stripe / Polar du dossier à 89 €.
Les deux boutons « Commander » basculent dessus automatiquement (le mailto reste le repli).

## Modèle

| Élément | Valeur |
|---|---|
| Prix | 89 € TTC (149 € pour deux adresses) |
| Coût marginal | ~0 € (Overpass, INSEE, GitHub Pages) |
| Temps de production | 1 min de calcul + 10 min de relecture |
| Livraison | page web privée + PDF, sous 24 h ouvrées |

## Hypothèses et limites (assumées dans chaque dossier)

- Population : densité communale × surface de l'anneau sous le rayon équivalent de la commune, puis
  population communale + 50 % des communes voisines dont le centre tombe dans le rayon. C'est une
  estimation, pas un recensement par carreau.
- Concurrence : points OpenStreetMap déclaratifs. Fermetures non répercutées, ouvertures récentes manquantes.
- Chiffre d'affaires : CA moyen du secteur en France (`ca_ref`) × facteur de densité (ratio^-0,5, borné
  0,55–1,20) × facteur de taille de marché (population 1 km / 15 000, borné 0,5–1,1). Un calcul de demande
  résidentielle (population × fréquence × panier ÷ concurrents) sert de plancher de contrôle.
- `ca_ref` : ordres de grandeur sectoriels (CA annuel moyen par établissement), à remplacer par des données
  officielles quand elles seront disponibles.
- Densités nationales (`density_fr`) : ordres de grandeur sectoriels, à raffiner avec des données officielles.
