// ============================================================
// Registre des adaptateurs de catalogue.
// Pour ajouter un système :
//   1. créer adapters/<nom>.js qui exporte un objet respectant le contrat
//      (id, label, buildQueries, buildSearchUrl, check) ;
//      pour un portail rendu côté serveur, makeHtmlAdapter() de common.js suffit ;
//   2. l'importer ici et l'ajouter au tableau ADAPTERS.
// La page d'options et le background s'adaptent automatiquement.
// ============================================================
import { ArchimedAdapter } from "./archimed.js";
import { C3rbAdapter } from "./c3rb.js";
import { KohaAdapter } from "./koha.js";
import { NanookAdapter, BokehAdapter } from "./afi.js";
import { DecalogAdapter } from "./decalog.js";
import { EsidocAdapter } from "./esidoc.js";
import { QuriaAdapter } from "./quria.js";
import { SapientiaAdapter } from "./sapientia.js";
import { VSmartAdapter } from "./vsmart.js";

export const ADAPTERS = [
  ArchimedAdapter,
  C3rbAdapter,
  KohaAdapter,
  NanookAdapter,
  BokehAdapter,
  DecalogAdapter,
  EsidocAdapter,
  QuriaAdapter,
  SapientiaAdapter,
  VSmartAdapter,
  // PmbAdapter,
];

export const DEFAULT_ADAPTER_ID = ArchimedAdapter.id;

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}