// ============================================================
// Adaptateur « Decalog SIGB »
// ------------------------------------------------------------
//   recherche : GET /opac/catalog/search?allfields[]=<mots>
//   liste     : cartes .panel-card ; le titre est un lien
//               /opac/catalog/bibrecord?id=<id>&referer=…&num=<n>
//               (la disponibilité n'est PAS dans la liste : bouton « Voir la disponibilité »,
//                chargé en AJAX)
//   notice    : /opac/catalog/bibrecord?id=<id> → exemplaires (lecture générique)
// ⚠ Si la notice ne contient pas les exemplaires dans le HTML (AJAX), envoyer la requête
//   réseau déclenchée par « Voir la disponibilité » pour appeler directement ce service.
// ============================================================
import { makeHtmlAdapter, encodeQ } from "./common.js";

const isRecord = (u) => /\/opac\/catalog\/bibrecord\/?$/i.test(u.pathname) && u.searchParams.has("id");

export const DecalogAdapter = makeHtmlAdapter({
  id: "decalog",
  label: "Decalog SIGB",
  maxCandidates: 5, // une même œuvre apparaît souvent sous plusieurs éditions
  buildSearchUrl: (base, q) => `${base}/opac/catalog/search?allfields%5B%5D=${encodeQ(q)}`,
  linkId: (pq, u) => (isRecord(u) ? u.searchParams.get("id") : null),
  isDetailUrl: (url) => isRecord(new URL(url)),
  // L'identifiant seul suffit : on retire referer/num pour une URL de notice propre
  detailUrl: (url) => {
    const u = new URL(url);
    return `${u.origin}${u.pathname}?id=${u.searchParams.get("id")}`;
  },
});