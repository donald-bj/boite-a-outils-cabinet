# Boîte à outils du cabinet

Deux conversions qui se font **entièrement dans le navigateur**, sans serveur et sans compte :

1. **Enregistrement vers texte** — transcrit un fichier audio (mp3, m4a, wav, ogg, opus, webm) avec le modèle Whisper, exécuté sur la machine de l'utilisateur.
2. **PDF vers Excel** — extrait le texte d'un PDF, détecte les colonnes et produit un classeur `.xlsx`, une feuille par page.

Le second outil répond à un besoin précis : convertir un document localement plutôt que de l'envoyer à un modèle de langage, ce qui évite une consommation de jetons inutile et garde le document sur le poste.

---

## Pourquoi tout se passe dans le navigateur

Un cabinet d'expertise comptable est tenu au secret professionnel, et les dossiers de fusions-acquisitions sont couverts par des accords de confidentialité. Un outil de conversion qui téléverserait les fichiers sur un serveur tiers serait inutilisable sur un vrai dossier.

Ici, aucun fichier ne part sur le réseau :

- l'audio est décodé par le navigateur lui-même (`AudioContext`) ;
- la transcription s'exécute dans un *worker*, sur le processeur de la machine ;
- le PDF est lu par `pdf.js` et le classeur écrit par `SheetJS`, tous deux côté client ;
- il n'y a ni serveur, ni base de données, ni clé d'API, ni cookie, ni mesure d'audience.

**La seule chose qui transite par le réseau** est le téléchargement du modèle de transcription depuis Hugging Face, au premier usage. Le modèle descend ; l'enregistrement ne monte jamais.

---

## Sécurité : ce qui a été mis en place

| Mesure | Où | Ce qu'elle empêche |
| --- | --- | --- |
| `Content-Security-Policy` avec `default-src 'none'` | balise `<meta>` de `index.html` | Tout chargement non explicitement autorisé |
| `connect-src` limité à trois domaines | idem | Qu'un script envoie un fichier vers un serveur quelconque |
| `form-action 'none'` | idem | Toute soumission de formulaire |
| `object-src 'none'` et `base-uri 'none'` | idem | L'injection de contenu par greffon ou par changement de base |
| `referrer: no-referrer` | balise `<meta>` | Que les domaines appelés sachent d'où vient la requête |
| Bibliothèques figées à une version exacte | `index.html` | Qu'une mise à jour non relue change le comportement du site |
| Aucun secret dans le dépôt | `.gitignore` | La publication accidentelle d'une clé ou d'un document |

**Deux limites à connaître.** D'abord, publier ce dépôt sur GitHub Pages rend le *code* public : c'est voulu, il n'y a rien de confidentiel dedans. Ensuite, et c'est le point important, **aucun fichier de travail ne doit être versé dans le dépôt** : `.gitignore` exclut déjà les formats audio, les PDF et les classeurs, mais la règle reste à respecter.

---

## Installation

Aucune installation côté utilisateur : il suffit d'ouvrir la page.

### Publier sur GitHub Pages

```bash
git clone https://github.com/<votre-compte>/<votre-depot>.git
cd <votre-depot>
# copier les fichiers de ce dossier, puis :
git add .
git commit -m "Ajoute la boîte à outils : transcription et PDF vers Excel"
git push origin main
```

Puis, dans le dépôt sur GitHub : **Settings → Pages → Source : Deploy from a branch → `main` / `(root)`**. La page est en ligne une à deux minutes plus tard.

### Essayer en local

Un simple double-clic sur `index.html` ne suffit pas : les modules JavaScript et le *worker* exigent un vrai serveur. Lancez-en un :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

---

## Tests

```bash
npm test
```

13 tests couvrent l'extraction PDF : regroupement des fragments en lignes, détection des colonnes, cellules manquantes, libellés coupés en deux fragments, et les contraintes d'Excel sur les noms de feuilles.

Ces tests ont déjà servi : ils ont révélé que « Raison sociale », rendu par `pdf.js` en deux fragments, était découpé en deux colonnes. La détection de colonnes a été corrigée pour n'ouvrir une colonne qu'après un blanc réel, mesuré à partir de la largeur du fragment précédent.

---

## Architecture

```
index.html                        page unique, politique de sécurité, structure
assets/style.css                  mise en forme
assets/app.js                     interface : dépôt de fichiers, audio, pilotage
assets/extraction-pdf.js          fonctions pures d'extraction (testées)
assets/transcription-worker.js    le modèle Whisper, dans un second fil d'exécution
tests/extraction-pdf.test.js      13 tests
```

Les fonctions d'extraction sont isolées dans leur propre fichier précisément parce qu'elles ne touchent ni au DOM ni au réseau : c'est ce qui les rend testables.

### Comment la détection de colonnes fonctionne

`pdf.js` ne rend pas des lignes de tableau, mais des fragments de texte, chacun avec sa position. L'algorithme procède en trois temps :

1. **Regrouper en lignes.** Deux fragments dont les ordonnées diffèrent de moins de 3 points sont sur la même ligne.
2. **Trouver les colonnes.** Une colonne commence là où un fragment démarre nettement après la fin du précédent, c'est-à-dire après un blanc d'au moins 8 points. Les débuts distants de moins de 12 points sont fusionnés : ils viennent de la même colonne.
3. **Remplir le tableau.** Chaque fragment va dans la dernière colonne qui commence avant lui. Une cellule sans fragment reste vide, ce qui évite de décaler toute la ligne.

---

## Bibliothèques utilisées

| Bibliothèque | Version | Rôle | Licence |
| --- | --- | --- | --- |
| `@xenova/transformers` | 2.17.2 | Exécute Whisper dans le navigateur | Apache 2.0 |
| `pdf.js` | 3.11.174 | Lit le texte et les positions d'un PDF | Apache 2.0 |
| `SheetJS` | 0.18.5 | Écrit le fichier `.xlsx` | Apache 2.0 |

---

## Limites connues

- **Un PDF scanné ne donne rien.** Il ne contient qu'une image, pas de texte. Il faut d'abord lui appliquer une reconnaissance de caractères.
- **Les tableaux à cellules fusionnées ou sur plusieurs lignes** sortent imparfaitement : l'algorithme raisonne ligne par ligne.
- **La transcription est une aide, pas un compte rendu.** Les noms propres, les montants et les sigles sont les premiers à être mal entendus. Il faut relire.
- **Le premier lancement est lent** : le modèle pèse de 40 à 250 Mo selon le choix. Il est ensuite gardé en cache par le navigateur.
- **La qualité dépend du modèle choisi.** Le modèle « rapide » suffit pour une note personnelle ; pour un entretien, le modèle « équilibré » est un minimum.

---

## Avant de s'en servir sur un dossier réel

1. **L'enregistrement d'une personne suppose son accord**, demandé avant l'entretien.
2. **La charte d'usage de l'IA du cabinet s'applique.** Tout nouvel outil passe par la validation écrite d'un associé, même lorsqu'il ne transmet aucune donnée, comme ici.
3. **Le fichier produit suit les mêmes règles que le document d'origine** : une transcription d'entretien client reste une donnée client.

---

## Licence

MIT.
