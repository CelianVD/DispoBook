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

/** Extrait les notices (id, base, type, titre) du HTML de résultats. */
function parseNotices(html) {
  const re = /<div class="notice notice_courte[^"]*"[^>]*?data-base="([^"]*)"[^>]*?data-id="([^"]*)"/g;
  const hits = [...html.matchAll(re)];
  return hits.map((m, i) => {
    const chunk = html.slice(m.index, hits[i + 1]?.index ?? html.length);
    const title =
      decodeEntities(chunk.match(/<h3[^>]*class="[^"]*title[^"]*"[^>]*title="([^"]*)"/)?.[1] || "") ||
      htmlToText(chunk.match(/<h3[\s\S]*?<\/h3>/)?.[0] || "");
    const type = chunk.match(/\/Cover\/[^/]+\/([A-Z_]+)\//)?.[1] || "MONO";
    return { docbase: m[1], id: m[2], type, title, chunk };
  });
}

const BORROWED = /indisponible|unavailable|emprunt[ée]|en\s+pr[êe]t|date\s+de\s+retour|retour\s+pr[ée]vu|aucun\s+exemplaire\s+disponible/i;

/** Lit la disponibilité dans la réponse (HTML ou JSON stringifié). */
function readAvailability(text) {
  const n = text.match(/(\d+)\s+exemplaires?\s+disponibles?/i);
  if (n && parseInt(n[1], 10) > 0) return "available";
  if (BORROWED.test(text)) return "borrowed";
  if (/class="[^"]*\bavailable\b/i.test(text) || /(?<!in)disponible|en\s+rayon/i.test(text)) return "available";
  return null; // illisible
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
      if (!words.length) return true;
      const t = normalize(n.title);
      return words.filter((w) => t.includes(w)).length / words.length >= 0.6;
    }).slice(0, 5);
    if (!matching.length) return { status: "notfound" };

    // 3) Disponibilité (parfois déjà dans le HTML, sinon via CheckAvailability)
    let verdicts = matching.map((n) => readAvailability(htmlToText(n.chunk.match(/class="statut"[\s\S]*$/)?.[0] || ""))).filter(Boolean);
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
      const text = htmlToText(collectStrings(avail).join(" ")) + " " + collectStrings(avail).join(" ");
      const v = readAvailability(text);
      if (v) verdicts = [v];
    }

    if (verdicts.includes("available")) return { status: "available" };
    return { status: "borrowed" }; // notice trouvée, aucun exemplaire libre (ou statut illisible)
  },
};
