// ============================================================
// Adaptateur « V-Smart (Axiell / Syracuse) »
// ------------------------------------------------------------
// V-Smart est une application monopage : la page /search/<uuid> est vide, les
// résultats viennent d'un appel JSON.
//
//   recherche : POST <base>/in/rest/api/search            (URL confirmée, BM Lyon)
//     corps   : { includeFacets, includeSearchRestrictions, locale, multiselect:["*"], order:null,
//                 pageSize, query:["<mots>"], queryid:"<uuid>", sf, useSpellcheck }
//     réponse : { numHits, resultSet:[ notice… ] }
//     notice  : title[0].value, id[0].value ("p::usmarcdef_0002342895"), LocalNumber, StockShelfmark,
//               IsPhysicalDocument, zmatIndex[0].value ("romans_nouvelles"…),
//               meta.creator[].value, meta.seriesGeneral[].value ("La quête d'Ewilan ; 2")
//     ⚠ Le resultSet NE CONTIENT PAS la disponibilité (aucun champ statut / exemplaires).
//
//   disponibilité : appel séparé, par notice : GET <base>/in/rest/api/notice?id=<id>&locale=fr&aspect=Stock&opac=true
//     (nom vu dans l'onglet Réseau ; l'écran affiche « En rayon » ou « Prêté - Retour prévu le … » par exemplaire).
//     La FORME de la réponse JSON n'est pas encore vue : readAvailability() cherche donc ces mots dans toutes
//     les chaînes courtes. Si rien n'est lisible, la pastille affiche un extrait de la réponse.
// ============================================================
import { authorMatches, classify, defaultQueries, titleMatches } from "./common.js";

// Filtre de la recherche (propre à Lyon : exclut les notices d'enrichissement). Mettre "*" ailleurs si besoin.
const SF = "(* NOT ZMAT:lyonEnrichment)";

// En-têtes envoyés par le site à chaque appel REST (vus dans l'onglet Réseau). Sans « X-microsite-id »,
// le serveur répond {"code":"Fatal","errorResponse":true}. Autre valeur que Lyon : voir l'onglet Réseau.
const MICROSITE = "mainSite";
const HEADERS = { "X-microsite-id": MICROSITE };

// Types de documents qui ne sont jamais un livre papier
const NOT_BOOK = new Set(["dvd", "cd_musicaux", "livres_audio", "revues_et_journaux", "articles_presse", "photographies"]);

// Appels de disponibilité essayés (le premier qui donne une réponse lisible est mémorisé).
// {id} est remplacé par l'identifiant de notice encodé (p%3A%3Ausmarcdef_…).
const AVAIL_CANDIDATES = [
  // Appel observé dans l'onglet Réseau de la page notice (« notice?id=…&locale=fr&aspect=Stock&opac=true… »)
  { method: "GET", path: "/notice?id={id}&locale=fr&aspect=Stock&opac=true" },
  { method: "GET", path: "/notice?id={id}&locale=fr&aspect=Stock" },
];

let workingAvail = null;       // index de AVAIL_CANDIDATES confirmé
const deadAvail = new Map();   // index → message, pour les URL qui ont répondu 400/403/404/405 (inutile d'insister)

/** Préfixe REST : « /in/rest/api », ou « /rest/api » si l'URL de base se termine déjà par /in. */
function restPrefix(base) {
  return /\/in$/i.test(base) ? "/rest/api" : "/in/rest/api";
}

// UUID déterministe dérivé de la requête : sert au corps POST et à l'URL ouverte par la pastille
function uuidFor(query) {
  let h = [0x811c9dc5, 0x1b873593, 0xcc9e2d51, 0x85ebca6b];
  for (const ch of query) for (let i = 0; i < 4; i++) h[i] = Math.imul(h[i] ^ (ch.charCodeAt(0) + i), 16777619) >>> 0;
  const hex = h.map((n) => n.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function buildBody(query) {
  return {
    includeFacets: true,
    includeSearchRestrictions: true,
    locale: "fr",
    multiselect: ["*"],
    order: null,
    pageSize: 8,
    query: [query],
    queryid: uuidFor(query),
    sf: SF,
    useSpellcheck: true,
  };
}

/** UUID v4 aléatoire (le serveur refuse peut-être un identifiant de recherche inconnu ou mal formé). */
function randomUuid() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* repli ci-dessous */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Variantes du corps de la requête de recherche, essayées dans l'ordre tant que le serveur répond par une erreur.
// La première qui marche est mémorisée pour la session.
const BODY_VARIANTS = [
  (q) => ({ ...buildBody(q), queryid: randomUuid() }),                       // 0 : corps identique à celui du site, identifiant aléatoire
  (q) => { const b = buildBody(q); delete b.queryid; return b; },             // 1 : sans identifiant
];
let workingBody = null;

/** Réponse d'erreur de l'API ({code, errorResponse}) → texte court, sinon null. */
function apiError(data) {
  if (!data || typeof data !== "object" || Array.isArray(data.resultSet)) return null;
  if (!("errorResponse" in data) && !("code" in data)) return null;
  let t = "";
  try { t = JSON.stringify(data.errorResponse ?? data); } catch { t = String(data.code); }
  return `code ${data.code ?? "?"} ${t}`.slice(0, 240);
}

// ---------- Lecture d'une notice du resultSet ----------
// Les champs sont des tableaux de { value } : first(item.title) → première valeur.
const first = (arr) => (Array.isArray(arr) && arr[0] && arr[0].value != null ? String(arr[0].value) : "");
const all = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x?.value ?? "")).filter(Boolean) : []);

/** Texte comparé au livre : titre + auteur(s) + collection (pas les URL de vignettes, très bruyantes). */
function textOf(item) {
  return [first(item.title), ...all(item.meta?.creator), ...all(item.meta?.seriesGeneral)].join(" ");
}

/** true si la notice peut être le livre papier cherché. */
function isCandidate(item, book) {
  if (first(item.IsPhysicalDocument) && first(item.IsPhysicalDocument) !== "1") return false; // ressource en ligne
  if (NOT_BOOK.has(first(item.zmatIndex))) return false;
  const title = first(item.title);
  // Bande dessinée adaptée du roman (« … d'après le roman … ») : pas le livre
  if (first(item.zmatIndex) === "bande_dessinees" && /d['’]apr[eè]s/i.test(title)) return false;
  const t = textOf(item);
  return titleMatches(t, book) && authorMatches(t, book);
}

// ---------- Disponibilité ----------
/** Cherche un indicateur de disponibilité dans une réponse JSON : "available" | "borrowed" | null. */
export function readAvailability(data) {
  let res = null;
  const mark = (v) => { if (v === "available") res = "available"; else if (!res) res = v; };
  (function walk(o, key, depth) {
    if (res === "available" || o == null || depth > 10) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, key, depth + 1); return; }
    if (typeof o === "object") { for (const [k, v] of Object.entries(o)) walk(v, k, depth + 1); return; }
    if (/stateFacet/i.test(key)) return;
    const keyed = /avail|dispon|statut|status|situation|loan|pret|state|etat/i.test(key);
    if (typeof o === "boolean") { if (keyed) mark(o ? "available" : "borrowed"); return; }
    if (typeof o === "number") { if (keyed && /nb|count|total|number|nombre/i.test(key)) mark(o > 0 ? "available" : "borrowed"); return; }
    if (typeof o !== "string" || o.length > 80) return; // libellés courts seulement (pas les résumés ni les URL)
    // Codes techniques éventuels
    if (/^(available|on_?shelf|in_?stock|in_?library|present)$/i.test(o)) return mark("available");
    if (/^(on_?loan|loaned|checked_?out|borrowed|unavailable|out|lost|ordered)$/i.test(o)) return mark("borrowed");
    // Libellés affichés (« En rayon », « Prêté », « Retour prévu le … ») : toute chaîne courte, quelle que soit la clé
    const c = classify(o);
    if (c === "available" || c === "borrowed") mark(c);
  })(data, "", 0);
  return res;
}

/**
 * Réponse « aspect=Stock » (structure observée) :
 *   { monographicCopies:[ { children:[ { data:{ stat:"di"|"pr", stat_desc:"En rayon"|"En prêt",
 *       category_desc:"Livre empruntable", dueDate:"20261128", branch_desc, callnumber… } } ] } ] }
 * Retourne "available" | "borrowed" | "none" (aucun exemplaire) | null (structure inconnue).
 */
export function parseStock(data) {
  const copies = [];
  (function walk(o, depth) {
    if (o == null || typeof o !== "object" || depth > 8) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (typeof o.stat_desc === "string" || typeof o.stat === "string") copies.push(o);
    for (const v of Object.values(o)) walk(v, depth + 1);
  })(data, 0);

  if (!copies.length) {
    const hasKey = data && typeof data === "object" && ("monographicCopies" in data || "serialCopies" in data);
    return hasKey ? "none" : null;
  }
  let borrowed = false;
  for (const c of copies) {
    // Consultation sur place / exclu du prêt : jamais compté disponible
    if (classify(c.category_desc || "") === "other" || classify(c.stat_desc || "") === "other") { borrowed = true; continue; }
    if (c.stat === "di" || classify(c.stat_desc || "") === "available") return "available";
    borrowed = true;
  }
  return borrowed ? "borrowed" : "none";
}

/**
 * Disponibilité d'une notice via les appels candidats. Retourne { state, tried } :
 *   state "available" | "borrowed" | null ; tried = lignes de diagnostic.
 */
async function fetchAvailability(ctx, base, id) {
  const tried = [];
  const order = workingAvail != null ? [workingAvail] : AVAIL_CANDIDATES.map((_, i) => i).filter((i) => !deadAvail.has(i));
  for (const msg of deadAvail.values()) tried.push(msg); // rappel des essais déjà écartés (diagnostic)
  for (const i of order) {
    const c = AVAIL_CANDIDATES[i];
    const url = base + restPrefix(base) + c.path.replace("{id}", encodeURIComponent(id));
    try {
      const data = c.method === "POST" ? await ctx.postJson(url, c.body(id), HEADERS) : await ctx.getJson(url, HEADERS);
      const state = parseStock(data) ?? readAvailability(data);
      if (state) { workingAvail = i; return { state, tried }; }
      let excerpt = "";
      try { excerpt = JSON.stringify(data).slice(0, 400); } catch { excerpt = typeof data; }
      tried.push(`${c.method} ${c.path.split("?")[0]} → 200 sans statut lisible. Réponse : ${excerpt}`);
    } catch (e) {
      if (e?.constructor?.name === "RateLimited") throw e;
      const line = `${c.method} ${c.path.split("?")[0]} → ${String(e).replace(/^Error:\s*/, "")}`;
      if (/HTTP (400|403|404|405)\b/.test(String(e))) deadAvail.set(i, line); // erreur « définitive » seulement
      tried.push(line);
    }
  }
  return { state: null, tried };
}

export const VSmartAdapter = {
  id: "vsmart",
  label: "V-Smart (Axiell)",
  buildQueries: defaultQueries,
  buildSearchUrl: (base, q) => `${base.replace(/\/+$/, "")}/search/${uuidFor(q)}`,

  async check(ctx, baseUrl, query, book) {
    const base = baseUrl.replace(/\/+$/, "");

    let data = null;
    const errors = [];
    const order = workingBody != null ? [workingBody] : BODY_VARIANTS.map((_, i) => i);
    for (const i of order) {
      try {
        const d = await ctx.postJson(base + restPrefix(base) + "/search", BODY_VARIANTS[i](query), HEADERS);
        const err = apiError(d);
        if (err) { errors.push(`variante ${i} : ${err}`); continue; }
        data = d;
        workingBody = i;
        break;
      } catch (e) {
        if (e?.constructor?.name === "RateLimited") throw e;
        errors.push(`variante ${i} : ${String(e).replace(/^Error:\s*/, "")}`);
        if (/HTTP (404|405)\b/.test(String(e))) break; // mauvaise URL : inutile de varier le corps
      }
    }
    if (!data) {
      workingBody = null;
      return { status: "error", reason: "network", message: `V-Smart : recherche refusée par ${restPrefix(base)}/search. ${errors.join(" | ")}. Si « Fatal » persiste, il manque probablement l'en-tête X-InMedia-Authorization (voir HEADERS dans adapters/vsmart.js).` };
    }

    const results = Array.isArray(data?.resultSet) ? data.resultSet : [];
    const matched = results.filter((r) => isCandidate(r, book));
    const head = `V-Smart « ${query} » : ${data?.numHits ?? "?"} résultat(s), ${results.length} lu(s), ${matched.length} retenu(s)`;
    if (!matched.length) {
      const refused = results.slice(0, 4).map((r) => "• " + textOf(r).slice(0, 70) +
        ` [${first(r.zmatIndex) || "?"}${first(r.IsPhysicalDocument) === "1" ? "" : ", non physique"}]`).join("\n");
      return { status: "notfound", debug: head + (refused ? "\nRefusés :\n" + refused : (data && !Array.isArray(data.resultSet) ? "\nRéponse sans resultSet : " + Object.keys(data || {}).join(",").slice(0, 150) : "")) };
    }

    // Disponibilité : une notice suffit si elle est disponible ; on en regarde 3 au plus
    let sawBorrowed = false;
    let sawNone = false;
    let diag = [];
    for (const item of matched.slice(0, 3)) {
      const id = first(item.id);
      if (!id) continue;
      const { state, tried } = await fetchAvailability(ctx, base, id);
      if (state === "available") return { status: "available" };
      if (state === "borrowed") sawBorrowed = true;
      else if (state === "none") sawNone = true;
      else diag = tried;
    }
    if (sawBorrowed) return { status: "borrowed" };
    if (sawNone && !diag.length) return { status: "notfound", debug: head + " mais aucun exemplaire dans le stock (aspect=Stock vide)." }; // notices sans aucun exemplaire

    return {
      status: "error",
      reason: "parse",
      message: "V-Smart : notice trouvée (" + first(matched[0].title).slice(0, 60) + ") mais la disponibilité est illisible. " +
        "Essais : " + (diag.join(" | ") || "aucun") + ". Voir AVAIL_CANDIDATES dans adapters/vsmart.js.",
    };
  },
};

// Exposé pour les tests
export const _internals = { isCandidate, textOf, readAvailability, parseStock, restPrefix, reset() { workingAvail = null; workingBody = null; deadAvail.clear(); } };
