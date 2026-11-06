// ============================================================
// content.js — page Booknode « Mes envies »
// Extrait les livres, interroge le background, affiche les badges.
// ============================================================
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  // ---------- Icônes Phosphor (regular, SVG embarqués : aucun CDN) ----------
  const P = {
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
  function setBadge(book, res) {
    book.loader?.remove();
    const key = STATES[res?.status] ? res.status : "error";
    const s = STATES[key];
    const a = document.createElement("a");
    a.className = "bnb-badge";
    a.style.color = s.color;
    const REASONS = {
      not_configured: " — configurez l'URL dans les options",
      no_permission: " — accès au site du catalogue non autorisé (ouvrez les options et enregistrez)",
      rate_limited: " — le catalogue limite les requêtes, rechargez la page plus tard",
      network: " — catalogue injoignable",
    };
    a.title = s.label + (key === "error" ? (REASONS[res?.reason] || ` (${res?.reason || "inconnue"})`) : "")
      + (key === "error" && res?.message ? `\n${res.message}` : "");
    a.innerHTML = svg(s.icon);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (res?.url) a.href = res.url;
    else {
      // Pas d'URL (non configuré / erreur) → ouvre les options
      a.href = "#";
      a.addEventListener("click", (e) => { e.preventDefault(); api.runtime.sendMessage({ type: "OPEN_OPTIONS" }); });
    }
    book.anchor.insertAdjacentElement("afterend", a);
  }

  function addLoader(book) {
    const l = document.createElement("span");
    l.className = "bnb-loading";
    book.anchor.insertAdjacentElement("afterend", l);
    book.loader = l;
  }

  // ---------- Envoi au background (séquentiel, le background gère le débit) ----------
  async function run() {
    const section = findWishSection();
    if (!section) return;
    const books = extractBooks(section).filter((b) => !b.anchor.dataset.bnbDone);

    for (const b of books) { b.anchor.dataset.bnbDone = "1"; addLoader(b); }

    for (const b of books) {
      let res;
      try {
        res = await api.runtime.sendMessage({
          type: "CHECK_BOOK",
          book: { title: b.title, author: b.author, isbn: b.isbn },
        });
      } catch (e) {
        res = { status: "error", reason: "messaging" };
      }
      setBadge(b, res);
    }
  }

  run();

  // Le site charge parfois la liste en différé / par pagination → on réobserve
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(run, 800);
  }).observe(document.body, { childList: true, subtree: true });
})();
