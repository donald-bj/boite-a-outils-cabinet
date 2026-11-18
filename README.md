# PDF vers Excel

Récupérez le tableau d'un PDF dans un fichier Excel, **sans ressaisie et sans que le document quitte votre ordinateur**.

L'outil lit le texte du PDF, retrouve les colonnes du tableau et produit un classeur `.xlsx`, une feuille par page.

Il répond à un besoin précis du cabinet : convertir un document localement plutôt que de l'envoyer à un modèle de langage, ce qui évite une consommation de jetons inutile et garde le document sur le poste.

---

## Pourquoi tout se passe dans le navigateur

Un cabinet d'expertise comptable est tenu au secret professionnel, et les dossiers de fusions-acquisitions sont couverts par des accords de confidentialité. Un convertisseur qui téléverserait les fichiers sur un serveur tiers serait inutilisable sur un vrai dossier.

Ici, **aucun fichier ne part sur le réseau** : le PDF est lu par `pdf.js` et le classeur écrit par `SheetJS`, tous deux dans le navigateur. Il n'y a ni serveur, ni base de données, ni clé d'API, ni cookie, ni mesure d'audience. Seules les deux bibliothèques se téléchargent au chargement de la page.

---

## Sécurité

| Mesure | Ce qu'elle empêche |
| --- | --- |
| `Content-Security-Policy` avec `default-src 'none'` | Tout chargement non explicitement autorisé |
| `connect-src` limité à un seul domaine | Qu'un script envoie un fichier vers un serveur quelconque |
| `form-action 'none'` | Toute soumission de formulaire |
| `object-src 'none'` et `base-uri 'none'` | L'injection de contenu par greffon ou par changement de base |
| Bibliothèques figées à une version exacte | Qu'une mise à jour non relue change le comportement |
| `.gitignore` excluant PDF et classeurs | La publication accidentelle d'un document |

**Deux limites.** Publier ce dépôt rend le *code* public, ce qui est voulu : il ne contient rien de confidentiel. Et **aucun fichier de travail ne doit entrer dans le dépôt**.

---

## Installation

Aucune installation côté utilisateur : il suffit d'ouvrir la page.

### Essayer en local

Un double-clic sur `index.html` ne suffit pas : les modules JavaScript exigent un vrai serveur.

```bash
# Windows
python -m http.server 8000

# macOS ou Linux
python3 -m http.server 8000
```

Puis ouvrir **http://localhost:8000**. Laissez la fenêtre du terminal ouverte : le serveur tourne tant qu'elle l'est.

### Publier sur GitHub Pages

Déposer les fichiers sur la branche `main`, puis **Settings → Pages → Deploy from a branch → `main` / `(root)`**. Cela demande un dépôt public : sur un dépôt privé, GitHub Pages exige un abonnement payant.

---

## Tests

```bash
npm test
```

29 tests couvrent l'extraction : regroupement des fragments en lignes, détection des colonnes, cellules manquantes, libellés coupés en deux lignes, colonnes parasites, conversion des montants, et contraintes d'Excel sur les noms de feuilles.

Ces tests ont déjà servi deux fois :
- ils ont révélé que « Raison sociale », rendu par `pdf.js` en deux fragments, était découpé en deux colonnes ;
- ils ont encadré la correction des libellés sur plusieurs lignes, qui éclataient un enregistrement sur trois lignes du tableau.

---

## Architecture

```
index.html                   page unique, politique de sécurité, structure
assets/style.css             mise en forme
assets/app.js                interface : dépôt du fichier, pilotage, export
assets/extraction-pdf.js     fonctions pures d'extraction (testées)
tests/extraction-pdf.test.js 21 tests
```

Les fonctions d'extraction sont isolées dans leur propre fichier parce qu'elles ne touchent ni au DOM ni au réseau : c'est ce qui les rend testables.

### Comment la conversion fonctionne

`pdf.js` ne rend pas des lignes de tableau, mais des fragments de texte, chacun avec sa position. L'outil procède en cinq temps :

1. **Regrouper en lignes.** Deux fragments dont les ordonnées diffèrent de moins de 3 points sont sur la même ligne.
2. **Trouver les colonnes.** Une colonne commence là où un fragment démarre après un blanc d'au moins 8 points. Les débuts distants de moins de 12 points sont fusionnés.
3. **Remplir le tableau.** Chaque fragment va dans la dernière colonne qui commence avant lui. Une cellule sans fragment reste vide, ce qui évite de décaler la ligne.
4. **Recoller les libellés sur plusieurs lignes.** Une ligne qui n'a qu'une cellule remplie, hors première colonne, est rendue à la ligne principale voisine dont cette place est libre, si elle est à portée verticale. Sans cette double condition, une ligne de totaux située plus bas serait avalée par le dernier enregistrement.
5. **Convertir les montants en nombres.** Un classeur dont toutes les cellules sont du texte ne permet aucune somme. La conversion est volontairement prudente : elle reconnaît la virgule décimale, les espaces de milliers, le signe moins avant ou après, les parenthèses comptables et le pourcentage, mais elle renonce dès qu'une écriture se lit de deux façons. « 1.234 » vaut mille deux cent trente-quatre en convention française et un virgule deux trois quatre en convention anglaise : la cellule reste du texte. Un identifiant à zéros initiaux comme « 000031 » reste du texte lui aussi, de même qu'un nombre de plus de quinze chiffres, qui perdrait de la précision. Réglage « Montants », activé par défaut.
6. **Absorber les colonnes parasites.** Une colonne qui ne sert qu'à une seule ligne, souvent celle des totaux, est reversée dans sa voisine de gauche : sans cela, deux pages d'un même tableau n'ont pas le même nombre de colonnes.

---

## Bibliothèques utilisées

| Bibliothèque | Version | Rôle | Licence |
| --- | --- | --- | --- |
| `pdf.js` | 3.11.174 | Lit le texte et les positions d'un PDF | Apache 2.0 |
| `SheetJS` | 0.18.5 | Écrit le fichier `.xlsx` | Apache 2.0 |

---

## Limites connues

- **Un PDF scanné ne donne rien.** Il ne contient qu'une image. L'outil le signale page par page au lieu de rendre un classeur vide sans explication.
- **Un tableau en image sur une page qui contient aussi du texte** n'est pas converti. L'outil nomme la page concernée, pour qu'on ne croie pas avoir tout récupéré.
- **Deux tableaux côte à côte** ressortent mélangés sur les mêmes lignes : l'extraction raisonne ligne par ligne, et deux cellules à la même hauteur sont sur la même ligne. Les données sont exactes, mais les colonnes sont à séparer dans Excel.
- **Les en-têtes et pieds de page** du document se retrouvent dans le classeur. Les filtrer automatiquement ferait courir le risque de supprimer une vraie ligne.
- **Les tableaux à cellules fusionnées sur plusieurs colonnes** sortent imparfaitement : l'algorithme raisonne ligne par ligne.
- **Les dates restent du texte.** « 04/05/26 » se lit 4 mai ou 5 avril selon la convention du logiciel qui a produit le document. Les convertir reviendrait à deviner.
- **Les catégories groupées ne sont pas recopiées.** Quand « Audit » couvre trois lignes dans le PDF, il n'apparaît que sur une ligne du classeur. Recopier une valeur dans des cellules vides, c'est écrire une donnée qui ne figure pas dans la source.
- **L'outil ne contrôle rien.** Une date impossible, un doublon ou un total faux sont reproduits tels quels. Repérer ces anomalies demande de savoir quelle colonne est une date et laquelle est un total : c'est le travail du comptable, pas celui d'un convertisseur.
- **Vérifiez toujours l'aperçu** avant de télécharger.

---

## Avant de s'en servir sur un dossier réel

La charte d'usage de l'IA du cabinet s'applique : tout nouvel outil passe par la validation écrite d'un associé, même lorsqu'il ne transmet aucune donnée, comme ici. Le classeur obtenu suit les mêmes règles que le document d'origine.

---

## Licence

MIT.
