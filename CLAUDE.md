# Vocab App — Contexte projet

## Vue d'ensemble

Application web d'apprentissage de vocabulaire multilingue, single-file `index.html` hébergée sur GitHub Pages. L'utilisateur communique en **français**.

- **URL** : https://huellasenarena.github.io/vocab-app
- **Repo local** : `~/Desktop/vocab-app/`
- **Stack** : HTML/CSS/JS pur, GitHub Pages + GitHub Actions
- **Backend** : Google Sheets via Cloudflare Worker (service account)
- **IA** : OpenAI `gpt-4.1` (défaut), Google `gemini-2.5-pro` ou `gemini-3-flash-preview` — sélectionnable dans ⚙️

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

#### Structure Tokens (A:E)
```
A: Date (YYYY-MM-DD) | B: InputTokens | C: OutputTokens | D: GeminiProRequests | E: GeminiFlashRequests
```
Une ligne par jour. Chargé au démarrage via `loadTodayTokens()`, mis à jour après chaque appel API via `trackTokens(usage)` (GPT) ou `trackGeminiRequest()` (Gemini). Header row 1 requis.

#### Structure formes grammaticales (sheet séparé)
- Onglet `Spanish` — row 1 = catégories (presente, pasado, futuro, subjuntivo, condicional, imperativo, misc.)
- Rows 2+ = formes spécifiques sous chaque catégorie
- Aplati en liste : `"${catégorie} ${forme}"` ex: `"futuro simple"`, `"subjuntivo imperfecto"`

### Modèles IA

Sélectionnable dans ⚙️, persisté en `localStorage` (`vocab_model`). Variable `currentModel` : `'gpt4'` | `'gemini'` | `'geminiflash'`.

#### GPT-4.1 (OpenAI)
- Non-reasoning, streaming immédiat, température 0.2
- Appels via route par défaut du Worker (Authorization Bearer injectée par le Worker)
- `callMistral(prompt, maxTokens)` — non-streaming
- `callMistralStream(prompt, onChunk, maxTokens)` — streaming SSE
- `callMistralVision(imageUrl, prompt, maxTokens)` — vision, timeout 45s
- **Note** : noms `callMistral*` conservés par héritage historique

#### Gemini 2.5 Pro
- Reasoning model, route Worker `/gemini`, clé `GEMINI_KEY`
- Quota gratuit : 100 req/jour (spending cap > $0 requis dans Google Cloud)
- `maxOutputTokens` default : 1000 (non-streaming), 1500 (streaming)

#### Gemini 3 Flash Preview
- Non-reasoning, route Worker `/gemini`, même clé `GEMINI_KEY`
- Quota gratuit : 20 req/jour
- Model ID : `gemini-3-flash-preview`

#### Wrappers modèle-agnostiques
- `callAI(prompt, maxTokens)` → dispatch selon `currentModel`
- `callAIStream(prompt, onChunk, maxTokens)` → idem
- `callAIVision(imageUrl, prompt, maxTokens)` → idem
- `isGemini()` → true si `currentModel` est `'gemini'` ou `'geminiflash'`
- `geminiModelId()` → retourne l'ID exact du modèle Gemini actif depuis `GEMINI_MODEL_IDS`
- Le nom du modèle est envoyé au Worker via `geminiModel` dans le body — le Worker l'utilise dynamiquement

#### Compteur tokens/requêtes
- GPT : `todayInputTokens` + `todayOutputTokens` → affiché `X tokens`
- Gemini Pro : `todayGeminiProRequests` → affiché `X / 100 req`
- Gemini Flash : `todayGeminiFlashRequests` → affiché `X / 20 req`
- `trackTokens(usage)` pour GPT, `trackGeminiRequest()` pour Gemini (s'auto-route selon `currentModel`)

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
let todayInputTokens         = 0;  // tokens input GPT aujourd'hui
let todayOutputTokens        = 0;  // tokens output GPT aujourd'hui
let todayGeminiProRequests   = 0;  // requêtes Gemini 2.5 Pro aujourd'hui
let todayGeminiFlashRequests = 0;  // requêtes Gemini 3 Flash aujourd'hui
let currentModel        = 'gpt4';  // 'gpt4' | 'gemini' | 'geminiflash', localStorage KEY_MODEL
let showTokenCounter    = true;    // toggle localStorage KEY_SHOW_TOKENS
let currentPhotoUrl     = '';      // URL complète de la photo en cours (mode Imagen)
let imageTheme          = '';      // thème Unsplash en cours, localStorage KEY_IMAGE_THEME
const definitionCache   = {};      // { "mot|lang": { html, ts } } — cache 24h
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
loadTodayTokens()         // charge todayInputTokens/todayOutputTokens depuis Tokens
saveTodayTokens()         // met à jour la ligne du jour dans Tokens (même pattern que saveTodayCount)
trackTokens(usage)        // incrémente les compteurs + appelle saveTodayTokens (fire-and-forget)
saveProgressNew(word)     // nouveau ✓ → NextReview=demain, étoiles neutres
saveProgressReviewHint(w) // révision+hint → NextReview=demain
saveProgress(w, bool)     // SM-2 normal (révision sans hint)
saveHint(word)            // incrémente HintUsed dans Progress
saveHistoryBatch(rows)    // écrit plusieurs lignes dans History en un seul appel
cleanOrphans(lang, rows)  // vide les lignes Progress dont le mot n'existe plus
loadGrammarForms()        // charge les formes grammaticales depuis le sheet séparé (Spanish seulement)
newPracticePhoto()        // async — appelle Worker /unsplash, met à jour currentPhotoUrl (mode Imagen)
analyzePhoto()            // soumet description + image à callMistralVision, affiche dans feedback-box.image
addImageVocabWord(word, i) // ajoute un mot du Vocabulario sugerido à l'onglet Spanish de Sheets
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
`definitionCache["mot|lang"]` avec timestamp — valide 24h, évite les appels API répétés.

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

### Formes grammaticales (Español uniquement)
- Chargées depuis `GRAMMAR_SHEET_ID`, onglet `Spanish`, au choix de la langue espagnole
- Aplaties : `"${catégorie} ${forme}"` — ex: `"futuro simple"`, `"subjuntivo pluscuamperfecto"`
- N formes aléatoires affichées en pills sous le prompt de phrase (N = nombre de mots du set)
- Mise à jour au changement du slider
- Toggle ⚙️ dans le header → panneau réglages → switch "Formes grammaticales (Español)"
- État persisté dans `localStorage` (clé `vocab_grammar_enabled`), activé par défaut
- Ignorées lors de la vérification — purement indicatives

### Compteur tokens
- Affiché sous le `<h1>Vocab</h1>` dans le header (`X tokens`), police DM Mono
- Affiche "0 tokens" dès que le toggle est actif, même si aucun appel API n'a été fait dans la journée
- Toggle dans le panneau ⚙️ : "Afficher compteur tokens", persisté en `localStorage` (clé `vocab_show_tokens`)
- Synchronisé dans Sheets onglet `Tokens` (multi-appareils) — même pattern que l'onglet `Session`
- `trackTokens(usage)` appelé automatiquement après chaque appel `callMistral`, `callMistralStream`, `callMistralVision`
- Pour le streaming, OpenAI envoie l'usage dans le dernier chunk SSE avant `[DONE]`

### Bouton Vérifier inline (mobile)
- Le bouton Vérifier est intégré **dans** le textarea (coin bas-droit), style iMessage — toujours visible même clavier ouvert sur iPhone
- Structure HTML : `<div class="textarea-wrap">` contient le textarea + `<button class="btn-submit-inline" id="btn-submit">`
- CSS : `.textarea-wrap` en `position: relative`, bouton en `position: absolute; bottom: 0.55rem; right: 0.55rem`, rond (2.2rem), fond `var(--accent)`
- Textarea : `padding-bottom: 3.2rem; overflow: hidden` pour laisser l'espace visuel sans scrollbar
- Icône : `↑` au repos, `<span class="spinner"></span>` pendant le chargement
- Le bouton `id="btn-submit"` est le même qu'avant — tous les appels JS (`btn.disabled`, `btn.innerHTML`) restent inchangés

### Mots du même univers
- Affichés après un ✓ en mode single-mot (sauf mode Situation et Imagen) via `fetchRelatedWords(word)`
- 3 mots suggérés par GPT-4.1, en JSON : `[{"word": "...", "note": "..."}]`
- **Filtre** : les mots déjà présents dans `allWords` sont exclus avant affichage — les chips ne montrent que les mots nouveaux. Si tous existent déjà, message "Tous les mots suggérés sont déjà dans ta liste."
- Bouton ＋ → `addRelatedWord(word, btnIndex)` : vérifie à nouveau contre `allWords` (défense), puis append dans l'onglet langue courant, met à jour `allWords` en mémoire
- Section `#related-box` + `#related-chips`

### Nettoyage au changement de mode (`setMode`)
- `setMode()` nettoie **systématiquement** au changement de mode : `related-box`, `image-vocab-box`, `feedback-box`, `sentence-input`, `lastSubmittedSentence`
- Évite l'accumulation ou la persistance de sections entre modes

### Mode Imagen (📸)
- Photos via Unsplash API, proxiée par le Worker `/unsplash` — requiert `UNSPLASH_KEY` dans les secrets Cloudflare
- `currentPhotoUrl` stocke l'URL complète retournée par Unsplash (inclut le paramètre `w=800`)
- Thème sélectionnable dans ⚙️ : 🎲 Aléatoire, 👥 Personnes, 🏙️ Ville, 🌿 Nature, 🍽️ Nourriture, ✈️ Voyage, 🏛️ Architecture, 🐾 Animaux. Persisté en `localStorage` (clé `vocab_image_theme`)
- `#vocab-section` utilise `display: contents` pour hériter du gap flex de `.screen` sans wrapper visuel
- `#image-section` est un flex-column avec photo + bouton "🔄 Nueva foto" en dessous
- Bouton Vérifier inline (`btn-submit`) redirige vers `analyzePhoto()` quand `practiceMode === 'image'`
- Timeout 45s pour `callMistralVision` (vs 30s pour les autres appels, images plus lentes)
- Chips "Vocabulario sugerido" rendues sous le feedback avec bouton ＋ pour ajouter à l'onglet Spanish — filtrées contre `allWords` avant affichage

### Limite nouveaux mots / jour (mode espacé)
- Configurable via slider ⚙️ dans le panneau réglages : "Nouveaux mots / jour (espacé)"
- Plage : 5–100, pas de 5, défaut 60
- Persisté dans `localStorage` (clé `vocab_max_new_per_day`)
- Met à jour le compteur `due-count` immédiatement au changement du slider
- Remplace la constante `MAX_NEW_PER_DAY` — désormais variable `maxNewPerDay`

### Auto-scroll streaming (`startAutoScroll(box, spacer)`)
- `topTarget` calculé une seule fois après double-RAF (layout stable), avec `PAD_TOP = 20px`
- Suit le **bas** de la boîte chunk par chunk (scroll instant)
- S'arrête quand le **haut** de la boîte atteint le haut du viewport (`stoppedAtTop = true`)
- Le scroll final post-streaming respecte `stoppedAtTop` (ne ré-impose pas le bas si déjà stoppé au haut)
- Spacer agrandi dynamiquement si `bottomTarget > maxScrollY`
- Scroll interrompu si l'utilisateur scrolle manuellement (`wheel`/`touchmove`)
- Utilisé pour : définition (hintBox) et feedback vocab (feedbackBox, avec spacer)
- Mode Imagen : scroll simple non-streaming via `requestAnimationFrame` + `window.scrollTo` après réception

### Protection double soumission
`lastSubmittedSentence` — si même réponse qu'avant, shake + ignore. Remis à `null` en cas d'erreur API pour permettre de réessayer.

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

1. **gpt-4.1 hallucinations** : Rares mais possibles. Les prompts ont des garde-fous (CRITICAL FILTER RULE, B2-STEP 2, etc.) mais ne sont pas infaillibles.

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
