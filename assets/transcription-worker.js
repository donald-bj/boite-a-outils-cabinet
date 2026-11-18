/* ---------------------------------------------------------------
   Worker de transcription.

   Pourquoi un worker : la transcription occupe le processeur pendant
   plusieurs dizaines de secondes. Si elle tournait dans la page, celle-ci
   serait figée. Un worker est un second fil d'exécution : la page reste
   utilisable et reçoit les messages d'avancement.

   Le modèle Whisper s'exécute ici, dans le navigateur. L'enregistrement
   n'est donc envoyé à aucun serveur.

   Pourquoi un import dynamique et non « import ... from ... » en tête de
   fichier : dans un worker, un import statique vers un autre domaine échoue
   sans message exploitable. L'import dynamique, lui, se place dans un bloc
   try, ce qui permet d'afficher une vraie cause à l'utilisateur.
   --------------------------------------------------------------- */

const ADRESSE_BIBLIOTHEQUE = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

/** La bibliothèque, chargée une seule fois. */
let bibliotheque = null;

/** Les modèles déjà chargés, pour ne pas les retélécharger. */
const modelesCharges = new Map();

async function obtenirBibliotheque() {
  if (bibliotheque) return bibliotheque;
  try {
    const module = await import(ADRESSE_BIBLIOTHEQUE);
    module.env.allowLocalModels = false; // le modèle vient du dépôt public
    bibliotheque = module;
    return module;
  } catch (erreur) {
    throw new Error(
      "la bibliothèque de transcription n'a pas pu être chargée. Vérifiez votre connexion. Détail : " + erreur
    );
  }
}

/**
 * Charge le modèle demandé, ou le rend s'il est déjà en mémoire.
 * @param {string} nomModele par exemple "Xenova/whisper-base"
 */
async function obtenirModele(nomModele) {
  if (modelesCharges.has(nomModele)) return modelesCharges.get(nomModele);

  const { pipeline } = await obtenirBibliotheque();

  const chargement = pipeline("automatic-speech-recognition", nomModele, {
    quantized: true,
    progress_callback: (info) => {
      if (info.status === "progress" && typeof info.progress === "number") {
        self.postMessage({
          type: "progression",
          pourcentage: Math.round(info.progress),
          fichier: info.file || "",
        });
      }
    },
  });

  modelesCharges.set(nomModele, chargement);

  try {
    return await chargement;
  } catch (erreur) {
    modelesCharges.delete(nomModele); // un échec ne doit pas être mis en cache
    throw erreur;
  }
}

/**
 * Transcrit un signal audio déjà décodé.
 * @param {{audio: Float32Array, modele: string, langue: string, horodatage: boolean}} demande
 */
async function transcrire(demande) {
  const { audio, modele, langue, horodatage } = demande;

  self.postMessage({ type: "etape", message: "Préparation du modèle…" });
  const transcripteur = await obtenirModele(modele);

  self.postMessage({ type: "etape", message: "Transcription en cours…" });

  // chunk_length_s découpe l'audio en tranches de 30 secondes, la durée que
  // le modèle sait traiter. stride_length_s fait se chevaucher les tranches
  // de 5 secondes, pour qu'aucun mot ne soit coupé à la jointure.
  return await transcripteur(audio, {
    language: langue,
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: horodatage,
  });
}

self.addEventListener("message", async (evenement) => {
  const demande = evenement.data;
  if (!demande || demande.type !== "transcrire") return;

  try {
    const resultat = await transcrire(demande);
    self.postMessage({
      type: "resultat",
      texte: (resultat.text || "").trim(),
      segments: Array.isArray(resultat.chunks) ? resultat.chunks : [],
    });
  } catch (erreur) {
    self.postMessage({
      type: "erreur",
      message: erreur && erreur.message ? erreur.message : String(erreur),
    });
  }
});
