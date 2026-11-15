// ============================================================
// Adaptateurs « AFI Nanook » et « Bokeh (portail OPAC) »
// ------------------------------------------------------------
// Les deux portails partagent la même structure (HTML observé) :
//   recherche : GET /recherche/simple/expressionRecherche/<mots>/tri/*
//   liste     : une carte .list-group-item par notice, avec le badge
//               <span class="badge_record_availability … record_available">Disponible</span>
//   notice    : /recherche/viewnotice/clef/…/id/<id>/…
//   exemplaires (repli) : /record/items/clef/…/id/<id>/…  → .item_availability
// ============================================================
import { makeHtmlAdapter, encodeQ, classify, htmlToText, statusFromList } from "./common.js";

const NOTICE_RE = /\/(?:recherche\/)?viewnotice\//i;

/** Badge de disponibilité d'une carte → "available" | "borrowed" | null. */
function cardStatus(card) {
  const m = card.match(/badge_record_availability([^>]*)>([\s\S]*?)<\/span>\s*<\/span>/i);
  if (!m) return null;
  const c = classify(htmlToText(m[2]));
  if (c === "available" || /\brecord_available\b/.test(m[1])) return "available";
  return "borrowed";
}

/** Liste de résultats : la disponibilité est lue directement sur chaque carte. */
function parseList(html, book) {
  const cards = html.split(/<div class="list-group-item/).slice(1);
  if (!cards.length) return null;
  const items = [];
  for (const card of cards) {
    const title = card.match(/<div class="card_title[\s\S]*?<\/a><\/div>/i)?.[0];
    if (!title) continue;
    const author = card.match(/class="card-subtitle">([\s\S]*?)<\/a><\/div>/i)?.[1] || "";
    const doctype = htmlToText(card.match(/record_doctype[\s\S]*?<\/a>/i)?.[0] || "");
    if (/\b(dvd|cd|jeu|vid[eé]o|revue|audio)\b/i.test(doctype.replace(/type de document/gi, ""))) continue;
    items.push({ text: htmlToText(title) + " " + htmlToText(author), status: cardStatus(card) });
  }
  return statusFromList(items, book);
}

/** Repli : page « Exemplaires » (.item_availability). */
function parseCopies(html) {
  const states = [...html.matchAll(/item_availability[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => classify(htmlToText(m[1])));
  if (!states.length) return null;
  return states.includes("available") ? "available" : "borrowed";
}

function afiConfig(id, label) {
  return {
    id,
    label,
    buildSearchUrl: (base, q) => `${base}/recherche/simple/expressionRecherche/${encodeQ(q)}/tri/%2A`,
    linkId: (pq, u) => (NOTICE_RE.test(u.pathname) ? u.pathname : null),
    isDetailUrl: (url) => NOTICE_RE.test(new URL(url).pathname),
    detailUrl: (url) => url.replace("/recherche/viewnotice/", "/record/items/"),
    parseList,
    parseCopies,
  };
}

export const NanookAdapter = makeHtmlAdapter(afiConfig("nanook", "AFI Nanook"));
export const BokehAdapter = makeHtmlAdapter(afiConfig("bokeh", "Bokeh (portail OPAC)"));

export const _internals = { parseList, parseCopies };