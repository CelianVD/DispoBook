// ============================================================
// Registre des adaptateurs de catalogue.
// Pour ajouter Koha, PMB, Waterbear… :
//   1. créer adapters/koha.js qui exporte un objet respectant le contrat
//      (id, label, buildQueries, buildSearchUrl, parseResults) ;
//   2. l'importer ici et l'ajouter au tableau ADAPTERS.
// La page d'options et le background s'adaptent automatiquement.
// ============================================================
import { ArchimedAdapter } from "./archimed.js";

export const ADAPTERS = [
  ArchimedAdapter,
  // KohaAdapter,
  // PmbAdapter,
  // WaterbearAdapter,
];

export const DEFAULT_ADAPTER_ID = ArchimedAdapter.id;

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}
