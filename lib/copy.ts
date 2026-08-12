/**
 * The words the panel uses for things that happen everywhere.
 *
 * "Salvataggio fallito" and "Salvataggio non riuscito" both existed, sometimes
 * in sibling tabs of the same screen, for the identical event. Nothing was
 * wrong with either — they had simply been written twice, months apart.
 *
 * The chosen verb is **non riuscito**, not "fallito", for a reason beyond
 * taste: `failed` is a lifecycle state in this product. A deploy is `failed`, a
 * backup run is `failed`, and those words appear as status badges. Using the
 * same Italian word for "the save request returned 500" blurs a status the
 * operator has to be able to trust.
 */
export const MSG = {
  saveFailed: "Salvataggio non riuscito",
  createFailed: "Creazione non riuscita",
  deleteFailed: "Eliminazione non riuscita",
  updateFailed: "Aggiornamento non riuscito",
  removeFailed: "Rimozione non riuscita",
  loadFailed: "Caricamento non riuscito",
  /** The request never reached the panel, as opposed to the panel refusing it. */
  unreachable: "Impossibile raggiungere il pannello",
} as const;
