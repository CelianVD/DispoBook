// ============================================================
// Adaptateur « Archimed / Syracuse »
// ------------------------------------------------------------
// Syracuse est une application monopage : le HTML de search.aspx ne contient
// PAS les résultats (ils arrivent par appel AJAX). On interroge donc
// directement les services JSON du portail :
//   POST /Portal/Recherche/Search.svc/Search           → notices (HTML dans du JSON)
//   POST /Portal/Services/ILSClient.svc/CheckAvailability → exemplaires disponibles
//
// Contrat commun à TOUS les adaptateurs :
//   id, label
//   buildQueries(book)       : requêtes à essayer, par priorité
//   buildSearchUrl(base, q)  : URL ouverte par le badge
//   check(ctx, base, q, book): { status: 'available'|'borrowed'|'notfound', ... }
//        ctx.postJson(url, body) → JSON (fourni par background.js : file d'attente, anti-rate-limit)
// ============================================================

function normalize(str = "") {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s = "") {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#x?([0-9a-f]+);/gi, (m, n) => {
      const code = /^&#x/i.test(m) ? parseInt(n, 16) : parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
}

function htmlToText(html) {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");
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

/** Récupère toutes les chaînes d'un JSON (y compris du JSON/HTML imbriqué). */
function collectStrings(v, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof v === "string") {
    out.push(v);
    const t = v.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length > 1) {
      try { collectStrings(JSON.parse(t), out, depth + 1); } catch { /* pas du JSON */ }
    }
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
  }
  return out;
}

/** Extrait les notices (id, base, type, titre, auteurs, statut) du HTML de résultats. */
function parseNotices(html) {
  const re = /<div class="notice notice_courte[^"]*"[^>]*?data-base="([^"]*)"[^>]*?data-id="([^"]*)"/g;
  const hits = [...html.matchAll(re)];
  return hits.map((m, i) => {
    let chunk = html.slice(m.index, hits[i + 1]?.index ?? html.length);
    // La dernière notice « traîne » le reste de la page (modale « Vérification des exemplaires
    // disponibles ... », pagination…) : on s'arrête à la fin de <li> de la notice.
    const end = chunk.search(/<\/li>/i);
    if (end > 0) chunk = chunk.slice(0, end);
    const title =
      decodeEntities(chunk.match(/<h3[^>]*class="[^"]*title[^"]*"[^>]*title="([^"]*)"/)?.[1] || "") ||
      htmlToText(chunk.match(/<h3[\s\S]*?<\/h3>/)?.[0] || "");
    const type = chunk.match(/\/Cover\/[^/]+\/([A-Z_]+)\//)?.[1] || "MONO";
    // Liens auteurs : « Delaney, Joseph (1945-....). Auteur » / « … Antécédent bibliographique »
    const authors = [...chunk.matchAll(/<a[^>]*class="tarzan"[^>]*>([^<]*)<\/a>/g)].map((a) => htmlToText(a[1]));
    // Bloc statut (vide / « statut-loading » tant que CheckAvailability n'a pas répondu)
    const statut = chunk.match(/class="statut"[^>]*>([\s\S]*)$/)?.[1] || "";
    return { docbase: m[1], id: m[2], type, title, authors, statut, chunk };
  });
}

/**
 * L'auteur cherché doit être l'auteur de la notice : dans le titre (« / Joseph Delaney »)
 * ou dans un lien auteur sans rôle secondaire. Évite de prendre une adaptation en BD
 * (où il n'est que « Antécédent bibliographique ») pour le roman.
 */
const SECONDARY_ROLE = /ant[ée]c[ée]dent|illustrat|pr[ée]fac|traduct|postfac|adaptat/i;
function authorMatches(notice, author = "") {
  const last = normalize(author).split(" ").filter((w) => w.length > 2).pop();
  if (!last) return true;
  if (normalize(notice.title).includes(last)) return true;
  return notice.authors.some((a) => normalize(a).includes(last) && !SECONDARY_ROLE.test(a));
}

const BORROWED = /indisponible|unavailable|emprunt[ée]|en\s+pr[êe]t|date\s+de\s+retour|retour\s+pr[ée]vu|aucun\s+exemplaire\s+disponible/i;

/**
 * Lit la disponibilité dans le bloc statut (HTML brut) ou la réponse CheckAvailability.
 * Marqueurs Syracuse : class="available indicator" / "not-available-here" / "loaned-elsewhere".
 */
function readAvailability(raw) {
  const html = raw.replace(/V[ée]rification des exemplaires[^<]*/gi, " ");
  const text = htmlToText(html);
  const n = text.match(/(\d+)\s+exemplaires?\s+disponibles?/i);
  if (n && parseInt(n[1], 10) > 0) return "available";
  if (/class="[^"]*(?<![\w-])available(?![\w-])/i.test(html)) return "available";
  if (/class="[^"]*(not-available|unavailable|loaned)/i.test(html) || BORROWED.test(text)) return "borrowed";
  // « disponible à/en… » ; surtout pas « autres disponibilités » ni « exemplaires disponibles ... »
  if (/(?<!in)disponible\s+(?:à|a|en|dans|au)\s/i.test(text) || /en\s+rayon/i.test(text)) return "available";
  return null; // illisible / pas encore chargé
}

export const ArchimedAdapter = {
  id: "archimed",
  label: "Archimed / Syracuse",

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
    return `${base}/search.aspx?SC=DEFAULT&QUERY=${encodeURIComponent(query)}&QUERY_LABEL=`;
  },

  async check(ctx, baseUrl, query, book) {
    const base = baseUrl.replace(/\/+$/, "");
    const searchUrl = this.buildSearchUrl(base, query);

    // 1) Recherche
    const found = await ctx.postJson(`${base}/Portal/Recherche/Search.svc/Search`, {
      query: {
        InitialSearch: true, Page: 0, PageRange: 3, QueryString: query,
        ResultSize: -1, ScenarioCode: "DEFAULT", SearchContext: 0, SearchLabel: "",
      },
      sst: 4,
    });
    const strs = collectStrings(found);
    const html = strs.find((s) => s.includes("notice_courte")) || "";
    const notices = parseNotices(html);

    if (!notices.length) {
      const all = strs.join(" ");
      if (/aucun\s+r[ée]sultat|0\s+r[ée]sultat|aucune\s+notice|aucun\s+document/i.test(htmlToText(all)) || !html) {
        // Pas de notice : soit vraiment rien, soit format inattendu
        const known = strs.some((s) => /r[ée]sultat/i.test(s));
        if (!known && Object.keys(found || {}).length) {
          return { status: "error", reason: "parse", message: "Réponse Search inattendue : " + JSON.stringify(found).slice(0, 300) };
        }
      }
      return { status: "notfound" };
    }

    // 2) On garde les notices dont le titre correspond au livre cherché
    const { series, subtitle } = splitTitle(book.title);
    const words = normalize(subtitle || series).split(" ").filter((w) => w.length > 2);
    const matching = notices.filter((n) => {
      if (!authorMatches(n, book.author)) return false;
      if (!words.length) return true;
      const t = normalize(n.title);
      return words.filter((w) => t.includes(w)).length / words.length >= 0.6;
    }).slice(0, 5);
    if (!matching.length) return { status: "notfound" };

    // 3) Disponibilité (parfois déjà dans le HTML, sinon via CheckAvailability)
    let verdicts = matching.map((n) => readAvailability(n.statut)).filter(Boolean);
    if (!verdicts.length) {
      const guid = (globalThis.crypto?.randomUUID?.() || String(Date.now()));
      const avail = await ctx.postJson(`${base}/Portal/Services/ILSClient.svc/CheckAvailability`, {
        RecordIdArray: matching.map((n) => ({ Docbase: n.docbase, RscId: n.id, RscType: n.type })),
        searchQuery: {
          FacetFilter: "{}", ForceSearch: false, InitialSearch: false, Page: 0, PageRange: 3,
          QueryGuid: guid, QueryString: query, ResultSize: 10, ScenarioCode: "DEFAULT",
          ScenarioDisplayMode: "display-standard", SearchGridFieldsShownOnResultsDTO: [],
          SearchLabel: "", SearchTerms: query, SortField: "%RANDOM%_random_sort",
          SortFieldRandomSeed: "73686572", SortOrder: 1,
          TemplateParams: { Scenario: "", Scope: "Default", Size: null, Source: "", Support: "", UseCompact: false },
          Url: searchUrl, UseSpellChecking: null,
        },
      });
      // Réponse réelle : { d: [ { HtmlView, Id:{RscId}, ItemHoldings:{HoldingLabel, Availability} } ] }
      // On lit chaque exemplaire séparément (un « disponible » suffit), sinon texte brut en repli.
      const recs = Array.isArray(avail?.d) ? avail.d : [];
      const perRecord = recs
        .map((r) => readAvailability(`${r?.HtmlView || ""} ${r?.ItemHoldings?.HoldingLabel || ""}`))
        .filter(Boolean);
      const v = perRecord.length
        ? (perRecord.includes("available") ? "available" : "borrowed")
        : readAvailability(collectStrings(avail).join(" "));
      if (v) verdicts = [v];
      else return { status: "error", reason: "parse", message: "Disponibilité illisible : " + JSON.stringify(avail).slice(0, 300) };
    }

    if (verdicts.includes("available")) return { status: "available" };
    return { status: "borrowed" }; // notice trouvée, aucun exemplaire libre
  },
};