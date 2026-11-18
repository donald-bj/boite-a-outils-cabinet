/* ---------------------------------------------------------------
   Extraction du texte d'un PDF, rangé en lignes et en colonnes.

   Ce fichier ne touche ni au DOM ni au réseau : ce sont des fonctions
   pures, qui prennent des données et en rendent d'autres. C'est ce qui
   permet de les tester (voir tests/extraction-pdf.test.js).
   --------------------------------------------------------------- */

/**
 * Regroupe les fragments de texte d'une page en lignes.
 *
 * pdf.js ne rend pas des lignes mais des fragments, chacun avec sa position.
 * Deux fragments à la même hauteur appartiennent à la même ligne : on les
 * regroupe quand leurs ordonnées diffèrent de moins de la tolérance.
 *
 * @param {Array} fragments éléments renvoyés par getTextContent()
 * @param {number} tolerance écart vertical toléré, en points
 * @returns {Array<Array>} les lignes, chacune étant une liste de fragments
 */
export function regrouperEnLignes(fragments, tolerance = 3) {
  const utiles = fragments
    .filter((f) => f.str && f.str.trim().length > 0)
    .map((f) => ({
      texte: f.str.trim(),
      x: f.transform[4],
      y: f.transform[5],
      // pdf.js ne renseigne pas toujours la largeur : on l'estime alors
      // d'après le nombre de caractères et la taille de la police.
      largeur: f.width > 0 ? f.width : f.str.trim().length * Math.abs(f.transform[0]) * 0.5,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x); // de haut en bas, puis de gauche à droite

  const lignes = [];
  let ligneCourante = [];
  let hauteurCourante = null;

  for (const fragment of utiles) {
    if (hauteurCourante === null || Math.abs(fragment.y - hauteurCourante) <= tolerance) {
      ligneCourante.push(fragment);
      // On garde la hauteur du premier fragment de la ligne comme référence.
      if (hauteurCourante === null) hauteurCourante = fragment.y;
    } else {
      lignes.push(ligneCourante.sort((a, b) => a.x - b.x));
      ligneCourante = [fragment];
      hauteurCourante = fragment.y;
    }
  }

  if (ligneCourante.length > 0) lignes.push(ligneCourante.sort((a, b) => a.x - b.x));
  return lignes;
}

/**
 * Déduit les débuts de colonnes d'une page.
 *
 * Une colonne ne commence pas à chaque fragment : dans « Raison sociale »,
 * pdf.js peut rendre deux fragments collés l'un à l'autre, qui appartiennent
 * à la même cellule. Une colonne commence donc là où un fragment démarre
 * après un vrai blanc, c'est-à-dire nettement après la fin du précédent.
 * On relève ces débuts sur toute la page, puis on fusionne ceux qui sont
 * assez proches pour venir de la même colonne.
 *
 * @param {Array<Array>} lignes les lignes déjà regroupées
 * @param {number} tolerance écart toléré entre deux débuts de même colonne, en points
 * @param {number} ecartMinimum blanc minimal qui sépare deux colonnes, en points
 * @returns {Array<number>} les abscisses de début de colonne, croissantes
 */
export function deduireColonnes(lignes, tolerance = 12, ecartMinimum = 8) {
  const debuts = [];

  for (const ligne of lignes) {
    let finPrecedente = null;

    for (const fragment of ligne) {
      const nouvelleColonne = finPrecedente === null || fragment.x - finPrecedente > ecartMinimum;
      if (nouvelleColonne) debuts.push(fragment.x);

      const fin = fragment.x + fragment.largeur;
      finPrecedente = finPrecedente === null ? fin : Math.max(finPrecedente, fin);
    }
  }

  debuts.sort((a, b) => a - b);

  const colonnes = [];
  for (const x of debuts) {
    if (colonnes.length === 0 || x - colonnes[colonnes.length - 1] > tolerance) {
      colonnes.push(x);
    }
  }
  return colonnes;
}

/**
 * Transforme les lignes d'une page en tableau de cellules.
 * @param {Array<Array>} lignes lignes regroupées
 * @param {"colonnes"|"lignes"} mode découpage demandé
 * @returns {Array<Array<string>>} un tableau à deux dimensions
 */
export function construireTableau(lignes, mode) {
  if (mode === "lignes") {
    return lignes.map((ligne) => [ligne.map((f) => f.texte).join(" ")]);
  }

  const colonnes = deduireColonnes(lignes);

  return lignes.map((ligne) => {
    const cellules = new Array(colonnes.length).fill("");

    for (const fragment of ligne) {
      // On place le fragment dans la dernière colonne qui commence avant lui.
      let indice = 0;
      for (let c = 0; c < colonnes.length; c++) {
        if (fragment.x >= colonnes[c] - 2) indice = c;
        else break;
      }
      cellules[indice] = cellules[indice] ? cellules[indice] + " " + fragment.texte : fragment.texte;
    }

    return cellules;
  });
}

/**
 * Donne l'ordonnée de chaque ligne, pour savoir lesquelles se touchent.
 * @param {Array<Array>} lignes lignes regroupées
 * @returns {Array<number>} une ordonnée par ligne
 */
export function ordonneesDesLignes(lignes) {
  return lignes.map((ligne) => (ligne.length ? ligne[0].y : 0));
}

/**
 * Recolle les lignes de suite dans la ligne principale.
 *
 * Quand un libellé tient sur deux lignes, pdf.js rend chaque ligne séparément,
 * et les autres cellules de l'enregistrement, centrées verticalement, se
 * retrouvent entre les deux. Sans correction, un enregistrement occupe trois
 * lignes du tableau au lieu d'une.
 *
 * Une ligne de suite se reconnaît à ceci : une seule cellule remplie, et pas
 * dans la première colonne. Elle est recollée à la ligne principale qui, dans
 * cette même colonne, n'a rien (c'est bien la place laissée libre par le
 * libellé) et qui se trouve à portée verticale. Sans ces deux conditions, une
 * ligne de totaux située plus bas serait avalée par le dernier enregistrement.
 *
 * @param {Array<Array<string>>} tableau le tableau brut
 * @param {Array<number>|null} ordonnees l'ordonnée de chaque ligne, ou null
 * @param {number} ecartMaximum écart vertical toléré, en points
 * @returns {Array<Array<string>>} le tableau avec les libellés recollés
 */
export function fusionnerLignesDeSuite(tableau, ordonnees = null, ecartMaximum = 25) {
  if (tableau.length < 2) return tableau;

  const estSuite = (ligne) => {
    const remplies = ligne.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    return remplies.length === 1 && remplies[0] > 0;
  };

  const principales = tableau.map((l, i) => (estSuite(l) ? -1 : i)).filter((i) => i >= 0);
  if (principales.length === 0) return tableau;

  const resultat = tableau.map((ligne) => ligne.slice());
  const aSupprimer = new Set();

  tableau.forEach((ligne, i) => {
    if (!estSuite(ligne)) return;

    const colonne = ligne.findIndex((c) => c);

    // la place doit être libre dans la ligne principale, et celle-ci à portée
    const candidats = principales.filter((p) => {
      if (tableau[p][colonne]) return false;
      if (!ordonnees) return true;
      return Math.abs(ordonnees[i] - ordonnees[p]) <= ecartMaximum;
    });
    if (candidats.length === 0) return; // aucune ligne d'accueil : on la laisse telle quelle

    let cible = candidats[0];
    for (const p of candidats) {
      if (Math.abs(p - i) < Math.abs(cible - i)) cible = p;
    }

    const texte = ligne[colonne];
    const existant = resultat[cible][colonne];

    // au-dessus de la ligne principale, le texte vient en tête ; au-dessous, en queue
    resultat[cible][colonne] = !existant
      ? texte
      : i < cible
        ? texte + " " + existant
        : existant + " " + texte;

    aSupprimer.add(i);
  });

  return resultat.filter((_, i) => !aSupprimer.has(i));
}

/**
 * Convertit un montant écrit à la française en nombre, ou rend null.
 *
 * Le pari est volontairement prudent : on ne convertit que ce qui ne peut pas
 * se lire de deux façons. « 1.234 » vaut mille deux cent trente-quatre en
 * convention française et un virgule deux trois quatre en convention anglaise :
 * impossible de trancher, donc on laisse le texte. De même, « 000031 » est un
 * code de dossier, pas le nombre 31 : des zéros en tête signalent un
 * identifiant, jamais une somme.
 *
 * Sont reconnus : la virgule décimale, les espaces de milliers y compris
 * insécables, le signe moins placé avant ou après, le moins Unicode, les
 * parenthèses comptables, et le pourcentage.
 *
 * @param {string} texte le contenu brut d'une cellule
 * @returns {{valeur: number, pourcentage: boolean}|null} null si ce n'est pas un nombre sûr
 */
export function convertirEnNombre(texte) {
  if (typeof texte !== "string") return null;

  let reste = texte.trim();
  if (reste === "") return null;

  let negatif = false;

  // parenthèses comptables : (250,00) vaut moins 250
  if (/^\(.*\)$/.test(reste)) {
    negatif = true;
    reste = reste.slice(1, -1).trim();
  }

  // pourcentage : le signe peut être collé ou séparé
  const pourcentage = /%$/.test(reste);
  if (pourcentage) reste = reste.slice(0, -1).trim();

  // signe moins avant ou après, tiret ordinaire ou moins Unicode
  if (/^[-\u2212]/.test(reste)) { negatif = !negatif; reste = reste.slice(1).trim(); }
  if (/[-\u2212]$/.test(reste)) { negatif = !negatif; reste = reste.slice(0, -1).trim(); }

  // espaces de milliers : ordinaire, insécable, insécable étroit, fine
  reste = reste.replace(/[\s\u00a0\u202f\u2009]/g, "");

  // un point ou une apostrophe rend la lecture ambiguë : on renonce
  if (/[.\u2019']/.test(reste)) return null;

  if (!/^\d+(,\d+)?$/.test(reste)) return null;

  // des zéros en tête désignent un identifiant, pas une somme
  if (/^0\d/.test(reste)) return null;

  // au-delà de quinze chiffres, un nombre perdrait de la précision
  if (reste.replace(",", "").length > 15) return null;

  let valeur = Number(reste.replace(",", "."));
  if (!Number.isFinite(valeur)) return null;
  if (negatif) valeur = -valeur;
  if (pourcentage) valeur = valeur / 100;

  return { valeur, pourcentage };
}

/**
 * Remplace par des nombres les cellules qui en sont vraiment.
 * Les autres restent telles qu'elles figurent dans le document.
 *
 * @param {Array<Array<string>>} tableau
 * @returns {{cellules: Array<Array>, pourcentages: Array<{ligne: number, colonne: number}>}}
 */
export function convertirLesMontants(tableau) {
  const pourcentages = [];
  const cellules = tableau.map((ligne, i) =>
    ligne.map((cellule, j) => {
      const nombre = convertirEnNombre(cellule);
      if (!nombre) return cellule;
      if (nombre.pourcentage) pourcentages.push({ ligne: i, colonne: j });
      return nombre.valeur;
    })
  );
  return { cellules, pourcentages };
}

/**
 * Absorbe les colonnes qui ne servent qu'à une seule ligne.
 *
 * Une ligne de totaux ou un numéro de page crée souvent une colonne à elle
 * seule. Elle fausse la largeur du tableau, et deux pages d'un même tableau
 * se retrouvent alors avec un nombre de colonnes différent. Son contenu est
 * reversé dans la colonne de gauche.
 *
 * La règle ne s'applique qu'aux tableaux d'au moins quelques lignes : dans un
 * tableau de trois lignes, une colonne utilisée une fois est légitime.
 *
 * @param {Array<Array<string>>} tableau
 * @param {number} minimumLignes taille à partir de laquelle la règle s'applique
 * @returns {Array<Array<string>>}
 */
export function absorberColonnesRares(tableau, minimumLignes = 5) {
  if (tableau.length < minimumLignes) return tableau;

  const largeur = Math.max(...tableau.map((l) => l.length));
  const resultat = tableau.map((ligne) => {
    const copie = ligne.slice();
    while (copie.length < largeur) copie.push("");
    return copie;
  });

  // de droite à gauche, pour qu'une absorption ne décale pas les suivantes
  for (let c = largeur - 1; c >= 1; c--) {
    const lignesUtilisant = resultat.filter((ligne) => ligne[c]);
    if (lignesUtilisant.length !== 1) continue;

    for (const ligne of resultat) {
      if (!ligne[c]) continue;
      ligne[c - 1] = ligne[c - 1] ? ligne[c - 1] + " " + ligne[c] : ligne[c];
      ligne[c] = "";
    }
  }

  return supprimerColonnesVides(resultat);
}

/**
 * Supprime les colonnes qui ne contiennent rien.
 *
 * Une ligne de total ou un pied de page peut créer une colonne parasite,
 * vide partout ailleurs. La retirer évite que deux pages d'un même tableau
 * n'aient pas le même nombre de colonnes.
 *
 * @param {Array<Array<string>>} tableau
 * @returns {Array<Array<string>>}
 */
export function supprimerColonnesVides(tableau) {
  if (tableau.length === 0) return tableau;

  const largeur = Math.max(...tableau.map((l) => l.length));
  const utiles = [];
  for (let c = 0; c < largeur; c++) {
    if (tableau.some((ligne) => ligne[c])) utiles.push(c);
  }
  if (utiles.length === largeur) return tableau;

  return tableau.map((ligne) => utiles.map((c) => ligne[c] || ""));
}

/** Rend un nom de feuille acceptable par Excel : 31 caractères, sans []:*?/\ */
export function nomDeFeuille(base, numero) {
  const propre = base.replace(/[\[\]:*?/\\]/g, " ").trim();
  const suffixe = " p" + numero;
  return (propre.slice(0, 31 - suffixe.length) || "Page") + suffixe;
}
