// ============================================================
// Outils communs aux adaptateurs « portails rendus côté serveur ».
// Tout est en regex (pas de DOMParser) : le background Chrome est un
// service worker, sans DOM.
//
// makeHtmlAdapter(cfg) fabrique un adaptateur complet. Config :
//   id, label
//   buildSearchUrl(base, query)  : URL de recherche (aussi ouverte par la pastille)
//   linkId(pathAndQuery, url)    : retourne un identifiant si le lien est une notice, sinon null
//   isDetailUrl(url)             : (optionnel) true si l'URL finale est déjà une notice (redirection)
//   sniff                        : (optionnel) RegExp que la page doit contenir
//   parseTitle(html)             : (optionnel) titre de la notice
//   parseCopies(html)            : (optionnel) "available" | "borrowed" | null
//   parseList(html, book)        : (optionnel) statut lu directement dans la liste de résultats
//   detailUrl(url)               : (optionnel) URL à lire pour les exemplaires
//   maxCandidates                : (optionnel) notices examinées au maximum (3 par défaut)
// ============================================================

export function normalize(str = "") {
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

export function decodeEntities(s = "") {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m)
    .replace(/&#x?([0-9a-f]+);/gi, (m, n) => {
      const code = /^&#x/i.test(m) ? parseInt(n, 16) : parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
}

export function htmlToText(html = "") {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

/** « Série, Tome 1 : Sous-titre » → { series, subtitle } */
export function splitTitle(title = "") {
  const [left, ...rest] = title.split(/\s:\s/);
  const series = left
    .replace(/,?\s*(tome|livre|volume|vol\.?|t\.?)\s*\d+.*$/i, "")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .trim();
  return { series: series || title, subtitle: rest.join(" : ").trim() };
}

/** Au moins 60 % des mots du titre doivent apparaître dans le candidat. */
export function titleMatches(candidate, book) {
  const { series, subtitle } = splitTitle(book.title);
  const words = normalize(subtitle || series).split(" ").filter((w) => w.length > 2);
  const t = normalize(candidate);
  if (words.length && words.filter((w) => t.includes(w)).length / words.length < 0.6) return false;

  // Sans sous-titre, « Série, Tome 2 » : si le candidat porte d'autres numéros de tome, il faut le bon
  const tome = !subtitle && book.title.match(/(?:tome|livre|volume|vol\.?|t\.?)\s*(\d{1,2})\b/i)?.[1];
  if (tome) {
    const nums = t.match(/\b\d{1,2}\b/g) || [];
    if (nums.length && !nums.includes(String(Number(tome)))) return false;
  }
  return true;
}

/** Le nom de famille (dernier mot) de l'auteur doit apparaître dans le texte. */
export function authorMatches(text, book) {
  const last = normalize(book.author || "").split(" ").filter((w) => w.length > 2).pop();
  return !last || normalize(text).includes(last);
}

/**
 * items : [{ text, status: "available"|"borrowed"|null }] lus dans une liste de résultats.
 * Retourne "available" | "borrowed" | "notfound" | null (disponibilité illisible → repli sur les notices).
 */
export function statusFromList(items, book) {
  const ok = items.filter((i) => titleMatches(i.text, book) && authorMatches(i.text, book));
  if (!ok.length) return "notfound";
  if (ok.some((i) => i.status === "available")) return "available";
  return ok.some((i) => !i.status) ? null : "borrowed";
}

/** Requête encodée « façon portail » : espaces → « + », apostrophe → %27. */
export function encodeQ(query = "") {
  return encodeURIComponent(query.trim().replace(/\s+/g, " ")).replace(/%20/g, "+").replace(/'/g, "%27");
}

export function defaultQueries(book) {
  const queries = [];
  if (book.isbn) queries.push(book.isbn);
  const { series, subtitle } = splitTitle(book.title);
  const author = book.author || "";
  if (subtitle) queries.push(`${subtitle} ${author}`.trim());
  queries.push(`${series} ${author}`.trim());
  if (subtitle) queries.push(`${series} ${subtitle}`.trim());
  return [...new Set(queries.filter(Boolean))];
}

/** Liens de notices d'une page de résultats : [{ id, url, text }] (dédoublonnés par id). */
export function extractLinks(html, pageUrl, linkId) {
  const origin = new URL(pageUrl).origin;
  const seen = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const raw = decodeEntities(href?.[1] ?? href?.[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) continue;
    let u;
    try { u = new URL(raw, pageUrl); } catch { continue; }
    if (u.origin !== origin) continue;
    const id = linkId(u.pathname + u.search, u);
    if (!id) continue;
    u.hash = "";
    const text = htmlToText(m[2]);
    const prev = seen.get(id);
    if (!prev) seen.set(id, { id, url: u.href, text });
    else if (text.length > prev.text.length) prev.text = text;
  }
  return [...seen.values()];
}

/**
 * Classe le texte d'un statut d'exemplaire :
 *   "other"    : exclu du prêt / consultation sur place (jamais compté disponible)
 *   "borrowed" : sorti, prêté, réservé, en commande…
 *   "available": en rayon / disponible
 *   null       : texte non reconnu
 */
export function classify(text = "") {
  const t = normalize(text);
  if (!t) return null;
  if (/exclu|consultation|sur place|non empruntable|usage interne/.test(t)) return "other";
  if (/indisponible|non disponible|emprunte|sorti|\bpret(e|s)?\b|retour|reservee?\b|en commande|perdu|manquant|transit|retrait|reparation|en cours/.test(t)) return "borrowed";
  if (/disponible|en rayon|en magasin|\blibre\b/.test(t)) return "available";
  return null;
}

/**
 * Lecture générique des exemplaires : tableau avec une colonne
 * « Situation / Statut / Disponibilité / État », puis repli sur le texte.
 */
export function parseCopiesGeneric(html) {
  let sawCopy = false;
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    let iStatus = -1;
    for (const [, body] of t[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const ths = [...body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => normalize(htmlToText(x[1])));
      if (ths.length) {
        const i = ths.findIndex((h) => /situation|statut|disponibilit|etat/.test(h));
        if (i >= 0) iStatus = i;
        continue;
      }
      if (iStatus < 0) continue;
      const cells = [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => htmlToText(x[1]));
      if (!cells.length) continue;
      const c = classify(cells[iStatus] || "");
      if (c === "available") return "available";
      if (c) sawCopy = true;
    }
  }
  if (sawCopy) return "borrowed";

  // Repli : texte de la page (sans menus)
  const text = normalize(htmlToText(html.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ")));
  const n = text.match(/(\d+) exemplaires? disponibles?/);
  if (n && Number(n[1]) > 0) return "available";
  if (/aucun exemplaire disponible|indisponible|non disponible|retour prevu|emprunte/.test(text)) return "borrowed";
  if (/\bdisponible\b/.test(text)) return "available";
  return null;
}

function defaultTitle(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return htmlToText(h1 || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
}

export function makeHtmlAdapter(cfg) {
  const parseTitle = cfg.parseTitle || defaultTitle;
  const parseCopies = cfg.parseCopies || parseCopiesGeneric;

  return {
    id: cfg.id,
    label: cfg.label,
    buildQueries: cfg.buildQueries || defaultQueries,
    buildSearchUrl: cfg.buildSearchUrl,

    async check(ctx, baseUrl, query, book) {
      const base = baseUrl.replace(/\/+$/, "");
      const page = await ctx.getPage(cfg.buildSearchUrl(base, query));

      if (cfg.sniff && !cfg.sniff.test(page.text)) {
        return { status: "error", reason: "parse", message: `Page inattendue (${cfg.label}) : ` + page.text.slice(0, 200) };
      }

      let candidates;
      if (!cfg.isDetailUrl?.(page.url) && cfg.parseList) {
        const r = cfg.parseList(page.text, book); // disponibilité lue directement dans la liste
        if (r) return { status: r };
      }
      if (cfg.isDetailUrl?.(page.url)) {
        // Un seul résultat : redirection directe vers la notice
        candidates = [{ url: page.url, text: "", html: page.text }];
      } else {
        const links = extractLinks(page.text, page.url, cfg.linkId);
        candidates = links.filter((l) => !l.text || titleMatches(l.text, book)).slice(0, cfg.maxCandidates || 3);
        if (!candidates.length) return { status: "notfound" };
      }

      let found = false;
      for (const c of candidates) {
        const html = c.html ?? (await ctx.getPage(cfg.detailUrl ? cfg.detailUrl(c.url) : c.url)).text;
        // Titre déjà validé sur le texte du lien de la liste : inutile de le revérifier sur la notice
        const title = c.text ? "" : parseTitle(html);
        if (title && !titleMatches(title, book)) continue;
        found = true;
        if (parseCopies(html) === "available") return { status: "available" };
      }
      return { status: found ? "borrowed" : "notfound" };
    },
  };
}