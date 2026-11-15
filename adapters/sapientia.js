// ============================================================
// Adaptateur « Sapientia (Microbib) » — composant Joomla com_microbib
// ------------------------------------------------------------
//   recherche : GET /index.php/component/microbib/?option=com_microbib&view=Books
//               &typeSearch=modsearch&search[type][]=…&search[lookfor][]=<mots>
//   notice    : lien de la liste (view=Book…)
// ⚠ Le paramètre à clé aléatoire (jeton Joomla) et l'Itemid de l'exemple sont
//   volontairement omis. Format des notices / exemplaires non vérifié.
// ============================================================
import { makeHtmlAdapter } from "./common.js";

const FIELDS = ["b.title", "b.subtitle", "b.coll5", "b.coll6", "b.serie", "b.collection", "a.title", "e.title"];

function buildSearchUrl(base, query) {
  const q = encodeURIComponent(query.trim());
  const qs = [
    "option=com_microbib",
    "view=Books",
    "_layout=listing",
    "typeSearch=modsearch",
    "adv_Search=0",
    "filter_Search=1",
    "_resetState=1",
    "filter_order=" + encodeURIComponent("`b`.`title`"),
    "filter_order_Dir=ASC",
    "search%5Bbool%5D%5B%5D=",
    ...FIELDS.map((f) => `search%5Btype%5D%5B%5D=${f}`),
    `search%5Blookfor%5D%5B%5D=${q}`,
    `Search=${q}`,
  ];
  return `${base}/index.php/component/microbib/?${qs.join("&")}`;
}

// Lien de notice : composant microbib, vue au singulier (Book) ou identifiant numérique
function linkId(pq) {
  if (!/microbib/i.test(pq)) return null;
  if (/view=Books\b/i.test(pq)) return null; // liste, pas notice
  return pq.match(/[?&]id=(\d+)/i)?.[1]
    ?? pq.match(/\/(?:notice|book|ouvrage|detail)[\/-](\d+)/i)?.[1]
    ?? (/view=Book\b/i.test(pq) ? pq : null);
}

export const SapientiaAdapter = makeHtmlAdapter({
  id: "sapientia",
  label: "Sapientia (Microbib)",
  sniff: /microbib/i,
  buildSearchUrl,
  linkId,
  isDetailUrl: (url) => /microbib/i.test(url) && /view=Book\b/i.test(url),
});