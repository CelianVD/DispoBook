// ============================================================
// Adaptateur « e-sidoc » (portail CDI / BCD des établissements scolaires)
// ------------------------------------------------------------
// Le portail (https://<RNE>.esidoc.fr) est une application monopage : le HTML ne contient pas
// les résultats. Il interroge une API JSON :
//   POST https://api-recherche.esidoc.fr/recherche/simple/<RNE>?esidocpublictoken=<JWT>
//   corps : { requete: [{ critere: "tous", valeur: "<mots>", operateur: "ET" }], facettes: [...], nb_resultats: N }
//   réponse : { nb_resultats, resultats: [{ contenu: { titre, auteurs, support, … }, exemplaires | notice_generale.exemplaires }] }
//     chaque exemplaire : { disponibilite: "Disponible", … }
// Le jeton est un JWT public (valide ~1 h), obtenu comme le fait le portail :
//   POST https://authentification.esidoc.fr/token   (application/x-www-form-urlencoded)
//   grant_type=client_credentials & client_id=<token_public_client_id de config.json> & client_secret=<RNE en minuscules>
//   réponse : { access_token, token_type: "Bearer", expires_in: 3600 }
// Il est gardé en mémoire jusqu'à son expiration. Si l'authentification échoue, on retombe sur
// l'ancienne méthode (recherche d'un JWT dans la page d'accueil du portail).
// Les articles de presse (« Je bouquine »…) sont ignorés : ce ne sont pas des livres.
// ============================================================
import { defaultQueries, classify, normalize, statusFromList } from "./common.js";

const API = "https://api-recherche.esidoc.fr";
const AUTH = "https://authentification.esidoc.fr";
const CONFIG_URL = "https://frontend.esidoc.fr/config/config.json";
const DEFAULT_CLIENT_ID = "d4ec4c5515dc0cfa1f29c0f56a3f3944"; // token_public_client_id (config.json)
const NOT_A_BOOK = /^(presse|dvd|cd\b|video|vid[ée]o|jeu|ressource num)/i;
const FACETTES = ["support_groupe", "date_parution_annee", "auteurs", "types_nature", "descripteurs", "editeurs", "collection", "langue"];
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// ---------- Jeton ----------
const tokens = new Map(); // base → { token, rne, exp (ms) }

function decodeJwt(jwt) {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)))));
  } catch { return null; }
}

function findToken(text) {
  let best = null;
  for (const jwt of text.match(JWT_RE) || []) {
    const p = decodeJwt(jwt);
    if (!p?.rne) continue;
    const t = { token: jwt, rne: String(p.rne), exp: (p.exp || 0) * 1000 };
    if (!best || t.exp > best.exp) best = t;
  }
  return best;
}

let clientId = null;
async function getClientId(ctx) {
  if (clientId) return clientId;
  try {
    const cfg = await ctx.getJson(CONFIG_URL);
    clientId = cfg?.token_public_client_id || DEFAULT_CLIENT_ID;
  } catch { return DEFAULT_CLIENT_ID; } // pas de mise en cache d'un échec
  return clientId;
}

/** RNE de l'établissement, */
const rneFromBase = (base) => new URL(base).hostname.split(".")[0].toLowerCase();

/** Jeton via l'endpoint d'authentification (client_credentials). */
async function fetchTokenFromAuth(ctx, base) {
  const rne = rneFromBase(base);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: await getClientId(ctx),
    client_secret: rne,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(AUTH + "/token", {
      method: "POST",
      signal: ctrl.signal,
      credentials: "omit",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "*/*",
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} (authentification e-sidoc)`);
    const j = await res.json();
    if (!j?.access_token) throw new Error("access_token absent de la réponse d'authentification");
    const p = decodeJwt(j.access_token);
    return {
      token: j.access_token,
      rne: String(p?.rne || rne),
      exp: p?.exp ? p.exp * 1000 : Date.now() + (Number(j.expires_in) || 3600) * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Ancienne méthode (secours) : JWT public intégré à la page d'accueil ou à ses scripts. */
async function scrapeTokenFromPortal(ctx, base) {
  const home = await ctx.getPage(base + "/");
  let t = findToken(home.text);
  if (!t) {
    const srcs = [...home.text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => { try { return new URL(m[1], base + "/"); } catch { return null; } })
      .filter((u) => u && u.origin === new URL(base).origin)
      .slice(0, 6);
    for (const u of srcs) {
      t = findToken((await ctx.getPage(u.href)).text);
      if (t) break;
    }
  }
  return t;
}

async function getToken(ctx, base, force = false) {
  const hit = tokens.get(base);
  if (!force && hit && hit.exp - Date.now() > 60_000) return hit;

  let t = null;
  let authError = null;
  try { t = await fetchTokenFromAuth(ctx, base); }
  catch (e) { authError = e; }
  if (!t) t = await scrapeTokenFromPortal(ctx, base).catch(() => null);
  if (!t) throw new Error("jeton e-sidoc introuvable : " + (authError ? String(authError.message || authError) : "échec de l'authentification"));
  tokens.set(base, t);
  return t;
}

// ---------- Lecture des résultats ----------
/** Exemplaires d'un résultat → "available" | "borrowed" | null (aucun exemplaire). */
function copiesStatus(r) {
  const copies = r.exemplaires || r.notice_generale?.exemplaires || [];
  if (!copies.length) return null;
  return copies.some((c) => classify(c.disponibilite) === "available") ? "available" : "borrowed";
}

/** Réponse de l'API → "available" | "borrowed" | "notfound". */
function parseResults(json, book) {
  const items = [];
  for (const r of json?.resultats || []) {
    const c = r.contenu || {};
    if (NOT_A_BOOK.test(c.support || "")) continue;
    if (!c.titre) continue;
    const status = copiesStatus(r);
    if (!status) continue; // aucun exemplaire (ressource en ligne…) : jamais « disponible »
    items.push({ text: `${c.titre} ${(c.auteurs || []).join(" ")}`, status });
  }
  return statusFromList(items, book) ?? "notfound";
}

const encodeSearch = (q) =>
  encodeURIComponent(q.trim().replace(/[\/?#\\]+/g, " ").replace(/\s+/g, " "));

export const EsidocAdapter = {
  id: "esidoc",
  label: "e-sidoc",
  // L'API, l'authentification et config.json sont sur d'autres domaines : la page d'options demande aussi ces autorisations
  extraOrigins: [API, AUTH, "https://frontend.esidoc.fr"],
  buildQueries: defaultQueries,
  // Page de recherche du portail (ouverte par un clic sur la pastille)
  buildSearchUrl: (base, q) => `${base.replace(/\/+$/, "")}/recherche/${encodeSearch(q)}`,

  async check(ctx, baseUrl, query, book) {
    const base = baseUrl.replace(/\/+$/, "");
    const body = {
      requete: [{ critere: "tous", valeur: query.trim(), operateur: "ET" }],
      facettes: FACETTES,
      nb_resultats: 20,
      avis_federes: "1",
    };

    let json;
    for (let attempt = 0; attempt < 2; attempt++) {
      let t;
      try { t = await getToken(ctx, base, attempt > 0); }
      catch (e) { return { status: "error", reason: "parse", message: String(e.message || e) }; }
      const url = `${API}/recherche/simple/${encodeURIComponent(t.rne.toUpperCase())}?esidocpublictoken=${encodeURIComponent(t.token)}`;
      try {
        json = await ctx.postJson(url, body, { Esidocpublictoken: t.token });
        break;
      } catch (e) {
        // Jeton refusé / expiré : on en récupère un neuf et on réessaie une fois
        if (attempt === 0 && /HTTP 40[013]/.test(String(e))) { tokens.delete(base); continue; }
        throw e;
      }
    }
    // Aucun résultat : l'API renvoie des facettes vides (et nb_resultats = 0), sans tableau « resultats »
    const isEmptyAnswer = json && typeof json === "object" && !Array.isArray(json.resultats) &&
      (json.nb_resultats === 0 || json.nb_resultats === undefined && json.facettes);
    if (isEmptyAnswer) return { status: "notfound" };
    if (!json || !Array.isArray(json.resultats)) {
      return { status: "error", reason: "parse", message: "Réponse e-sidoc inattendue : " + JSON.stringify(json)?.slice(0, 150) };
    }
    return { status: parseResults(json, book) };
  },
};

export const _internals = { parseResults, copiesStatus, findToken, decodeJwt };