// ============================================================
// background.js — requêtes catalogue, cache, file d'attente
// Fonctionne en service worker (Chrome) et en event page (Firefox).
// ============================================================
import { getAdapter, DEFAULT_ADAPTER_ID } from "./adapters/index.js";

const api = globalThis.browser ?? globalThis.chrome;

const CACHE_KEY = "resultCache";
const CACHE_REV = 2; // révision du format / des adaptateurs (voir cacheKey)
const CACHE_TTL_MS = 2 * 24 * 3600 * 1000; // 48 h
const CACHE_TTL = {
  // Mémoire de 2 jours pour tous les résultats (le bouton ↻ force une mise à jour)
  available: CACHE_TTL_MS,
  borrowed: CACHE_TTL_MS,
  notfound: CACHE_TTL_MS,
};
const MIN_DELAY_MS = 1000;      // délai minimal entre deux appels réseau (catalogues = rate limit strict)
const FETCH_TIMEOUT_MS = 15000;
const MAX_QUERIES_PER_BOOK = 2; // au plus 2 recherches par livre
const COOLDOWN_STEP_MS = 30000; // pause après un « Trop de requêtes » (30 s, 60 s, 90 s…)
const COOLDOWN_MAX_MS = 120000;

class RateLimited extends Error {}
let cooldownUntil = 0;
let strikes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Réglages ----------
async function getSettings() {
  const { baseUrl = "", systemType = DEFAULT_ADAPTER_ID } =
    await api.storage.sync.get(["baseUrl", "systemType"]);
  return { baseUrl: baseUrl.trim(), systemType };
}

// ---------- Cache (storage.local, persistant) ----------
async function readCache() {
  const data = await api.storage.local.get(CACHE_KEY);
  return data[CACHE_KEY] || {};
}

async function writeCache(cache) {
  // On jette les entrées périmées pour que le cache ne grossisse pas indéfiniment
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) {
    if (now - v.ts > CACHE_TTL_MS) delete cache[k];
  }
  await api.storage.local.set({ [CACHE_KEY]: cache });
}

function cacheKey(settings, book) {
  const id = book.isbn || `${book.title}|${book.author}`;
  // CACHE_REV : à incrémenter quand un adaptateur change, pour ne pas garder d'anciens « non trouvé » erronés
  return `r${CACHE_REV}|${settings.systemType}|${settings.baseUrl}|${id}`.toLowerCase();
}

// Vide le cache quand l'utilisateur change de catalogue
api.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.baseUrl || changes.systemType)) {
    api.storage.local.remove(CACHE_KEY);
  }
});

// ---------- File d'attente séquentielle (anti-surcharge) ----------
let chain = Promise.resolve();
let lastCall = 0;

function enqueue(task) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCall + MIN_DELAY_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return task();
  });
  chain = run.catch(() => {});
  return run;
}

// ---------- Requêtes JSON avec timeout ----------
const warmed = new Set();
async function warmUp(base) {
  // Une seule fois par session : crée les cookies Syracuse (sinon chaque appel repart de zéro, très lent)
  if (warmed.has(base)) return;
  warmed.add(base);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try { await fetch(base + "/", { signal: ctrl.signal, credentials: "include" }); } catch { /* non bloquant */ }
  finally { clearTimeout(timer); }
}

async function fetchJson(url, body, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      credentials: "include",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) throw new RateLimited();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (/trop\s+de\s+requ[êe]tes/i.test(raw)) throw new RateLimited();
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

// GET JSON (ex. V-Smart : appels de disponibilité) : retourne le JSON, ou lève « HTTP <code> »
async function fetchJsonGet(url, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      credentials: "include",
      headers: { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest", ...extraHeaders },
    });
    if (res.status === 429 || res.status === 503) throw new RateLimited();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (/trop\s+de\s+requ[êe]tes/i.test(raw.slice(0, 2000))) throw new RateLimited();
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

// GET HTML (portails rendus côté serveur, ex. Orphée) : retourne { url, text }
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      credentials: "include",
      headers: { "Accept": "text/html,application/xhtml+xml" },
    });
    if (res.status === 429 || res.status === 503) throw new RateLimited();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/trop\s+de\s+requ[êe]tes/i.test(text.slice(0, 5000))) throw new RateLimited();
    return { url: res.url || url, text };
  } finally {
    clearTimeout(timer);
  }
}

// Même logique « polie » que politePostJson, pour les GET
async function politeGetPage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await enqueue(async () => {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const page = await fetchText(url);
        strikes = 0;
        return { ok: true, page };
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e;
        strikes++;
        cooldownUntil = Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_STEP_MS * strikes);
        return null;
      }
    });
    if (out) return out.page;
  }
  throw new RateLimited();
}

// GET JSON « poli » (même file d'attente et mêmes pauses que les autres appels)
async function politeGetJson(url, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await enqueue(async () => {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const j = await fetchJsonGet(url, headers);
        strikes = 0;
        return { ok: true, j };
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e;
        strikes++;
        cooldownUntil = Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_STEP_MS * strikes);
        return null;
      }
    });
    if (out) return out.j;
  }
  throw new RateLimited();
}

// POST « poli » : respecte la file, attend pendant un blocage, retente 2 fois.
async function politePostJson(url, body, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await enqueue(async () => {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const j = await fetchJson(url, body, headers);
        strikes = 0;
        return { ok: true, j };
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e;
        strikes++;
        cooldownUntil = Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_STEP_MS * strikes);
        return null;
      }
    });
    if (out) return out.j;
  }
  throw new RateLimited();
}

// Lecture du cache SEULE (aucun appel réseau) : sert à afficher les pastilles au chargement
async function lookupCached(books) {
  const settings = await getSettings();
  if (!settings.baseUrl) return books.map(() => null);
  const cache = await readCache();
  return books.map((book) => {
    const hit = cache[cacheKey(settings, book)];
    return hit && Date.now() - hit.ts < (CACHE_TTL[hit.status] ?? 0)
      ? { status: hit.status, url: hit.url, cached: true, ts: hit.ts }
      : null;
  });
}

// ---------- Vérification d'un livre ----------
async function checkBook(book, force = false) {
  const settings = await getSettings();
  if (!settings.baseUrl) return { status: "error", reason: "not_configured" };

  const adapter = getAdapter(settings.systemType);
  if (!adapter) return { status: "error", reason: "unknown_system" };

  // 1) Cache
  const key = cacheKey(settings, book);
  const cache = await readCache();
  const hit = cache[key];
  if (!force && hit && Date.now() - hit.ts < (CACHE_TTL[hit.status] ?? 0)) {
    return { status: hit.status, url: hit.url, cached: true, ts: hit.ts };
  }

  // 2) Permission d'accès au domaine du catalogue
  const origin = new URL(settings.baseUrl).origin + "/*";
  if (!(await api.permissions.contains({ origins: [origin] }))) {
    return { status: "error", reason: "no_permission" };
  }

  // 3) Requêtes (par ordre de priorité) via la file d'attente
  let result = { status: "notfound" };
  const debugLines = []; // diagnostic affiché au survol de la pastille (adaptateurs qui en fournissent)
  let usedUrl = adapter.buildSearchUrl(settings.baseUrl, adapter.buildQueries(book)[0] || book.title);

  try {
    await warmUp(new URL(settings.baseUrl).origin);
    const ctx = { postJson: politePostJson, getJson: politeGetJson, getPage: politeGetPage };
    for (const query of adapter.buildQueries(book).slice(0, MAX_QUERIES_PER_BOOK)) {
      const url = adapter.buildSearchUrl(settings.baseUrl, query);
      const parsed = await adapter.check(ctx, settings.baseUrl, query, book);
      usedUrl = url;
      if (parsed.status === "error") return { ...parsed, url };
      result = parsed;
      if (parsed.debug) debugLines.push(parsed.debug);
      if (parsed.status !== "notfound") break; // trouvé : on s'arrête
    }
  } catch (err) {
    // On renvoie quand même l'URL : le badge reste cliquable vers le catalogue
    const reason = err instanceof RateLimited ? "rate_limited" : "network";
    return { status: "error", reason, message: String(err), url: usedUrl };
  }

  // 4) Mise en cache (on ne cache pas les erreurs)
  cache[key] = { status: result.status, url: usedUrl, ts: Date.now() };
  await writeCache(cache);

  return { status: result.status, url: usedUrl, cached: false, ts: Date.now(), debug: result.status === "available" ? undefined : debugLines.join("\n") || undefined };
}

// ---------- Messagerie avec le content script ----------
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CHECK_BOOK") {
    checkBook(msg.book, !!msg.force)
      .then(sendResponse)
      .catch((e) => sendResponse({ status: "error", reason: "exception", message: String(e) }));
    return true; // réponse asynchrone (Firefox + Chrome)
  }
  if (msg?.type === "GET_CACHED") {
    lookupCached(msg.books || []).then(sendResponse).catch(() => sendResponse((msg.books || []).map(() => null)));
    return true;
  }
  if (msg?.type === "OPEN_OPTIONS") {
    api.runtime.openOptionsPage();
    return false;
  }
  if (msg?.type === "GET_CONFIG_STATE") {
    getSettings().then((s) => sendResponse({ configured: !!s.baseUrl }));
    return true;
  }
});

// Clic sur l'icône de l'extension → page d'options
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

// Premier démarrage → ouvre les options pour configurer l'URL
api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") api.runtime.openOptionsPage();
});
