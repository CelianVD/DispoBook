// ============================================================
// options.js — lecture / sauvegarde des réglages
// ============================================================
import { ADAPTERS, DEFAULT_ADAPTER_ID } from "./adapters/index.js";

const api = globalThis.browser ?? globalThis.chrome;

const $form = document.getElementById("form");
const $type = document.getElementById("systemType");
const $url = document.getElementById("baseUrl");
const $status = document.getElementById("status");

function say(text, ok = true) {
  $status.textContent = text;
  $status.className = ok ? "ok" : "err";
}

// Menu déroulant alimenté par le registre d'adaptateurs
for (const a of ADAPTERS) $type.add(new Option(a.label, a.id));

// Chargement des valeurs enregistrées
(async () => {
  const { baseUrl = "", systemType = DEFAULT_ADAPTER_ID } =
    await api.storage.sync.get(["baseUrl", "systemType"]);
  $url.value = baseUrl;
  $type.value = systemType;
})();

$form.addEventListener("submit", async (e) => {
  e.preventDefault();

  let origin;
  try {
    const u = new URL($url.value.trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    origin = u.origin;
  } catch {
    return say("URL invalide.", false);
  }

  // Demande l'accès au domaine du catalogue (doit être appelée dans le clic)
  const granted = await api.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return say("Accès au site refusé : la vérification ne pourra pas fonctionner.", false);

  await api.storage.sync.set({ baseUrl: origin, systemType: $type.value });
  $url.value = origin;
  say("Réglages enregistrés ✔");
});

document.getElementById("clear").addEventListener("click", async () => {
  await api.storage.local.remove("resultCache");
  say("Cache vidé ✔");
});
