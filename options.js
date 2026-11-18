// ============================================================
// options.js — lecture / sauvegarde des réglages (plusieurs médiathèques)
// ============================================================
import { ADAPTERS, DEFAULT_ADAPTER_ID } from "./adapters/index.js";

const api = globalThis.browser ?? globalThis.chrome;

const $form = document.getElementById("form");
const $list = document.getElementById("libraries");
const $tpl = document.getElementById("lib-template");
const $status = document.getElementById("status");

// Exemples d'URL de base selon le système (aide sous le champ)
const HINTS = {
  esidoc: "Exemple : https://code-etablissement.esidoc.fr (portail e-sidoc d'un CDI)",
};
const DEFAULT_HINT = "Adresse du site de la bibliothèque, sans le chemin de recherche. Exemple : https://bibliotheque.fr";

function say(text, ok = true) {
  $status.textContent = text;
  $status.className = ok ? "ok" : "err";
}

function renumber() {
  const rows = [...$list.querySelectorAll(".lib")];
  rows.forEach((row, i) => {
    row.querySelector(".lib-num").textContent = `Médiathèque ${i + 1}`;
    row.querySelector(".remove").hidden = rows.length < 2; // toujours au moins une ligne
  });
}

function addRow(lib = {}) {
  const row = $tpl.content.firstElementChild.cloneNode(true);
  row.dataset.id = lib.id || (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())).slice(0, 8);

  const $type = row.querySelector(".f-type");
  for (const a of ADAPTERS) $type.add(new Option(a.label, a.id));
  $type.value = lib.systemType || DEFAULT_ADAPTER_ID;

  const $hint = row.querySelector(".hint");
  const updateHint = () => { $hint.textContent = HINTS[$type.value] || DEFAULT_HINT; };
  $type.addEventListener("change", updateHint);
  updateHint();

  row.querySelector(".f-name").value = lib.name || "";
  row.querySelector(".f-url").value = lib.baseUrl || "";
  row.querySelector(".remove").addEventListener("click", () => { row.remove(); renumber(); });

  $list.appendChild(row);
  renumber();
  return row;
}

document.getElementById("add").addEventListener("click", () => {
  addRow().querySelector(".f-url").focus();
});

// Chargement des valeurs enregistrées (avec conversion des anciens réglages à une seule médiathèque)
(async () => {
  const { libraries, baseUrl = "", systemType = DEFAULT_ADAPTER_ID } =
    await api.storage.sync.get(["libraries", "baseUrl", "systemType"]);
  let list = Array.isArray(libraries) ? libraries : [];
  if (!list.length && baseUrl) list = [{ id: "main", name: "", systemType, baseUrl }];
  if (!list.length) list = [{}];
  list.forEach(addRow);
})();

$form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const libraries = [];
  const origins = new Set();
  for (const row of $list.querySelectorAll(".lib")) {
    const raw = row.querySelector(".f-url").value.trim();
    let origin;
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      origin = u.origin;
    } catch {
      return say(`URL invalide : « ${raw} »`, false);
    }
    origins.add(origin + "/*");
    for (const o of ADAPTERS.find((a) => a.id === row.querySelector(".f-type").value)?.extraOrigins || []) origins.add(o + "/*");
    libraries.push({
      id: row.dataset.id,
      name: row.querySelector(".f-name").value.trim(),
      systemType: row.querySelector(".f-type").value,
      baseUrl: origin,
    });
  }

  // Demande l'accès à tous les domaines en une seule fois (doit être appelée dans le clic)
  const granted = await api.permissions.request({ origins: [...origins] });
  if (!granted) return say("Accès aux sites refusé : la vérification ne pourra pas fonctionner.", false);

  await api.storage.sync.set({ libraries });
  await api.storage.sync.remove(["baseUrl", "systemType"]); // anciens réglages, désormais inclus dans « libraries »

  // Remet les URL normalisées dans les champs
  $list.querySelectorAll(".lib").forEach((row, i) => { row.querySelector(".f-url").value = libraries[i].baseUrl; });
  say(libraries.length > 1 ? `${libraries.length} médiathèques enregistrées ✔` : "Réglages enregistrés ✔");
});

document.getElementById("clear").addEventListener("click", async () => {
  await api.storage.local.remove("resultCache");
  say("Cache vidé ✔");
});