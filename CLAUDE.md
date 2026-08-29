# Vocab App — Contexte projet

App single-file `index.html` (GitHub Pages) **multi-utilisateur**. Backend = **Cloudflare D1** (SQLite edge) via Cloudflare Worker. Auth = email/mdp **+ Google OAuth** (JWT). IA = **BYOK** (chaque utilisateur sa clé), multi-provider. Utilisateur communique en **français**.

- URL : https://byov.net (domaine custom Cloudflare, **BYOV** = *Bring Your Own Vocab*) — ancienne URL `https://huellasenarena.github.io/vocab-app` toujours active
- Repo : `~/Desktop/vocab-app/` (remote SSH `git@github.com:huellasenarena/vocab-app.git`), **public**
- Push sur `main` → GitHub Actions déploie sur `gh-pages` (~1 min). **Ne jamais éditer `gh-pages`.** Le `cname: byov.net` est dans `deploy.yml` (sinon le CNAME serait écrasé à chaque déploiement).
- Le Worker (`dark-brook-87cc/`) est **versionné dans le repo** (peut être commité).

> **Historique** : avant juin 2026, l'app était mono-utilisateur (backend Google Sheets, secret `WORKER_SECRET` en dur dans le HTML). Migrée en multi-utilisateur (D1 + auth + BYOK), déployée le 2026-06-07. Grosse vague d'améliorations UX/features les 2026-06-13/14 (voir mémoire `project_changes_june2026`). Voir aussi `project_generalization` pour les phases de migration. **2026-08-18** : notes entre parenthèses (expressions) + réparation des 28 entrées dont la note avait été rognée ; grammaire ouverte aux 4 langues ; transfert d'un mot d'une langue à l'autre. **2026-08-23** : modèles à jour (GPT-5.6 Terra, Gemini 3.7 Flash / 3.5 Flash Lite, efforts `xhigh`/`max`) ; prompt « version améliorée » refondu ; cartes « mots du même univers » qui ne débordent plus ; slider du mode Libre débloqué (perf). **2026-08-27** : compteur de mots **par mode** (espacé ≠ libre) et **valeur souhaitée** qui survit aux journées à peu de mots ; écran « ajouter » (pilules de langue + panneaux pleine largeur) ; **« 🔍 vérifier le mot »** (menu ⋯ et « mes mots ») ; **quota des nouveaux respecté par le slider** ; **liste des mots maîtrisés** en mode Situation ; entonnoir d'ajout basculé sur **gpt-5.6-luna** ; plus de rectangle vide au clic sur « Vérifier ». **2026-08-28** : **« étudier un mot »** (définition + QCM au lieu d'écrire la phrase, pour un nouveau mot seulement) ; **traduction** et **image** d'un mot à la demande ; **remarques de l'analyse classées par gravité** ; **fuite de la blacklist bouchée** ; **graphie proposée à l'ajout** (« ajouter « pensar » » au lieu du seul « ajouter quand même ») ; **curseur de mélange du mode libre** (découverte ↔ révision, poids normalisés par catégorie).

---

## Cloudflare Worker

URL : `https://dark-brook-87cc.georg-dreym.workers.dev` · Code : `~/Desktop/vocab-app/dark-brook-87cc/src/worker.js`

### Routes

**Publiques (auth)**
- `/auth/signup`, `/auth/login` → email/mdp (PBKDF2), retourne `{ token, user }` (JWT HS256, 30 j)
- `/auth/google` → vérifie l'ID token Google (JWKS RS256, contrôle `iss`/`aud`/`exp`), **lie par email** si compte mdp existant, sinon crée → retourne JWT
- `/me` (JWT) → `{ user: { id, email, created_at, add_token, openai_key, gemini_key, settings } }` ; génère `add_token` au besoin
- `/add` (token perso, **pas de JWT**) → ajout de mot externe (raccourci iPhone + écran « ajouter du contenu ») — voir section dédiée. Accepte `X-OpenAI-Key` (BYOK de l'entonnoir) sinon repli `OPENAI_API_KEY_SCRIPT`.
- `/judge-similar` (token perso, **pas de JWT**) → similarité **groupée** pour l'import Kindle. Body `{ token, lang, words[] }` + header `X-OpenAI-Key`. Le Worker calcule les candidats (local), n'appelle **GPT-5.6 Luna « low »** (`judgeSimilarBatch`, lots de 40) que pour les mots ayant une ressemblance, et renvoie `{ skip: { mot: mot_existant } }`.

**Données utilisateur (JWT, filtrées par `user_id`)**
- `/api/words` GET (`?lang=`, `?detail=1` → +`created_at`) · POST · DELETE (**unitaire** `{lang,word}` **ou groupé** `{items:[{lang,word}…]}`, mot+progress) · **PUT** `{lang, oldWord, newWord?, newLang?}` (**renommer et/ou changer de langue** — met à jour `words` + `progress` + `history` ; 409 si le mot existe déjà dans la langue cible)
- `/api/progress`, `/api/session`, `/api/history`, `/api/blacklist`, `/api/usage`
- `/api/grammar` GET · **POST** (ajouter une forme) · **DELETE** (supprimer une forme)
- `/api/keys` POST → stocke `openai_key`/`gemini_key` en D1 (sync multi-appareils)
- `/api/settings` POST → stocke le blob JSON des réglages (`users.settings`) — sync multi-appareils

**IA (JWT + BYOK : clé utilisateur par header)**
- `/` (défaut) → OpenAI Responses API, clé via header **`X-OpenAI-Key`** (400 si absente)
- `/gemini` → Google AI Studio, clé via header **`X-Gemini-Key`**
- `/unsplash` → photo random (clé propriétaire `UNSPLASH_KEY`, gardée par JWT)

> **Modèle serveur** : toutes les décisions de l'entonnoir (`analyzeWordLangSense`, `identifyLang`, `validateWord`, `judgeSimilarity`, `judgeSimilarBatch`) passent par `callScriptReasoning` = **`gpt-5.6-luna`, effort `low`** (worker.js). `callScriptLLM` (gpt-4.1-mini) n'est plus appelé que par la route morte `/openai-script`. Bascule terra → luna le **2026-08-27** : réponses identiques sur 23 mots rares/dialectaux des 4 langues et sur 12 cas de similarité, ~10× moins cher ($0,20/$1,20 contre $2/$12 par M tokens).

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
| `words` | user_id, language, word, created_at — `UNIQUE(user_id, language, word)` · `word` peut être `base (note)`, voir « Entrées annotées » |
| `progress` | user_id, language, word, correct, incorrect, last_practiced, hint_used, next_review |
| `history` | user_id, date, word, language, result (1/0) |
| `sessions` | user_id, date (YYYY-MM-DD), language, new_count |
| `usage` | user_id, date, openai_input, openai_output, openai_requests, gemma_requests, geminiflash_req, geminiflashlite_req |
| `blacklist` | user_id, language, word |
| `grammar_forms` | user_id, language, category, form |

`language` ∈ `English` · `Spanish` · `French` · `Greek` (4 langues possibles **codées en dur** dans `LANGS`). Chaque utilisateur **choisit un sous-ensemble** de ces 4 (voir « Langues configurables »).

**Date** : progression/sessions en heure **locale** (`todayStrLocal()`). Tokens (`usage`) : OpenAI en UTC, Google en PT (reset quotas). Migration one-time : `scripts/migrate_data.mjs <user_id>` (lit l'ancien Sheet → SQL). Pour `--remote`, retirer les `BEGIN TRANSACTION/COMMIT` du SQL (D1 distante les refuse).

**Grammaire** : `grammar_forms` par utilisateur **et par langue** ; aplati côté JS en `"${category} ${form}"` (ex: `"futuro simple"`). Voir « Formes grammaticales » plus bas.

---

## BYOK (Bring Your Own Key) + sync

Chaque utilisateur entre sa clé OpenAI et/ou Gemini dans ⚙️ (`KEY_OPENAI_KEY`, `KEY_GEMINI_KEY`). Vars `openaiKey`/`geminiKey`. Envoyées au Worker par header (`X-OpenAI-Key`/`X-Gemini-Key`) à chaque requête IA — **jamais de clé partagée**, zéro coût IA serveur.

- `checkApiKey()` (dans `checkDailyLimit()`) bloque avant l'appel réseau si la clé du modèle sélectionné manque.
- **Sync multi-appareils** : `loadAccountInfo()` (au login/chargement/⚙️) récupère les clés depuis D1 (`/me`) ; `setOpenaiKey`/`setGeminiKey` poussent vers le serveur (`saveKeysToServer` → `/api/keys`). La clé saisie sur un appareil suit sur les autres. Stockage D1 = chiffré au repos par Cloudflare, accès protégé par JWT (pas de chiffrement applicatif).
- **3 clés OpenAI distinctes** (voir mémoire `api_keys_mapping`) : (1) **vérification des phrases** = BYOK app ⚙️ ; (2) **raccourci iPhone** = `OPENAI_API_KEY_SCRIPT` (propriétaire, repli) ; (3) **Kindle** = clé dédiée locale `~/Desktop/vocab-app/.openai_key`, envoyée par `kindle_import.py` en `X-OpenAI-Key` sur `/add` et `/judge-similar`. Le Worker utilise le header si présent (via `aiEnv = {...env, OPENAI_API_KEY_SCRIPT: callerKey}`), sinon la clé propriétaire.
- `sanitizeKey()` nettoie la clé (ASCII imprimable seulement) à chaque assignation — un caractère parasite (retour à la ligne, espace insécable) collé dans la clé faisait planter la construction de l'en-tête en Safari (« The string did not match the expected pattern »).

---

## Sync des réglages (`/api/settings`)

Tous les réglages (sliders nombre de mots/formes **par langue**, **nombre de mots Situation** (`vocab_situation_words`, 1-5), modèle, niveaux de raisonnement, **grammaire on/off + nombre de formes, par langue**, thème image, compteur tokens, **langues choisies**, **toggle progression Situation+Libre** `vocab_situation_counts`, **mélange du mode libre** `vocab_free_mix`) sont sérialisés en un blob JSON et synchronisés en D1 (`users.settings`).
- Front : `collectSettings()` (toutes les clés `vocab_*` sauf denylist : jwt, pwd_ok, clés BYOK, `today_new_*`) · `saveSettingsToServer()` (debounce 1,5 s, appelé par chaque setter) · `applyServerSettings()`/`reloadSettingsVars()`/`applySettingsUI()` au login.
- Chargé via `/me` (`loadAccountInfo`). Les clés BYOK restent synchronisées séparément (`/api/keys`).

## Langues configurables

Chaque utilisateur choisit ses langues parmi les 4 (`selectedLangs`, clé `vocab_languages` synchronisée). `renderLangGrid()` construit la grille d'accueil dynamiquement (#lang-grid) + tuile **« ＋ ajouter »** (masquée si 4/4). Sélecteur modal `#lang-picker-modal` (`openLangPicker(mandatory)`). À l'inscription / 1re connexion (pas de `vocab_languages`) → `afterAuth()` impose le choix (≥1, fermeture cachée). Défaut comptes existants = les 4.

**Libellés dépendant de la langue pratiquée** : `applyI18n` substitue le jeton **`{lang}`** par le nom de la langue courante (ex. `set_grammar` → « Formes grammaticales (Français) »). Hors d'une langue (accueil), le motif ` ({lang})` disparaît entièrement — ne pas coder un nom de langue en dur dans une traduction.

## Formes grammaticales (les 4 langues)

`grammar_forms` a toujours été par langue en D1 ; jusqu'en août 2026 seul le **front** verrouillait sur l'espagnol. Désormais : `loadGrammarForms()` est appelé pour **toute** langue ouverte, et `renderGrammarForms()` affiche la zone + le slider dès que la langue courante a des formes.
- **Réglages par langue** : `vocab_grammar_enabled_<Langue>` et `vocab_grammar_count_<Langue>`, lus par `grammarEnabledFor(lang)` / `grammarCountFor(lang)` — **repli sur l'ancienne clé globale**, qui portait le réglage espagnol d'avant la généralisation (ne pas la supprimer).
- Appliqués dans `selectLanguage()` (toggle + slider recalés sur la langue qu'on ouvre) et `applySettingsUI()`.
- La ligne de réglage `#grammar-toggle-row` est **masquée** si la langue courante n'a aucune forme (interrupteur sans effet sinon).
- Les formes sont un rappel visuel (pilules) : elles n'entrent dans aucun prompt.

---

## Ajout de mots — route `/add` (raccourci iPhone)

`GET|POST /add?token=<add_token>&word=<mot>&lang=auto` → insère dans D1 pour l'utilisateur du token. Accepte `word`/`lang`/`ignore_sens`/`ignore_sim` en query **ou corps POST** (formulaire), `token` dans l'URL. Réponses **texte** (mêmes formats que l'ancien Apps Script, le raccourci les parse) :

- `INVALID:<raison> | <Langue>[ | SUGGEST:<entrée corrigée>]` — mot non valide. Le 3e segment (facultatif) est la **graphie proposée** par le modèle, **entrée complète** : la note est réattachée (`pnetsar (expresión colombiana)` → `pensar (expresión colombiana)`), sinon le clic « ajouter le mot proposé » la perdrait. `cleanSuggestion()` (Worker) écarte NONE / vide / identique au mot saisi / > 80 car. Segment ajouté **en fin** → le raccourci iPhone, qui ne lit que `[0]` et `[1]`, n'est pas affecté.
  - Front : `_addSuggestion(txt)` + bouton **« ajouter « X » »** à côté de « ajouter quand même » (`addSuggestedRow`). Le mot corrigé est renvoyé **sans `ignore_*`** — il repasse doublon et similarité, cas le plus fréquent. ⚠️ La suggestion transite par `_addBatch[i].suggestion`, **jamais** par l'attribut `onclick` (une apostrophe casserait l'attribut).
- `SIMILAR:<mot> | <Langue>` — variante d'un mot existant
- `Doublon : '<mot>' existe déjà dans <Langue>.`
- `Succès (<Langue>) : '<mot>' ajouté.`

Entonnoir (porté de l'ancien Apps Script, lit les mots existants depuis D1) :
1. **Langue + validité** (**`gpt-5.6-luna`** « low » via `callScriptReasoning`) si `lang=auto` (`analyzeWordLangSense`), sinon `identifyLang` + `validateWord`. Codes ISO `es/fr/en/el` acceptés.
2. **Doublon exact** bloqué.
3. **Similarité** : `normSim` + `similarityScore` sur tous les mots existants, top 5 → **juge LLM** (`judgeSimilarity`, `gpt-5.6-luna`).

`ignore_sens=true` / `ignore_sim=true` bypassent (1)/(3). Retries 429/5xx (3 tentatives).

**Normalisation** (`normalizeWord`) : minuscules, apostrophes unifiées, points isolés retirés, liste blanche de caractères (`cleanBase` admet lettres, **chiffres**, espace, `'¿?,.-+()`). ⚠️ **La virgule n'est plus un séparateur de saisie** (`splitAddInput` : retour à la ligne et `;` seulement) — sans ça une expression comme « cabe inferir, aunque el texto no lo dice, que... » était impossible à taper. Les chiffres ont été rétablis en même temps (« los años 70 » perdait son année). Les **parenthèses** y sont admises → voir « Entrées annotées » (une parenthèse mal formée renvoie `Erreur : <raison>`, sans bouton « ajouter quand même » : l'utilisateur doit corriger).

**Raccourci iOS** : POST le mot dans le corps, `token`+`lang=auto` dans l'URL ; gère `INVALID:`/`SIMILAR:` par alerte « ajouter quand même ? » → renvoie avec `ignore_*`. (Utilise (1)+(3) avec la clé propriétaire.)

**Écran in-app « ➕ ajouter du contenu »** (`screen-add`, depuis l'accueil) : toggle **Mot / Forme grammaticale**. Mot → `/add` avec `myAddToken` + code langue (gère INVALID/SIMILAR + « ajouter quand même »). Forme → `/api/grammar` POST/DELETE (liste + suppression).
- **Langue** : pilules `.filter-btn` (`#add-lang-pills`, `renderAddLangPills()`) construites à partir de `selectedLangs` — plus de `<select>` à 4 langues en dur. Variable `addLang` (plus de lecture DOM). Étirées (`flex:1 1 auto`) et à retour à la ligne : 1 à 4 pilules selon les langues choisies. **Une seule langue** → label + pilules masqués (rien à choisir).
- ⚠️ `#add-word-panel`/`#add-grammar-panel` portent `width:100%` : sans ça, un div enfant du flex `align-items:center` de `.screen` se rétrécit à son contenu et le `width:100%` du textarea vaut 100 % d'un panneau déjà rétréci (boîte de saisie plus étroite que le reste de l'écran).

### Entrées annotées — note entre parenthèses (août 2026)

Une entrée peut porter une **note en fin de chaîne** : `hacer el oso (expresión colombiana)`. La note est du **contexte** (variété régionale, registre, désambiguïsation d'homonyme), **jamais du vocabulaire à réviser**. Stockée dans `words.word` (pas de colonne dédiée, pas de migration) ; la clé de progression/history reste le **texte complet**.

- **Séparation** : `splitEntry(w) → { base, note }` (Worker **et** front). Une parenthèse **collée** au mot en fait partie (`asomar(se)` reste intact) ; seule une parenthèse **détachée par un espace** est une note.
- **Validation** (`assertParens`, Worker) : une seule paire, équilibrée, non vide, en fin d'entrée → sinon **throw** avec un message explicite (`Erreur : parenthèse non fermée…`). ⚠️ Ne jamais revenir à une suppression silencieuse : c'est elle (liste blanche de `normalizeWord`) qui avait fait perdre la note de 28 expressions ajoutées le 2026-08-16 (réparées en D1 le 2026-08-18). Mêmes règles au renommage (`PUT /api/words`).
- **Note** : texte libre (lettres, chiffres, `,;:.!?/'-+`), minuscules, **120 caractères max** (`NOTE_MAX`).
- **`/add`** : doublon exact sur le **texte complet** (`berraco (…enojo)` et `berraco (…inteligencia)` sont deux entrées légitimes) ; validité IA et similarité sur la **base** seule, note passée en contexte au juge LLM (`entryContext`, Worker). Idem `/judge-similar`.
- **Front** : `wordBase`/`wordNote`/`hasNote` · `entryContext(words)` = bloc injecté dans les 6 prompts · `promptLabel(w, all)` = base, **sauf** si deux entrées de la session partagent la même base (alors base + note, sinon ni le modèle ni le parsing ne peuvent les distinguer).
- **Affichage** : base en principal, note en gris (`.word-note`, `.chip-note`, `.mot-note`) sur la carte, les chips, « mes mots » et les révisions ; floutée avec 👁 ; **jamais affichée en mode Situation** avant la réponse. Les chips portent `data-word` = entrée complète — clé de progression et de verdict, que le texte affiché ne porte plus (⚠️ ne pas relire la clé depuis `.chip-word.textContent`).
- **Saisie multi-mots** : `splitAddInput()` coupe sur retour à la ligne et `;` (plus sur `,`), jamais **à l'intérieur** des parenthèses.

### Import Kindle — `kindle_import.py` (refonte juin 2026)
Lit `vocab.db`/`My Clippings` de la Kindle → sélection → import D1. **Config** : `.token` (jeton perso) et `.openai_key` (clé OpenAI dédiée) — **fichiers prioritaires sur `$ADD_TOKEN`/`$OPENAI_KEY_IMPORT`** (sinon une vieille var parasite casse tout). 
- **Validité IA supprimée** : l'import envoie `ignore_sens=true` (les mots viennent d'un dico → un modèle faible ne faisait que les rejeter à tort). Remplacée par un **filtre charabia local** (`is_gibberish` : longueur/voyelle/chiffres, sans IA).
- **Mots trop courants** : `is_too_common` via **`wordfreq`** (es/fr/en/el), seuil `COMMON_ZIPF_MIN` (défaut **5.5**, ~250-300 mots). Repli `TOO_COMMON` si `wordfreq` absent (`pip3 install wordfreq`).
- **Similarité groupée** : `judge_similar_batch` → route `/judge-similar` (GPT-5.6 Luna « low »), `ignore_sim=true` ensuite sur `/add`. **Aucune question** pendant l'import (auto-skip + résumé).
- **Import reprenable** : cache `.kindle_cache.json` = mots **restants** (retirés au fur et à mesure) ; coupure → relance reprend pile. Mot en erreur dure conservé ; maj Kindle sautée tant qu'il reste des mots. `check_token()` = fail-fast au démarrage.
- `call_openai`/`/openai-script`, `get_existing_words`, `llm_decide_similar_batch`, `validate_words_ai`, `review_words` = **code mort** (legacy Sheets).

---

## Modèles IA

Sélectionnable dans ⚙️, persisté `localStorage` (`vocab_model`). `currentModel` ∈ `'gpt4' | 'gemma' | 'geminiflash' | 'geminiflashlite'`. Toutes les requêtes IA passent par `${API_ENDPOINT}` avec `Authorization: Bearer <JWT>` + la clé BYOK en header.

### GPT-5.6 Terra (OpenAI) — `'gpt4'`  ·  `gpt-5.6-terra`
Reasoning model via **Responses API** (route Worker défaut). Pas de `temperature`. Body : `input`, `max_output_tokens`. Vision : `input_text`/`input_image`.
- `reasoning: { effort: gptEffort }` sauf si `none`.
- `max_output_tokens` compte **reasoning + texte**. Eval/QCM/définition : budget **16000**, **doublé** (32000) par `gptMaxTokens()` aux efforts `xhigh`/`max` — sinon le raisonnement consomme tout le budget et la boîte revient vide.
- Streaming SSE : `response.output_text.delta`. **Usage dans `response.completed`**. ⚠️ `usage.output_tokens` **inclut déjà** les reasoning tokens (`output_tokens_details.reasoning_tokens` n'est qu'un sous-détail) → `trackTokens` ajoute **uniquement `output_tokens`**, jamais reasoning en plus (sinon double comptage vs dashboard OpenAI — ancien bug corrigé).
- Fonctions : `callMistral`, `callMistralStream`, `callAIVision` (vision GPT) — envoient `X-OpenAI-Key`. Noms `callMistral*` par héritage.

### Gemma 4 31B — `'gemma'`
Route `/gemini`, `gemma-4-31b-it`. `thinkingLevel` ∈ `minimal`(défaut)|`high` (`NONE`/`thinkingBudget:0` non supportés). Worker filtre les chunks `thought:true`.

### Gemini 3.7 Flash / 3.5 Flash Lite — `'geminiflash'`/`'geminiflashlite'`
`gemini-3.7-flash` / `gemini-3.5-flash-lite`. `thinkingLevel` ∈ `none`(défaut)|`minimal`|`low`|`medium`|`high`. Sans thinking : `temperature: 0.2`.

### Niveau de raisonnement — ⚙️
Un `<select>` dynamique (`updateReasoningUI()`) : GPT→`gptEffort` ∈ `none|low|medium|high|xhigh|max` (défaut low) · Gemini→`geminiThinkingLevel` (défaut none) · Gemma→`gemmaThinkingLevel` (défaut minimal).

### Wrappers
`callAI` / `callAIStream` / `callAIVision` → `checkDailyLimit()` (qui appelle `checkApiKey()`) puis dispatch selon `currentModel`. `isGemini()` = gemma|geminiflash|geminiflashlite.
> Doublon connu : 2 déclarations `callAIVision` (la 2e, GPT, écrase le dispatcher → l'Imagen utilise toujours GPT).

### Compteurs tokens / requêtes
Sous `<h1>Vocab</h1>`, toggle ⚙️ (`KEY_SHOW_TOKENS`). `DAILY_LIMITS = { gpt4: 250000, gemma: 14400, geminiflash: 20, geminiflashlite: 500 }` (RPD réels du palier gratuit AI Studio). ≥80% orange, ≥100% rouge + `checkDailyLimit()` throw. `trackTokens`/`trackGeminiRequest` → `saveTodayTokensDebounced()` (2s). Persistés en **D1** (`/api/usage`) : `saveTodayTokens()` lit la valeur D1 puis ajoute les `_pending*` (multi-appareils).

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
**Slider « nombre de mots » — compteur PAR MODE et valeur souhaitée** : clé `vocab_word_count_<Langue>` (espacé, historique) et `vocab_word_count_<Langue>_free` (libre) via `wcKey(lang, mode)` ; la clé libre absente **replie en lecture seule** sur la clé historique (pas de retour à « 1 mot » au premier passage). Deux notions distinctes :
- **souhaitée** (`desiredWordCount()` / `setDesiredWordCount()`) — écrite **uniquement** sur un geste de l'utilisateur (`onchange="onSliderChange(this.value, true)"`) ;
- **affichée** = `min(souhaitée, pool du jour)`, calculée par `setWordSliderMax()`, **jamais persistée**.
**Quota des nouveaux et slider** : `spacedEligibleSet()` est la **source unique** du pool ajoutable (utilisée par `onSliderChange` et `removeWordFromSession`). Elle retire du quota `maxNewPerDay - todayNewCount` les nouveaux **déjà tirés** (`currentWords` + `previousWordsPool`) et les remet **en tête** de la liste. ⚠️ Sans ça, chaque mouvement du slider rouvrait `newRemaining` places et ajoutait un nouveau de plus — et un autre à chaque fois, la liste des jamais-pratiqués étant re-mélangée à chaque appel (bug du 2026-08-27 : 2 mots dorés pour « 1 nouveau restant »).
⚠️ Ne jamais faire persister la valeur plafonnée (ancien bug) : une journée où un seul mot était dû écrasait le réglage pour de bon et le slider ne remontait plus le lendemain. `setMode()` recale le slider sur le réglage du mode qu'on ouvre (et remet `max=30`, sinon le plafond du mode précédent rogne la valeur).
**Slider « nombre de mots » — perf** : `oninput` → `onSliderPreview()` (libellé seul) et `onchange` → `onSliderChange()` (tirage + re-render, au relâchement). ⚠️ Ne pas remettre le travail lourd sur `oninput` : avec ~6600 mots, le mode Libre saturait le thread iOS et le curseur devenait injouable. Même raison pour `pickWeightedOne()` = **réservoir pondéré en un passage** (aucun `filter`/`map`/`reduce` intermédiaire).
**Limite quotidienne** : `maxNewPerDay` (défaut 60, par langue, `KEY_MAX_NEW`). Slider ⚙️ : valeurs `MAX_NEW_VALUES` = 1,2,3,4,5 puis pas de 5 jusqu'à 100 (`maxNewToIndex`). `pickWords` : `newRemaining = max(0, maxNewPerDay - todayNewCount)`. `onSliderChange` en mode espacé pioche dans le pool éligible `[...trulyDue, ...newToShow]` (jamais `pickWeightedOne`).

### « Étudier » un mot nouveau (mode espacé)

Anti-abandon : quand plusieurs mots inconnus tombent le même jour, écrire une phrase avec 5 mots dont on ignore le sens fait décrocher. On peut alors **étudier** un mot au lieu de l'employer.

- **Éligibilité** : `canStudy(word)` = mode espacé, avant soumission, `isNewWord(word)`, pas déjà étudié. **Auto-limité** : un mot n'est nouveau qu'une fois, donc l'échappatoire s'éteint d'elle-même — aucun quota supplémentaire à gérer.
- **Parcours** : la boîte définition (`#hint-box`) gagne en bas un bouton **« ✓ je l'ai compris — teste-moi »** (`#hint-study`, affiché par `showStudyOffer` **après** l'affichage de la définition). Le coup d'œil à la définition reste gratuit et sans conséquence ; c'est le bouton qui engage. → `startStudyQuiz()` → `startQCM` réutilisé tel quel.
- **QCM d'étude = neutre** : `inStudy` dans `checkQCM` **supprime le `saveProgress(qcmWord, false)`** de l'échec. ⚠️ Sans ça, un ✗ sur un mot jamais employé lui donnerait un net négatif (☆☆☆). Échec n°1 → bouton « autre question » (`retryStudyQuiz`) ; échec n°2 → étudié quand même (le vrai test est demain).
- **Validation** (`markWordStudied`) = exactement « nouveau + ✓ » : `saveProgressNew` (demain, net et étoiles inchangés) + `todayNewCount++` + `saveTodayCount`. **Rien dans `history`** (le mot n'a pas été testé en production).
- **`studiedWords`** (Set de clés lc) + **`sentenceWords()`** = `currentWords` moins les étudiés. ⚠️ Le mot étudié **reste dans `currentWords`** : il garde sa place à l'écran (`.chip-studied`/`.card-studied`, badge `📖 étudié`) **et** dans le total vu par le slider — sinon `onSliderChange` verrait une place libre et tirerait un mot de plus (même piège que le remplaçant de `removeWordFromSession`). `sentenceWords()` est la source unique pour le prompt d'évaluation, `entryContext`, le parsing du verdict, le score `N/total`, la boucle de sauvegarde, les mots liés et l'offre de QCM.
- **Tous les mots étudiés** → plus de phrase à écrire : `updateStudyUI()` masque `#sentence-section` et montre `#study-all-done`.
- ⚠️ `chipHint` : un mot étudié n'est plus « nouveau », mais le cliquer ne doit **pas** déclencher `showJeNeSaisPas` (✗ imérité) → garde explicite sur `studiedWords`. Idem `refreshWordColors` (sinon le mot repasse en blanc « à réviser »).

**Modes Situation + Libre dans la progression** : un **seul toggle** ⚙️ (`situationCounts`, clé `vocab_situation_counts`, **défaut OFF**) gouverne **à la fois** Situation et Libre. OFF → ni étoiles ni SM-2 ni consommation du quota nouveaux/jour (l'**historique** est toujours écrit). En Libre, gardé par `countsProgress = practiceMode !== 'free' || situationCounts` dans `submitSentence` ; en Situation, par `if (situationCounts)` autour de `saveProgress`.

---

## Modes de pratique

- 📅 **Espacée** — SM-2, limite nouveaux/jour. Sliders : nombre de mots (plafonné au pool dispo) + formes grammaticales (1-10, toute langue ayant des formes). Bouton bas **« 📅 mes révisions à venir »** → `screen-revisions` (tous les mots programmés langue courante + prochaine date + étoiles ; tris proche/lointaine/A-Z + recherche). État terminé = carte ✓ seule.
- 🎯 **Situation** — recall actif, mots ★★★ (`net ≥ 3`). Refonte juin 2026 :
  - **Bouton « Commencer »** (`startSituation`, sans icône) à l'entrée du mode → **aucun appel API auto** (`pickWords` tire les mots mais ne génère pas). « Autre situation → » (`nextSituation`) enchaîne directement.
  - **Multi-mots 1-5** : slider dédié `#situation-word-slider` (`situationWordCount`, clé `vocab_situation_words`, défaut 1, plafonné aux mots maîtrisés via `setSituationSliderMax`). Tirage pondéré **sans répétition** de N mots.
  - **Poids de relance** : les mots ratés (`situationMissed`, Set en mémoire de session) pèsent **×4** au tirage jusqu'à réussite (ajout sur ✗/« je ne sais pas », retrait sur ✓).
  - **Génération** (`generateSituation`, sans arg, lit `currentWords`) : 1 mot → scène simple ; N mots → **un seul texte cohérent** (même thème) évoquant tous les mots sans les nommer.
  - **Saisie** (`submitSituation`) : un champ, format numéroté libre (`1. mot, candidat  2. …`), **ordre/numéros ignorés** → matching **ensembliste** par l'IA (✓ par mot si un candidat correspond). Verdict **✓/✗ par mot** + score **N/total** ; couleur `correct`/`partial`/`incorrect`. Sauvegarde par mot (history + progress si toggle).
  - **Liste des ★★★** : bouton bas **« ★★★ mes mots maîtrisés »** (`#mastered-bar`, jumeau de `#revisions-bar`), affiché seulement s'il y a des mots maîtrisés (allumé dans `pickWords`, éteint par défaut + par `setMode`). Il ouvre `screen-revisions` via `openWordListScreen(view)` : **un seul écran** pour les deux listes (`revisionsView` ∈ `due|mastered`), seuls le titre (`data-i18n` réécrit, sinon `applyI18n` le remettrait), le filtre `net >= 3` et le message « liste vide » changent.
  - **UI** : « Je ne sais pas → » / « Autre situation → » (`btn-situation-skip`/`btn-situation-next`) **entre le texte et le champ** (un seul visible à la fois) ; bouton `↑` inline dans le `.textarea-wrap` ; verdict avec **autoscroll** (`startAutoScroll`). Pas de carte « Le mot » séparée : après vérif le verdict nomme déjà le mot ; après « Je ne sais pas » (`revealWord`), le(s) mot(s) sont affichés **dans la boîte de verdict** (`#situation-feedback-box`, rouge, `Le mot était : …`). Saisie **verrouillée** (`lockSituationAnswer`) après réponse, jamais masquée (évite le saut visuel).
- 🎲 **Libre** — tirage pondéré (`pickWeightedOne`). Compte dans la progression **seulement** si le toggle ⚙️ Situation+Libre est ON (sinon historique seul).
  - **Curseur de mélange** (`#free-mix-section`, `freeMix` 0-4, clé `vocab_free_mix`, défaut **2 « équilibré »**) : découverte ↔ révision. Visible **en mode libre seulement**, masqué dans une sélection manuelle (le pool y est imposé). `oninput` = libellé seul, `onchange` = nouveau tirage — jamais sous une phrase en cours ou une correction affichée.
  - ⚠️ **Les poids sont des parts de tirage PAR CATÉGORIE, pas par mot** : `getWeight = FREE_MIX[freeMix][bucket] / effectif(bucket)`. Les anciens poids par tête (10/8/5/1) étaient écrasés par la taille du stock — avec ~6400 mots neufs contre ~380 travaillés, même 1 contre 8 donnait >90 % de neufs et un mot déjà vu ne revenait jamais. Ne pas revenir à un poids par tête. Une catégorie vide disparaît d'elle-même (le total renormalise).
  - `bucketOf(word)` ∈ `new|bad|mid|mastered` (remplace le test `getWeight(w) > 1` du compteur « mots à travailler »). Effectifs mémorisés **pour le tick courant seulement** (`_bucketMemo`, purgé par un microtask) : une passe par salve de tirage, aucun cache à invalider quand la progression bouge, et la passe unique du réservoir est préservée.
- 📸 **Imagen** — photo Unsplash, description espagnol, `callAIVision`. Indépendant de la liste.

---

## Prompts IA

Tous répondent dans `feedbackLang`. `LANGS` = mappings (English, Spanish, French, Modern Greek).

**Mot cible = la `base`**, jamais l'entrée complète (voir « Entrées annotées »). Les 6 prompts (évaluation, définition, QCM, Situation génération + verdict, mots liés) reçoivent en plus `entryContext(words)` : « expression figée, ne pas lire mot à mot » — déclenché par toute entrée **multi-mots**, même **sans note** — et la note quand elle existe. En Situation, le prompt interdit explicitement de citer ou paraphraser la note (elle donnerait la réponse).

### Évaluation
Deux **BLOCS indépendants** : (1) **Verdict** ✓/✗ sur le(s) mot(s) cible(s) (un ✗ → verdict ✗ ; mot absent → ✗) ; (2) **Analyse linguistique** (grammaire/registre/ponctuation), indépendante du verdict.
**Version améliorée — lexique figé / grammaire libre** (6 règles) : chaque entrée cible doit apparaître, jamais remplacée par un synonyme ou un équivalent moderne (règles 1-2) ; **mais** elle DOIT être fléchie pour entrer dans la phrase (conjugaison, accord, clitiques, déterminant — règle 3), les mots grammaticaux que l'apprenant a mis autour de l'expression peuvent sauter (règle 4 : plus de « como cualquier **un candidato** de corte y pinta »), la **grammaticalité prime** sur le collage littéral (règle 5), et la note entre parenthèses n'entre jamais dans la phrase (règle 6). Vaut pour 1 mot comme pour N. ⚠️ Ne jamais revenir à « MUST use the exact target word(s) as given » : c'est cette formule qui produisait *« a que **da a luz** »* au lieu de *dieran a luz*. Une flexion fautive du mot cible est signalée en **Analyse linguistique**, jamais dans le verdict.
Règles : period/semicolon/colon entre phrases = TOUJOURS correct · analyser UNIQUEMENT l'écrit · accepter archaïsmes/dialectes · **CRITICAL FILTER** (items incertains/corrects → silently dropped) · version améliorée seulement si ✓ (italique, mot cible exact).
Format : `## Verdict`, `## Analyse linguistique`, `## Version améliorée`.
**Parsing verdict (multi-mots)** : pour chaque mot, 1re ligne contenant **`promptLabel(w, currentWords)`** — le libellé réellement envoyé au modèle, pas l'entrée complète (sinon aucun match → tous les mots comptés ✗) — puis 1er `✓`/`✗`. Regex tolérante aux variantes emoji (`OK_RE=[✓✔✅]`, `KO_RE=[✗✘❌]`). `wordResults` (mot→bool) = **source unique de vérité** (couleur boîte, score `N/total`, contours mots, QCM). **Piège accents** : frontières Unicode `(^|[^\p{L}])mot([^\p{L}]|$)` flag `u`, jamais `\b…\b` ASCII (échoue sur accentués, critique pour le grec).
**Gravité des remarques** (2026-08-28) : le prompt n'imposait aucun ordre, donc le modèle listait dans l'**ordre de lecture du texte** — une majuscule oubliée (premier caractère) passait presque toujours en tête, et l'aperçu replié de 2 lignes ne montrait qu'elle.
- **Prompt** : B2-STEP 3 attribue à chaque erreur `[MAJ]` (langue fausse : accord, conjugaison, mode, genre, préposition, **et les accents** — une faute d'accent est orthographique, pas typographique) · `[MIN]` (correct mais pas idiomatique) · `[DET]` (majuscules, ponctuation, espaces). Liste triée du plus grave au moins grave, chaque item **préfixé du marqueur ASCII** juste après son numéro.
- **Front** : `renderAnalysisBody(body, final)` (appelé via `feedbackBodyHtml`, actif seulement si `hasSeverityTags`). En **streaming** → pastilles seules, **ordre du modèle conservé** (trier en direct ferait sauter les items sous les yeux). Au rendu **final** → tri stable + les `[DET]` repliés dans un `<details>` « N détails de forme ».
- ⚠️ Un item **sans marqueur** est traité en `MIN` et garde sa place : on ne perd jamais une remarque parce que le modèle a oublié l'étiquette. Un corps sans aucun marqueur retombe sur `renderMarkdown` (ancien format, mode Imagen).
- Pastilles `.sev` en `currentColor` : elles doivent rester lisibles sur les trois états vert / orange / rouge de la boîte.

**Rendu de la boîte** (`renderFeedbackSections`) : après le streaming, re-rendu en **sections repliables** (verdict ouvert, reste = aperçu 2 lignes `-webkit-line-clamp`), bouton « tout déplier/replier », **note `N/total` en bas**. Couleur boîte 3 états : `.correct` vert (tout ✓) / `.partial` orange (quelques ✗) / `.incorrect` rouge (tout ✗) — ⚠️ `.partial` doit être dans **tous** les `classList.remove` (sinon orange bloqué). Bordure neutre pendant le streaming.

### Définition
Cache `definitionCache["mot|lang|model"]` 24h. Lock `_hintInFlight`. 3 sections `##` : **Sens** (polysémie : liste numérotée, **max 3** sens distincts, **un exemple en italique par sens**), Registre (global, étiquette « (sens N) » si diffère), Collocations. Budget tokens `4000` (relevé pour 3 sens). Le prompt interdit de sur-découper les nuances ; 1 sens → 1 entrée.

### QCM
4 scénarios (le mot cible n'apparaît pas), 1 correct + 3 distracteurs, Fisher-Yates JS. JSON via regex.

### Mots du même univers (`fetchRelatedWords`)
1 mot → 3 du même champ ; N mots → 3 liés (`relatedTo`). **Rendu = carte, pas pilule** : `.related-chip` en colonne (`.rel-head` = mot + `↖ relatedTo` + `＋` · `.rel-note` dessous), `min-width:0` + `overflow-wrap` — une note longue passe à la ligne au lieu de pousser la carte hors de la boîte. Note cadrée à **12 mots max** dans le prompt (idem « Vocabulario sugerido » du mode Imagen, même CSS). Affiché après ✓, filtre `allWords` + `blacklistWords`, `＋` pour ajouter. **Blacklist** : les mots affichés mais non ajoutés partent en `/api/blacklist` (fire-and-forget) et ne sont plus jamais suggérés. **Point de sortie unique = `flushBlacklist()`, appelé en tête de `resetPracticeUI()`** — donc aussi par `setMode`, `selectLanguage`, la file du mode libre et `nextSituation`. ⚠️ Jusqu'au 2026-08-28 seul `nextWord()` blacklistait : tout mot vu puis quitté par un autre chemin était perdu (214 lignes en base, mais des suggestions qui revenaient). Un second flush sur **`pagehide`** (`keepalive: true` — `sendBeacon` ne permet pas l'en-tête JWT) couvre la fermeture de l'app.

### Mode Imagen (vision)
Prompt anglais, réponse espagnol. Sections : `## Precisión`, `## Análisis lingüístico` (CRITICAL FILTER), `## Vocabulario sugerido` (JSON `[{word,note}]`). Convention `(?)` pour mot inconnu. JSON extrait, retiré du rendu, chips avec `＋`.

---

## Comportements UI / iOS

### Écrans
`screen-loading`, `screen-auth`, `screen-lang`, `screen-practice`, `screen-stats`, `screen-history`, `screen-mots`, `screen-revisions`, **`screen-add`** (ajouter du contenu). `showScreen(id)` (déclenche `updateLangBadges` sur screen-lang). Écrans-listes ancrés en haut (`align-self:flex-start`) — titre/recherche figés quand la liste change. **Modales** : `#help-modal` (instructions), `#lang-picker-modal` (choix langues), `#word-ctx-menu` (menu ⋯). `screen-lang` : grille langues (badges vert/rouge `updateLangBadges`) + 📊 stats / 📋 historique / 📝 mes mots / ➕ ajouter / ❓ aide / 🚪 logout.

### Mes mots (`screen-mots`, `showMots`)
Voir/chercher/renommer/supprimer + **étoiles** (`motsStars`, charge progress des 4 langues). Charge les 4 langues (`/api/words?...&detail=1`), tri **chronologique** (récent d'abord, `created_at`), filtres par langue + compteurs, recherche live. Lignes `.mot-row` : case à cocher + drapeau + mot + étoiles + date + 🔍 (`verifyMot` → vérif du sens) + ✏️ (`editMot` → `PUT /api/words`, refuse collision) + 🔀 (`moveMot` → transfert de langue) + 🗑 (`deleteMot` → `DELETE`). **Pagination** (`motsPageSize` 5/15/25/50/100, défaut 25 ; `motsPage` ; `#mots-controls`) — la recherche/filtre porte sur **tous** les mots, l'affichage est paginé (fluide à ~10000 mots). **Sélection multiple** (`motsSelected` Set `lang|word`, multi-langues) : case par ligne + « tout sélectionner (cette page) » + barre « N sélectionnés → 🔀 / 🗑 » (`moveSelectedMots` ; `deleteSelectedMots` → `DELETE {items:[…]}` groupé, confirmation). `screen-revisions` a aussi étoiles + recherche.

### Mots cachés (👁) · Chips cliquables
Toggle header, raccourci `Opt+←` (blur 7px). `Opt+→` = `nextWord()`. À la **vérification**, les mots cachés réapparaissent (`revealHiddenWords`). Mot nouveau → `fetchHint`. Mot à réviser (avant soumission) → `showJeNeSaisPas` → `saveProgress(false)` + `startQCM` (1 seul QCM/mot via `_qcmStartedWords`). Casse : affichage + prompts en **minuscules** (`lc()`), DB en casse d'origine.

### Édition / suppression de mot (bouton ⋯)
Le clic-droit/appui long est **retiré**. Carte + chips ont un bouton **« ⋯ »** (`openWordMenu`) → `#word-ctx-menu` avec **✏️ Modifier** (`editWordOnCard` → `PUT /api/words`, propage à words+progress+history), **🔀 Changer de langue** (`ctxMenuMove` → sous-menu `#ctx-langs` dans le même popup) et **🗑 Supprimer** (`deleteWordFromSheets`, nom hérité : `DELETE /api/words` mot+progress). Ferme au clic dehors ; `closeWordContextMenu` repasse toujours au 1er niveau (`ctxMenuBack`).

### Traduire un mot (🌐) · Voir une image (🖼)

`wordGloss(word, lang)` : **un seul appel front** (`callAI`, BYOK + modèle de ⚙️) qui renvoie `{translation, english, concrete}` — la traduction sert l'affichage, `english` + `concrete` servent l'image. Cache mémoire `translationCache["mot|appLang"]`.
- **Langue de sortie = `appLang`** (langue de l'appli), pas `feedbackLang`. Rien n'est stocké en D1 : changer de langue d'interface reste libre (c'est ce qui a fait écarter une colonne « glose » calculée à l'ajout).
- **Points d'entrée** : menu ⋯ (`ctxMenuTranslate` / `ctxMenuPhoto`) et lien « 🌐 traduire » dans la boîte définition (`hintTranslate`). Masqués en mode **Situation** (`.ctx-gloss-btn`, `showWordContextMenu`) : le mot y est la réponse à trouver.
- **Anti-triche** (`requestGloss`) : gratuit sur un mot **nouveau** ; sur un mot **à réviser**, passe par `showJeNeSaisPas` (✗ + QCM) et la glose ne s'affiche qu'après confirmation (`_pendingGloss`, repris dans `confirmJeNeSaisPas`) — même règle que la définition.
- **Image** : `concrete: false` → message, **aucun appel Unsplash**. Sinon `/unsplash` avec `query = english` (la route accepte déjà un `query`). Affichée dans `#word-image-box`.

### Vérifier le sens d'un mot (🔍)

`verifyWordSense(word, lang)` : le mot existe-t-il vraiment ? Appel **front** (`callAI`, clé BYOK + modèle et raisonnement de ⚙️) — l'entonnoir `/add` valide avec la clé propriétaire, un modèle plus faible, et n'est pas exposé pour un mot déjà en base. Prompt sur la **base** seule + `entryContext`, réponse JSON `{valid, note, suggestion}`, `note` en une phrase dans le `feedbackLang` de la **langue du mot** (pas de la langue courante : « mes mots » est multi-langues). Budget `isGemini() ? 800 : 16000` (GPT = reasoning + texte dans le même budget).
- Le prompt **accepte** archaïsmes, régionalismes, dialectes, registres familiers et mots rares : invalide seulement une coquille, une chaîne tronquée ou un mot d'une autre langue. Le verdict **propose**, il ne supprime jamais tout seul (c'est la validité IA à tort qui a été retirée de l'import Kindle).
- **UI** : `openVerifyPopup(word, lang, ev, actions, t)` réutilise `#word-ctx-menu` (3e panneau `#ctx-verify`, classe `.verify` pour élargir le popup). Spinner → verdict ✓/✗ + explication ; si invalide : **✏️ Corriger** (graphie suggérée pré-remplie dans `editWordOnCard(word, prefill)` / `editMot(lang, word, prefill)`) et **🗑 Supprimer**. `ctxMenuBack()` replie aussi ce panneau.
- Deux points d'entrée : `ctxMenuVerify()` (menu ⋯ de la carte/chips, libellés en langue **pratiquée** via `tPrac`) et `verifyMot(lang, word, ev)` (bouton 🔍 par ligne de « mes mots », langue de l'**appli**) — même convention que `ctxMenuMove` ↔ `openLangMenu`.

Suppression et transfert partagent **`removeWordFromSession(word)`** : retrait de `allWords`/`currentWords`/`previousWordsPool`/`progressMap`/`definitionCache` + pioche d'un remplaçant (ou `nextWord()` si plus rien).

### Transfert de langue (mot mal classé)
`PUT /api/words` avec **`newLang`** déplace `words` + `progress` + `history` → étoiles et `next_review` suivent le mot. Refus 409 si le mot existe déjà dans la langue cible (jamais d'écrasement). Un `DELETE` préalable retire une éventuelle ligne `progress` **orpheline** côté cible (PK `user_id+language+word`).
- **Carte / chips** : menu ⋯ → 🔀 → langue → `moveWordToLang()` puis `removeWordFromSession()`.
- **Mes mots** : 🔀 par ligne (`moveMot`) + **action groupée** sur la sélection (`moveSelectedMots`, multi-langues : chaque mot part de SA langue, les échecs sont listés à la fin).
- **`openLangMenu(ev, label, excludeLang, onPick)`** réutilise `#word-ctx-menu` comme popup de choix de langue (positionné au clic, `stopPropagation` sinon le listener global le referme aussitôt).

### Couleurs / contours des mots
- Nouveau : doré (`--accent`) · À réviser : blanc (`chip-review`/`card-review`).
- Après sauvegarde, `refreshWordColors()` recale doré/blanc **sans re-render** (un `renderWordDisplay()` effacerait les contours ✓/✗) : un nouveau mot validé reçoit sa date de révision et cesse aussitôt d'être doré.
- **Après vérification** : contour vert (`--success`) si ✓, rouge (`#e05a5a`) si ✗ (`applyWordOutlines` d'après `wordResults`, classes `chip-correct/incorrect`/`card-correct/incorrect`), reset au mot suivant.

### Champs / boutons
- Inputs : `input[type=password|email]` stylés pareil (fond surface, radius), autofill Safari neutralisé (`-webkit-autofill`).
- Bouton Vérifier inline iMessage (`.btn-submit-inline` dans `.textarea-wrap`), `↑`/spinner.
- `#btn-next-below` « Autre mot → » après ✓ (autoscroll sauf `scroller.stoppedAtTop`).
- Bouton Réessayer injecté après échec API.
- Protection double soumission (`lastSubmittedSentence`) + « Autre mot » avec phrase non vérifiée (`confirm()`).
- **Attente d'une boîte** : `SPINNER_BOX` (`<div class="spinner-wrap">`, flex centré) pour verdict / définition / situation / verdict Situation — écrasé avec l'`innerHTML` au 1er chunk, donc **rien à nettoyer** (pas de classe posée sur le conteneur, pas de résidu possible). Les spinners **dans un bouton** ou suivis d'un libellé restent des `<span class="spinner">` inline.

### iOS
- `--safe-top` par JS **uniquement en PWA standalone** (iPhone 59px, iPad 44px) ; en Safari normal on garde `env()` ≈ 0 (sinon gros rideau noir inutile). `#status-curtain` (CSS pur, `z-index:9999`).
- **PWA** : `manifest.json` `start_url:"./"` (relatif — `/vocab-app/` faisait un 404 sur byov.net). `apple-mobile-web-app-capable`, `apple-touch-icon` = `icon.svg`.
- **Sticky bar `#sticky-words-bar` : retirée** (instable en PWA ; `_updateStickyVisibility` = no-op, élément `display:none`).
- **Autoscroll clavier retiré** (trop glitchy — on laisse iOS gérer le focus). L'app ne déclenche **aucun** scroll au focus (handler `focus` du textarea supprimé ; pas d'auto-focus du champ Situation). Auto-scroll **streaming** conservé : `startAutoScroll(box, spacer)` suit le bas, stoppe quand le haut atteint `PAD_TOP`, spacer dynamique, interrompu par `wheel`/`touchmove`. ⚠️ **Ne jamais pré-allouer `#scroll-spacer`** : la vérification gonflait le spacer d'un écran entier *avant* le 1er chunk → grand rectangle vide sous la boîte dès le clic. Il grandit uniquement via **`growSpacer(spacer, px)`**, qui pose `height` **et** `display` — les anciens appels ne réglaient que `height` sur un spacer en `display:none`, donc l'autoscroll de Situation et de la définition ne pouvait pas étendre le document. Définition : remonte le haut de la boîte en fin de streaming. Le verdict Situation utilise aussi `startAutoScroll`.
- **Changement de mode** : `setMode()` appelle `resetPracticeUI()` (nettoyage complet) → plus de résidu d'un autre mode (définition `#hint-box`, feedback/boutons Situation, QCM, mots liés…).

### Historique / stats
Lus depuis D1 en parallèle (`/api/history` journal + `/api/progress` scores cumulés). Filtre par langue.

### renderMarkdown
`**gras**`, `*italique*`, `##` → `<br><strong class="md-h2">…</strong><br>`, `•` puces. Max 2 `<br>`. `.md-h2` stylé selon contexte (image = label DM Mono ; correct/incorrect = couleur héritée).

---

## Problèmes connus

1. **gpt-5.6 hallucinations** : rares. Garde-fous prompts (CRITICAL FILTER) imparfaits.
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

## Groupes de mots (2026-08-29)

Chaque mot appartient à **0 à 3 groupes thématiques**, **par langue** (les groupes sont nommés dans la langue pratiquée : *comida* en espagnol, *nourriture* en français). Taxonomie de 88 groupes construite à partir du corpus réel : 38 espagnols, 24 français, 14 anglais, 12 grecs.

| Table | Colonnes |
|---|---|
| `groups` | id, user_id, language, **name**, **kind** (`theme`\|`lot`), **scope**, created_at — `UNIQUE(user_id, language, name)` |
| `word_groups` | user_id, language, word, group_id, **auto** (1 = posé par l'IA, 0 = à la main) |
| `words.grouped` | 0/1 — un mot classé dans *zéro* groupe est indiscernable d'un mot jamais traité |

Migrations `0004_groups.sql` (tables + colonne) et `0005_group_scope.sql` (`groups.scope`).

- **`scope`** = ligne de portée du groupe (« ce qu'il contient, et surtout ce qu'il ne contient pas »). ⚠️ **Indispensable** : avec le seul nom, le modèle lisait « fórmulas del ensayo y la crítica » comme « tout ce qui est intellectuel » et y rangeait des adjectifs. Sert aussi de définition à l'écran de gestion.
- **`auto`** : un reclassement ne recalcule QUE les lignes `auto = 1`. Tout ce qui passe par `/api/word-groups` est `auto = 0`.
- **Changement de langue** (`PUT /api/words` avec `newLang`) → les rattachements **tombent** (ils appartiennent à la taxonomie de l'ancienne langue) et le mot repasse à `grouped = 0`. Un simple renommage les garde. `DELETE /api/words` les supprime.

### Routes
- `/api/autogroup` POST (**JWT ou token perso**, clé OpenAI de l'utilisateur — header sinon `users.openai_key`, jamais de repli propriétaire) → classe `body.words` ou, à défaut, les `limit` premiers mots `grouped = 0`. `dry: true` rend le verdict sans écrire. `model` ∈ luna\|terra.
  - Prompt : **numéros des deux côtés** (groupes ET entrées) — 3× moins de tokens et plus aucun rapprochement de chaînes ; hors liste, l'index est ignoré, donc le modèle ne peut pas inventer de groupe.
  - Front : `autogroupAfterAdd(texts)` appelé après un ajout réussi (un appel par lot collé, fire-and-forget ; la langue est lue dans la réponse de `/add`).
- `/api/groups` GET (effectif + jauge `mastered` en une requête) · POST · PUT (nom, scope) · DELETE (relâche les mots à `grouped = 0`)
- `/api/word-groups` GET (`?group_id=`) · POST · DELETE — toujours `auto = 0`

### UI
- **Mode libre** : bouton **🏷 groupes** → `#groups-modal` (liste + jauge `12/128 ★★★`, choix multiple) puis **tous / au hasard N / à la main**. Le « au hasard » est un **tirage pondéré restreint au groupe** (`pickWeightedOne(picked, pool)`), donc gouverné par le curseur de mélange.
- **`beginFreeQueue(list)`** = point d'entrée unique d'une file imposée (recherche manuelle ET groupe) — sans lui les deux chemins recalaient le slider différemment.
- **`screen-groups`** (⚙ gérer) : renommer, supprimer, créer un groupe ou un **lot d'étude** (N mots tirés par `pickWeightedOne`, `kind='lot'`, jamais alimenté par l'IA).
- Les mots d'un groupe s'affichent dans `screen-revisions` via **`revisionsView = 'group'`** — un mot de groupe peut n'avoir jamais été pratiqué, d'où `next` vide → tiret, et compteur « dûs aujourd'hui » réservé à la vue `due`.

### Classement initial (2026-08-29)
9 785 mots en 96 appels **gpt-5.6-luna « low »**, ~0,30 $. Mesure faite avant de choisir : **luna comparé à lui-même = 90/100 verdicts identiques** ; luna vs terra = 86/100, donc dans le bruit (terra gagne 4 fois, perd 4 fois sur 14 divergences). Résultat : 1,5 % de mots sans groupe en espagnol, 2,4 % en français (des formes fléchies nues — refus justifié), 0,7 % en anglais après ajout de deux groupes manquants (*change, process & consequence* et *nature, body & the physical world* : la taxonomie anglaise, pensée « par registre », n'avait aucune étagère pour le concret). ~1,01 groupe par mot : le classement est en pratique mono-groupe.

### Refaire la taxonomie (`mode: 'propose'`)
`/api/autogroup` avec `mode: 'propose'` envoie **tout le corpus de la langue** (plafond `PROPOSE_MAX` = 5000 entrées tirées au hasard) et rend une liste de groupes `[{name, scope}]`, **sans rien écrire**. Nombre visé calculé sur la taille du corpus (`targetGroupCount` : 12 / 18 / 24 / 38). Le prompt impose de **réutiliser le nom exact** d'un groupe existant qui convient encore, et de prévoir des catégories **fonctionnelles** si le corpus est riche en locutions.
- Front : `screen-groups` → **⟳ refaire la taxonomie** → panneau de validation (nouveaux groupes cochables, descriptions à mettre à jour, groupes « plus proposés » simplement signalés). ⚠️ **Jamais de suppression automatique** : elle emporterait aussi les rattachements manuels.
- **🏷 classer les mots sans groupe** (`reopen: 'orphans'`) rouvre les seuls orphelins puis les repasse par lots de 100 — ce qui rend l'ajout d'un groupe rattrapable sans tout reclasser. Validation croisée : relancée à l'aveugle sur le grec, la passe a retrouvé **exactement** les 12 groupes existants.

### Rattacher un mot à la main
- Menu ⋯ → **🏷 Groupes** (`ctxMenuGroups`, panneau `#ctx-groups`) : liste cochable, bascule optimiste avec retour arrière si le réseau échoue.
- « mes mots » → **🏷** sur la sélection (`groupSelectedMots` + `openGroupMenu`, jumeau d'`openLangMenu`). Les groupes étant par langue, une sélection **multi-langues est refusée** explicitement.
- `GET /api/word-groups?lang=&word=` rend les groupes d'un mot.
- `kindle_import.py` : `parse_added()` + `autogroup()` — classement **après** l'import, un lot de 100 par langue, best-effort.

### Groupes virtuels et pools
`VGROUPS` (ids **négatifs**, jamais en base) : **★★★ maîtrisés** · **à travailler** · **sans groupe** (celui-ci via `GET /api/word-groups?ungrouped=1&lang=`). Offerts dans le même sélecteur que les vrais groupes — d'où l'absence d'un mode « pratiquer les maîtrisés » séparé.
- **Sémantique du pool** (`resolveGroupPool`) : les vrais groupes s'**additionnent**, les virtuels **filtrent** ce qui en sort (« comida ∩ maîtrisés »).
- **Situation et Libre offrent les MÊMES commandes** (🏷 groupes · 🔍 chercher un mot · 👁 voir les mots · ✕ quitter) et le même sélecteur avec les mêmes sous-options. Seule l'exploitation du pool diffère, et elle passe par **`usePool(words, label)`** : file à parcourir en Libre, **restriction du tirage** en Situation (`_sitGroupWords`).
- Sans sélection, Situation se pratique sur les ★★★ ; **avec** sélection, elle fait foi telle quelle — le filtre « maîtrisés » étant offert comme **groupe virtuel**, l'imposer par-dessus ignorerait un choix explicite. Le sélecteur pré-coche donc ★★★ en Situation au lieu d'appliquer un filtre invisible.
- **👁 voir les mots** (mode libre) : ouvre le pool trié par **poids de tirage décroissant** — avec le curseur de mélange tout est « possible », seule la probabilité change. Passe par `openWordListScreen('group', {keepOrder:true})` → `revisionsSort = 'given'`.

### La file ne se termine plus toute seule
⚠️ Avant : file épuisée → `freeQueueActive = false` et retour **silencieux** dans tout le stock, alors qu'on croyait travailler son groupe. Désormais elle **reboucle** (`freeLap++`, ordre re-tiré par `reorderQueueByWeight` → les mots ratés reviennent en tête) et seul le bouton ✕ en sort. Le compteur affiche `🏷 <groupe> · tour N`.

### « Mes mots » : filtre par groupe
Seconde ligne de pilules (`#mots-group-filters`), **masquée sur « Tout »** (les groupes sont par langue) : `tous · ★★★ · à travailler · sans groupe · <groupes> · ⚙ gérer`. `openGroupsManager(lang, back)` — l'écran de gestion s'ouvre donc sur une langue qui n'est pas forcément celle qu'on pratique (`_manageLang`, `_manageBack`) ; le bouton « lot d'étude » est masqué dans ce cas (un lot se tire dans le stock de la langue **pratiquée**).

### Divers
- **Mélange par langue** : `vocab_free_mix_<Langue>` via `freeMixKey()`, **repli sur l'ancienne clé globale** (même motif que la grammaire). Recalé par `selectLanguage()`. Le curseur vit dans **⚙**, avec les autres réglages de la langue — pas sur l'écran de pratique.
- **`progress.last_practiced`** est désormais chargé côté front (`progressMap[...].lastPracticed`) → tris **A-Z / vus récemment / les plus anciens / jamais vus** dans « chercher un mot » (« jamais vus » filtre en plus de trier ; « les plus anciens » renvoie les jamais-vus en fin, ils ne sont pas « anciens »).

### `screen-mots` — visuel (2026-08-29)
Retenu après essai comparatif : **cartes** (inchangé) · **sélection à la ligne** · **en-tête collé** · densité aérée.
- `.mots-head` = `position: sticky; top: var(--safe-top)` autour du titre, de la recherche, des deux lignes de pilules et de la pagination. Elle **porte le fond** (`--bg`), sinon la liste défilerait au travers.
- **Plus de case native** : `.mot-row.selectable` bascule au clic n'importe où, `.sel` allume la bordure et un ✓ (`toggleMotRow` ignore les clics sur 🔍 ✏️ 🔀 🗑). Même idiome que `.free-pick-row`.
- ⚠️ Écartés : le défilement imbriqué (famille de solutions déjà retirée en PWA iOS, cf. `#sticky-words-bar`) et l'en-tête qui se réduit (essayé, jugé instable à l'usage).

## Idées futures

**Faites ✅** : Auth Google + email/mdp · migration Sheets → D1 · BYOK + sync · ajout de mots `/add` (token) · **écran « ajouter du contenu » in-app (mots + formes grammaticales)** · Mes mots (+ étoiles) · calendrier des révisions (tri + recherche + étoiles) · **sync de tous les réglages** · **langues configurables par utilisateur** (sous-ensemble des 4) · **page d'instructions (modale)** · **boîte de vérif repliable** · `kindle_import.py` → `/add`/D1 · compteur tokens corrigé · PWA `manifest` corrigé · déploiement prod · **refonte mode Situation** (bouton Commencer, multi-mots 1-5, poids de relance ×4, verdict par mot + score, autoscroll, UI cohérente) · **toggle progression Situation+Libre** · **refonte import Kindle** (validité IA off + filtre charabia/`wordfreq`, similarité groupée GPT-5.6 Terra via `/judge-similar`, **clé Kindle dédiée** `.openai_key`, import reprenable) · **« mes mots » paginé + sélection multiple/suppression groupée** · **notes entre parenthèses** (`hacer el oso (expresión colombiana)`) + traitement « expression figée » automatique pour toute entrée multi-mots · **formes grammaticales dans les 4 langues** (réglages par langue, libellé `{lang}`) · **transfert d'un mot d'une langue à l'autre** (menu ⋯, mes mots, action groupée) · spinners centrés · **modèles 2026-08** (GPT-5.6 Terra, Gemini 3.7 Flash / 3.5 Flash Lite, efforts `xhigh`/`max` + budget doublé) · **version améliorée : flexion autorisée, lexique figé** · **cartes « même univers » sans débordement** · **slider Libre débloqué** · **compteur de mots par mode + valeur souhaitée persistante** · **pilules de langue + panneaux pleine largeur dans « ajouter »** · **« 🔍 vérifier le mot »** (menu ⋯ + « mes mots ») · **quota des nouveaux mots respecté quand on bouge le slider** · **liste « ★★★ mes mots maîtrisés »** (mode Situation) · **entonnoir d'ajout sur gpt-5.6-luna** (10× moins cher, qualité vérifiée) · **spacer d'autoscroll non pré-alloué** · **« étudier un mot »** (définition + QCM à la place de la phrase, nouveaux mots seulement) · **traduction et image d'un mot à la demande** · **graphie proposée à l'ajout** · **curseur de mélange du mode libre**.

**À faire / à concevoir** :
- **BYOK total** : le **raccourci iPhone** utilise encore `OPENAI_API_KEY_SCRIPT` (pas d'UI BYOK). La Kindle, elle, est passée BYOK (`.openai_key`).
- **Plus de 4 langues** : les 4 possibles sont codées en dur dans `LANGS` (mappings, prompts, détection `/add`). Pour une langue hors-liste, il faudrait généraliser `LANGS`.
- **Rotation `WORKER_SECRET`** + suppression secrets morts (`SA_JSON`, `OPENAI_API_KEY`, `GEMINI_KEY`).
- **Sécurité/scalabilité** : OK pour des centaines d'utilisateurs ; 1ers plafonds = quotas D1 gratuits (~100K écritures/j) + clé `/add` du propriétaire.
- **PWA** : service worker (offline) · **App Store** via Capacitor (Apple Dev $99/an).
- **Gérer mes langues** : pouvoir retirer une langue quand on a les 4.

> Case study portfolio : `~/Desktop/vocab-app/portfolio-case-study.md` (ES+EN).
