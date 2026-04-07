# Vocab App — Contexte projet

## Vue d'ensemble

Application web d'apprentissage de vocabulaire multilingue, single-file `index.html` hébergée sur GitHub Pages. L'utilisateur communique en **français**.

- **URL** : https://huellasenarena.github.io/vocab-app
- **Repo local** : `~/Desktop/vocab-app/`
- **Stack** : HTML/CSS/JS pur, GitHub Pages + GitHub Actions
- **Backend** : Google Sheets (pas de serveur)
- **IA** : Mistral AI (`mistral-large-latest`, température 0.2, streaming SSE)

---

## Configuration

### Google OAuth
- Client ID : `742808037031-61r1roac158e5ltrosgahkemc4r9e7n1.apps.googleusercontent.com`
- Scopes : `https://www.googleapis.com/auth/spreadsheets`
- Token stocké dans `localStorage` (`vocab_google_token`, `vocab_google_expiry`)
- Durée de vie : 1 heure (limite Google, non contournable sans serveur)

### Google Sheets
- Sheet ID : `1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc`
- Onglets : `English`, `Spanish`, `French`, `Greek`, `Progress`, `History`, `Session`
- Mots dans colonne B, timestamp en colonne A

#### Structure Progress (A:G)
```
A: Word | B: Language | C: Correct | D: Incorrect | E: LastPracticed | F: HintUsed | G: NextReview
```

#### Structure History (A:D)
```
A: Date | B: Word | C: Language | D: Result (✓ ou ✗)
```

#### Structure Session (A:B)
```
A: Date (YYYY-MM-DD) | B: NewWordsPracticed
```

### Mistral AI
- Modèle : `mistral-large-latest`
- Température : 0.2
- Streaming activé pour définitions et évaluations
- `callMistral()` pour appels non-streaming (QCM, mots liés, situation)
- `callMistralStream(prompt, onChunk)` pour streaming progressif
- Clé injectée via GitHub Actions secret `MISTRAL_API_KEY` (placeholder `__MISTRAL_API_KEY__`)

### Déploiement
```bash
git add index.html
git commit -m "description"
git push origin main
# GitHub Actions déploie automatiquement sur gh-pages
```

---

## Architecture de l'app

### Écrans
1. `screen-password` — mot de passe SHA-256
2. `screen-google` — connexion Google OAuth
3. `screen-lang` — sélection de langue
4. `screen-practice` — pratique principale
5. `screen-stats` — statistiques
6. `screen-history` — historique chronologique

### Modes de pratique
- **📅 Espacée** — révision espacée SM-2, limite 60 nouveaux/jour
- **🎯 Situation** — recall actif, mots ★★★ seulement
- **🎲 Libre** — tirage pondéré classique

---

## État global (variables JS clés)

```javascript
let allWords            = [];      // mots chargés depuis Sheets
let progressMap         = {};      // { word.toLowerCase(): { correct, incorrect, hintUsed, nextReview, rowIndex } }
let currentWords        = [];      // mots affichés actuellement
let previousWordsPool   = [];      // pool pour le slider (mémorise les mots vus)
let currentLang         = "";      // 'Spanish', 'French', etc.
let hintUsedWords       = new Set(); // mots avec hint demandé cette session
let practiceMode        = 'spaced';
let sessionFirstResult  = {};      // { word: bool } — premier résultat par session
let todayNewCount       = 0;       // nouveaux mots pratiqués aujourd'hui (depuis Session sheet)
let sessionNewPracticed = new Set();
const MAX_NEW_PER_DAY   = 60;
const definitionCache   = {};      // { "mot|lang": "HTML définition" }
```

---

## Règles de progression (mode espacé)

| Situation | Compteur | NextReview | Étoiles |
|-----------|----------|------------|---------|
| Nouveau + ✓ (avec ou sans hint) | −1 | +1 jour | inchangées |
| Nouveau + ✗ | inchangé | inchangé | inchangées |
| À réviser + ✓ sans hint | inchangé | SM-2 | +1 |
| À réviser + ✓ avec hint | inchangé | +1 jour | inchangées |
| À réviser + ✗ | inchangé | +1 jour | inchangées |
| 2ème+ tentative | ignoré | ignoré | ignoré |

### Calcul SM-2
```
net ≤ 0 : +1 jour
net = 1  : +1 jour
net = 2  : +6 jours
net = 3  : +14 jours
net = 4  : +30 jours
net = 5  : +60 jours
net ≥ 6  : +120 jours (max)
```

### Étoiles
- ☆☆☆ : net ≤ 0
- ★☆☆ : net = 1
- ★★☆ : net = 2
- ★★★ : net ≥ 3 (considéré maîtrisé)

---

## Fonctions Sheets clés

```javascript
loadWords(lang)           // charge allWords depuis onglet langue
loadProgress(lang)        // charge progressMap depuis Progress!A:G
loadTodayCount()          // charge todayNewCount depuis Session
saveTodayCount(n)         // sauvegarde compteur dans Session
saveProgressNew(word)     // nouveau ✓ → NextReview=demain, étoiles neutres
saveProgressReviewHint(w) // révision+hint → NextReview=demain
saveProgress(w, bool)     // SM-2 normal (révision sans hint)
saveHint(word)            // incrémente HintUsed dans Progress
saveHistory(word, bool)   // écrit dans onglet History
cleanOrphans(lang, rows)  // supprime lignes Progress dont le mot n'existe plus
```

---

## Prompts Mistral

### Évaluation (structure critique)
Deux BLOCS **indépendants** :
- **BLOC 1** — Verdict sur le(s) mot(s) cible(s) SEULEMENT. Erreurs grammaticales des autres parties ignorées.
- **BLOC 2** — Analyse linguistique complète (grammaire, registre, ponctuation, naturel). Entièrement indépendant du verdict.

Règles importantes dans le prompt :
- Mot absent du texte → ✗ automatique
- Si un seul mot est ✗ → verdict global ✗
- Period/semicolon/colon entre phrases = TOUJOURS correct, ne jamais signaler comme coma manquante
- Analyser UNIQUEMENT ce que l'apprenant a écrit, pas des variantes imaginaires
- Accepter formes archaïques, dialectales, littéraires

### Définition
4 sections naturelles dans la langue cible :
1. Définition
2. Registre
3. Collocations
4. Exemple en italique

### Situation (mode recall actif)
Génère une scène concrète **sans mentionner le mot**. Évaluation en 3 étapes internes.

### Tous les prompts répondent entièrement dans `feedbackLang` (la langue cible)

---

## Fonctionnalités importantes

### Cache définitions
`definitionCache["mot|lang"]` — évite les appels API répétés pour le même mot.

### Hint en mode espacé
- **Mots nouveaux** : hint disponible
- **Mots à réviser** : hint caché
- **Mix** : hint disponible mais dropdown filtré aux nouveaux seulement

### Alerte token Google
- Vérification toutes les 30 secondes
- Badge ⚠️ + bannière si < 5 minutes ou expiré
- `pendingSaveAfterReauth` mémorise la sauvegarde en attente

### Nettoyage orphelins Progress
Au chargement de chaque langue, `cleanOrphans()` vide les lignes Progress dont le mot n'existe plus dans l'onglet de langue.

### Slider multi-mots
`previousWordsPool` mémorise tous les mots vus dans la session. Réduire puis augmenter le slider réutilise les mots précédents.

### Historique chronologique
L'onglet `History` est un journal pur (une ligne par tentative). `Progress` garde les scores cumulés. Les deux sont lus en parallèle pour enrichir l'affichage historique.

---

## Problèmes connus / points d'attention

1. **Mistral hallucinations** : Parfois Mistral commente des formes que l'apprenant n'a pas écrites, ou choisit un seul sens d'un mot polysémique. Le prompt atténue ça mais ne l'élimine pas.

2. **max_tokens** : Actuellement 500. Avec 5 mots et une réponse longue, le texte peut être tronqué. Envisager 1000-1500 pour le mode multi-mots.

3. **Notice aide en français** : Le texte `"(aide utilisée — non comptabilisé dans les étoiles)"` est hardcodé en français dans le JS. À adapter selon `currentLang`.

4. **Token Google** : Expire après 1h. Sans serveur backend, impossible de faire un vrai refresh token. La bannière d'alerte est le meilleur compromis.

5. **Apps Script** : Un script séparé gère l'ajout de mots depuis le raccourci iPhone. Il vérifie les doublons. L'URL du déploiement Apps Script est séparée du code principal.

---

## Langues supportées

```javascript
const LANGS = [
  { key: 'English', flag: '🇬🇧', mistralName: 'English', feedbackLang: 'English' },
  { key: 'Spanish', flag: '🇪🇸', mistralName: 'Spanish', feedbackLang: 'Spanish' },
  { key: 'French',  flag: '🇫🇷', mistralName: 'French',  feedbackLang: 'French'  },
  { key: 'Greek',   flag: '🇬🇷', mistralName: 'Modern Greek', feedbackLang: 'Modern Greek' },
]
```

---

## Workflow de développement

1. Modifier `~/Desktop/vocab-app/index.html`
2. Tester localement (ouvrir dans Safari)
3. `git add index.html && git commit -m "..." && git push origin main`
4. GitHub Actions déploie en ~1 minute sur `gh-pages`

**Ne jamais modifier directement la branche `gh-pages`.**
