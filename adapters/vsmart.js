// ============================================================
// Adaptateur « V-Smart (Axiell) »
// ------------------------------------------------------------
// V-Smart est une application monopage : la page /search/<uuid> est vide, les
// résultats viennent d'un appel JSON. Corps de requête observé (BM Lyon) :
//   { includeFacets, includeSearchRestrictions, locale, multiselect:["*"], order:null,
//     pageSize, query:["<mots>"], queryid:"<uuid>", sf, useSpellcheck }
// Réponse : { numHits, resultSet:[…], … }
//
// ⚠ À CONFIRMER avec l'onglet Réseau de Firefox/Chrome (filtre XHR, requête POST émise
//   lors d'une recherche) :
//   1. l'URL exacte de la requête → adapter ENDPOINTS ci-dessous ;
//   2. la forme d'un élément de resultSet et l'endroit où se trouve la disponibilité
//      (éventuellement un second appel) → adapter readAvailability().
// Tant que ce n'est pas fait, un message d'erreur précis s'affiche au survol de la pastille.
// ============================================================
import { authorMatches, classify, defaultQueries, titleMatches } from "./common.js";

// Chemins essayés dans l'ordre (le premier qui répond est mémorisé)
const ENDPOINTS = ["/api/search", "/api/v1/search", "/api/search/search"];
// Filtre de la recherche (propre à Lyon : exclut les notices d'enrichissement). Mettre "*" ailleurs si besoin.
const SF = "(* NOT ZMAT:lyonEnrichment)";
let workingEndpoint = null;

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

/** Toutes les chaînes d'un élément (titre, auteur…) pour la comparaison. */
function textOf(item) {
  const out = [];
  (function walk(o, depth) {
    if (o == null || depth > 4) return;
    if (typeof o === "string") out.push(o);
    else if (typeof o === "object") for (const v of Object.values(o)) walk(v, depth + 1);
  })(item, 0);
  return out.join(" ");
}

/** Cherche un indicateur de disponibilité dans l'élément : "available" | "borrowed" | null. */
function readAvailability(item) {
  let res = null;
  (function walk(o, key, depth) {
    if (res === "available" || o == null || depth > 5) return;
    if (typeof o === "object") {
      for (const [k, v] of Object.entries(o)) walk(v, k, depth + 1);
    } else if (/avail|dispon/i.test(key)) {
      if (typeof o === "boolean" || typeof o === "number") res = o ? "available" : res || "borrowed";
      else if (typeof o === "string") {
        const c = classify(o);
        if (c === "available") res = "available";
        else if (c) res = res || "borrowed";
      }
    }
  })(item, "", 0);
  return res;
}

export const VSmartAdapter = {
  id: "vsmart",
  label: "V-Smart (Axiell)",
  buildQueries: defaultQueries,
  buildSearchUrl: (base, q) => `${base.replace(/\/+$/, "")}/search/${uuidFor(q)}`,

  async check(ctx, baseUrl, query, book) {
    const base = baseUrl.replace(/\/+$/, "");
    const body = buildBody(query);
    const paths = workingEndpoint ? [workingEndpoint] : ENDPOINTS;

    let data = null;
    let lastErr = null;
    for (const p of paths) {
      try {
        data = await ctx.postJson(base + p, body);
        workingEndpoint = p;
        break;
      } catch (e) {
        if (e?.constructor?.name === "RateLimited") throw e;
        lastErr = e;
      }
    }
    if (!data) {
      return { status: "error", reason: "network", message: `V-Smart : URL de l'API introuvable (${lastErr}). Voir ENDPOINTS dans adapters/vsmart.js.` };
    }

    const results = Array.isArray(data.resultSet) ? data.resultSet : [];
    const matched = results.filter((r) => {
      const t = textOf(r);
      return titleMatches(t, book) && authorMatches(t, book);
    });
    if (!matched.length) return { status: "notfound" };

    const states = matched.map(readAvailability);
    if (states.includes("available")) return { status: "available" };
    if (states.includes("borrowed")) return { status: "borrowed" };

    // Notice trouvée mais disponibilité illisible : diagnostic pour adapter readAvailability()
    return {
      status: "error",
      reason: "parse",
      message: "V-Smart : notice trouvée, disponibilité introuvable dans resultSet. Clés d'un élément : " +
        Object.keys(matched[0] || {}).join(", ").slice(0, 300),
    };
  },
};