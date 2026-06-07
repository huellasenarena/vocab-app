# Vocab App — Contexte projet

App single-file `index.html` (GitHub Pages) **multi-utilisateur**. Backend = **Cloudflare D1** (SQLite edge) via Cloudflare Worker. Auth = email/mdp **+ Google OAuth** (JWT). IA = **BYOK** (chaque utilisateur sa clé), multi-provider. Utilisateur communique en **français**.

- URL : https://byov.net (domaine custom Cloudflare, **BYOV** = *Bring Your Own Vocab*) — ancienne URL `https://huellasenarena.github.io/vocab-app` toujours active
- Repo : `~/Desktop/vocab-app/` (remote SSH `git@github.com:huellasenarena/vocab-app.git`), **public**
- Push sur `main` → GitHub Actions déploie sur `gh-pages` (~1 min). **Ne jamais éditer `gh-pages`.** Le `cname: byov.net` est dans `deploy.yml` (sinon le CNAME serait écrasé à chaque déploiement).
- Le Worker (`dark-brook-87cc/`) est **versionné dans le repo** (peut être commité).

> **Historique** : avant juin 2026, l'app était mono-utilisateur (backend Google Sheets, secret `WORKER_SECRET` en dur dans le HTML). Migrée en multi-utilisateur (D1 + auth + BYOK) et déployée le 2026-06-07. Voir la mémoire `project_generalization` pour le détail des phases.

---

## Cloudflare Worker

URL : `https://dark-brook-87cc.georg-dreym.workers.dev` · Code : `~/Desktop/vocab-app/dark-brook-87cc/src/worker.js`

### Routes

**Publiques (auth)**
- `/auth/signup`, `/auth/login` → email/mdp (PBKDF2), retourne `{ token, user }` (JWT HS256, 30 j)
- `/auth/google` → vérifie l'ID token Google (JWKS RS256, contrôle `iss`/`aud`/`exp`), **lie par email** si compte mdp existant, sinon crée → retourne JWT
- `/me` (JWT) → `{ user: { id, email, created_at, add_token, openai_key, gemini_key } }` ; génère `add_token` au besoin
- `/add` (token perso, **pas de JWT**) → ajout de mot externe (raccourci iPhone) — voir section dédiée

**Données utilisateur (JWT, filtrées par `user_id`)**
- `/api/words` GET (`?lang=`, `?detail=1` → +`created_at`) · POST · DELETE (mot+progress) · **PUT** (renommer)
- `/api/progress`, `/api/session`, `/api/history`, `/api/blacklist`, `/api/grammar`, `/api/usage`
- `/api/keys` POST → stocke `openai_key`/`gemini_key` en D1 (sync multi-appareils)

**IA (JWT + BYOK : clé utilisateur par header)**
- `/` (défaut) → OpenAI Responses API, clé via header **`X-OpenAI-Key`** (400 si absente)
- `/gemini` → Google AI Studio, clé via header **`X-Gemini-Key`**
- `/unsplash` → photo random (clé propriétaire `UNSPLASH_KEY`, gardée par JWT)

**Externe (gardée par `X-Worker-Secret`)**
- `/openai-script` → OpenAI Chat Completions (`OPENAI_API_KEY_SCRIPT`). Utilisée par `kindle_import.py` (l'ajout de mots, lui, passe par `/add` qui appelle OpenAI directement).

### Secrets (dashboard Cloudflare)
`JWT_SECRET`, `OPENAI_API_KEY_SCRIPT`, `UNSPLASH_KEY`, `WORKER_SECRET`. Var publique : `GOOGLE_CLIENT_ID` (dans `wrangler.jsonc`).
*Morts/inutilisés (BYOK + D1)* : `OPENAI_API_KEY`, `GEMINI_KEY`, `SA_JSON` (peuvent être supprimés).

### Sécurité
- Routes IA + données = **JWT** (`Authorization: Bearer`). Plus aucun secret dans `index.html`.
- `/openai-script` = `X-Worker-Secret`. ⚠️ `WORKER_SECRET` a fuité (repo public + historique git) → **rotation à faire** quand l'utilisateur veut (les scripts lisent désormais la valeur depuis `process.env.WORKER_SECRET`, plus en dur).

```bash
cd ~/Desktop/vocab-app/dark-brook-87cc
wrangler deploy
wrangler secret put NOM_SECRET
```
Cold start après inactivité : ~100-200ms sur la 1re requête.

---

## Authentification

- **Email/mdp** : `hashPassword`/`verifyPassword` = PBKDF2-SHA256 (100k itérations, Web Crypto), format `pbkdf2$iter$salt$hash`.
- **Google OAuth** : lib Google Identity Services (front), bouton « Continuer avec Google » sur `screen-auth`. Le Worker vérifie l'ID token via les clés publiques Google (JWKS, cache selon `max-age`). `GOOGLE_CLIENT_ID` prod = `742808037031-...apps.googleusercontent.com` (origines JS autorisées : `localhost:8080` + `huellasenarena.github.io`).
- **Liaison par email** : même email = un seul compte (qu'on entre par Google ou mdp) → `google_id` rattaché à la ligne existante.
- **Session** : JWT HS256 signé par le Worker, stocké `localStorage` (`KEY_JWT = vocab_jwt`). Front : `authFetch(path, opts)` ajoute le header. `API_ENDPOINT` auto-détecté (localhost → worker local `:8787`, sinon prod).

---

## Cloudflare D1 (base `vocab`)

ID : `87b54745-9878-402b-a4a5-e76720516dea`, binding `DB`. Migrations dans `dark-brook-87cc/migrations/` (`0001_init.sql`, `0002_byok_keys.sql`). Appliquer : `wrangler d1 migrations apply vocab --local|--remote`.

Toutes les tables de données portent `user_id`. Les onglets Sheets d'avant sont devenus des tables relationnelles.

| Table | Colonnes clés |
|---|---|
| `users` | id, email, password_hash, google_id, **add_token**, **openai_key**, **gemini_key**, created_at |
| `words` | user_id, language, word, created_at — `UNIQUE(user_id, language, word)` |
| `progress` | user_id, language, word, correct, incorrect, last_practiced, hint_used, next_review |
| `history` | user_id, date, word, language, result (1/0) |
| `sessions` | user_id, date (YYYY-MM-DD), language, new_count |
| `usage` | user_id, date, openai_input, openai_output, openai_requests, gemma_requests, geminiflash_req, geminiflashlite_req |
| `blacklist` | user_id, language, word |
| `grammar_forms` | user_id, language, category, form |

`language` ∈ `English` · `Spanish` · `French` · `Greek` (**codé en dur** — voir Idées futures).

**Date** : progression/sessions en heure **locale** (`todayStrLocal()`). Tokens (`usage`) : OpenAI en UTC, Google en PT (reset quotas). Migration one-time : `scripts/migrate_data.mjs <user_id>` (lit l'ancien Sheet → SQL). Pour `--remote`, retirer les `BEGIN TRANSACTION/COMMIT` du SQL (D1 distante les refuse).

**Grammaire** : `grammar_forms` par utilisateur ; aplati côté JS en `"${category} ${form}"` (ex: `"futuro simple"`).

---

## BYOK (Bring Your Own Key) + sync

Chaque utilisateur entre sa clé OpenAI et/ou Gemini dans ⚙️ (`KEY_OPENAI_KEY`, `KEY_GEMINI_KEY`). Vars `openaiKey`/`geminiKey`. Envoyées au Worker par header (`X-OpenAI-Key`/`X-Gemini-Key`) à chaque requête IA — **jamais de clé partagée**, zéro coût IA serveur.

- `checkApiKey()` (dans `checkDailyLimit()`) bloque avant l'appel réseau si la clé du modèle sélectionné manque.
- **Sync multi-appareils** : `loadAccountInfo()` (au login/chargement/⚙️) récupère les clés depuis D1 (`/me`) ; `setOpenaiKey`/`setGeminiKey` poussent vers le serveur (`saveKeysToServer` → `/api/keys`). La clé saisie sur un appareil suit sur les autres. Stockage D1 = chiffré au repos par Cloudflare, accès protégé par JWT (pas de chiffrement applicatif).
- La clé de `/add` (`OPENAI_API_KEY_SCRIPT`, propriétaire) est **séparée** de la clé BYOK de la pratique (volontaire).

---

## Ajout de mots — route `/add` (raccourci iPhone)

`GET|POST /add?token=<add_token>&word=<mot>&lang=auto` → insère dans D1 pour l'utilisateur du token. Accepte `word`/`lang`/`ignore_sens`/`ignore_sim` en query **ou corps POST** (formulaire), `token` dans l'URL. Réponses **texte** (mêmes formats que l'ancien Apps Script, le raccourci les parse) :

- `INVALID:<raison> | <Langue>` — mot non valide
- `SIMILAR:<mot> | <Langue>` — variante d'un mot existant
- `Doublon : '<mot>' existe déjà dans <Langue>.`
- `Succès (<Langue>) : '<mot>' ajouté.`

Entonnoir (porté de l'ancien Apps Script, lit les mots existants depuis D1) :
1. **Langue + validité** (`gpt-4.1-mini` via `OPENAI_API_KEY_SCRIPT`) si `lang=auto` (`analyzeWordLangSense`), sinon `identifyLang` + `validateWord`. Codes ISO `es/fr/en/el` acceptés.
2. **Doublon exact** bloqué.
3. **Similarité** : `normSim` + `similarityScore` sur tous les mots existants, top 5 → **juge LLM** (`judgeSimilarity`).

`ignore_sens=true` / `ignore_sim=true` bypassent (1)/(3). Retries 429/5xx (3 tentatives).

**Raccourci iOS** : POST le mot dans le corps, `token`+`lang=auto` dans l'URL ; gère `INVALID:`/`SIMILAR:` par alerte « ajouter quand même ? » → renvoie avec `ignore_*`.

---

## Modèles IA

Sélectionnable dans ⚙️, persisté `localStorage` (`vocab_model`). `currentModel` ∈ `'gpt4' | 'gemma' | 'geminiflash' | 'geminiflashlite'`. Toutes les requêtes IA passent par `${API_ENDPOINT}` avec `Authorization: Bearer <JWT>` + la clé BYOK en header.

### GPT-5.4 (OpenAI) — `'gpt4'`
Reasoning model via **Responses API** (route Worker défaut). Pas de `temperature`. Body : `input`, `max_output_tokens`. Vision : `input_text`/`input_image`.
- `reasoning: { effort: gptEffort }` sauf si `none`.
- `max_output_tokens` compte **reasoning + texte**. Eval/QCM/définition : budget **16000**.
- Streaming SSE : `response.output_text.delta`. **Usage dans `response.completed`**. Reasoning tokens dans `usage.output_tokens_details.reasoning_tokens` (séparé). `trackTokens` les ajoute à `todayOutputTokens` ET `_pendingOutput`.
- Fonctions : `callMistral`, `callMistralStream`, `callAIVision` (vision GPT) — envoient `X-OpenAI-Key`. Noms `callMistral*` par héritage.

### Gemma 4 31B — `'gemma'`
Route `/gemini`, `gemma-4-31b-it`. `thinkingLevel` ∈ `minimal`(défaut)|`high` (`NONE`/`thinkingBudget:0` non supportés). Worker filtre les chunks `thought:true`.

### Gemini 3 Flash / 3.1 Flash Lite — `'geminiflash'`/`'geminiflashlite'`
`gemini-3-flash-preview` / `gemini-3.1-flash-lite-preview`. `thinkingLevel` ∈ `none`(défaut)|`minimal`|`low`|`medium`|`high`. Sans thinking : `temperature: 0.2`.

### Niveau de raisonnement — ⚙️
Un `<select>` dynamique (`updateReasoningUI()`) : GPT→`gptEffort` (défaut low) · Gemini→`geminiThinkingLevel` (défaut none) · Gemma→`gemmaThinkingLevel` (défaut minimal).

### Wrappers
`callAI` / `callAIStream` / `callAIVision` → `checkDailyLimit()` (qui appelle `checkApiKey()`) puis dispatch selon `currentModel`. `isGemini()` = gemma|geminiflash|geminiflashlite.
> Doublon connu : 2 déclarations `callAIVision` (la 2e, GPT, écrase le dispatcher → l'Imagen utilise toujours GPT).

### Compteurs tokens / requêtes
Sous `<h1>Vocab</h1>`, toggle ⚙️ (`KEY_SHOW_TOKENS`). `DAILY_LIMITS = { gpt4: 250000, gemma: 1500, geminiflash: 20, geminiflashlite: 500 }`. ≥80% orange, ≥100% rouge + `checkDailyLimit()` throw. `trackTokens`/`trackGeminiRequest` → `saveTodayTokensDebounced()` (2s). Persistés en **D1** (`/api/usage`) : `saveTodayTokens()` lit la valeur D1 puis ajoute les `_pending*` (multi-appareils).

---

## Règles de progression (mode espacé)

| Situation | Compteur | NextReview | Étoiles |
|---|---|---|---|
| Nouveau + ✓ | −1 nouveau | +1 jour | inchangées |
| Nouveau + ✗ | inchangé | inchangé | inchangées |
| À réviser + ✓ sans hint | inchangé | SM-2 | +1 |
| À réviser + ✓ avec hint | inchangé | +1 jour | inchangées |
| À réviser + ✗ / "Je ne sais pas" | inchangé | +1 jour | inchangées |
| 2ème+ tentative dans la session | ignoré | ignoré | ignoré |

**Changement de jour** : heure locale (`todayStrLocal()`).
**SM-2** (jours) : `net ≤ 1 → 1`, `2 → 6`, `3 → 14`, `4 → 30`, `5 → 60`, `≥ 6 → 120`.
**Étoiles** : ☆☆☆ (`net ≤ 0`) · ★☆☆ (`1`) · ★★☆ (`2`) · ★★★ (`≥ 3`, maîtrisé).
**Limite quotidienne** : `maxNewPerDay` (défaut 60, par langue, `KEY_MAX_NEW`). Slider ⚙️ : valeurs `MAX_NEW_VALUES` = 1,2,3,4,5 puis pas de 5 jusqu'à 100 (`maxNewToIndex`). `pickWords` : `newRemaining = max(0, maxNewPerDay - todayNewCount)`. `onSliderChange` en mode espacé pioche dans le pool éligible `[...trulyDue, ...newToShow]` (jamais `pickWeightedOne`).

---

## Modes de pratique

- 📅 **Espacée** — SM-2, limite nouveaux/jour. Sliders : nombre de mots (1-30) + formes grammaticales (1-10, Español). Bouton bas **« 📅 mes révisions à venir »** → écran `screen-revisions` (mots pratiqués langue courante + prochaine date, triés).
- 🎯 **Situation** — recall actif, mots ★★★ (`net ≥ 3`). Scène sans mentionner le mot.
- 🎲 **Libre** — tirage pondéré (`pickWeightedOne`, poids 10/8/5/1).
- 📸 **Imagen** — photo Unsplash, description espagnol, `callAIVision`. Indépendant de la liste.

---

## Prompts IA

Tous répondent dans `feedbackLang`. `LANGS` = mappings (English, Spanish, French, Modern Greek).

### Évaluation
Deux **BLOCS indépendants** : (1) **Verdict** ✓/✗ sur le(s) mot(s) cible(s) (un ✗ → verdict ✗ ; mot absent → ✗) ; (2) **Analyse linguistique** (grammaire/registre/ponctuation), indépendante du verdict.
Règles : period/semicolon/colon entre phrases = TOUJOURS correct · analyser UNIQUEMENT l'écrit · accepter archaïsmes/dialectes · **CRITICAL FILTER** (items incertains/corrects → silently dropped) · version améliorée seulement si ✓ (italique, mot cible exact).
Format : `## Verdict`, `## Analyse linguistique`, `## Version améliorée`.
**Parsing verdict (multi-mots)** : pour chaque mot, 1re ligne le contenant puis 1er `✓`/`✗`. `wordResults` (mot→bool) = **source unique de vérité** (couleur boîte, score `N/total`, contours mots, QCM). **Piège accents** : frontières Unicode `(^|[^\p{L}])mot([^\p{L}]|$)` flag `u`, jamais `\b…\b` ASCII (échoue sur accentués, critique pour le grec).

### Définition
Cache `definitionCache["mot|lang|model"]` 24h. Lock `_hintInFlight`. 4 sections `##` : Définition, Registre, Collocations, Exemple (italique).

### QCM
4 scénarios (le mot cible n'apparaît pas), 1 correct + 3 distracteurs, Fisher-Yates JS. JSON via regex.

### Mots du même univers (`fetchRelatedWords`)
1 mot → 3 du même champ ; N mots → 3 liés (`relatedTo`). Affiché après ✓, filtre `allWords` + `blacklistWords`, `＋` pour ajouter. **Blacklist** : au `nextWord()`, les mots non ajoutés → `/api/blacklist` (fire-and-forget), plus jamais suggérés.

### Mode Imagen (vision)
Prompt anglais, réponse espagnol. Sections : `## Precisión`, `## Análisis lingüístico` (CRITICAL FILTER), `## Vocabulario sugerido` (JSON `[{word,note}]`). Convention `(?)` pour mot inconnu. JSON extrait, retiré du rendu, chips avec `＋`.

---

## Comportements UI / iOS

### Écrans
`screen-loading`, `screen-auth`, `screen-lang` (sélecteur langue + 📊 stats / 📋 historique / 📝 mes mots / 🚪 logout), `screen-practice`, `screen-stats`, `screen-history`, `screen-mots`, `screen-revisions`. `showScreen(id)`.

### Mes mots (`screen-mots`, `showMots`)
Voir/chercher/renommer/supprimer. Charge les 4 langues (`/api/words?...&detail=1`), tri **chronologique** (récent d'abord, `created_at`), filtres par langue + compteurs, recherche live. Lignes `.mot-row` : drapeau + mot + date + ✏️ (`editMot` → `PUT /api/words`, refuse collision) + 🗑 (`deleteMot` → `DELETE`).

### Mots cachés (👁) · Chips cliquables
Toggle header, raccourci `Opt+←` (blur 7px). `Opt+→` = `nextWord()`. Mot nouveau → `fetchHint`. Mot à réviser (avant soumission) → `showJeNeSaisPas` → `saveProgress(false)` + `startQCM`.

### Suppression de mot (menu contextuel)
Right-click / long press 500ms sur `.word-chip`/`#single-word-card` → `#word-ctx-menu`. Guard `_justLongPressed`. **`deleteWordFromSheets(word)`** (nom hérité) : `DELETE /api/words` (mot + progress), met à jour `allWords`/`progressMap`/`definitionCache` en mémoire, pioche un remplaçant (même pool que `onSliderChange`).

### Couleurs / contours des mots
- Nouveau : doré (`--accent`) · À réviser : blanc (`chip-review`/`card-review`).
- **Après vérification** : contour vert (`--success`) si ✓, rouge (`#e05a5a`) si ✗ (`applyWordOutlines` d'après `wordResults`, classes `chip-correct/incorrect`/`card-correct/incorrect`), reset au mot suivant.

### Champs / boutons
- Inputs : `input[type=password|email]` stylés pareil (fond surface, radius), autofill Safari neutralisé (`-webkit-autofill`).
- Bouton Vérifier inline iMessage (`.btn-submit-inline` dans `.textarea-wrap`), `↑`/spinner.
- `#btn-next-below` « Autre mot → » après ✓ (autoscroll sauf `scroller.stoppedAtTop`).
- Bouton Réessayer injecté après échec API.
- Protection double soumission (`lastSubmittedSentence`) + « Autre mot » avec phrase non vérifiée (`confirm()`).

### iOS
- `--safe-top` par JS : iPhone 59px, iPad 32/44px, sinon `env(safe-area-inset-top)`. `#status-curtain` (CSS pur, `z-index:9999`). PWA standalone : iOS auto-scrolle au focus input, on se fie au rideau.
- **Sticky bar `#sticky-words-bar` : retirée** (instable en PWA ; `_updateStickyVisibility` = no-op, élément `display:none`).
- Autoscroll focus textarea (ignore réductions <150px = barre URL). Auto-scroll streaming `startAutoScroll(box, spacer)` : suit le bas, stoppe quand le haut atteint `PAD_TOP`, spacer dynamique, interrompu par `wheel`/`touchmove`.

### Historique / stats
Lus depuis D1 en parallèle (`/api/history` journal + `/api/progress` scores cumulés). Filtre par langue.

### renderMarkdown
`**gras**`, `*italique*`, `##` → `<br><strong class="md-h2">…</strong><br>`, `•` puces. Max 2 `<br>`. `.md-h2` stylé selon contexte (image = label DM Mono ; correct/incorrect = couleur héritée).

---

## Problèmes connus

1. **gpt-5.4 hallucinations** : rares. Garde-fous prompts (CRITICAL FILTER) imparfaits.
2. **Doublon `callAIVision`** : 2 déclarations, la 2e (GPT) écrase le dispatcher → Imagen utilise toujours GPT (pas Gemini vision).
3. **`WORKER_SECRET` exposé** (repo public + historique git) → rotation à faire (scripts lisent déjà `process.env.WORKER_SECRET`).
4. **`kindle_import.py`** : import Kindle, écrit encore dans **Google Sheets** (outil pré-D1, orphelin) + utilise `/openai-script`. À refaire vers `/add`/D1 si besoin. User-Agent navigateur requis (sinon 403 Cloudflare 1010).
5. **Gemma 4 thinking** : `NONE`/`thinkingBudget:0` non supportés (`MINIMAL`/`HIGH` seulement).

---

## Workflow

### Modifier `index.html`
```bash
node -e "const fs=require('fs'),html=fs.readFileSync('index.html','utf8'),m=html.match(/<script>([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/check.js',m[1]);" && node --check /tmp/check.js && echo "OK"
```
Toujours vérifier la syntaxe JS avant `git push`. Tester en local (Safari).

### Modifier le Worker
```bash
cd ~/Desktop/vocab-app/dark-brook-87cc && node --check src/worker.js && wrangler deploy
```
Le Worker est versionné → commiter `dark-brook-87cc/src/worker.js`, `wrangler.jsonc`, `migrations/`.

### Dev local
`wrangler dev` (D1 `--local`, `.dev.vars` pour `JWT_SECRET`) + `python3 -m http.server 8080`. `API_ENDPOINT` détecte localhost. L'IA est testable en local en collant une vraie clé dans ⚙️ (BYOK).

### Déployer en prod
Worker : `wrangler deploy`. Front : push `main` → GitHub Actions → `gh-pages`. Migrations D1 : `wrangler d1 migrations apply vocab --remote`.

---

## Idées futures

**Faites ✅** : Auth Google OAuth + email/mdp · migration Sheets → D1 · BYOK + sync · ajout de mots `/add` (token) · Mes mots · calendrier des révisions · déploiement prod.

**À faire / à concevoir** :
- **BYOK total** (priorité, important pour l'utilisateur) : l'**ajout de mots** (`/add`) utilise encore `OPENAI_API_KEY_SCRIPT` (clé propriétaire) car le raccourci n'a pas d'UI BYOK. À rendre BYOK (clé de l'utilisateur côté requête, ou clé D1 réutilisée).
- **Page d'instructions / onboarding** : l'app n'est pas évidente (login, clé BYOK, raccourci, modes).
- **Langues configurables par utilisateur** : EN/ES/FR/Greek codés en dur (sélecteur, prompts, détection `/add`) → un utilisateur apprenant une autre langue ne peut pas.
- **Rotation `WORKER_SECRET`** + suppression secrets morts (`SA_JSON`, `OPENAI_API_KEY`, `GEMINI_KEY`).
- **Sécurité/scalabilité** : OK pour des centaines d'utilisateurs ; 1ers plafonds = quotas D1 gratuits (~100K écritures/j) + clé `/add` du propriétaire.
- **PWA installable** (manifest + service worker) · **App Store** via Capacitor (nécessite Apple Dev $99/an).
- `kindle_import.py` → cibler D1/`/add`.

> Case study portfolio : `~/Desktop/vocab-app/portfolio-case-study.md` (ES+EN).
