function normalize(str = "") {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â",
  ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ugrave: "ù", ucirc: "û",
  Eacute: "É", Egrave: "È", Agrave: "À", Ccedil: "Ç", oelig: "œ", rsquo: "’", laquo: "«", raquo: "»",
};

function decodeEntities(s = "") {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m)
    .replace(/&#x?([0-9a-f]+);/gi, (m, n) => {
      const code = /^&#x/i.test(m) ? parseInt(n, 16) : parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
}

function htmlToText(html = "") {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

/** « Série, Tome 1 : Sous-titre » → { series, subtitle } */
function splitTitle(title = "") {
  const [left, ...rest] = title.split(/\s:\s/);
  const series = left
    .replace(/,?\s*(tome|livre|volume|vol\.?|t\.?)\s*\d+.*$/i, "")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .trim();
  return { series: series || title, subtitle: rest.join(" : ").trim() };
}

function titleMatches(candidate, book) {
  const { series, subtitle } = splitTitle(book.title);
  const words = normalize(subtitle || series).split(" ").filter((w) => w.length > 2);
  if (!words.length) return true;
  const t = normalize(candidate);
  return words.filter((w) => t.includes(w)).length / words.length >= 0.6;
}

// Segment de recherche du portail : mots séparés par « + », puis double encodage
// (ex. « lever de soleil » → lever%2Bde%2Bsoleil).
function encodeQuery(query) {
  return normalize(query).split(" ").filter(Boolean).map((w) => encodeURIComponent(w)).join("%2B");
}

/** Liens vers les notices dans une page de résultats. */
function parseNoticeLinks(html, baseUrl) {
  const seen = new Map();
  const re = /<a\b[^>]*?href="([^"]*\/detail-dune-notice\/notice\/(\d+-\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const id = m[2];
    const text = htmlToText(m[3]);
    const url = new URL(decodeEntities(m[1]).replace(/[?&]no_return=1/, ""), baseUrl).href;
    const prev = seen.get(id);
    if (!prev) seen.set(id, { id, url, text });
    else if (!prev.text && text) prev.text = text;
  }
  return [...seen.values()];
}

/** Titre de la page notice (h1 de l'en-tête). */
function parseNoticeTitle(html) {
  const h1 = html.match(/<div class="page-header">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return htmlToText(h1 || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+-\s+[^-]*$/, "");
}

/**
 * Lit le tableau « Exemplaires » d'une notice.
 * Retourne "available" | "borrowed" | null (aucun exemplaire lisible).
 */
function parseCopies(html) {
  const block = html.match(/id="table_dmt"[\s\S]*?<\/table>/i)?.[0] || html.match(/<table[^>]*>[\s\S]*?<\/table>/i)?.[0] || "";
  if (!block) return null;

  const headers = [...(block.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "").matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => normalize(htmlToText(m[1])));
  const iSituation = headers.indexOf("situation");
  const iUsage = headers.indexOf("utilisation");

  const rows = [...(block.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || "").matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
  let sawCopy = false;
  for (const [, attrs, body] of rows) {
    const cells = [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => htmlToText(m[1]));
    if (!cells.length) continue;
    sawCopy = true;

    let situation = iSituation >= 0 ? normalize(cells[iSituation] || "") : "";
    // Repli : la classe de ligne sit1 = en rayon (observé sur les portails Orphée)
    if (!situation && /\bsit1\b/.test(attrs)) situation = "en rayon";
    const usage = iUsage >= 0 ? normalize(cells[iUsage] || "") : "";

    const inShelf = /\ben rayon\b|\bdisponible\b/.test(situation);
    const notLendable = /exclu|consultation|sur place/.test(usage);
    if (inShelf && !notLendable) return "available";
  }
  return sawCopy ? "borrowed" : null;
}

export const C3rbAdapter = {
  id: "c3rb",
  label: "C3RB Informatique / Orphée",

  buildQueries(book) {
    const queries = [];
    if (book.isbn) queries.push(book.isbn);
    const { series, subtitle } = splitTitle(book.title);
    const author = book.author || "";
    if (subtitle) queries.push(`${subtitle} ${author}`.trim());
    queries.push(`${series} ${author}`.trim());
    if (subtitle) queries.push(`${series} ${subtitle}`.trim());
    return [...new Set(queries.filter(Boolean))];
  },

  buildSearchUrl(baseUrl, query) {
    const base = baseUrl.replace(/\/+$/, "");
    return `${base}/recherche-simple/simple/Mots%2BNotice/-1/${encodeQuery(query)}/perso`;
  },

  async check(ctx, baseUrl, query, book) {
    const base = baseUrl.replace(/\/+$/, "");
    const page = await ctx.getPage(this.buildSearchUrl(base, query));

    if (!/com_opac|Portail Orph[ée]e|c3rb/i.test(page.text)) {
      return { status: "error", reason: "parse", message: "Page inattendue (ce n'est pas un portail Orphée ?) : " + page.text.slice(0, 200) };
    }

    // Cas 1 : un seul résultat, le portail redirige directement vers la notice
    let candidates;
    if (/\/detail-dune-notice\/notice\//.test(page.url)) {
      candidates = [{ url: page.url, text: "", html: page.text }];
    } else {
      // Cas 2 : liste de résultats
      const links = parseNoticeLinks(page.text, base);
      if (!links.length) return { status: "notfound" };
      candidates = links
        .filter((l) => !l.text || titleMatches(l.text, book)) // texte du lien absent → on vérifie sur la notice
        .slice(0, 3);
      if (!candidates.length) return { status: "notfound" };
    }

    // Vérification sur la page de chaque notice (titre + exemplaires)
    let found = false;
    for (const c of candidates) {
      const html = c.html ?? (await ctx.getPage(c.url)).text;
      if (!titleMatches(parseNoticeTitle(html), book)) continue;
      found = true;
      if (parseCopies(html) === "available") return { status: "available" };
    }
    return { status: found ? "borrowed" : "notfound" };
  },
};

// Exposé pour les tests
export const _internals = { parseNoticeLinks, parseNoticeTitle, parseCopies, encodeQuery, titleMatches };
