// ============================================================
// Adaptateur « Koha » (OPAC)
// ------------------------------------------------------------
//   recherche : GET /cgi-bin/koha/opac-search.pl?idx=&q=<mots>&weight_search=1
//   notice    : GET /cgi-bin/koha/opac-detail.pl?biblionumber=<id>
//               → tableau « Exemplaires » (#holdingst) avec une colonne Statut
// ============================================================
import { makeHtmlAdapter, encodeQ, classify, htmlToText, normalize, statusFromList } from "./common.js";

/** Titre : <span class="biblio-title"> du fil d'Ariane, sinon <h1>. */
function parseTitle(html) {
  const t = html.match(/<span class="biblio-title">([\s\S]*?)<\/span>/i)?.[1]
    || html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || "";
  return htmlToText(t);
}

/** Tableau #holdingst → "available" | "borrowed" | null. */
function parseCopies(html) {
  const table = html.match(/<table\b[^>]*id="holdingst"[\s\S]*?<\/table>/i)?.[0];
  if (!table) return null;

  const headers = [...(table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "").matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => normalize(htmlToText(m[1])));
  const iStatus = headers.findIndex((h) => /statut|disponibilit|situation/.test(h));

  // Signaux Koha standard d'un exemplaire disponible : badge « item-status available » ou microdonnée InStock
  if (/<span[^>]*class="[^"]*\bitem-status\b[^"]*\bavailable\b/i.test(table)) return "available";
  if (/schema\.org\/InStock/i.test(table)) return "available";

  let sawCopy = false;
  const body = table.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || table;
  for (const [, rowHtml] of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map((m) => ({ attrs: m[1], text: htmlToText(m[2]) }));
    if (!cells.length) continue;
    sawCopy = true;

    // Cellule de statut : classe « status » (Koha), sinon colonne repérée par l'en-tête
    const cell = cells.find((c) => /\bstatus\b/.test(c.attrs)) ?? cells[iStatus];
    if (classify(cell?.text) === "available") return "available";
  }
  return sawCopy ? "borrowed" : null;
}

/**
 * Liste de résultats : chaque notice (#title_summary_<id>) porte sa disponibilité
 *   <span class="available"> = au moins un exemplaire disponible
 *   <span class="unavailable"> / « Aucun exemplaire disponible » = tout est sorti
 * On évite ainsi de charger chaque notice.
 */
function parseList(html, book) {
  const blocks = html.split(/<div id="title_summary_\d+"/).slice(1);
  if (!blocks.length) return null;
  const items = [];
  for (const b of blocks) {
    const iAvail = b.search(/results_summary availability/);
    const head = htmlToText(iAvail >= 0 ? b.slice(0, iAvail) : b);
    if (/\[(dvd|cd|blu|jeu|enregistrement)/i.test(head)) continue; // pas un livre
    if (iAvail < 0) continue; // aucun exemplaire (ressource en ligne…)
    const end = b.indexOf('<div class="actions-menu', iAvail);
    const seg = b.slice(iAvail, end > 0 ? end : undefined);
    const status = /class="available"/.test(seg) ? "available" : "borrowed";
    items.push({ text: head, status });
  }
  return statusFromList(items, book);
}

export const KohaAdapter = makeHtmlAdapter({
  id: "koha",
  label: "Koha",
  sniff: /koha|opac-main\.pl|opac-search\.pl/i,
  buildSearchUrl: (base, q) => `${base}/cgi-bin/koha/opac-search.pl?idx=&q=${encodeQ(q)}&weight_search=1`,
  linkId: (pq) => pq.match(/opac-detail\.pl\?(?:.*&)?biblionumber=(\d+)/i)?.[1] ?? null,
  isDetailUrl: (url) => /opac-detail\.pl/i.test(url),
  parseTitle,
  parseCopies,
  parseList,
  verifyBorrowed: true, // un « emprunté » de la liste est confirmé sur la notice (faux orange constaté)
});

// Exposé pour les tests
export const _internals = { parseTitle, parseCopies, parseList };