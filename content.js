// ============================================================
// content.js — page Booknode « Mes envies »
// Extrait les livres, interroge le background, affiche les badges.
// ============================================================
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  // ---------- Icônes Phosphor (regular, SVG embarqués : aucun CDN) ----------
  const P = {
    reload:   "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z",
    check:    "M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
    clock:    "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z",
    xcircle:  "M165.66,101.66,139.31,128l26.35,26.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
    question: "M140,180a12,12,0,1,1-12-12A12,12,0,0,1,140,180ZM128,72c-22.06,0-40,16.15-40,36v4a8,8,0,0,0,16,0v-4c0-11,10.77-20,24-20s24,9,24,20-10.77,20-24,20a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-.72c18.24-3.35,32-17.9,32-35.28C168,88.15,150.06,72,128,72Zm104,56A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
  };

  const STATES = {
    available: { icon: "check",    color: "#2e9b4e", label: "Disponible dans le catalogue" },
    borrowed:  { icon: "clock",    color: "#e08a1e", label: "Présent mais emprunté" },
    notfound:  { icon: "xcircle",  color: "#9aa0a6", label: "Non trouvé au catalogue" },
    error:     { icon: "question", color: "#d0432f", label: "Erreur / non configuré" },
  };

  function svg(name) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="1.2em" height="1.2em" fill="currentColor" aria-hidden="true"><path d="${P[name]}"/></svg>`;
  }

  // ---------- Styles ----------
  const style = document.createElement("style");
  style.textContent = `
    .bnb-badge{display:inline-flex;align-items:center;vertical-align:middle;margin-left:6px;
      text-decoration:none!important;cursor:pointer;line-height:1}
    .bnb-badge:hover{transform:scale(1.15)}
    .bnb-loading{display:inline-block;width:1em;height:1em;margin-left:6px;vertical-align:middle;
      border:2px solid #9aa0a6;border-top-color:transparent;border-radius:50%;animation:bnb-spin .8s linear infinite}
    @keyframes bnb-spin{to{transform:rotate(360deg)}}
    .bnb-reload-all{display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:2px 4px;border:0;background:none;
      color:inherit;cursor:pointer;line-height:1;font-size:.85em;opacity:.75;border-radius:6px;vertical-align:middle}
    .bnb-reload-all:hover{opacity:1}
    .bnb-reload-all[disabled]{cursor:progress;opacity:.6}
    .bnb-reload-all.bnb-run svg{animation:bnb-spin .8s linear infinite}
  `;
  document.head.appendChild(style);

  // ---------- Repérage de la section « Mes envies » ----------
  // ⚠️ Booknode n'a pas d'API : on repère le titre « Mes envies » puis son conteneur.
  // Si le site change son HTML, c'est ici qu'il faut ajuster.
  // Structure réelle (Vue) :
  //   <div class="panel library-panel-list">
  //     <div class="panel-heading-list"><span>Mes envies</span> (23)</div>
  //     <div class="panel-body"> … .library-list-item (.name a + .person a) … </div>
  function findWishSection() {
    const panels = document.querySelectorAll(".library-panel-list");
    for (const p of panels) {
      const head = p.querySelector(".panel-heading-list");
      if (head && /^\s*mes envies/i.test(head.textContent)) return p;
    }
    return null;
  }

  // ---------- Extraction des livres ----------
  function extractBooks(section) {
    const books = [];
    section.querySelectorAll(".library-list-item").forEach((item) => {
      const link = item.querySelector(".name a");
      if (!link) return;
      const title = link.textContent.trim();
      if (!title) return;
      // L'auteur est dans le DOM même s'il est masqué sur mobile (hidden-xs)
      const author = item.querySelector('.person a[href*="/auteur/"]')?.textContent.trim() || "";
      // Booknode n'affiche pas l'ISBN dans la liste : recherche par titre + auteur
      books.push({ title, author, isbn: "", anchor: link });
    });
    return books;
  }

  // ---------- Badge ----------
  function clearMarks(anchor) {
    let n = anchor.nextElementSibling;
    while (n && (n.classList.contains("bnb-badge") || n.classList.contains("bnb-loading"))) {
      const next = n.nextElementSibling;
      n.remove();
      n = next;
    }
  }

  function ago(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.round(min / 60);
    return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
  }

  const REASONS = {
    not_configured: " — ajoutez une médiathèque dans les options",
    no_permission: " — accès au site du catalogue non autorisé (ouvrez les options et enregistrez)",
    rate_limited: " — le catalogue limite les requêtes, rechargez la page plus tard",
    network: " — catalogue injoignable",
    bad_url: " — URL du catalogue invalide (voir les options)",
  };

  // Une pastille pour une médiathèque (entry = résultat d'une médiathèque)
  function makeBadge(entry, showName) {
    const key = STATES[entry?.status] ? entry.status : "error";
    const s = STATES[key];
    const a = document.createElement("a");
    a.className = "bnb-badge";
    a.style.color = s.color;
    a.title = (showName && entry?.name ? `${entry.name} : ` : "") + s.label
      + (key === "error" ? (REASONS[entry?.reason] || ` (${entry?.reason || "inconnue"})`) : "")
      + (key === "error" && entry?.message ? `\n${entry.message}` : "")
      + (entry?.debug ? `\n${entry.debug}` : "")
      + (entry?.ts ? `\nVérifié ${ago(entry.ts)}` : "");
    a.innerHTML = svg(s.icon);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (entry?.url) a.href = entry.url;
    else {
      // Pas d'URL (non configuré / erreur) → ouvre les options
      a.href = "#";
      a.addEventListener("click", (e) => { e.preventDefault(); api.runtime.sendMessage({ type: "OPEN_OPTIONS" }); });
    }
    return a;
  }

  // Une pastille par médiathèque (dans l'ordre des réglages), chacune cliquable vers SON catalogue
  function setBadge(book, res) {
    clearMarks(book.anchor);
    const entries = res?.libraries?.length ? res.libraries : [res];
    let prev = book.anchor;
    for (const entry of entries) {
      const a = makeBadge(entry, entries.length > 1);
      prev.insertAdjacentElement("afterend", a);
      prev = a;
    }
  }

  function addLoader(book) {
    clearMarks(book.anchor);
    const l = document.createElement("span");
    l.className = "bnb-loading";
    book.anchor.insertAdjacentElement("afterend", l);
    book.loader = l;
  }

  // ---------- Fonctionnement ----------
  // Au chargement : AUCUN appel au catalogue, on affiche seulement ce qui est en mémoire (2 jours).
  // Le bouton ↻ du titre « Mes envies » lance la vérification des livres sans résultat récent.
  // Maj + clic : tout revérifier en ignorant la mémoire.
  const send = (msg) => api.runtime.sendMessage(msg).catch(() => null);
  const payload = (b) => ({ title: b.title, author: b.author, isbn: b.isbn });
  let running = false;

  async function showCached() {
    const section = findWishSection();
    if (!section) return;
    injectButton(section);
    const books = extractBooks(section).filter((b) => !b.anchor.dataset.bnbSeen);
    if (!books.length) return;
    books.forEach((b) => { b.anchor.dataset.bnbSeen = "1"; });
    const cached = (await send({ type: "GET_CACHED", books: books.map(payload) })) || [];
    books.forEach((b, i) => { if (cached[i]) setBadge(b, cached[i]); });
  }

  async function runAll(force, btn) {
    if (running) return;
    const section = findWishSection();
    if (!section) return;
    running = true;
    btn.disabled = true;
    btn.classList.add("bnb-run");
    const count = btn.querySelector(".bnb-count");

    try {
      const books = extractBooks(section);
      const cached = force ? [] : ((await send({ type: "GET_CACHED", books: books.map(payload) })) || []);
      const todo = [];
      books.forEach((b, i) => {
        b.anchor.dataset.bnbSeen = "1";
        if (cached[i]) setBadge(b, cached[i]);
        else todo.push(b);
      });
      todo.forEach(addLoader);

      let done = 0;
      for (const b of todo) {
        count.textContent = `${done}/${todo.length}`;
        let res;
        try {
          res = await api.runtime.sendMessage({ type: "CHECK_BOOK", book: payload(b), force: !!force });
        } catch {
          res = { status: "error", reason: "messaging" };
        }
        setBadge(b, res);
        done++;
      }
    } finally {
      count.textContent = "";
      btn.disabled = false;
      btn.classList.remove("bnb-run");
      running = false;
    }
  }

  function injectButton(section) {
    const head = section.querySelector(".panel-heading-list");
    if (!head || head.querySelector(".bnb-reload-all")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bnb-reload-all";
    btn.title = "Vérifier la disponibilité dans vos médiathèques\n(résultats gardés 2 jours — Maj + clic : tout revérifier)";
    btn.setAttribute("aria-label", "Vérifier la disponibilité dans vos médiathèques");
    btn.innerHTML = svg("reload") + '<span class="bnb-count"></span>';
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); runAll(e.shiftKey, btn); });
    head.appendChild(btn);
  }

  showCached();

  // Le site charge parfois la liste en différé / par pagination → on réaffiche la mémoire (sans appel réseau)
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(showCached, 800);
  }).observe(document.body, { childList: true, subtree: true });
})();