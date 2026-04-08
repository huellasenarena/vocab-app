# Vocab App — Contexte projet

## Vue d'ensemble

Application web d'apprentissage de vocabulaire multilingue, single-file `index.html` hébergée sur GitHub Pages. L'utilisateur communique en **français**.

- **URL** : https://huellasenarena.github.io/vocab-app
- **Repo local** : `~/Desktop/vocab-app/`
- **Stack** : HTML/CSS/JS pur, GitHub Pages + GitHub Actions
- **Backend** : Google Sheets via Cloudflare Worker (service account)
- **IA** : OpenAI `gpt-4.1`, température 0.2, streaming SSE

---

## Configuration

### Cloudflare Worker
- **URL** : `https://dark-brook-87cc.georg-dreym.workers.dev`
- Proxy pour **deux services** : OpenAI (route par défaut) et Google Sheets (route `/sheets`)
- Secrets configurés dans le dashboard Cloudflare :
  - `OPENAI_API_KEY` — clé OpenAI
  - `SA_JSON` — JSON complet du service account Google (contient `client_email` et `private_key`)
- Le Worker génère un JWT RS256 signé pour s'authentifier auprès de Google, avec cache du token (1h)

### Google Sheets (via service account)
- Sheet ID : `1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc`
- Partagé en **Éditeur** avec l'email du service account
- Onglets : `English`, `Spanish`, `French`, `Greek`, `Progress`, `History`, `Session`
- Mots dans colonne B, timestamp en colonne A
- Tous les appels Sheets passent par `sheetsApi(sheetPath, method, body)` → Worker

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

### OpenAI
- Modèle : `gpt-4.1` (non-reasoning — streaming immédiat, pas de phase de réflexion interne)
- Température : 0.2
- Streaming activé pour définitions et évaluations
- `callMistral(prompt, maxTokens)` pour appels non-streaming (QCM, mots liés, situation)
- `callMistralStream(prompt, onChunk, maxTokens)` pour streaming progressif
- Les appels passent tous par le Cloudflare Worker (pas d'Authorization header côté app)

### Déploiement
```bash
git add index.html
git commit -m "description"
git push origin main
# GitHub Actions déploie automatiquement sur gh-pages (~1 minute)
```

---

## Architecture de l'app

### Écrans
1. `screen-password` — mot de passe SHA-256
2. `screen-lang` — sélection de langue (plus d'écran Google OAuth)
3. `screen-practice` — pratique principale
4. `screen-stats` — statistiques
5. `screen-history` — historique chronologique

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
const definitionCache   = {};      // { "mot|lang": { html, ts } } — cache 24h
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
sheetsApi(sheetPath, method, body) // proxy via Cloudflare Worker — remplace tous les fetch directs
loadWords(lang)           // charge allWords depuis onglet langue
loadProgress(lang)        // charge progressMap depuis Progress!A:G
loadTodayCount()          // charge todayNewCount depuis Session
saveTodayCount(n)         // sauvegarde compteur dans Session
saveProgressNew(word)     // nouveau ✓ → NextReview=demain, étoiles neutres
saveProgressReviewHint(w) // révision+hint → NextReview=demain
saveProgress(w, bool)     // SM-2 normal (révision sans hint)
saveHint(word)            // incrémente HintUsed dans Progress
saveHistoryBatch(rows)    // écrit plusieurs lignes dans History en un seul appel
cleanOrphans(lang, rows)  // vide les lignes Progress dont le mot n'existe plus
```

---

## Prompts GPT-4.1

### Évaluation (structure critique)
Deux BLOCS **indépendants** :
- **BLOC 1** — Verdict sur le(s) mot(s) cible(s) SEULEMENT. Erreurs grammaticales des autres parties ignorées.
- **BLOC 2** — Analyse linguistique complète (grammaire, registre, ponctuation, naturel). Entièrement indépendant du verdict.

Règles importantes dans le prompt :
- Mot absent du texte → ✗ automatique
- Si un seul mot est ✗ → verdict global ✗
- Period/semicolon/colon entre phrases = TOUJOURS correct, ne jamais signaler comme virgule manquante
- Analyser UNIQUEMENT ce que l'apprenant a écrit, pas des variantes imaginaires
- Accepter formes archaïques, dialectales, littéraires
- CRITICAL FILTER RULE : items incertains ou corrects → silently dropped (ne pas les inclure du tout)
- Version améliorée : uniquement si verdict ✓, en italique, doit utiliser le mot cible exact

### Format de sortie évaluation
- `## Verdict` → ✓ ou ✗ + une phrase d'explication
- `## Analyse linguistique` → liste numérotée d'erreurs confirmées (ou "Aucune erreur")
- `## Version améliorée` → (seulement si ✓) réécriture enrichie en italique

### Définition
4 sections avec `##` headings dans la langue cible :
1. Définition
2. Registre
3. Collocations — format `• *expression* — explication`
4. Exemple en italique

### Situation (mode recall actif)
Génère une scène concrète **sans mentionner le mot**. Évaluation en 3 étapes internes.

### Tous les prompts répondent entièrement dans `feedbackLang` (la langue cible)

---

## Fonctionnalités importantes

### Cache définitions
`definitionCache["mot|lang"]` avec timestamp — valide 24h, évite les appels API répétés.

### renderMarkdown
Convertit `**gras**`, `*italique*`, `##` headings, `•` puces en HTML. Consomme les sauts de ligne après les headings pour éviter les espaces doubles. Limite à 2 `<br>` consécutifs max.

### stripVerdictLines
Supprime les lignes contenant uniquement ✓ ou ✗ du texte affiché (le label `feedbackLabel` les affiche déjà).

### Hint en mode espacé
- **Mots nouveaux** : hint disponible
- **Mots à réviser** : hint caché
- **Mix** : hint disponible mais dropdown filtré aux nouveaux seulement

### QCM
Généré par gpt-4.1 avec distracteurs difficiles (mots sémantiquement proches). Mélangé côté JS (Fisher-Yates) pour que la bonne réponse ne soit pas toujours en première position.

### Nettoyage orphelins Progress
Au chargement de chaque langue, `cleanOrphans()` vide les lignes Progress dont le mot n'existe plus dans l'onglet de langue.

### Slider multi-mots
`previousWordsPool` mémorise tous les mots vus dans la session. Réduire puis augmenter le slider réutilise les mots précédents.

### Historique chronologique
L'onglet `History` est un journal pur (une ligne par tentative). `Progress` garde les scores cumulés. Les deux sont lus en parallèle pour enrichir l'affichage historique.

---

## Problèmes connus / points d'attention

1. **gpt-4.1 hallucinations** : Rares mais possibles. Les prompts ont des garde-fous (CRITICAL FILTER RULE, B2-STEP 2, etc.) mais ne sont pas infaillibles.

2. **Apps Script** : Un script séparé gère l'ajout de mots depuis le raccourci iPhone. Il vérifie les doublons. L'URL du déploiement Apps Script est séparée du code principal.

3. **Cloudflare Worker cold start** : Première requête après une longue inactivité peut être légèrement plus lente (~100-200ms). Normal.

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
