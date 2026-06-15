# Vocab App — Contexte projet

App single-file `index.html` (GitHub Pages) **multi-utilisateur**. Backend = **Cloudflare D1** (SQLite edge) via Cloudflare Worker. Auth = email/mdp **+ Google OAuth** (JWT). IA = **BYOK** (chaque utilisateur sa clé), multi-provider. Utilisateur communique en **français**.

- URL : https://byov.net (domaine custom Cloudflare, **BYOV** = *Bring Your Own Vocab*) — ancienne URL `https://huellasenarena.github.io/vocab-app` toujours active
- Repo : `~/Desktop/vocab-app/` (remote SSH `git@github.com:huellasenarena/vocab-app.git`), **public**
- Push sur `main` → GitHub Actions déploie sur `gh-pages` (~1 min). **Ne jamais éditer `gh-pages`.** Le `cname: byov.net` est dans `deploy.yml` (sinon le CNAME serait écrasé à chaque déploiement).
- Le Worker (`dark-brook-87cc/`) est **versionné dans le repo** (peut être commité).

> **Historique** : avant juin 2026, l'app était mono-utilisateur (backend Google Sheets, secret `WORKER_SECRET` en dur dans le HTML). Migrée en multi-utilisateur (D1 + auth + BYOK), déployée le 2026-06-07. Grosse vague d'améliorations UX/features les 2026-06-13/14 (voir mémoire `project_changes_june2026`). Voir aussi `project_generalization` pour les phases de migration.

---

## Cloudflare Worker

URL : `https://dark-brook-87cc.georg-dreym.workers.dev` · Code : `~/Desktop/vocab-app/dark-brook-87cc/src/worker.js`

### Routes

**Publiques (auth)**
- `/auth/signup`, `/auth/login` → email/mdp (PBKDF2), retourne `{ token, user }` (JWT HS256, 30 j)
- `/auth/google` → vérifie l'ID token Google (JWKS RS256, contrôle `iss`/`aud`/`exp`), **lie par email** si compte mdp existant, sinon crée → retourne JWT
- `/me` (JWT) → `{ user: { id, email, created_at, add_token, openai_key, gemini_key, settings } }` ; génère `add_token` au besoin
- `/add` (token perso, **pas de JWT**) → ajout de mot externe (raccourci iPhone + écran « ajouter du contenu ») — voir section dédiée. Accepte `X-OpenAI-Key` (BYOK de l'entonnoir) sinon repli `OPENAI_API_KEY_SCRIPT`.
- `/judge-similar` (token perso, **pas de JWT**) → similarité **groupée** pour l'import Kindle. Body `{ token, lang, words[] }` + header `X-OpenAI-Key`. Le Worker calcule les candidats (local), n'appelle **GPT-5.4 « low »** (`judgeSimilarBatch`, lots de 40) que pour les mots ayant une ressemblance, et renvoie `{ skip: { mot: mot_existant } }`.

**Données utilisateur (JWT, filtrées par `user_id`)**
- `/api/words` GET (`?lang=`, `?detail=1` → +`created_at`) · POST · DELETE (**unitaire** `{lang,word}` **ou groupé** `{items:[{lang,word}…]}`, mot+progress) · **PUT** (renommer — met à jour `words` + `progress` + `history`)
- `/api/progress`, `/api/session`, `/api/history`, `/api/blacklist`, `/api/usage`
- `/api/grammar` GET · **POST** (ajouter une forme) · **DELETE** (supprimer une forme)
- `/api/keys` POST → stocke `openai_key`/`gemini_key` en D1 (sync multi-appareils)
- `/api/settings` POST → stocke le blob JSON des réglages (`users.settings`) — sync multi-appareils

**IA (JWT + BYOK : clé utilisateur par header)**
- `/` (défaut) → OpenAI Responses API, clé via header **`X-OpenAI-Key`** (400 si absente)
- `/gemini` → Google AI Studio, clé via header **`X-Gemini-Key`**
- `/unsplash` → photo random (clé propriétaire `UNSPLASH_KEY`, gardée par JWT)

**Externe (gardée par `X-Worker-Secret`)**
- `/openai-script` → OpenAI Chat Completions (`OPENAI_API_KEY_SCRIPT`, ou `X-OpenAI-Key` si fourni). **Route quasi-dormante** : le `call_openai` de `kindle_import.py` qui l'utilisait est mort (`WORKER_SECRET` indéfini dans le script ; pré-filtres IA en repli silencieux). L'import passe par `/add` + `/judge-similar`.

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

ID : `87b54745-9878-402b-a4a5-e76720516dea`, binding `DB`. Migrations dans `dark-brook-87cc/migrations/` (`0001_init.sql`, `0002_byok_keys.sql`, `0003_settings.sql` = colonne `users.settings`). Appliquer : `wrangler d1 migrations apply vocab --local|--remote`.

Toutes les tables de données portent `user_id`. Les onglets Sheets d'avant sont devenus des tables relationnelles.

| Table | Colonnes clés |
|---|---|
| `users` | id, email, password_hash, google_id, **add_token**, **openai_key**, **gemini_key**, **settings** (JSON), created_at |
| `words` | user_id, language, word, created_at — `UNIQUE(user_id, language, word)` |
| `progress` | user_id, language, word, correct, incorrect, last_practiced, hint_used, next_review |
| `history` | user_id, date, word, language, result (1/0) |
| `sessions` | user_id, date (YYYY-MM-DD), language, new_count |
| `usage` | user_id, date, openai_input, openai_output, openai_requests, gemma_requests, geminiflash_req, geminiflashlite_req |
| `blacklist` | user_id, language, word |
| `grammar_forms` | user_id, language, category, form |

`language` ∈ `English` · `Spanish` · `French` · `Greek` (4 langues possibles **codées en dur** dans `LANGS`). Chaque utilisateur **choisit un sous-ensemble** de ces 4 (voir « Langues configurables »).

**Date** : progression/sessions en heure **locale** (`todayStrLocal()`). Tokens (`usage`) : OpenAI en UTC, Google en PT (reset quotas). Migration one-time : `scripts/migrate_data.mjs <user_id>` (lit l'ancien Sheet → SQL). Pour `--remote`, retirer les `BEGIN TRANSACTION/COMMIT` du SQL (D1 distante les refuse).

**Grammaire** : `grammar_forms` par utilisateur ; aplati côté JS en `"${category} ${form}"` (ex: `"futuro simple"`).

---

## BYOK (Bring Your Own Key) + sync

Chaque utilisateur entre sa clé OpenAI et/ou Gemini dans ⚙️ (`KEY_OPENAI_KEY`, `KEY_GEMINI_KEY`). Vars `openaiKey`/`geminiKey`. Envoyées au Worker par header (`X-OpenAI-Key`/`X-Gemini-Key`) à chaque requête IA — **jamais de clé partagée**, zéro coût IA serveur.

- `checkApiKey()` (dans `checkDailyLimit()`) bloque avant l'appel réseau si la clé du modèle sélectionné manque.
- **Sync multi-appareils** : `loadAccountInfo()` (au login/chargement/⚙️) récupère les clés depuis D1 (`/me`) ; `setOpenaiKey`/`setGeminiKey` poussent vers le serveur (`saveKeysToServer` → `/api/keys`). La clé saisie sur un appareil suit sur les autres. Stockage D1 = chiffré au repos par Cloudflare, accès protégé par JWT (pas de chiffrement applicatif).
- **3 clés OpenAI distinctes** (voir mémoire `api_keys_mapping`) : (1) **vérification des phrases** = BYOK app ⚙️ ; (2) **raccourci iPhone** = `OPENAI_API_KEY_SCRIPT` (propriétaire, repli) ; (3) **Kindle** = clé dédiée locale `~/Desktop/vocab-app/.openai_key`, envoyée par `kindle_import.py` en `X-OpenAI-Key` sur `/add` et `/judge-similar`. Le Worker utilise le header si présent (via `aiEnv = {...env, OPENAI_API_KEY_SCRIPT: callerKey}`), sinon la clé propriétaire.
- `sanitizeKey()` nettoie la clé (ASCII imprimable seulement) à chaque assignation — un caractère parasite (retour à la ligne, espace insécable) collé dans la clé faisait planter la construction de l'en-tête en Safari (« The string did not match the expected pattern »).

---

## Sync des réglages (`/api/settings`)

Tous les réglages (sliders nombre de mots/formes **par langue**, **nombre de mots Situation** (`vocab_situation_words`, 1-5), modèle, niveaux de raisonnement, grammaire on/off, thème image, compteur tokens, **langues choisies**, **toggle progression Situation+Libre** `vocab_situation_counts`) sont sérialisés en un blob JSON et synchronisés en D1 (`users.settings`).
- Front : `collectSettings()` (toutes les clés `vocab_*` sauf denylist : jwt, pwd_ok, clés BYOK, `today_new_*`) · `saveSettingsToServer()` (debounce 1,5 s, appelé par chaque setter) · `applyServerSettings()`/`reloadSettingsVars()`/`applySettingsUI()` au login.
- Chargé via `/me` (`loadAccountInfo`). Les clés BYOK restent synchronisées séparément (`/api/keys`).

## Langues configurables

Chaque utilisateur choisit ses langues parmi les 4 (`selectedLangs`, clé `vocab_languages` synchronisée). `renderLangGrid()` construit la grille d'accueil dynamiquement (#lang-grid) + tuile **« ＋ ajouter »** (masquée si 4/4). Sélecteur modal `#lang-picker-modal` (`openLangPicker(mandatory)`). À l'inscription / 1re connexion (pas de `vocab_languages`) → `afterAuth()` impose le choix (≥1, fermeture cachée). Défaut comptes existants = les 4.

---

## Ajout de mots — route `/add` (raccourci iPhone)

`GET|POST /add?token=<add_token>&word=<mot>&lang=auto` → insère dans D1 pour l'utilisateur du token. Accepte `word`/`lang`/`ignore_sens`/`ignore_sim` en query **ou corps POST** (formulaire), `token` dans l'URL. Réponses **texte** (mêmes formats que l'ancien Apps Script, le raccourci les parse) :

- `INVALID:<raison> | <Langue>` — mot non valide
- `SIMILAR:<mot> | <Langue>` — variante d'un mot existant
- `Doublon : '<mot>' existe déjà dans <Langue>.`
- `Succès (<Langue>) : '<mot>' ajouté.`

Entonnoir (porté de l'ancien Apps Script, lit les mots existants depuis D1) :
1. **Langue + validité** (`gpt-4.1-mini` via `callScriptLLM`) si `lang=auto` (`analyzeWordLangSense`), sinon `identifyLang` + `validateWord`. Codes ISO `es/fr/en/el` acceptés.
2. **Doublon exact** bloqué.
3. **Similarité** : `normSim` + `similarityScore` sur tous les mots existants, top 5 → **juge LLM** (`judgeSimilarity`, gpt-4.1-mini).

`ignore_sens=true` / `ignore_sim=true` bypassent (1)/(3). Retries 429/5xx (3 tentatives).

**Raccourci iOS** : POST le mot dans le corps, `token`+`lang=auto` dans l'URL ; gère `INVALID:`/`SIMILAR:` par alerte « ajouter quand même ? » → renvoie avec `ignore_*`. (Utilise (1)+(3) avec la clé propriétaire.)

**Écran in-app « ➕ ajouter du contenu »** (`screen-add`, depuis l'accueil) : toggle **Mot / Forme grammaticale**. Mot → `/add` avec `myAddToken` + code langue (gère INVALID/SIMILAR + « ajouter quand même »). Forme → `/api/grammar` POST/DELETE (liste + suppression).

### Import Kindle — `kindle_import.py` (refonte juin 2026)
Lit `vocab.db`/`My Clippings` de la Kindle → sélection → import D1. **Config** : `.token` (jeton perso) et `.openai_key` (clé OpenAI dédiée) — **fichiers prioritaires sur `$ADD_TOKEN`/`$OPENAI_KEY_IMPORT`** (sinon une vieille var parasite casse tout). 
- **Validité IA supprimée** : l'import envoie `ignore_sens=true` (les mots viennent d'un dico → un modèle faible ne faisait que les rejeter à tort). Remplacée par un **filtre charabia local** (`is_gibberish` : longueur/voyelle/chiffres, sans IA).
- **Mots trop courants** : `is_too_common` via **`wordfreq`** (es/fr/en/el), seuil `COMMON_ZIPF_MIN` (défaut **5.5**, ~250-300 mots). Repli `TOO_COMMON` si `wordfreq` absent (`pip3 install wordfreq`).
- **Similarité groupée** : `judge_similar_batch` → route `/judge-similar` (GPT-5.4 « low »), `ignore_sim=true` ensuite sur `/add`. **Aucune question** pendant l'import (auto-skip + résumé).
- **Import reprenable** : cache `.kindle_cache.json` = mots **restants** (retirés au fur et à mesure) ; coupure → relance reprend pile. Mot en erreur dure conservé ; maj Kindle sautée tant qu'il reste des mots. `check_token()` = fail-fast au démarrage.
- `call_openai`/`/openai-script`, `get_existing_words`, `llm_decide_similar_batch`, `validate_words_ai`, `review_words` = **code mort** (legacy Sheets).

---

## Modèles IA

Sélectionnable dans ⚙️, persisté `localStorage` (`vocab_model`). `currentModel` ∈ `'gpt4' | 'gemma' | 'geminiflash' | 'geminiflashlite'`. Toutes les requêtes IA passent par `${API_ENDPOINT}` avec `Authorization: Bearer <JWT>` + la clé BYOK en header.

### GPT-5.4 (OpenAI) — `'gpt4'`
Reasoning model via **Responses API** (route Worker défaut). Pas de `temperature`. Body : `input`, `max_output_tokens`. Vision : `input_text`/`input_image`.
- `reasoning: { effort: gptEffort }` sauf si `none`.
- `max_output_tokens` compte **reasoning + texte**. Eval/QCM/définition : budget **16000**.
- Streaming SSE : `response.output_text.delta`. **Usage dans `response.completed`**. ⚠️ `usage.output_tokens` **inclut déjà** les reasoning tokens (`output_tokens_details.reasoning_tokens` n'est qu'un sous-détail) → `trackTokens` ajoute **uniquement `output_tokens`**, jamais reasoning en plus (sinon double comptage vs dashboard OpenAI — ancien bug corrigé).
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
**SM-2** (`calcNextReview`, jours, basé sur le net **AVANT** d'ajouter le succès courant) : `net ≤ 1 → 1`, `2 → 4`, `3 → 8`, `4 → 14`, `5 → 20`, `6 → 30`, `7 → 45`, `≥ 8 → 60`. (Nouveau + ✓ via `saveProgressNew` = +1 jour, net **inchangé** → le mot revient ~3 jours de suite au début, voulu.)
**Étoiles** : ☆☆☆ (`net ≤ 0`) · ★☆☆ (`1`) · ★★☆ (`2`) · ★★★ (`≥ 3`, maîtrisé). `starsFromNet(net)`.
**Prochaine date** affichée dans la boîte après vérif (`.next-review-line`, single + multi). Slider « nombre de mots » **plafonné** au pool dispo (`setWordSliderMax`). **État terminé** : classe `spaced-done` sur `#screen-practice` → masque slider/carte/boutons, n'affiche que `#spaced-done-card` ✓.
**Limite quotidienne** : `maxNewPerDay` (défaut 60, par langue, `KEY_MAX_NEW`). Slider ⚙️ : valeurs `MAX_NEW_VALUES` = 1,2,3,4,5 puis pas de 5 jusqu'à 100 (`maxNewToIndex`). `pickWords` : `newRemaining = max(0, maxNewPerDay - todayNewCount)`. `onSliderChange` en mode espacé pioche dans le pool éligible `[...trulyDue, ...newToShow]` (jamais `pickWeightedOne`).

**Modes Situation + Libre dans la progression** : un **seul toggle** ⚙️ (`situationCounts`, clé `vocab_situation_counts`, **défaut OFF**) gouverne **à la fois** Situation et Libre. OFF → ni étoiles ni SM-2 ni consommation du quota nouveaux/jour (l'**historique** est toujours écrit). En Libre, gardé par `countsProgress = practiceMode !== 'free' || situationCounts` dans `submitSentence` ; en Situation, par `if (situationCounts)` autour de `saveProgress`.

---

## Modes de pratique

- 📅 **Espacée** — SM-2, limite nouveaux/jour. Sliders : nombre de mots (plafonné au pool dispo) + formes grammaticales (1-10, Español). Bouton bas **« 📅 mes révisions à venir »** → `screen-revisions` (tous les mots programmés langue courante + prochaine date + étoiles ; tris proche/lointaine/A-Z + recherche). État terminé = carte ✓ seule.
- 🎯 **Situation** — recall actif, mots ★★★ (`net ≥ 3`). Refonte juin 2026 :
  - **Bouton ▶ Commencer** (`startSituation`) à l'entrée du mode → **aucun appel API auto** (`pickWords` tire les mots mais ne génère pas). « Autre situation → » (`nextSituation`) enchaîne directement.
  - **Multi-mots 1-5** : slider dédié `#situation-word-slider` (`situationWordCount`, clé `vocab_situation_words`, défaut 1, plafonné aux mots maîtrisés via `setSituationSliderMax`). Tirage pondéré **sans répétition** de N mots.
  - **Poids de relance** : les mots ratés (`situationMissed`, Set en mémoire de session) pèsent **×4** au tirage jusqu'à réussite (ajout sur ✗/« je ne sais pas », retrait sur ✓).
  - **Génération** (`generateSituation`, sans arg, lit `currentWords`) : 1 mot → scène simple ; N mots → **un seul texte cohérent** (même thème) évoquant tous les mots sans les nommer.
  - **Saisie** (`submitSituation`) : un champ, format numéroté libre (`1. mot, candidat  2. …`), **ordre/numéros ignorés** → matching **ensembliste** par l'IA (✓ par mot si un candidat correspond). Verdict **✓/✗ par mot** + score **N/total** ; couleur `correct`/`partial`/`incorrect`. Sauvegarde par mot (history + progress si toggle).
  - **UI** : « Je ne sais pas → » / « Autre situation → » (`btn-situation-skip`/`btn-situation-next`) **entre le texte et le champ** (un seul visible à la fois) ; bouton `↑` inline dans le `.textarea-wrap` ; verdict avec **autoscroll** (`startAutoScroll`). Pas de carte « Le mot » séparée : après vérif le verdict nomme déjà le mot ; après « Je ne sais pas » (`revealWord`), le(s) mot(s) sont affichés **dans la boîte de verdict** (`#situation-feedback-box`, rouge, `Le mot était : …`). Saisie **verrouillée** (`lockSituationAnswer`) après réponse, jamais masquée (évite le saut visuel).
- 🎲 **Libre** — tirage pondéré (`pickWeightedOne`, poids 10/8/5/1). Compte dans la progression **seulement** si le toggle ⚙️ Situation+Libre est ON (sinon historique seul).
- 📸 **Imagen** — photo Unsplash, description espagnol, `callAIVision`. Indépendant de la liste.

---

## Prompts IA

Tous répondent dans `feedbackLang`. `LANGS` = mappings (English, Spanish, French, Modern Greek).

### Évaluation
Deux **BLOCS indépendants** : (1) **Verdict** ✓/✗ sur le(s) mot(s) cible(s) (un ✗ → verdict ✗ ; mot absent → ✗) ; (2) **Analyse linguistique** (grammaire/registre/ponctuation), indépendante du verdict.
Règles : period/semicolon/colon entre phrases = TOUJOURS correct · analyser UNIQUEMENT l'écrit · accepter archaïsmes/dialectes · **CRITICAL FILTER** (items incertains/corrects → silently dropped) · version améliorée seulement si ✓ (italique, mot cible exact).
Format : `## Verdict`, `## Analyse linguistique`, `## Version améliorée`.
**Parsing verdict (multi-mots)** : pour chaque mot, 1re ligne le contenant puis 1er `✓`/`✗`. Regex tolérante aux variantes emoji (`OK_RE=[✓✔✅]`, `KO_RE=[✗✘❌]`). `wordResults` (mot→bool) = **source unique de vérité** (couleur boîte, score `N/total`, contours mots, QCM). **Piège accents** : frontières Unicode `(^|[^\p{L}])mot([^\p{L}]|$)` flag `u`, jamais `\b…\b` ASCII (échoue sur accentués, critique pour le grec).
**Rendu de la boîte** (`renderFeedbackSections`) : après le streaming, re-rendu en **sections repliables** (verdict ouvert, reste = aperçu 2 lignes `-webkit-line-clamp`), bouton « tout déplier/replier », **note `N/total` en bas**. Couleur boîte 3 états : `.correct` vert (tout ✓) / `.partial` orange (quelques ✗) / `.incorrect` rouge (tout ✗) — ⚠️ `.partial` doit être dans **tous** les `classList.remove` (sinon orange bloqué). Bordure neutre pendant le streaming.

### Définition
Cache `definitionCache["mot|lang|model"]` 24h. Lock `_hintInFlight`. 3 sections `##` : **Sens** (polysémie : liste numérotée, **max 3** sens distincts, **un exemple en italique par sens**), Registre (global, étiquette « (sens N) » si diffère), Collocations. Budget tokens `4000` (relevé pour 3 sens). Le prompt interdit de sur-découper les nuances ; 1 sens → 1 entrée.

### QCM
4 scénarios (le mot cible n'apparaît pas), 1 correct + 3 distracteurs, Fisher-Yates JS. JSON via regex.

### Mots du même univers (`fetchRelatedWords`)
1 mot → 3 du même champ ; N mots → 3 liés (`relatedTo`). Affiché après ✓, filtre `allWords` + `blacklistWords`, `＋` pour ajouter. **Blacklist** : au `nextWord()`, les mots non ajoutés → `/api/blacklist` (fire-and-forget), plus jamais suggérés.

### Mode Imagen (vision)
Prompt anglais, réponse espagnol. Sections : `## Precisión`, `## Análisis lingüístico` (CRITICAL FILTER), `## Vocabulario sugerido` (JSON `[{word,note}]`). Convention `(?)` pour mot inconnu. JSON extrait, retiré du rendu, chips avec `＋`.

---

## Comportements UI / iOS

### Écrans
`screen-loading`, `screen-auth`, `screen-lang`, `screen-practice`, `screen-stats`, `screen-history`, `screen-mots`, `screen-revisions`, **`screen-add`** (ajouter du contenu). `showScreen(id)` (déclenche `updateLangBadges` sur screen-lang). Écrans-listes ancrés en haut (`align-self:flex-start`) — titre/recherche figés quand la liste change. **Modales** : `#help-modal` (instructions), `#lang-picker-modal` (choix langues), `#word-ctx-menu` (menu ⋯). `screen-lang` : grille langues (badges vert/rouge `updateLangBadges`) + 📊 stats / 📋 historique / 📝 mes mots / ➕ ajouter / ❓ aide / 🚪 logout.

### Mes mots (`screen-mots`, `showMots`)
Voir/chercher/renommer/supprimer + **étoiles** (`motsStars`, charge progress des 4 langues). Charge les 4 langues (`/api/words?...&detail=1`), tri **chronologique** (récent d'abord, `created_at`), filtres par langue + compteurs, recherche live. Lignes `.mot-row` : case à cocher + drapeau + mot + étoiles + date + ✏️ (`editMot` → `PUT /api/words`, refuse collision) + 🗑 (`deleteMot` → `DELETE`). **Pagination** (`motsPageSize` 5/15/25/50/100, défaut 25 ; `motsPage` ; `#mots-controls`) — la recherche/filtre porte sur **tous** les mots, l'affichage est paginé (fluide à ~10000 mots). **Sélection multiple** (`motsSelected` Set `lang|word`, multi-langues) : case par ligne + « tout sélectionner (cette page) » + barre « N sélectionnés → 🗑 » (`deleteSelectedMots` → `DELETE {items:[…]}` groupé, confirmation). `screen-revisions` a aussi étoiles + recherche.

### Mots cachés (👁) · Chips cliquables
Toggle header, raccourci `Opt+←` (blur 7px). `Opt+→` = `nextWord()`. À la **vérification**, les mots cachés réapparaissent (`revealHiddenWords`). Mot nouveau → `fetchHint`. Mot à réviser (avant soumission) → `showJeNeSaisPas` → `saveProgress(false)` + `startQCM` (1 seul QCM/mot via `_qcmStartedWords`). Casse : affichage + prompts en **minuscules** (`lc()`), DB en casse d'origine.

### Édition / suppression de mot (bouton ⋯)
Le clic-droit/appui long est **retiré**. Carte + chips ont un bouton **« ⋯ »** (`openWordMenu`) → `#word-ctx-menu` avec **✏️ Modifier** (`editWordOnCard` → `PUT /api/words`, propage à words+progress+history) et **🗑 Supprimer** (`deleteWordFromSheets`, nom hérité : `DELETE /api/words` mot+progress, maj mémoire, pioche un remplaçant). Ferme au clic dehors.

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
- `--safe-top` par JS **uniquement en PWA standalone** (iPhone 59px, iPad 44px) ; en Safari normal on garde `env()` ≈ 0 (sinon gros rideau noir inutile). `#status-curtain` (CSS pur, `z-index:9999`).
- **PWA** : `manifest.json` `start_url:"./"` (relatif — `/vocab-app/` faisait un 404 sur byov.net). `apple-mobile-web-app-capable`, `apple-touch-icon` = `icon.svg`.
- **Sticky bar `#sticky-words-bar` : retirée** (instable en PWA ; `_updateStickyVisibility` = no-op, élément `display:none`).
- **Autoscroll clavier retiré** (trop glitchy — on laisse iOS gérer le focus). L'app ne déclenche **aucun** scroll au focus (handler `focus` du textarea supprimé ; pas d'auto-focus du champ Situation). Auto-scroll **streaming** conservé : `startAutoScroll(box, spacer)` suit le bas, stoppe quand le haut atteint `PAD_TOP`, spacer dynamique, interrompu par `wheel`/`touchmove`. Définition : remonte le haut de la boîte en fin de streaming. Le verdict Situation utilise aussi `startAutoScroll`.
- **Changement de mode** : `setMode()` appelle `resetPracticeUI()` (nettoyage complet) → plus de résidu d'un autre mode (définition `#hint-box`, feedback/boutons Situation, QCM, mots liés…).

### Historique / stats
Lus depuis D1 en parallèle (`/api/history` journal + `/api/progress` scores cumulés). Filtre par langue.

### renderMarkdown
`**gras**`, `*italique*`, `##` → `<br><strong class="md-h2">…</strong><br>`, `•` puces. Max 2 `<br>`. `.md-h2` stylé selon contexte (image = label DM Mono ; correct/incorrect = couleur héritée).

---

## Problèmes connus

1. **gpt-5.4 hallucinations** : rares. Garde-fous prompts (CRITICAL FILTER) imparfaits.
2. **Doublon `callAIVision`** : 2 déclarations, la 2e (GPT) écrase le dispatcher → Imagen utilise toujours GPT (pas Gemini vision).
3. **`WORKER_SECRET` exposé** (repo public + historique git) → rotation à faire. Encore utilisé par `/openai-script` (route legacy).
4. **Gemma 4 thinking** : `NONE`/`thinkingBudget:0` non supportés (`MINIMAL`/`HIGH` seulement).
5. **Langues à 4/4** : la tuile « ＋ ajouter » disparaît → plus d'entrée UI pour *retirer* une langue (ajouter un « gérer mes langues » si besoin).
6. **`wrangler dev --remote`** se fait throttler (erreur Cloudflare 1031) après plusieurs heures → relancer le process.

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

**Faites ✅** : Auth Google + email/mdp · migration Sheets → D1 · BYOK + sync · ajout de mots `/add` (token) · **écran « ajouter du contenu » in-app (mots + formes grammaticales)** · Mes mots (+ étoiles) · calendrier des révisions (tri + recherche + étoiles) · **sync de tous les réglages** · **langues configurables par utilisateur** (sous-ensemble des 4) · **page d'instructions (modale)** · **boîte de vérif repliable** · `kindle_import.py` → `/add`/D1 · compteur tokens corrigé · PWA `manifest` corrigé · déploiement prod · **refonte mode Situation** (bouton Commencer, multi-mots 1-5, poids de relance ×4, verdict par mot + score, autoscroll, UI cohérente) · **toggle progression Situation+Libre** · **refonte import Kindle** (validité IA off + filtre charabia/`wordfreq`, similarité groupée GPT-5.4 via `/judge-similar`, **clé Kindle dédiée** `.openai_key`, import reprenable) · **« mes mots » paginé + sélection multiple/suppression groupée**.

**À faire / à concevoir** :
- **BYOK total** : le **raccourci iPhone** utilise encore `OPENAI_API_KEY_SCRIPT` (pas d'UI BYOK). La Kindle, elle, est passée BYOK (`.openai_key`).
- **Plus de 4 langues** : les 4 possibles sont codées en dur dans `LANGS` (mappings, prompts, détection `/add`). Pour une langue hors-liste, il faudrait généraliser `LANGS`.
- **Rotation `WORKER_SECRET`** + suppression secrets morts (`SA_JSON`, `OPENAI_API_KEY`, `GEMINI_KEY`).
- **Sécurité/scalabilité** : OK pour des centaines d'utilisateurs ; 1ers plafonds = quotas D1 gratuits (~100K écritures/j) + clé `/add` du propriétaire.
- **PWA** : service worker (offline) · **App Store** via Capacitor (Apple Dev $99/an).
- **Gérer mes langues** : pouvoir retirer une langue quand on a les 4.

> Case study portfolio : `~/Desktop/vocab-app/portfolio-case-study.md` (ES+EN).
