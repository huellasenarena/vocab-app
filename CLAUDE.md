# Vocab App — Contexte projet

## Vue d'ensemble

Application web d'apprentissage de vocabulaire multilingue, single-file `index.html` hébergée sur GitHub Pages. L'utilisateur communique en **français**.

- **URL** : https://huellasenarena.github.io/vocab-app
- **Repo local** : `~/Desktop/vocab-app/`
- **Stack** : HTML/CSS/JS pur, GitHub Pages + GitHub Actions
- **Backend** : Google Sheets via Cloudflare Worker (service account)
- **IA** : OpenAI `gpt-5.4` (défaut), Google `gemma-4-31b-it`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview` — sélectionnable dans ⚙️

---

## Configuration

### Cloudflare Worker
- **URL** : `https://dark-brook-87cc.georg-dreym.workers.dev`
- Proxy pour **quatre services** : OpenAI (route par défaut), Google Sheets (route `/sheets`), Unsplash (route `/unsplash`), Gemini (route `/gemini`)
- Secrets configurés dans le dashboard Cloudflare :
  - `OPENAI_API_KEY` — clé OpenAI
  - `SA_JSON` — JSON complet du service account Google (contient `client_email` et `private_key`)
  - `UNSPLASH_KEY` — clé API Unsplash (Access Key)
  - `GEMINI_KEY` — clé Google AI Studio (Gemini API)
  - `WORKER_SECRET` — secret partagé pour authentifier les requêtes depuis `index.html`
- Le Worker génère un JWT RS256 signé pour s'authentifier auprès de Google, avec cache du token (1h)
- La route `/unsplash` proxy les requêtes vers `https://api.unsplash.com/photos/random` en injectant `UNSPLASH_KEY`
- **Sécurité** : toutes les requêtes doivent inclure le header `X-Worker-Secret` — sinon rejet 403. La route `/sheets` valide que le `sheetPath` contient uniquement les Sheet IDs autorisés (`ALLOWED_SHEET_IDS`). Le proxy OpenAI est protégé par un `try/catch`.
- **Code Worker** : géré localement dans `~/Desktop/vocab-app/dark-brook-87cc/` (exclu du repo git via `.gitignore`). Déploiement via `wrangler deploy` depuis ce dossier. Ne jamais commiter ce dossier sur GitHub.
- **Wrangler** : outil CLI Cloudflare pour gérer le Worker. `wrangler deploy` pour déployer, `wrangler secret put NOM` pour ajouter un secret.

### Google Sheets (via service account)
- Sheet ID vocab : `1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc`
- Sheet ID formes grammaticales : `1xRaN0cp4gMHifiBVJ_f1S1Qbyn5krmzWYHJ5Kd6oqzs`
- Partagés en **Éditeur/Lecteur** avec l'email du service account
- Onglets vocab : `English`, `Spanish`, `French`, `Greek`, `Progress`, `History`, `Session`, `Tokens`
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

#### Structure Tokens (A:F)
```
A: Date (YYYY-MM-DD PT) | B: InputTokens | C: OutputTokens | D: GemmaRequests | E: GeminiFlashRequests | F: GeminiFlashLiteRequests
```
Une ligne par jour. Date en **heure du Pacifique** (reset Google à minuit PT) via `todayStrPT()`. Chargé au démarrage via `loadTodayTokens()`, mis à jour après chaque appel API. Header row 1 requis.

#### Structure formes grammaticales (sheet séparé)
- Onglet `Spanish` — row 1 = catégories (presente, pasado, futuro, subjuntivo, condicional, imperativo, misc.)
- Rows 2+ = formes spécifiques sous chaque catégorie
- Aplati en liste : `"${catégorie} ${forme}"` ex: `"futuro simple"`, `"subjuntivo imperfecto"`

### Modèles IA

Sélectionnable dans ⚙️, persisté en `localStorage` (`vocab_model`). Variable `currentModel` : `'gpt4'` | `'gemma'` | `'geminiflash'` | `'geminiflashlite'`.

#### GPT-5.4 (OpenAI)
- Reasoning model, `reasoning: { effort: 'low' }`, pas de `temperature`
- Utilise la **Responses API** (`/v1/responses`) — body : `input` (au lieu de `messages`), `max_output_tokens` (au lieu de `max_tokens`)
- Réponse non-streaming : `data.output_text` ; streaming SSE : event `response.output_text.delta` → `parsed.delta`, usage dans `response.done`
- **IMPORTANT** : `max_output_tokens` compte reasoning + texte ensemble. Avec `effort: 'low'`, ~1024 tokens de reasoning sont consommés avant tout texte → budget minimum 2000 pour avoir ~1000 tokens de texte réel. En dessous, `output_text` peut être `null`/`undefined` → erreur "Réponse vide".
- `callMistral` et `callAIVision` (non-streaming) : null check sur `data.output_text` avant `.trim()`, sinon throw "Réponse vide — réessaie"
- Vision : content types `input_text` / `input_image` (format Responses API)
- Appels via route par défaut du Worker (Authorization Bearer injectée par le Worker)
- `callMistral(prompt, maxTokens = 2000)` — non-streaming
- `callMistralStream(prompt, onChunk, maxTokens = 2000)` — streaming SSE
- `callMistralVision(imageUrl, prompt, maxTokens)` — vision, timeout 45s
- **Note** : noms `callMistral*` conservés par héritage historique

#### Gemma 4 31B (`gemma`)
- Reasoning model (thinking tokens) — quota gratuit : **1500 req/jour** (reset minuit PT)
- Route Worker `/gemini`, clé `GEMINI_KEY`, model ID : `gemma-4-31b-it`
- Worker : `thinkingConfig: { thinkingLevel: 'MINIMAL' }` pour limiter le temps de reasoning
- Worker : filtre les chunks `thought: true` du stream SSE et des parts non-streaming — seule la réponse finale est envoyée au client
- Supporte la vision (mode Imagen)
- `maxOutputTokens` default : 1000 (non-streaming), 1500 (streaming)

#### Gemini 3.1 Flash Lite (`geminiflashlite`)
- Non-reasoning, quota gratuit : **500 req/jour** (reset minuit PT)
- Route Worker `/gemini`, clé `GEMINI_KEY`, model ID : `gemini-3.1-flash-lite-preview`

#### Gemini 3 Flash (`geminiflash`)
- Non-reasoning, quota gratuit : **20 req/jour** (reset minuit PT)
- Route Worker `/gemini`, clé `GEMINI_KEY`, model ID : `gemini-3-flash-preview`

#### Wrappers modèle-agnostiques
- `callAI(prompt, maxTokens)` → dispatch selon `currentModel`
- `callAIStream(prompt, onChunk, maxTokens)` → idem
- `callAIVision(imageUrl, prompt, maxTokens)` → idem
- `isGemini()` → true si `currentModel` est `'gemma'`, `'geminiflash'` ou `'geminiflashlite'`
- `geminiModelId()` → retourne l'ID exact du modèle Gemini actif depuis `GEMINI_MODEL_IDS`
- Le nom du modèle est envoyé au Worker via `geminiModel` dans le body — le Worker l'utilise dynamiquement

#### Compteur tokens/requêtes
- GPT : `todayInputTokens` + `todayOutputTokens` → affiché `X tokens`
- Gemma : `todayGemmaRequests` → affiché `X / 1500 req`
- Gemini Flash : `todayGeminiFlashRequests` → affiché `X / 20 req`
- Gemini Flash Lite : `todayGeminiFlashLiteRequests` → affiché `X / 500 req`
- `trackTokens(usage)` pour GPT, `trackGeminiRequest()` pour Google (s'auto-route selon `currentModel`)
- Les deux appellent `saveTodayTokensDebounced()` (debounce 2s) — pas `saveTodayTokens()` directement — pour éviter la race condition read-modify-write quand deux appels API se terminent quasi-simultanément

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
2. `screen-lang` — sélection de langue
3. `screen-practice` — pratique principale
4. `screen-stats` — statistiques
5. `screen-history` — historique chronologique

### Modes de pratique
- **📅 Espacée** — révision espacée SM-2, limite 60 nouveaux/jour
- **🎯 Situation** — recall actif, mots ★★★ seulement
- **🎲 Libre** — tirage pondéré classique. Affiche `X mots à pratiquer (N au total)` où N = `allWords.length`
- **📸 Imagen** — description de photo aléatoire (Unsplash via Worker) en espagnol, analysée par le modèle actif via `callAIVision`. Indépendant de la liste de mots.

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
let grammarForms        = [];      // formes grammaticales espagnoles aplaties
let grammarFormsEnabled = ...;     // toggle localStorage KEY_GRAMMAR
let maxNewPerDay        = 60;      // configurable via réglages ⚙️, localStorage KEY_MAX_NEW (5–100)
let jeNeSaisPasWord     = null;    // mot en attente de confirmation "Je ne sais pas"
let todayInputTokens             = 0;  // tokens input GPT aujourd'hui
let todayOutputTokens            = 0;  // tokens output GPT aujourd'hui
let todayGemmaRequests           = 0;  // requêtes Gemma 4 31B aujourd'hui
let todayGeminiFlashRequests     = 0;  // requêtes Gemini 3 Flash aujourd'hui
let todayGeminiFlashLiteRequests = 0;  // requêtes Gemini 3.1 Flash Lite aujourd'hui
let currentModel        = 'gpt4';  // 'gpt4' | 'gemma' | 'geminiflash' | 'geminiflashlite'
let showTokenCounter    = true;    // toggle localStorage KEY_SHOW_TOKENS
let currentPhotoUrl     = '';      // URL complète de la photo en cours (mode Imagen)
let imageTheme          = '';      // thème Unsplash en cours, localStorage KEY_IMAGE_THEME
const definitionCache   = {};      // { "mot|lang|model": { html, ts } } — cache 24h par modèle
const GRAMMAR_SHEET_ID  = "1xRaN0cp4gMHifiBVJ_f1S1Qbyn5krmzWYHJ5Kd6oqzs";
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
| "Je ne sais pas" | inchangé | +1 jour | inchangées (= ✗) |
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
loadTodayTokens()         // charge compteurs depuis Tokens!A:F (date PT)
saveTodayTokens()         // met à jour la ligne du jour dans Tokens (date PT) — NE PAS appeler directement
saveTodayTokensDebounced() // version debouncée (2s) — à utiliser à la place de saveTodayTokens()
trackTokens(usage)        // incrémente les compteurs GPT + appelle saveTodayTokensDebounced
trackGeminiRequest()      // incrémente le compteur du modèle Google actif + appelle saveTodayTokensDebounced
saveProgressNew(word)     // nouveau ✓ → NextReview=demain, étoiles neutres
saveProgressReviewHint(w) // révision+hint → NextReview=demain
saveProgress(w, bool)     // SM-2 normal (révision sans hint)
saveHint(word)            // incrémente HintUsed dans Progress
saveHistoryBatch(rows)    // écrit plusieurs lignes dans History en un seul appel
cleanOrphans(lang, rows)  // vide les lignes Progress dont le mot n'existe plus
loadGrammarForms()        // charge les formes grammaticales depuis le sheet séparé (Spanish seulement)
newPracticePhoto()        // async — appelle Worker /unsplash, met à jour currentPhotoUrl (mode Imagen)
analyzePhoto()            // soumet description + image à callAIVision, affiche dans feedback-box.image
addImageVocabWord(word, i) // ajoute un mot du Vocabulario sugerido à l'onglet Spanish de Sheets
todayStr()                // date YYYY-MM-DD UTC (Session)
todayStrPT()              // date YYYY-MM-DD heure Pacifique (Tokens Google)
```

---

## Prompts IA

### Évaluation (structure critique)
`evalMaxTokens` = `isGemini() ? 2000 + N*400 : 2000 + N*300` (N = nombre de mots). Budget GPT augmenté à 2000 minimum pour couvrir les ~1024 tokens de reasoning.


Deux BLOCS **indépendants** :
- **BLOC 1** — Verdict sur le(s) mot(s) cible(s) SEULEMENT. Erreurs grammaticales des autres parties ignorées.
- **BLOC 2** — Analyse linguistique complète (grammaire, registre, ponctuation, naturel). Entièrement indépendant du verdict.

Règles importantes dans le prompt :
- Mot absent du texte → ✗ automatique
- Si un seul mot est ✗ → verdict global ✗
- Period/semicolon/colon entre phrases = TOUJOURS correct, ne jamais signaler comme virgule manquante
- Analyser UNIQUEMENT ce que l'apprenant a écrit, pas des variantes imaginaires
- Accepter formes archaïques, dialectales, littéraires **et mots archaïques autonomes** (ex: vieux espagnol "desque", "maguer") — B1-STEP 2 les couvre explicitement
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

### QCM
4 scénarios courts (1-2 phrases) — 1 correct, 3 distracteurs plausibles. Le mot cible **ne doit pas apparaître** dans aucun des scénarios. Mélangé côté JS (Fisher-Yates).

### Situation (mode recall actif)
Génère une scène concrète **sans mentionner le mot**. Évaluation en 3 étapes internes.

### Mode Imagen — prompt vision
Prompt écrit en anglais, réponse en espagnol. Structure imposée :
- `## Precisión` — précision de la description vs image. Éléments corrects en **gras**, omissions notables. 2–4 phrases.
- `## Análisis lingüístico` — liste numérotée d'erreurs confirmées uniquement. Format : *forma incorrecta* → **forma correcta** — explication. CRITICAL FILTER. Si aucune erreur : "Sin errores detectados."
- `## Vocabulario sugerido` — JSON array 3–5 mots/expressions utiles pour décrire ce type d'image : `[{"word": "...", "note": "breve explicación en español"}]`

Convention `(?)` : si l'utilisateur écrit `(?)` pour marquer un mot inconnu, le prompt demande à l'IA d'identifier le mot voulu et de l'intégrer dans l'analyse linguistique.

Le JSON `## Vocabulario sugerido` est extrait côté JS (regex), retiré du texte principal, et rendu en chips avec bouton `＋` pour ajouter le mot à l'onglet Spanish. Fonction : `addImageVocabWord(word, btnIndex)`. Les mots déjà présents dans `allWords` sont filtrés avant affichage — les chips ne montrent que les mots nouveaux.

### Tous les prompts répondent entièrement dans `feedbackLang` (la langue cible)

---

## Fonctionnalités importantes

### Cache définitions
`definitionCache["mot|lang|model"]` avec timestamp — valide 24h, évite les appels API répétés. La clé inclut le modèle : changer de modèle puis ré-appuyer sur Définition recharge avec le nouveau modèle.

### Stream définition — gate `## ` (Gemma)
Gemma 4 génère parfois du texte de vérification avant la réponse. Le stream est gaté : les chunks sont supprimés silencieusement jusqu'au premier `## ` dans le texte accumulé. Le cache stocke aussi la version trimée. Transparent pour GPT-5.4 (commence directement par `## `).

### renderMarkdown
Convertit `**gras**`, `*italique*`, `##` headings, `•` puces en HTML. Les `##` headings deviennent `<br><strong class="md-h2">Heading</strong><br>`. Limite à 2 `<br>` consécutifs max. Supprime les `<br>` en tête du résultat.

La classe `md-h2` est utilisée pour styler différemment les headings selon le contexte :
- Dans `.feedback-box.image` : DM Mono, uppercase, couleur accent, border-bottom (style label)
- Dans `.feedback-box.correct/incorrect` : héritage couleur (vert/rouge), gras — comportement identique à l'ancien `<strong>`

### feedbackLabel
Élément DOM présent mais `display: none`. Le ✓/✗ du verdict apparaît uniquement dans la section `## Verdict` du texte rendu. Le `feedbackBox` reçoit la classe `correct`/`incorrect` pour la couleur. Les erreurs API s'affichent directement dans `feedbackText`.

### Feedback mode image
Le `feedbackBox` reçoit la classe `image` (au lieu de `correct`/`incorrect`) : fond `var(--surface)`, bordure `var(--border)`, couleur `var(--text)`. Autoscroll vers la boîte après réception de la réponse (non-streaming → `requestAnimationFrame` + `window.scrollTo`).

### stripVerdictLines
Supprime les lignes contenant uniquement ✓ ou ✗ du texte affiché (évite le doublon avec le ✓/✗ déjà présent dans la section Verdict).

### Bouton hint / "Je ne sais pas" (`updateHintButton`)
`updateHintButton()` centralise le label et la visibilité du bouton hint selon le contexte :
- **Mode espacé, mot nouveau** : "💡 Définition"
- **Mode espacé, mot à réviser (avant soumission)** : "🤔 Je ne sais pas ?"
- **Mode espacé, mix** : "💡 Définition / QCM"
- **Après soumission / autres modes** : "💡 Définition"

### "Je ne sais pas" (mots à réviser)
- Appuyer le bouton → panneau de confirmation inline (textarea bloqué)
- Confirmer → `saveProgress(word, false)` + `startQCM(word)`
- Annuler → retour normal
- En mode multi-mots : chips des mots à réviser affichées en doré, dropdown avec routing (new→définition, review→QCM)
- `jeNeSaisPasWord` stocke le mot en attente de confirmation

### QCM
- Proposé après ✗ ou via "Je ne sais pas"
- 4 scénarios sans le mot cible — identifie la situation correcte
- Auto-scroll vers la section QCM après rendu des choix
- QCM incorrect → `saveProgress(word, false)` supplémentaire
- Appel non-streaming via `callAI(prompt, 1000)` — hérite du défaut 2000 de `callMistral` pour GPT

### Formes grammaticales (Español uniquement)
- Chargées depuis `GRAMMAR_SHEET_ID`, onglet `Spanish`, au choix de la langue espagnole
- Aplaties : `"${catégorie} ${forme}"` — ex: `"futuro simple"`, `"subjuntivo pluscuamperfecto"`
- N formes aléatoires affichées en pills sous le prompt de phrase (N = nombre de mots du set)
- Mise à jour au changement du slider
- Toggle ⚙️ dans le header → panneau réglages → switch "Formes grammaticales (Español)"
- État persisté dans `localStorage` (clé `vocab_grammar_enabled`), activé par défaut
- Ignorées lors de la vérification — purement indicatives

### Compteur tokens
- Affiché sous le `<h1>Vocab</h1>` dans le header, police DM Mono
- GPT : `X tokens` | Gemma : `X / 1500 req` | Flash : `X / 20 req` | Flash Lite : `X / 500 req`
- Toggle dans le panneau ⚙️ : "Afficher compteur tokens", persisté en `localStorage` (clé `vocab_show_tokens`)
- Synchronisé dans Sheets onglet `Tokens` (multi-appareils)

### Bouton Vérifier inline (mobile)
- Le bouton Vérifier est intégré **dans** le textarea (coin bas-droit), style iMessage — toujours visible même clavier ouvert sur iPhone
- Structure HTML : `<div class="textarea-wrap">` contient le textarea + `<button class="btn-submit-inline" id="btn-submit">`
- CSS : `.textarea-wrap` en `position: relative`, bouton en `position: absolute; bottom: 0.6rem; right: 0.6rem`, rond (2.4rem), fond `var(--accent)`
- Textarea : `padding-bottom: 3.2rem; overflow: hidden` pour laisser l'espace visuel sans scrollbar
- `.textarea-wrap` a `-webkit-transform: translateZ(0)` pour forcer le clipping sur iOS Safari
- Icône : `↑` au repos, `<span class="spinner"></span>` pendant le chargement

### iOS — Status bar et safe area
- `viewport-fit=cover` dans le meta viewport → le contenu peut passer derrière la status bar
- Au chargement : `--safe-top: 50px` hardcodé sur iOS via `navigator.userAgent` (couvre Dynamic Island et notch)
- `body { padding-top: var(--safe-top, 0px) }` — espace initial sous la status bar
- **Rideau** : `html { background: #0f0f0f }` (couvre la safe area au niveau du `<html>`) + `<div id="status-curtain">` réel (`position: fixed; top: 0; height: var(--safe-top); background: var(--bg); z-index: 9999`) — remplace l'ancien `body::before` qui ne fonctionnait pas avec `body { display: flex }` sur iOS Safari

### iOS — Autoscroll au focus textarea
Au focus sur le textarea (`sentence-input`), le clavier iOS s'ouvre et la page doit scroller pour que le textarea soit visible juste au-dessus du clavier :
- On note `origHeight = visualViewport.height` au moment du focus
- On écoute `visualViewport resize` — mais on ignore les resize < 150px (barre URL Safari qui rétrécit) — on attend une réduction > 150px qui confirme l'ouverture du clavier
- Une fois confirmé : `gap = rect.bottom - vv.height + 12` → `window.scrollBy({ top: gap, behavior: 'smooth' })` — **toujours exécuté, même si gap négatif** (gap négatif = scroll vers le haut = le contenu descend = textarea se rapproche du clavier)
- Fallback setTimeout 800ms si le clavier était déjà ouvert

### Auto-scroll streaming (`startAutoScroll(box, spacer)`)
- `PAD_TOP = safeTop + 8` (58px sur iOS, 8px ailleurs) — s'arrête juste sous le rideau status bar
- `topTarget` calculé une seule fois (layout stable), avec `PAD_TOP`
- Suit le **bas** de la boîte chunk par chunk
- S'arrête quand le **haut** de la boîte atteint `PAD_TOP` du viewport (`stoppedAtTop = true`)
- Le scroll final post-streaming respecte `stoppedAtTop`
- Spacer agrandi dynamiquement si `bottomTarget > maxScrollY`
- Scroll interrompu si l'utilisateur scrolle manuellement (`wheel`/`touchmove`)
- Utilisé pour : définition (hintBox) et feedback vocab (feedbackBox, avec spacer)
- Mode Imagen : scroll simple non-streaming via `requestAnimationFrame` + `window.scrollTo` après réception

### Protection double soumission
`lastSubmittedSentence` — si même réponse qu'avant, shake + ignore. Remis à `null` en cas d'erreur API pour permettre de réessayer. Remis à `''` au changement de modèle pour permettre de re-vérifier avec le nouveau modèle.

### Protection "Autre mot" avec phrase non vérifiée
Au début de `nextWord()` : si le textarea est non vide **et** différent de `lastSubmittedSentence`, un `confirm()` natif demande confirmation. Couvre deux cas :
- Phrase écrite mais jamais vérifiée (`lastSubmittedSentence` est null)
- Phrase vérifiée puis modifiée sans re-vérifier

### Notice aide utilisée
Affichée **après** le streaming (peuplée synchrone après `scroller.cleanup()`, avant le `requestAnimationFrame` du scroll final). Précise les mots concernés :
`(ayuda utilizada: tapar, guiar — no contabilizado en las estrellas)`
Template `{words}` dans `hintNotice` de chaque langue. Vidée au début de chaque nouvelle soumission (`noCountNotice.textContent = ''`).

### Nettoyage orphelins Progress
Au chargement de chaque langue, `cleanOrphans()` vide les lignes Progress dont le mot n'existe plus dans l'onglet de langue.

### Slider multi-mots
`previousWordsPool` mémorise tous les mots vus dans la session. Réduire puis augmenter le slider réutilise les mots précédents. Le slider met aussi à jour les formes grammaticales.

### Historique chronologique
L'onglet `History` est un journal pur (une ligne par tentative). `Progress` garde les scores cumulés. Les deux sont lus en parallèle pour enrichir l'affichage historique.

---

## Problèmes connus / points d'attention

1. **gpt-5.4 hallucinations** : Rares mais possibles. Les prompts ont des garde-fous (CRITICAL FILTER RULE, B2-STEP 2, etc.) mais ne sont pas infaillibles.

2. **Apps Script** : Un script séparé (`doPost`) gère l'ajout de mots depuis le raccourci iPhone. L'URL du déploiement est séparée du code principal. Comportements :
   - Normalise le mot : supprime astérisques Markdown, point(s) final(aux), trim, **met en minuscules**
   - Doublon exact → bloqué, retourne `"Doublon : '…' existe déjà."`
   - Quasi-doublon (substring ou même mot après suppression d'article) → retourne `"SIMILAR:motExistant"` sauf si `force=true`
   - `force=true` en paramètre POST → bypass la vérification de similarité, ajoute directement
   - Le raccourci iPhone gère la réponse `SIMILAR:` : affiche une alerte de confirmation, puis rappelle avec `&force=true` si l'utilisateur confirme

3. **kindle_import.py** : Script Python d'import Kindle → Google Sheets. Utilise l'API Sheets v4 directement (OAuth2, `credentials.json` + `token.json`) — pas d'Apps Script. Lit `vocab.db` et `My Clippings.txt`. Logique de déduplication :
   - Doublons exacts → ignorés silencieusement
   - Similarité contre Sheets existants (substring ou même mot après suppression d'article) → question interactive, même logique que `areSimilar()` dans l'Apps Script
   - `deduplicate_clips()` : déduplication inter-clips (doublons partiels + SequenceMatcher ≥ 0.80)

4. **Cloudflare Worker cold start** : Première requête après une longue inactivité peut être légèrement plus lente (~100-200ms). Normal.

5. **Gemma 4 thinking** : `thinkingBudget: 0` et `thinkingLevel: 'NONE'` ne sont pas supportés. Les niveaux valides sont `'MINIMAL'` et `'HIGH'`. Le Worker filtre les parts `thought: true` côté stream et non-streaming pour ne jamais exposer les pensées au client.

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

### Modifier l'app (`index.html`)
1. Modifier `~/Desktop/vocab-app/index.html`
2. Tester localement (ouvrir dans Safari)
3. `git add index.html && git commit -m "..." && git push origin main`
4. GitHub Actions déploie en ~1 minute sur `gh-pages`

**Ne jamais modifier directement la branche `gh-pages`.**

### Modifier le Worker Cloudflare
1. Modifier `~/Desktop/vocab-app/dark-brook-87cc/src/worker.js`
2. `cd ~/Desktop/vocab-app/dark-brook-87cc && wrangler deploy`
3. Ne pas commiter ce dossier sur GitHub (`.gitignore`)

Pour ajouter/modifier un secret Cloudflare :
```bash
cd ~/Desktop/vocab-app/dark-brook-87cc && wrangler secret put NOM_SECRET
```

---

## Idées futures

### Authentification Google OAuth (non implémenté)
Remplacer le mot de passe SHA-256 actuel par Google OAuth. L'écran de connexion deviendrait un bouton "Se connecter avec Google" ; ensuite l'app fonctionnerait identiquement. Le Worker vérifierait le token Google au lieu du `WORKER_SECRET`, éliminant ainsi le secret visible dans le code source. La reconnexion serait automatique (token stocké en `localStorage`, refresh silencieux). Complexité estimée : ~20h. Non prioritaire pour une app mono-utilisateur perso.
