/* ---------------------------------------------------------------
   Tests de l'extraction PDF.
   Lancer avec :  node --test tests/
   --------------------------------------------------------------- */

import test from "node:test";
import assert from "node:assert/strict";

import {
  regrouperEnLignes,
  deduireColonnes,
  construireTableau,
  nomDeFeuille,
  fusionnerLignesDeSuite,
  supprimerColonnesVides,
  absorberColonnesRares,
  convertirEnNombre,
  convertirLesMontants,
} from "../assets/extraction-pdf.js";

/**
 * Fabrique un fragment au format que pdf.js renvoie réellement :
 * transform = [échelleX, 0, 0, échelleY, x, y].
 */
function fragment(texte, x, y, largeur = 40) {
  return { str: texte, transform: [10, 0, 0, 10, x, y], width: largeur };
}

/* --- regrouperEnLignes --- */

test("regroupe les fragments de même hauteur sur une seule ligne", () => {
  const lignes = regrouperEnLignes([
    fragment("Client", 50, 700),
    fragment("Montant", 300, 700),
    fragment("Date", 450, 700),
  ]);

  assert.equal(lignes.length, 1);
  assert.deepEqual(lignes[0].map((f) => f.texte), ["Client", "Montant", "Date"]);
});

test("sépare deux hauteurs différentes et garde l'ordre de lecture", () => {
  const lignes = regrouperEnLignes([
    fragment("deuxième", 50, 680),
    fragment("première", 50, 700),
  ]);

  assert.equal(lignes.length, 2);
  assert.equal(lignes[0][0].texte, "première"); // le plus haut d'abord
  assert.equal(lignes[1][0].texte, "deuxième");
});

test("tolère un léger décalage vertical dans une même ligne", () => {
  // Un exposant ou une police différente décale le fragment de 2 points.
  const lignes = regrouperEnLignes([fragment("Total", 50, 700), fragment("HT", 120, 698)]);
  assert.equal(lignes.length, 1);
});

test("ignore les fragments vides ou faits d'espaces", () => {
  const lignes = regrouperEnLignes([fragment("Client", 50, 700), fragment("   ", 200, 700)]);
  assert.equal(lignes[0].length, 1);
});

test("rend une liste vide quand la page n'a aucun texte", () => {
  assert.deepEqual(regrouperEnLignes([]), []);
});

/* --- deduireColonnes --- */

test("déduit une abscisse par colonne, pas une par fragment", () => {
  const lignes = regrouperEnLignes([
    fragment("Client", 50, 700),
    fragment("Montant", 300, 700),
    fragment("Dupont", 50, 680),
    fragment("1 200", 300, 680),
    fragment("Martin", 52, 660), // 2 points d'écart : même colonne
    fragment("980", 301, 660),
  ]);

  assert.deepEqual(deduireColonnes(lignes), [50, 300]);
});

/* --- construireTableau --- */

test("range un tableau de trois colonnes dans le bon ordre", () => {
  const lignes = regrouperEnLignes([
    fragment("Client", 50, 700),
    fragment("Montant", 300, 700),
    fragment("Date", 450, 700),
    fragment("Dupont", 50, 680),
    fragment("1 200", 300, 680),
    fragment("12/11/2026", 450, 680),
  ]);

  assert.deepEqual(construireTableau(lignes, "colonnes"), [
    ["Client", "Montant", "Date"],
    ["Dupont", "1 200", "12/11/2026"],
  ]);
});

test("laisse vide une cellule absente au lieu de décaler la ligne", () => {
  const lignes = regrouperEnLignes([
    fragment("Client", 50, 700),
    fragment("Montant", 300, 700),
    fragment("Date", 450, 700),
    fragment("Dupont", 50, 680),
    fragment("12/11/2026", 450, 680), // montant manquant
  ]);

  const tableau = construireTableau(lignes, "colonnes");
  assert.deepEqual(tableau[1], ["Dupont", "", "12/11/2026"]);
});

test("recolle dans une même cellule deux fragments d'un même libellé", () => {
  const lignes = regrouperEnLignes([
    fragment("Raison", 50, 700),
    fragment("sociale", 85, 700), // 35 points : sous la tolérance de colonne
    fragment("Montant", 300, 700),
  ]);

  assert.deepEqual(construireTableau(lignes, "colonnes"), [["Raison sociale", "Montant"]]);
});

test("le mode lignes met toute la ligne dans une seule cellule", () => {
  const lignes = regrouperEnLignes([
    fragment("Client", 50, 700),
    fragment("Montant", 300, 700),
  ]);

  assert.deepEqual(construireTableau(lignes, "lignes"), [["Client Montant"]]);
});

/* --- nomDeFeuille --- */

test("retire les caractères qu'Excel refuse dans un nom de feuille", () => {
  const nom = nomDeFeuille("Bilan [2026]/définitif", 2);
  assert.ok(!/[[\]:*?/\\]/.test(nom), "le nom contient encore un caractère interdit : " + nom);
  assert.ok(nom.endsWith(" p2"));
});

test("ne dépasse jamais les 31 caractères autorisés par Excel", () => {
  const nom = nomDeFeuille("Un nom de document vraiment beaucoup trop long pour Excel", 12);
  assert.ok(nom.length <= 31, "nom trop long : " + nom.length);
  assert.ok(nom.endsWith(" p12"));
});

test("remplace un nom vide par un libellé par défaut", () => {
  assert.equal(nomDeFeuille("", 1), "Page p1");
});

/* --- fusionnerLignesDeSuite --- */

test("recolle un libelle coupe en deux lignes autour de sa ligne principale", () => {
  const tableau = [
    ["", "Révision annuelle du dossier et contrôle", "", "", "", ""],
    ["00101", "", "1", "1 250,00", "20,00", "1 250,00"],
    ["", "des pièces justificatives", "", "", "", ""],
  ];
  assert.deepEqual(fusionnerLignesDeSuite(tableau), [
    ["00101", "Révision annuelle du dossier et contrôle des pièces justificatives", "1", "1 250,00", "20,00", "1 250,00"],
  ]);
});

test("recolle une mention ajoutee sous un libelle deja rempli", () => {
  const tableau = [
    ["", "", "", "Règlement client Équinoxe", "", ""],
    ["0007", "07/11/2026", "FAC-00007", "", "", "192,89"],
    ["", "", "", "Pièce justificative jointe", "", ""],
  ];
  assert.deepEqual(fusionnerLignesDeSuite(tableau)[0][3], "Règlement client Équinoxe Pièce justificative jointe");
});

test("ne touche pas a un tableau dont chaque ligne est complete", () => {
  const tableau = [["Client", "Montant"], ["Dupont", "1 200"], ["Martin", "980"]];
  assert.deepEqual(fusionnerLignesDeSuite(tableau), tableau);
});

test("une ligne a cellule unique en premiere colonne reste une ligne a part", () => {
  const tableau = [["Effectifs par équipe", "", ""], ["Audit", "12", "13"]];
  assert.equal(fusionnerLignesDeSuite(tableau).length, 2);
});

/* --- supprimerColonnesVides --- */

test("retire une colonne vide partout et conserve l'ordre", () => {
  const tableau = [["Ligne", "", "Débit"], ["0016", "", "312,32"]];
  assert.deepEqual(supprimerColonnesVides(tableau), [["Ligne", "Débit"], ["0016", "312,32"]]);
});

test("ne retire rien quand toutes les colonnes servent", () => {
  const tableau = [["a", "b"], ["c", ""], ["", "d"]];
  assert.deepEqual(supprimerColonnesVides(tableau), tableau);
});

/* --- absorberColonnesRares --- */

test("reverse dans sa voisine une colonne utilisee par une seule ligne", () => {
  const tableau = [
    ["Ligne", "Libellé", "", "Crédit"],
    ["0001", "Règlement", "", "113,27"],
    ["0002", "Règlement", "", "126,54"],
    ["0003", "Règlement", "", "139,81"],
    ["0004", "Règlement", "", "153,08"],
    ["TOTAL", "", "Crédit : 6 984,31 €", ""],
  ];
  const sortie = absorberColonnesRares(tableau);
  assert.equal(Math.max(...sortie.map((l) => l.length)), 3, "le tableau doit perdre une colonne");
  assert.equal(sortie[5][1], "Crédit : 6 984,31 €");
  assert.deepEqual(sortie[1], ["0001", "Règlement", "113,27"]);
});

test("laisse intact un petit tableau ou chaque colonne compte", () => {
  const tableau = [["Équipe", "Janvier"], ["Audit", "12"], ["Conseil", ""]];
  assert.deepEqual(absorberColonnesRares(tableau), tableau);
});

/* --- convertirEnNombre --- */

test("convertit les montants ecrits a la francaise", () => {
  assert.equal(convertirEnNombre("1 234 567,89").valeur, 1234567.89);
  assert.equal(convertirEnNombre("85,00").valeur, 85);
  assert.equal(convertirEnNombre("0,000125").valeur, 0.000125);
  assert.equal(convertirEnNombre("10").valeur, 10);
  assert.equal(convertirEnNombre("0,00").valeur, 0);
});

test("reconnait les trois facons d'ecrire un montant negatif", () => {
  assert.equal(convertirEnNombre("(250,00)").valeur, -250);
  assert.equal(convertirEnNombre("250,00-").valeur, -250);
  assert.equal(convertirEnNombre("\u22120,75").valeur, -0.75); // moins Unicode
});

test("ramene un pourcentage a sa valeur numerique et le signale", () => {
  const r = convertirEnNombre("12,50 %");
  assert.equal(r.valeur, 0.125);
  assert.equal(r.pourcentage, true);
});

test("laisse en texte un identifiant a zeros initiaux", () => {
  assert.equal(convertirEnNombre("000031"), null);
  assert.equal(convertirEnNombre("000000000000000019"), null);
});

test("laisse en texte ce qui se lit de deux facons", () => {
  assert.equal(convertirEnNombre("1.234"), null, "point : milliers ou décimale ?");
  assert.equal(convertirEnNombre("1\u2019234.50"), null, "apostrophe suisse");
});

test("laisse en texte ce qui n'est pas un montant", () => {
  for (const cas of ["01/10/2026", "1E10", "=SUM(A1:A2)", "\u2014", "illisible", "", "   ", "F26-0001"]) {
    assert.equal(convertirEnNombre(cas), null, "aurait dû rester du texte : " + cas);
  }
});

test("refuse un nombre trop long pour etre represente sans perte", () => {
  assert.equal(convertirEnNombre("123456789012345678"), null);
});

/* --- convertirLesMontants --- */

test("convertit un tableau entier et releve la position des pourcentages", () => {
  const { cellules, pourcentages } = convertirLesMontants([
    ["Dossier", "Montant", "Taux"],
    ["000031", "1 200,00", "20,00 %"],
  ]);
  assert.deepEqual(cellules, [["Dossier", "Montant", "Taux"], ["000031", 1200, 0.2]]);
  assert.deepEqual(pourcentages, [{ ligne: 1, colonne: 2 }]);
});
