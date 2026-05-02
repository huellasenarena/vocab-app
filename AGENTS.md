# Vocab App — Contexte projet

App single-file `index.html`, GitHub Pages. Backend = Google Sheets via Cloudflare Worker (service account). Multi-provider IA. Utilisateur communique en **français**.

- URL : https://huellasenarena.github.io/vocab-app
- Repo : `~/Desktop/vocab-app/` (remote SSH `git@github.com:huellasenarena/vocab-app.git`)
- Push sur `main` → GitHub Actions déploie sur `gh-pages` (~1 min). **Ne jamais éditer `gh-pages`.**

---

## Cloudflare Worker

URL : `https://dark-brook-87cc.georg-dreym.workers.dev`

Quatre routes :
- `/` (défaut) → OpenAI
- `/sheets` → Google Sheets (JWT RS256 signé via `SA_JSON`, token caché 1h)
- `/unsplash` → `api.unsplash.com/photos/random`
- `/gemini` → Google AI Studio (Gemma + Gemini)

Secrets (dashboard Cloudflare) : `OPENAI_API_KEY`, `SA_JSON`, `UNSPLASH_KEY`, `GEMINI_KEY`, `WORKER_SECRET`.

**Sécurité** : header `X-Worker-Secret` requis sinon 403. La route `/sheets` valide que le `sheetPath` cible un Sheet ID dans `ALLOWED_SHEET_IDS`.

**Code** : `~/Desktop/vocab-app/dark-brook-87cc/` (exclu du repo GitHub via `.gitignore`).

```bash
cd ~/Desktop/vocab-app/dark-brook-87cc
wrangler deploy
wrangler secret put NOM_SECRET
```

Cold start après inactivité prolongée : ~100-200ms supplémentaires sur la 1re requête.

---

## Google Sheets

Sheet ID vocab : `1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc`
Partagés Éditeur avec l'email du service account. Tous les appels passent par `sheetsApi(sheetPath, method, body)`.

**Onglets** : `English`, `Spanish`, `French`, `Greek`, `Progress`, `History`, `Session`, `Tokens`, `Blacklist`, `Grammar: Spanish`. Mots dans colonne B (timestamp en A) pour chaque onglet langue.

### Schémas

| Onglet | Colonnes |
|---|---|
| Progress | A:Word B:Language C:Correct D:Incorrect E:LastPracticed F:HintUsed G:NextReview |
| History | A:Date B:Word C:Language D:Result(✓/✗) |
| Session | A:Date(YYYY-MM-DD) B:NewWordsPracticed |
| Tokens | A:Date B:OpenAIInputTokens C:OpenAIOutputTokens D:OpenAIRequests E:GemmaRequests F:GeminiFlashRequests G:GeminiFlashLiteRequests |
| Blacklist | A:English B:Spanish C:French D:Greek (row 1 = headers) |
| Grammar: Spanish | Row 1 = catégories, Row 2+ = formes |

**Tokens — particularité date** : colonnes B/C/D (OpenAI) en date UTC via `todayStr()`, colonnes E/F/G (Google) en date PT via `todayStrPT()` (reset quotas Google). Pour tout ce qui touche à la progression utilisateur (mots à réviser, limite nouveaux/jour), l'app utilise la date locale via `todayStrLocal()`.

**Grammaire** : onglet `Grammar: Spanish` (main sheet), row 1 = catégories (presente, pasado, futuro, subjuntivo, condicional, imperativo, misc.), rows 2+ = formes. Aplati côté JS en `"${cat} ${forme}"` (ex: `"futuro simple"`, `"subjuntivo pluscuamperfecto"`).

---

## Modèles IA

Sélectionnable dans ⚙️, persisté en `localStorage` (`vocab_model`). `currentModel` ∈ `'gpt4' | 'gemma' | 'geminiflash' | 'geminiflashlite'`.

### GPT-5.4 (OpenAI) — `'gpt4'`

Reasoning model via **Responses API** (`/v1/responses`, route Worker par défaut). Pas de `temperature`. Body : `input` (pas `messages`), `max_output_tokens` (pas `max_tokens`). Vision : content types `input_text` / `input_image`.

- `reasoning: { effort: gptEffort }` envoyé sauf si `gptEffort === 'none'` (sinon 400).
- `max_output_tokens` compte **reasoning + texte ensemble**. Avec `effort: 'low'`, ~1024 tokens de reasoning consommés avant tout texte → budget min 2000 pour ~1000 tokens visibles. En dessous, `output_text` peut être `null` → throw "Réponse vide".
- Évaluation/QCM/définition GPT : budget = **16000** (large pour absorber le reasoning). Gemini : `2000 + N*400` pour eval, `1500` pour QCM.
- Streaming SSE : event `response.output_text.delta` → `parsed.delta`. **Usage uniquement dans `response.completed`** (capture obligatoire).
- **Reasoning tokens** dans `usage.output_tokens_details.reasoning_tokens` (champ séparé, **pas** inclus dans `output_tokens`). `trackTokens` les ajoute à `todayOutputTokens` ET à `_pendingOutput` (oublier dans `_pending` perdait ~80% des tokens à chaque sync Sheets).
- Fonctions : `callMistral`, `callMistralStream`, `callMistralVision` (timeout connexion 30s, rolling timeout 60s sur stream). Noms `callMistral*` conservés par héritage.

### Gemma 4 31B — `'gemma'`

Quota gratuit **1500 req/jour** (reset minuit PT). Route `/gemini`, model ID `gemma-4-31b-it`. Supporte vision.

- `thinkingLevel` ∈ `'minimal'` (défaut) | `'high'`. `'NONE'` et `thinkingBudget: 0` **non supportés**.
- Worker applique `thinkingConfig: { thinkingLevel: val.toUpperCase() }` et **supprime `temperature`** (recommandation Google).
- Worker filtre les chunks `thought: true` (stream + non-streaming) — les pensées ne sortent jamais au client.
- Stream définition : Gemma génère parfois du texte de vérification avant `## ` → côté client, gate qui supprime tout chunk avant le 1er `## ` accumulé.

### Gemini 3 Flash / 3.1 Flash Lite — `'geminiflash'` / `'geminiflashlite'`

Route `/gemini`, IDs `gemini-3-flash-preview` / `gemini-3.1-flash-lite-preview`. Quotas : 20 / 500 req/jour (reset minuit PT).

- `thinkingLevel` ∈ `'none'` (défaut) | `'minimal'` | `'low'` | `'medium'` | `'high'`.
- Avec thinking actif : Worker supprime `temperature`. Sans thinking : `temperature: 0.2`.

### Niveau de raisonnement — UI ⚙️

Un seul `<select>` dynamique mis à jour par `updateReasoningUI()` selon `currentModel` :
- GPT-5.4 → `gptEffort` (`KEY_GPT_EFFORT`), valeurs `none|low|medium|high`, défaut `low`
- Gemini Flash (3 + 3.1) → `geminiThinkingLevel` (`KEY_GEMINI_THINKING`), `none|minimal|low|medium|high`, défaut `none`
- Gemma → `gemmaThinkingLevel` (`KEY_GEMMA_THINKING`), `minimal|high`, défaut `minimal`

`setReasoningLevel(val)` dispatche. `geminiThinkingBody()` retourne `{ thinkingLevel }` ou `{}` si `none`.

### Wrappers modèle-agnostiques

`callAI(prompt, maxTokens)` / `callAIStream(prompt, onChunk, maxTokens)` / `callAIVision(imageUrl, prompt, maxTokens)` : appellent `checkDailyLimit()` puis dispatch selon `currentModel`. `isGemini()` = `currentModel ∈ {gemma, geminiflash, geminiflashlite}`. `geminiModelId()` lit `GEMINI_MODEL_IDS` (le Worker utilise `geminiModel` du body).

### Compteurs tokens / requêtes

Affichés sous `<h1>Vocab</h1>`, DM Mono. Toggle ⚙️ "Afficher compteur tokens" (`KEY_SHOW_TOKENS`).

| Modèle | Affichage | Variable principale |
|---|---|---|
| GPT-5.4 | `X / 235 000 tokens` | `todayInputTokens + todayOutputTokens` |
| Gemma | `X / 1500 req` | `todayGemmaRequests` |
| Gemini Flash | `X / 20 req` | `todayGeminiFlashRequests` |
| Gemini Flash Lite | `X / 500 req` | `todayGeminiFlashLiteRequests` |

`DAILY_LIMITS = { gpt4: 235000, gemma: 1500, geminiflash: 20, geminiflashlite: 500 }`. ≥80% : compteur orange. ≥100% : rouge + `checkDailyLimit()` throw → impossible d'appeler le modèle.

`trackTokens(usage)` (GPT) — incrémente `todayInputTokens`, `todayOutputTokens` (texte + reasoning), `todayGptRequests` ; ajoute aussi à `_pendingInput`/`_pendingOutput`/`_pendingGptReq`. `trackGeminiRequest()` (Google) — incrémente le compteur du modèle actif + son `_pending*`. Les deux appellent `saveTodayTokensDebounced()` (debounce 2s — **pas** `saveTodayTokens()` directement).

**Multi-appareils** : `saveTodayTokens()` lit la valeur Sheets actuelle puis ajoute uniquement les `_pending*` capturés au moment du save. Les `_pending*` sont décrémentés (pas remis à 0) après save pour ne pas perdre les tokens arrivés pendant l'`await`.

---

## Règles de progression (mode espacé)

| Situation | Compteur | NextReview | Étoiles |
|---|---|---|---|
| Nouveau + ✓ (avec ou sans hint) | −1 nouveau | +1 jour | inchangées |
| Nouveau + ✗ | inchangé | inchangé | inchangées |
| À réviser + ✓ sans hint | inchangé | SM-2 | +1 |
| À réviser + ✓ avec hint | inchangé | +1 jour | inchangées |
| À réviser + ✗ | inchangé | +1 jour | inchangées |
| "Je ne sais pas" | inchangé | +1 jour | inchangées (= ✗) |
| 2ème+ tentative dans la session | ignoré | ignoré | ignoré |

**Changement de jour** : l'application utilise l'heure locale de l'utilisateur (`todayStrLocal()`). Les mots prévus pour le lendemain apparaissent à minuit heure locale.

**SM-2** (jours jusqu'à `NextReview`) : `net ≤ 1 → 1`, `net=2 → 6`, `net=3 → 14`, `net=4 → 30`, `net=5 → 60`, `net ≥ 6 → 120` (max).


**Étoiles** : ☆☆☆ (`net ≤ 0`) · ★☆☆ (`net=1`) · ★★☆ (`net=2`) · ★★★ (`net ≥ 3`, considéré maîtrisé).

**Limite quotidienne** : `maxNewPerDay` (défaut 60, configurable 5-100 via ⚙️, `KEY_MAX_NEW`). `pickWords` calcule `newRemaining = max(0, maxNewPerDay - todayNewCount)` puis `newToShow = neverPracticed.slice(0, newRemaining)`. **Important** : `onSliderChange` doit aussi respecter cette limite quand il complète `currentWords` en mode espacé (utiliser le même pool éligible que `pickWords`, pas `pickWeightedOne` qui pioche dans tout `allWords`).

---

## Modes de pratique

- 📅 **Espacée** — révision SM-2, limite nouveaux/jour. Sliders : nombre de mots (1-30) + nombre de formes grammaticales (1-10, Español uniquement)
- 🎯 **Situation** — recall actif, mots ★★★ uniquement (`net ≥ 3`). Génère une scène concrète sans mentionner le mot
- 🎲 **Libre** — tirage pondéré classique (`pickWeightedOne`, poids 10/8/5/1 selon net)
- 📸 **Imagen** — photo Unsplash random, description en espagnol, analyse via `callAIVision`. Indépendant de la liste de mots

---

## Prompts IA

Tous les prompts répondent dans `feedbackLang` (langue cible). `LANGS` définit les mappings (English, Spanish, French, Modern Greek).

### Évaluation

Deux **BLOCS indépendants** :
- **BLOC 1 — Verdict** : ✓ ou ✗ uniquement sur le(s) mot(s) cible(s). Si un mot ✗ → verdict global ✗. Mot absent du texte → ✗ automatique.
- **BLOC 2 — Analyse linguistique** : grammaire/registre/ponctuation/naturel, totalement indépendant du verdict.

Règles critiques :
- Period/semicolon/colon entre phrases = TOUJOURS correct (jamais signaler comme virgule manquante)
- Analyser UNIQUEMENT ce qui est écrit, pas des variantes imaginaires
- Accepter formes archaïques/dialectales/littéraires + mots archaïques autonomes (ex: "desque", "maguer")
- **CRITICAL FILTER RULE** : items incertains/corrects → silently dropped (ne pas inclure)
- Version améliorée : seulement si verdict ✓, en italique, doit utiliser le mot cible exact

Format sortie : `## Verdict` (✓/✗ + une phrase), `## Analyse linguistique` (liste numérotée ou "Aucune erreur"), `## Version améliorée` (si ✓).

### Définition

Cache `definitionCache["mot|lang|model"]` valide 24h (clé inclut le modèle pour permettre rechargement après changement). Lock global `_hintInFlight` : tant qu'un streaming est en cours, tout autre clic sur un mot est ignoré silencieusement (cache hit reste instantané).

4 sections `##` dans la langue cible : Définition, Registre, Collocations (`• *expression* — explication`), Exemple en italique.

### QCM

4 scénarios courts (1-2 phrases), 1 correct + 3 distracteurs. Le mot cible **ne doit pas apparaître** dans aucun scénario. Mélangé Fisher-Yates côté JS. JSON extrait via regex (`[\s*{` → dernier `]`). Scroll immédiat vers la section dès le clic, avant la réponse API.

### Situation (mode recall actif)

Génère une scène concrète **sans mentionner le mot**. Évaluation en 3 étapes internes.

### Mots du même univers (`fetchRelatedWords(words)`)

Accepte string ou array :
- 1 mot : 3 mots du même champ sémantique, format `[{"word","note"}]`
- N mots : 3 mots les plus utiles liés au set, format `[{"word","note","relatedTo"}]` — chip affiche `↖ mot-source`

Affiché après ✓. Filtre les mots déjà dans `allWords` **et** dans `blacklistWords`. Bouton `＋` pour ajouter (marque dans `_relatedWordsAdded`).

**Blacklist** : au clic "Autre mot" (`nextWord()`), les mots affichés mais non ajoutés sont envoyés dans l'onglet `Blacklist` (colonne de la langue) via `saveToBlacklist()` fire-and-forget — ils ne seront plus jamais suggérés.

### Mode Imagen — prompt vision

Prompt en anglais, réponse en espagnol. Sections imposées :
- `## Precisión` — éléments corrects en **gras**, omissions notables, 2-4 phrases
- `## Análisis lingüístico` — *forma incorrecta* → **forma correcta** — explication. CRITICAL FILTER. Si rien : "Sin errores detectados."
- `## Vocabulario sugerido` — JSON 3-5 entrées `[{"word","note"}]`

Convention `(?)` : utilisateur marque un mot inconnu → l'IA l'identifie et l'intègre à l'analyse.

JSON Vocabulario extrait par regex côté JS, retiré du texte rendu, affiché en chips avec `＋` (`addImageVocabWord`). Mots déjà dans `allWords` filtrés avant affichage.

---

## Comportements UI / iOS

### Mots cachés (👁 Cacher)

Toggle dans le header. Raccourci clavier `Opt+←` (sur Mac/iPad clavier externe). Blur 7px sur `.word-main`, `.chip-word`, `#sticky-words-text`, `.hint-word-in-label`, `.qcm-word`, `.qcm-offer-word`. Désactivé dans les TEXTAREA/INPUT pour préserver la nav par mot native.

`Opt+→` = "Autre mot" (`nextWord()`), même garde-fou TEXTAREA/INPUT.

### Chips cliquables (pas de bouton "Définition")

- Mot nouveau (card unique ou chip) → `fetchHint(word)` direct
- Mot à réviser (mode espacé, avant soumission) → `showJeNeSaisPas(word)` → panneau de confirmation, textarea bloqué. Confirmer = `saveProgress(word, false)` + `startQCM(word)`

### Suppression de mot (menu contextuel)

Right-click (Mac/iPad trackpad) ou long press 500ms (touch) sur un `.word-chip` ou `#single-word-card` → menu `#word-ctx-menu` (`position: fixed; z-index: 10000`), positionné au point de clic/tap, clampé au viewport.

- **Guard `_justLongPressed`** : bloque le `click` qui suit un long press — vérifié dans `chipHint` et `singleCardHint` avant toute action
- **`deleteWordFromSheets(word)`** :
  1. Lit `currentLang!A:B` → trouve l'index 0-based de la ligne (col B = mot)
  2. `GET /v4/spreadsheets/${SHEET_ID}?fields=sheets.properties` → sheetIds numériques des onglets
  3. `batchUpdate` avec `DeleteDimensionRequest` sur l'onglet langue (vraie suppression de ligne)
  4. Idem sur Progress si la ligne existe (cherche col A = mot, skip header row)
  5. Met à jour `allWords`, `progressMap`, `definitionCache` en mémoire
  6. Pioche un remplaçant avec le même pool que `onSliderChange` → `renderWordDisplay()`
- **`batchUpdate` vs `:clear`** : `deleteWordFromSheets` supprime vraiment la ligne. `cleanOrphans` utilise `:clear` — intentionnel (nettoyage passif, différent).

### Couleurs des mots

- **Nouveau** : doré (`var(--accent)`) — pas de classe spéciale
- **À réviser** : blanc (`var(--text)`) — classe `chip-review` (chips) ou `card-review` (`#single-word-card`)

### Bouton "Autre mot →" sous le verdict ✓

`#btn-next-below`, affiché uniquement après verdict correct. Autoscroll post-streaming pour le révéler — **sauf si `scroller.stoppedAtTop`** (boîte plus grande que l'écran : on ne pousse pas le haut hors écran).

### Bouton Vérifier inline (style iMessage)

Intégré dans le textarea (coin bas-droit), toujours visible même clavier ouvert sur iPhone. Structure : `<div class="textarea-wrap">` (position relative) contient textarea + `<button class="btn-submit-inline">` (position absolute). Textarea : `padding-bottom: 3.2rem; overflow: hidden`. `.textarea-wrap` a `-webkit-transform: translateZ(0)` pour forcer le clipping iOS Safari. Icône `↑` au repos, spinner pendant chargement.

### Bouton Réessayer

Injecté dans la zone d'erreur après échec API. Cibles : `submitSentence`, `startQCM(qcmWord)`, `fetchHint(word)`, `generateSituation(word)`, `fetchRelatedWords(currentWords)`.

### Protection double soumission

`lastSubmittedSentence` : même phrase que la précédente → shake + ignore. Reset à `null` sur erreur API (permet de réessayer la même phrase). Reset à `''` au changement de modèle.

### Protection "Autre mot" avec phrase non vérifiée

Au début de `nextWord()` : si textarea non vide ET ≠ `lastSubmittedSentence` → `confirm()` natif. Couvre phrase écrite mais jamais vérifiée + phrase vérifiée puis modifiée.

### iOS — `--safe-top` et rideau status bar

`viewport-fit=cover` permet au contenu de passer derrière la status bar. `--safe-top` est défini par JS au chargement :
- iPhone/iPod : `59px` hardcodé
- iPad : `32px` hardcodé (détection `/iPad/.test(UA)` OU `maxTouchPoints > 1 && /Macintosh/`)
- Mac/autres : `env(safe-area-inset-top, 0px)` via CSS

`env(safe-area-inset-top)` n'est PAS utilisé sur iPhone/iPad : résolution incorrecte dans certains contextes PWA standalone.

`body { padding-top: var(--safe-top) }`. `html { background: var(--bg) }` couvre le rubber band.

**`#status-curtain`** : `position: fixed; top: 0; height: var(--safe-top); background: var(--bg); z-index: 9999` — CSS pur, **aucun JS**. Dans l'état stabilisé (clavier ouvert, animation finie), `vv.offsetTop = 0` et `top: 0` est la bonne position. Glitch bref pendant l'animation du clavier inévitable (comportement identique à ChatGPT PWA — iOS scrolle window pendant l'animation, puis stabilise).

**Approches CSS abandonnées** (toutes échouent en standalone PWA) : `curtain.style.top = vv.offsetTop`, `position: absolute + scrollY`, `mask-attachment: fixed`, `html { overflow: hidden; height: 100dvh }`, `interactive-widget=resizes-content`. Conclusion : iOS PWA auto-scrolle window au focus input — accepter ce scroll, se fier au rideau CSS pur.

### iOS — Sticky bar (`#sticky-words-bar`)

**Désactivée sur iPhone/iPad** (`_isIOS = true`) car instable dans les contextes PWA. Active uniquement sur Mac/Desktop.

CSS : `position: fixed; top: 0; padding-top: calc(var(--safe-top) + 0.55rem)` → la barre couvre la zone status bar ET affiche le mot juste en dessous. `z-index: 500` (sous le rideau 9999).

`_updateStickyVisibility()` compare le rect du mot avec `safeTop + 10`. Listeners : `window scroll` + `vv scroll/resize` + `setTimeout(200ms, 500ms)` après `vv.resize` (capture position post-clavier-iOS). Appelée aussi directement après chaque `window.scrollTo` dans `startAutoScroll` (events scroll programmatiques décalés sur iPad).

### iOS — Autoscroll au focus textarea

Au focus de `sentence-input` : note `origHeight = vv.height`. Écoute `vv.resize` mais ignore les réductions <150px (barre URL Safari). Réduction >150px = clavier ouvert : `gap = rect.bottom - vv.height + 12` → `window.scrollBy({ top: gap, behavior: 'smooth' })`. Toujours exécuté même si gap négatif (ramène le textarea vers le clavier).

Fallback `setTimeout(800ms)` pour clavier déjà ouvert. **Ignoré si `origHeight - vv.height ≤ 100px`** (iPad clavier physique : seule la barre d'outils ~50px apparaît, pas de scroll nécessaire — évite scroll parasite).

### Auto-scroll streaming (`startAutoScroll(box, spacer)`)

`PAD_TOP = max(safeTop + 20, stickyBarHeight + 16)`. La hauteur de sticky bar est **toujours** prise en compte même si `.visible` n'est pas encore activée (peut apparaître pendant le scroll). Suit le bas de la boîte chunk par chunk, s'arrête quand le **haut** atteint `PAD_TOP` (`stoppedAtTop = true`). Le scroll final post-streaming respecte `stoppedAtTop`.

Spacer (`#scroll-spacer`) : grandit dynamiquement si `bottomTarget > maxScrollY`. Déclaré **avant** le `try` dans `submitSentence` (accessible dans le `catch`). `cleanupSpacer()` appelé après streaming ET dans le `catch` (évite l'espace noir géant en cas d'erreur).

Scroll interrompu si `wheel`/`touchmove` utilisateur. Mode Imagen : scroll simple non-streaming via `requestAnimationFrame` + `window.scrollTo`.

### Slider multi-mots

`previousWordsPool` mémorise les mots vus dans la session. Réduire/augmenter le slider réutilise les mots précédents. `onSliderChange` met aussi à jour les formes grammaticales.

**En mode espacé** : `onSliderChange` calcule le pool éligible `[...trulyDue, ...newToShow]` (mêmes règles que `pickWords`) et ne pioche QUE dedans. Si `previousWordsPool` contient des mots non éligibles, ils sont skippés. **Ne jamais utiliser `pickWeightedOne` en mode espacé** (sinon des nouveaux mots peuvent dépasser la limite quotidienne).

### Slider formes grammaticales

`#grammar-slider-section` (1-10), persisté `KEY_GRAMMAR_COUNT`. Visible uniquement si `grammarFormsEnabled && currentLang === 'Spanish' && grammarForms.length > 0 && practiceMode ∉ {situation, image}` (`renderGrammarForms` gère la visibilité).

### Notice aide utilisée

Affichée après le streaming (peuplée synchrone après `scroller.cleanup()`, avant le `requestAnimationFrame` final). Template `{words}` dans `hintNotice` de chaque langue. Vidée au début de chaque submission.

### Nettoyage orphelins Progress

À chaque `loadProgress`, `setTimeout(cleanOrphans, 500)` vide les lignes Progress dont le mot n'existe plus dans l'onglet de langue. Ne touche PAS `progressMap` en mémoire.

### Historique chronologique

Onglet `History` = journal pur (1 ligne par tentative, écriture batch via `saveHistoryBatch`). `Progress` = scores cumulés. Lus en parallèle pour l'affichage de l'écran historique.

### renderMarkdown

Convertit `**gras**`, `*italique*`, `##` headings, `•` puces. `##` → `<br><strong class="md-h2">…</strong><br>`. Max 2 `<br>` consécutifs. `<br>` en tête supprimés.

`.md-h2` stylé différemment selon contexte :
- `.feedback-box.image` : DM Mono uppercase, accent, border-bottom (style label)
- `.feedback-box.correct/incorrect` : héritage couleur (vert/rouge), gras

---

## Problèmes connus

1. **gpt-5.4 hallucinations** : rares mais possibles. Garde-fous dans les prompts (CRITICAL FILTER, B2-STEP 2) imparfaits.

2. **Apps Script `doPost`** : ajout de mots depuis raccourci iPhone, URL séparée. `Code_test.js` est le script actif (remplace `Code.js`). Architecture : `doPost` wrapper → `_doPost` (logique) + `updateTokensGemma` (incrémente col E onglet Tokens après chaque appel). Ordre des checks : (1) **détection langue** Gemma si `lang=auto` — échec → erreur explicite (pas de fallback silencieux) ; (2) **validation** Gemma (`gemma-4-31b-it`) → `INVALID:raison | langue` ; (3) doublon exact bloqué ; (4) **similarité** — pré-filtre `normSim`+`isSimilarCandidate` (préfixe 4 chars, substring, suffixe 3 chars, normalisation accents, 15 candidats max) + juge LLM → `SIMILAR:mot | langue`. `ignore_sens=true` / `ignore_sim=true` bypasse chaque check. **OAuth scope requis** : `script.external_request` dans `appsscript.json` — si les appels Gemma échouent avec "no permission", révoquer l'autorisation sur myaccount.google.com/permissions et relancer depuis l'éditeur. Menu **🔍 Audit** dans Sheets (`Audit.js`) : modèle `gemma-3-4b-it` (30 RPM / 14 400 RPD), batch 60 mots, sleep 2 200ms entre batches. Sélection d'onglet (actif par défaut ou choix numéroté), plage de lignes, mémoire par onglet dans Script Properties (`AUDIT_END_English`, `AUDIT_END_Spanish`, etc.).

3. **`kindle_import.py`** : import Kindle → Sheets via Worker (`/sheets` + `X-Worker-Secret`, plus d'OAuth2). Lit `vocab.db` + `My Clippings.txt`. Déduplication contre Sheets (substring ou article-stripped) : menu `i/n/d` (importer / ne pas / ignorer les deux). Inter-clips : `SequenceMatcher ≥ 0.80`, menu `1/2/+/-`. **Validation Gemma batch** (30 mots/appel) après déduplication : suspects marqués `⚠️ raison` dans la revue paginée. Revue paginée 10/page avant import. **User-Agent navigateur requis** dans les requêtes Worker (sinon 403 Cloudflare 1010).

4. **Gemma 4 thinking** : `'NONE'` et `thinkingBudget: 0` non supportés. Niveaux confirmés : `'MINIMAL'`, `'HIGH'`.

5. **Gemini Flash thinking + temperature** : Worker n'envoie PAS `temperature` quand thinking actif. Sans thinking : `temperature: 0.2`.

---

## Apps Script & Raccourci (Ajout de mots)

Le flux d'ajout est centralisé dans l'Apps Script (`Code_test.js`, script actif — `Code.js` conservé mais inactif). Il utilise un système d'entonnoir intelligent :

1.  **Analyse Combinée (IA)** : Si `lang=auto`, Gemma identifie la langue (French, English, Spanish, Greek) ET vérifie si le mot est valide en un seul appel. Format de réponse : `VALID | Langue` ou `INVALID: raison | Langue`.
2.  **Vérification des Doublons (Double passe)** :
    *   **Passe 1 (Exact)** : Bloque si le mot exact existe déjà.
    *   **Passe 2 (Similitude/IA)** : Scanne les mots visuellement proches, puis utilise un **Juge LLM** pour déterminer s'il s'agit d'une simple variation (conjugaison, genre, nombre).

**Paramètres de bypass** :
- `ignore_sens=true` : Saute l'analyse IA du sens (garde juste la détection de langue rapide).
- `ignore_sim=true` : Saute la détection des doublons similaires.

**Raccourci iOS** : 
- Envoie `lang=auto` au premier appel.
- Si réponse `INVALID` ou `SIMILAR`, propose de forcer via une alerte.
- Le forçage renvoie la requête avec les paramètres `ignore_*` appropriés.

---

## Workflow

### Modifier `index.html`

```bash
node -e "const fs=require('fs'),html=fs.readFileSync('index.html','utf8'),m=html.match(/<script>([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/check.js',m[1]);" && node --check /tmp/check.js && echo "OK"
```

Toujours vérifier la syntaxe JS avant `git push`. Tester en local (Safari).

### Modifier le Worker

`cd ~/Desktop/vocab-app/dark-brook-87cc && wrangler deploy`. Ne pas commiter ce dossier.

### Modifier l'Apps Script

Code dans `apps_script/` (versionné dans le repo). Déploiement via clasp :

```bash
cd ~/Desktop/vocab-app/apps_script
clasp push        # met à jour le code dans Sheets
```

Après `clasp push`, **redéployer** dans l'éditeur Apps Script pour que le raccourci iPhone prenne les changements : Déployer > Gérer les déploiements > ✏️ > Nouvelle version > Déployer. `.clasp.json` exclu du repo (`.gitignore`).

---

## Idée future (non implémentée)

**Auth Google OAuth** : remplacer le mot de passe SHA-256 par "Se connecter avec Google". Worker vérifierait le token Google au lieu du `WORKER_SECRET`, éliminant le secret visible en clair. Reconnexion silencieuse via refresh token en localStorage. ~20h estimées. Non prioritaire (app mono-utilisateur).
