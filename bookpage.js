// ============================================================
// bookpage.js — page d'un livre Booknode
// Ajoute un bouton « actualiser » à côté de « N extraits » : un clic lance
// la vérification au catalogue pour CE livre, sans l'ajouter à Mes envies.
// ============================================================
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  // Une page livre ressemble à /titre_du_livre_123456 (pas /profil/…, pas /auteur/…)
  if (!/^\/[^/]+_\d+\/?$/.test(location.pathname)) return;

  // ---------- Icônes Phosphor (regular) ----------
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
  const REASONS = {
    not_configured: " — configurez l'URL dans les options",
    no_permission: " — accès au site du catalogue non autorisé (ouvrez les options et enregistrez)",
    rate_limited: " — le catalogue limite les requêtes, réessayez plus tard",
    network: " — catalogue injoignable",
  };

  const svg = (name) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true"><path d="${P[name]}"/></svg>`;

  const style = document.createElement("style");
  style.textContent = `
    .bnb-wrap{display:inline-flex;align-items:center;gap:4px;margin-left:8px;vertical-align:middle;font-size:inherit;line-height:1}
    .bnb-reload{display:inline-flex;align-items:center;justify-content:center;padding:2px;border:0;background:none;
      color:inherit;cursor:pointer;line-height:1;opacity:.75;border-radius:50%}
    .bnb-reload:hover{opacity:1;transform:rotate(60deg);transition:transform .2s}
    .bnb-reload[disabled]{cursor:progress;opacity:.5}
    .bnb-reload.bnb-spin svg{animation:bnb-spin .8s linear infinite}
    @keyframes bnb-spin{to{transform:rotate(360deg)}}
    .bnb-badge{display:inline-flex;align-items:center;text-decoration:none!important;line-height:1}
    .bnb-badge:hover{transform:scale(1.15)}
  `;
  document.head.appendChild(style);

  // ---------- Lecture de la page ----------
  function readBook() {
    const h1 = document.querySelector("h1");
    const title = h1?.textContent.replace(/\s+/g, " ").trim();
    if (!title) return null;
    let author = document.querySelector('a[href*="/auteur/"]')?.textContent.trim() || "";
    if (!author) {
      // Repli : données structurées éventuelles
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          const a = [].concat(j.author || j["@graph"]?.find?.((n) => n.author)?.author || [])[0];
          if (a) { author = (typeof a === "string" ? a : a.name) || ""; break; }
        } catch { /* JSON invalide : on ignore */ }
      }
    }
    return { title, author, isbn: "" };
  }

  // ---------- Repérage de la fin de la ligne « N notes | N commentaires | N extraits » ----------
  // Selon le livre, la ligne peut être « 9 notes | 1 commentaire », « 6 687 notes | 981 commentaires | 147 extraits »
  // ou juste « 3 notes ». On part de « N notes », puis on cherche le dernier « N commentaires » / « N extraits »
  // de la même ligne : le bouton se met juste après. Sans eux, il se met juste après « N notes ».
  // ⚠️ Si Booknode change son HTML, c'est ici qu'il faut ajuster.
  const NUM = "\\d[\\d\\s\\u00a0.,]*";
  const NOTES_RE = new RegExp(`^[^\\p{L}\\d]*${NUM}\\s*notes?\\s*$`, "iu");
  const COUNT_RE = new RegExp(`^\\s*${NUM}\\s*(?:commentaires?|extraits?)\\s*$`, "iu");
  const TAGS = "a, span, div, p, li, small, b, strong, em";

  function findLineEnd() {
    const inScope = (el) => !el.closest("nav, .bnb-wrap, script, style");

    // 1) l'élément « N notes » (le plus grand qui ne contient que ça)
    const notes = [...document.querySelectorAll(TAGS)].filter((el) => inScope(el) && NOTES_RE.test(el.textContent));
    const notesEl = notes.find((el) => !notes.some((o) => o !== el && o.contains(el)));
    if (!notesEl) return null;

    // 2) les « N commentaires » / « N extraits » proches (3 niveaux au plus), le dernier dans la page
    const counts = [...document.querySelectorAll(TAGS)].filter((el) => inScope(el) && COUNT_RE.test(el.textContent));
    const outer = counts.filter((el) => !counts.some((o) => o !== el && o.contains(el)));
    const top = notesEl.getBoundingClientRect().top;
    const near = (el) => {
      const t = el.getBoundingClientRect().top;
      return !top || !t || Math.abs(t - top) < 40; // sans mise en page (tests) : pas de contrôle
    };
    let scope = notesEl;
    for (let i = 0; i < 3 && scope.parentElement; i++) {
      scope = scope.parentElement;
      const inside = outer.filter((el) => scope.contains(el) && !el.contains(notesEl) && near(el));
      if (inside.length) return inside[inside.length - 1]; // dernier dans l'ordre du document
    }
    return notesEl;
  }

  // ---------- Affichage ----------
  function showResult(wrap, res) {
    wrap.querySelector(".bnb-badge")?.remove();
    const key = STATES[res?.status] ? res.status : "error";
    const s = STATES[key];
    const a = document.createElement("a");
    a.className = "bnb-badge";
    a.style.color = s.color;
    a.title = s.label + (key === "error" ? (REASONS[res?.reason] || ` (${res?.reason || "inconnue"})`) : "")
      + (key === "error" && res?.message ? `\n${res.message}` : "");
    a.innerHTML = svg(s.icon);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (res?.url) a.href = res.url;
    else {
      a.href = "#";
      a.addEventListener("click", (e) => { e.preventDefault(); api.runtime.sendMessage({ type: "OPEN_OPTIONS" }); });
    }
    wrap.appendChild(a);
  }

  async function check(wrap, btn) {
    const book = readBook();
    if (!book) return;
    btn.disabled = true;
    btn.classList.add("bnb-spin");
    wrap.querySelector(".bnb-badge")?.remove();
    let res;
    try {
      // force : un clic sur « actualiser » ignore le cache
      res = await api.runtime.sendMessage({ type: "CHECK_BOOK", book, force: true });
    } catch {
      res = { status: "error", reason: "messaging" };
    }
    btn.disabled = false;
    btn.classList.remove("bnb-spin");
    showResult(wrap, res);
  }

  function inject() {
    if (document.querySelector(".bnb-wrap")) return;
    // Structure réelle de Booknode : <div class="top-stat-line"> notes | commentaires | extraits | 🏆 … </div>
    const statLine = document.querySelector(".top-stat-line");
    const end = statLine ? null : findLineEnd(); // repli heuristique si Booknode renomme la classe
    if (!statLine && !end) return; // ligne pas (encore) affichée : l'observateur réessaiera

    const wrap = document.createElement("span");
    wrap.className = "bnb-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bnb-reload";
    btn.title = "Vérifier la disponibilité à la bibliothèque";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = svg("reload");
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); check(wrap, btn); });
    wrap.appendChild(btn);
    if (statLine) statLine.appendChild(wrap); // tout à la fin de la ligne (après 🏆 s'il y en a un)
    else end.after(wrap);
  }

  inject();

  // Booknode recharge parfois des morceaux de page : on remet le bouton s'il disparaît
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(inject, 500);
  }).observe(document.body, { childList: true, subtree: true });
})();
