// ============================================================
// Adaptateur « Quria (Axiell) »
// ------------------------------------------------------------
//   recherche : GET /livres/catalogue?qr=<mots>
//   notice    : GET /<type>/<id>   (ex. /album/4138574, /roman/…, /bd/…)
// ⚠ Si la disponibilité est chargée en AJAX sur la page notice, elle ne sera pas
//   visible ici : envoyer le HTML (ou la requête XHR) pour affiner parseCopies.
// ============================================================
import { makeHtmlAdapter, encodeQ } from "./common.js";

const DETAIL_RE = /^\/[a-z][a-z0-9-]*\/(\d{5,})\/?$/i;

export const QuriaAdapter = makeHtmlAdapter({
  id: "quria",
  label: "Quria (Axiell)",
  buildSearchUrl: (base, q) => `${base}/livres/catalogue?qr=${encodeQ(q)}`,
  linkId: (pq, u) => u.pathname.match(DETAIL_RE)?.[1] ?? null,
  isDetailUrl: (url) => DETAIL_RE.test(new URL(url).pathname),
});