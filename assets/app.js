/* ---------------------------------------------------------------
   PDF vers Excel — logique de l'interface.

   Tout se passe dans le navigateur : le PDF est lu par pdf.js et le
   classeur écrit par SheetJS. Aucun fichier n'est envoyé sur un réseau.
   --------------------------------------------------------------- */

import { regrouperEnLignes, construireTableau, nomDeFeuille, ordonneesDesLignes, fusionnerLignesDeSuite, absorberColonnesRares, convertirLesMontants } from "./extraction-pdf.js";

/* =============================================================
   Petits utilitaires communs
   ============================================================= */

const $ = (identifiant) => document.getElementById(identifiant);

/**
 * Affiche un message d'état sous un outil.
 * @param {HTMLElement} element paragraphe d'état
 * @param {string} message texte à montrer
 * @param {"normal"|"erreur"|"fini"} ton couleur du message
 */
function etat(element, message, ton = "normal") {
  element.textContent = message;
  element.dataset.ton = ton;
}

/**
 * Montre ou cache la jauge d'avancement, et règle sa largeur.
 * @param {HTMLElement} jauge conteneur de la jauge
 * @param {number|null} pourcentage 0 à 100, ou null pour cacher
 */
function avancement(jauge, pourcentage) {
  if (pourcentage === null) {
    jauge.hidden = true;
    return;
  }
  jauge.hidden = false;
  jauge.firstElementChild.style.width = Math.max(0, Math.min(100, pourcentage)) + "%";
}

/** Rend une taille d'octets lisible : 1 258 291 → "1,2 Mo". */
function tailleLisible(octets) {
  if (octets < 1024) return octets + " o";
  if (octets < 1024 * 1024) return (octets / 1024).toFixed(0) + " Ko";
  return (octets / (1024 * 1024)).toFixed(1).replace(".", ",") + " Mo";
}

/** Retire l'extension d'un nom de fichier, pour nommer le fichier produit. */
function sansExtension(nom) {
  return nom.replace(/\.[^.]+$/, "") || "document";
}

/**
 * Branche une zone de dépôt : clic, glisser-déposer, et touche Entrée.
 * @param {HTMLElement} zone l'étiquette qui sert de zone
 * @param {HTMLInputElement} champ le champ fichier caché
 * @param {(fichier: File) => void} quandChoisi appelé avec le fichier retenu
 */
function brancherDepot(zone, champ, quandChoisi) {
  champ.addEventListener("change", () => {
    if (champ.files && champ.files[0]) quandChoisi(champ.files[0]);
  });

  ["dragenter", "dragover"].forEach((nom) => {
    zone.addEventListener(nom, (e) => {
      e.preventDefault();
      zone.classList.add("survol");
    });
  });

  ["dragleave", "drop"].forEach((nom) => {
    zone.addEventListener(nom, (e) => {
      e.preventDefault();
      zone.classList.remove("survol");
    });
  });

  zone.addEventListener("drop", (e) => {
    const fichiers = e.dataTransfer && e.dataTransfer.files;
    if (fichiers && fichiers[0]) quandChoisi(fichiers[0]);
  });
}

/** Propose un fichier au téléchargement, sans passer par un serveur. */
function telecharger(contenu, nomFichier, typeMime) {
  const lien = document.createElement("a");
  const url = URL.createObjectURL(new Blob([contenu], { type: typeMime }));
  lien.href = url;
  lien.download = nomFichier;
  document.body.appendChild(lien);
  lien.click();
  document.body.removeChild(lien);
  // On libère la mémoire une fois le téléchargement lancé.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Marque la zone comme remplie et y affiche le nom du fichier choisi. */
function marquerDepot(zone, fichier) {
  zone.classList.add("rempli");
  zone.querySelector("b").textContent = fichier.name;
  zone.querySelector("small").textContent = tailleLisible(fichier.size) + " — cliquez pour changer de fichier";
}

/* =============================================================
   PDF vers Excel
   ============================================================= */

const pdf = {
  fichier: null,
  classeur: null,
};

const depotPdf = $("depot-pdf");
const champPdf = $("fichier-pdf");
const etatPdf = $("etat-pdf");
const jaugePdf = $("jauge-pdf");
const apercuPdf = $("apercu-pdf");
const boutonConvertir = $("lancer-pdf");
const boutonXlsx = $("telecharger-xlsx");

/** Construit un aperçu HTML des premières lignes extraites. */
function afficherApercu(tableau, titre) {
  apercuPdf.innerHTML = "";
  if (!tableau || tableau.length === 0) return;

  const table = document.createElement("table");
  const legende = document.createElement("caption");
  legende.textContent = titre;
  table.appendChild(legende);

  tableau.slice(0, 12).forEach((ligne, indexLigne) => {
    const tr = document.createElement("tr");
    ligne.slice(0, 8).forEach((cellule) => {
      const cases = document.createElement(indexLigne === 0 ? "th" : "td");
      cases.textContent = cellule;
      tr.appendChild(cases);
    });
    table.appendChild(tr);
  });

  apercuPdf.appendChild(table);
}

/**
 * Écrit un tableau dans une feuille du classeur, en donnant leur format
 * d'affichage aux pourcentages : sans cela, 12,50 % s'afficherait 0,125.
 *
 * @param {object} classeur le classeur SheetJS
 * @param {Array<Array>} cellules les valeurs, nombres et textes mêlés
 * @param {Array<{ligne: number, colonne: number}>} pourcentages leurs positions
 * @param {string} nom le nom de la feuille
 */
function ecrireFeuille(classeur, cellules, pourcentages, nom) {
  const feuille = window.XLSX.utils.aoa_to_sheet(cellules.length ? cellules : [[""]]);

  for (const position of pourcentages) {
    const adresse = window.XLSX.utils.encode_cell({ r: position.ligne, c: position.colonne });
    if (feuille[adresse]) feuille[adresse].z = "0,00 %";
  }

  window.XLSX.utils.book_append_sheet(classeur, feuille, nom);
}

/**
 * Dit si une page comporte une image.
 *
 * Une page peut contenir à la fois du texte, qui sera converti, et un tableau
 * en image, qui ne le sera pas. Sans avertissement, on croit avoir tout
 * récupéré. On lit la liste des opérations de dessin de la page et on y
 * cherche celles qui peignent une image.
 *
 * @param {object} page une page rendue par pdf.js
 * @returns {Promise<boolean>}
 */
async function pageContientUneImage(page) {
  try {
    const OPS = window.pdfjsLib.OPS;
    const peintures = [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject];
    const operations = await page.getOperatorList();
    return operations.fnArray.some((operation) => peintures.includes(operation));
  } catch {
    return false; // la détection est un confort : son échec ne doit rien casser
  }
}

brancherDepot(depotPdf, champPdf, (fichier) => {
  pdf.fichier = fichier;
  pdf.classeur = null;
  boutonConvertir.disabled = false;
  boutonXlsx.disabled = true;
  apercuPdf.innerHTML = "";
  marquerDepot(depotPdf, fichier);
  etat(etatPdf, "Fichier prêt. Cliquez sur Convertir.");
});

boutonConvertir.addEventListener("click", async () => {
  if (!pdf.fichier) return;

  if (typeof window.pdfjsLib === "undefined" || typeof window.XLSX === "undefined") {
    etat(etatPdf, "Les bibliothèques de lecture ne sont pas chargées. Vérifiez votre connexion et rechargez la page.", "erreur");
    return;
  }

  boutonConvertir.disabled = true;
  boutonXlsx.disabled = true;
  apercuPdf.innerHTML = "";
  etat(etatPdf, "Ouverture du document…");
  avancement(jaugePdf, 0);

  // pdf.js a besoin de savoir où trouver son propre worker.
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  try {
    const donnees = await pdf.fichier.arrayBuffer();
    const document_ = await window.pdfjsLib.getDocument({ data: donnees }).promise;

    const mode = $("mode-pdf").value;
    const enNombres = $("montants-pdf").value === "nombres";
    const feuillesSeparees = $("pages-pdf").value === "separees";
    const classeur = window.XLSX.utils.book_new();
    const base = sansExtension(pdf.fichier.name);

    const pagesSansTexte = [];
    const pagesAvecImage = [];
    let toutesLesLignes = [];
    let tousLesPourcentages = [];
    let premierTableau = null;
    let cellulesTotales = 0;
    let nombresTrouves = 0;

    for (let numero = 1; numero <= document_.numPages; numero++) {
      const page = await document_.getPage(numero);
      if (await pageContientUneImage(page)) pagesAvecImage.push(numero);
      const contenu = await page.getTextContent();
      const lignes = regrouperEnLignes(contenu.items);
      let tableau = construireTableau(lignes, mode);
      if (mode === "colonnes") {
        tableau = absorberColonnesRares(fusionnerLignesDeSuite(tableau, ordonneesDesLignes(lignes)));
      }
      if (tableau.length === 0) pagesSansTexte.push(numero);

      cellulesTotales += tableau.reduce((somme, ligne) => somme + ligne.filter(Boolean).length, 0);
      if (premierTableau === null && tableau.length > 0) premierTableau = tableau;

      // Les montants deviennent de vrais nombres, utilisables dans une somme.
      let cellules = tableau;
      let pourcentages = [];
      if (enNombres) {
        const converti = convertirLesMontants(tableau);
        cellules = converti.cellules;
        pourcentages = converti.pourcentages;
        nombresTrouves += cellules.reduce(
          (somme, ligne) => somme + ligne.filter((c) => typeof c === "number").length,
          0
        );
      }

      if (feuillesSeparees) {
        ecrireFeuille(classeur, cellules, pourcentages, nomDeFeuille(base, numero));
      } else {
        if (numero > 1) toutesLesLignes.push([]); // une ligne vide entre deux pages
        const decalage = toutesLesLignes.length;
        tousLesPourcentages = tousLesPourcentages.concat(
          pourcentages.map((p) => ({ ligne: p.ligne + decalage, colonne: p.colonne }))
        );
        toutesLesLignes = toutesLesLignes.concat(cellules);
      }

      avancement(jaugePdf, Math.round((numero / document_.numPages) * 100));
      etat(etatPdf, `Page ${numero} sur ${document_.numPages}…`);
    }

    if (!feuillesSeparees) {
      ecrireFeuille(classeur, toutesLesLignes, tousLesPourcentages, "Document");
    }

    pdf.classeur = classeur;
    avancement(jaugePdf, null);
    boutonConvertir.disabled = false;
    boutonXlsx.disabled = false;

    if (cellulesTotales === 0) {
      etat(etatPdf, "Aucun texte trouvé. Ce PDF est scanné : il contient des images, pas du texte. Il faut d'abord lui appliquer une reconnaissance de caractères.", "erreur");
      return;
    }

    afficherApercu(premierTableau, "Aperçu des premières lignes de la première page");

    // Un document mélange souvent du texte et des images. On nomme les pages
    // concernées au lieu de les laisser passer en silence : une page scannée
    // ressort vide, et un tableau en image n'est pas converti du tout.
    const avecImageEtTexte = pagesAvecImage.filter((n) => !pagesSansTexte.includes(n));
    const alertes = [];

    if (pagesSansTexte.length === 1) {
      alertes.push(`la page ${pagesSansTexte[0]} ne contient aucun texte et ressort vide`);
    } else if (pagesSansTexte.length > 1) {
      alertes.push(`les pages ${pagesSansTexte.join(", ")} ne contiennent aucun texte et ressortent vides`);
    }

    if (avecImageEtTexte.length === 1) {
      alertes.push(`la page ${avecImageEtTexte[0]} contient aussi une image, qui n'est pas convertie`);
    } else if (avecImageEtTexte.length > 1) {
      alertes.push(`les pages ${avecImageEtTexte.join(", ")} contiennent aussi des images, qui ne sont pas converties`);
    }

    if (alertes.length > 0) {
      etat(etatPdf, `Conversion terminée, mais attention : ${alertes.join(", et ")}. Un tableau en image doit être ressaisi, ou passé à la reconnaissance de caractères.`, "erreur");
    } else {
      const mention = enNombres ? `, dont ${nombresTrouves} montants convertis en nombres` : "";
      etat(etatPdf, `Conversion terminée : ${document_.numPages} page(s), ${cellulesTotales} cellules${mention}. Vérifiez l'aperçu avant de télécharger.`, "fini");
    }
  } catch (erreur) {
    avancement(jaugePdf, null);
    boutonConvertir.disabled = false;
    etat(etatPdf, "Ce PDF n'a pas pu être lu : " + erreur.message, "erreur");
  }
});

boutonXlsx.addEventListener("click", () => {
  if (!pdf.classeur) return;
  const nom = sansExtension(pdf.fichier.name) + ".xlsx";
  window.XLSX.writeFile(pdf.classeur, nom, { compression: true });
  etat(etatPdf, "Classeur téléchargé : " + nom, "fini");
});
