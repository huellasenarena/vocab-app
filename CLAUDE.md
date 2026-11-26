# Vocab App (BYOV) — l'essentiel

App single-file `index.html` (GitHub Pages) **multi-utilisateur**. Backend = **Cloudflare D1** via un Worker. Auth = email/mdp + Google OAuth (JWT). IA = **un seul modèle, `gpt-6.1-terra`**, réflexion `none` : clé OpenAI de l'utilisateur, sinon celle du propriétaire (10 mots/jour). L'utilisateur écrit en **français**.

> **Le détail et le « pourquoi » de chaque décision** sont dans `docs/historique.md` (l'ancien CLAUDE.md complet, 700 lignes, figé au 2026-11-26). Ne pas le charger d'office : le lire (grep) avant de toucher à une zone — manche, QCM, curseurs, sync, prompts… Les ⚠️ ci-dessous en sont le résumé.

- URL : https://byov.net (ancienne : huellasenarena.github.io/vocab-app). Repo **public** `~/Desktop/vocab-app/`.
- Push sur `main` → GitHub Actions → `gh-pages` (~1 min). **Ne jamais éditer `gh-pages`.** `cname: byov.net` est dans `deploy.yml`.
- Worker versionné dans `dark-brook-87cc/` — **toujours `wrangler deploy` depuis ce dossier** (un deploy depuis la racine crée un `wrangler.jsonc` parasite).

## Workflow
```bash
# vérifier le JS avant tout push
node -e "const fs=require('fs'),h=fs.readFileSync('index.html','utf8'),m=h.match(/<script>([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/check.js',m[1]);" && node --check /tmp/check.js && echo OK
# Worker
cd dark-brook-87cc && node --check src/worker.js && wrangler deploy
# migrations D1
wrangler d1 migrations apply vocab --remote
```
Dev local : `wrangler dev` (+ `.dev.vars`) et `python3 -m http.server 8080` ; `API_ENDPOINT` bascule sur `:8787` en localhost. Le Worker répond `Access-Control-Allow-Origin: *`.
Avant un changement visuel : **page de test (artifact) à variantes combinables**, l'utilisateur choisit (« 1 a · 2 c… »). Citer la page et les choix dans le commit.

## Estilo
@~/Desktop/estilo/estilo.md

### Excepciones en este proyecto
- Tokens collés dans le `<style>` (bloc « Estilo común — copiado de ~/Desktop/estilo ») : ne pas les éditer ici. **Thème sombre** (`oscuro.css`). `--barra-estado` sombre dans les deux thèmes.
- Mono du système seulement pour le technique (tokens, clés, lien d'ajout, `code`).
- **Colonne étroite centrée** (`.screen`, 480 px), contenu aligné à gauche.
- Popups/modales (`#word-ctx-menu`, `.modal-card`) : papier + filet `--linea-fuerte`, sans ombre ni radius.
- Pastilles un peu plus grandes (`6px 16px`, `--t-nav`) : app au pouce.
- ⚠️ `base.css` colore le survol de **tout** `button` (dans `@media (hover: hover)`) : chaque bouton non-pastille le neutralise avec `.classe:hover:not(:disabled)`.
- `input[type=range]` et cases à cocher : `border:0; padding:0`.
- **Pas d'emojis ni de symboles dans l'interface**, des mots. Restent : étoiles `★☆` (donnée), `→` dans une phrase, ✓/✗ des prompts et du parsing (`OK_RE`/`KO_RE`), ✓/✗ en marge d'une réponse de QCM (`markQcmChoice`), ▸/▾ au bout d'un titre repliable, `+` du carré « nuevo grupo », `⌫` du clavier.
- Pastilles flottantes centrées en bas : `#catchup-btn`, `#back-current-btn`. « Reprendre / Nouvelle manche » centrés quand une manche attend.
- Bascule « diaria / grupos » : pastille coupée par **une seule** diagonale (`.diag`).
- Mouvement permis : couleur au survol, fondu de photo, spinner. Rien d'autre.

## Langue de l'interface
Accueil et ce qu'on ouvre depuis lui = **langue de l'appli** (`tApp`). Tout ce qui vit dans la page d'une langue (pratique, menu ⋯, sélecteurs) = **langue pratiquée** (`tPrac`, `applyPracticeLangUI`). Un texte en dur dans la page d'une langue est un bug. Libellés dans `I18N` (en/fr/es/el). `{lang}` dans une traduction = nom de la langue courante.

## Worker (`dark-brook-87cc/src/worker.js`)
URL `https://dark-brook-87cc.georg-dreym.workers.dev`.
- Auth : `/auth/signup`, `/auth/login`, `/auth/google` (lie par email), `/me`.
- `/add` (token perso, sans JWT) : ajout de mot (raccourci iPhone, écran « ajouter », Kindle). Réponses texte `INVALID:… | Langue[ | SUGGEST:…]`, `SIMILAR:…`, `Doublon…`, `Succès…` — le raccourci iPhone les parse, ne pas changer le format. Entonnoir sur `gpt-5.6-luna` low. **Plus de classement automatique en groupes** (arrêté le 2026-11-26).
- `/judge-similar` (Kindle). `/openai-script` (legacy, `X-Worker-Secret`).
- Données (JWT, filtrées par `user_id`) : `/api/words` (GET/POST/DELETE/PUT renommer ou changer de langue), `/api/progress`, `/api/session`, `/api/history`, `/api/blacklist`, `/api/usage`, `/api/keys`, `/api/settings`, `/api/grammar`, `/api/examples` (+`/mark`), `/api/round` (manche en cours), `/api/round-log` (historique des manches), `/api/groups` (`?kind=mine` = groupes de l'utilisateur **avec leurs mots**), `/api/word-groups`.
- IA : `/` = OpenAI Responses API, clé en `X-OpenAI-Key` ; sans clé, clé du propriétaire, recadrée (terra, `none`, 16 000 tokens), `FREE_AI_PER_DAY` 40 → 429 `free_limit`.
- Secrets : `JWT_SECRET`, `OPENAI_API_KEY_SCRIPT`, `UNSPLASH_KEY`, `WORKER_SECRET` (⚠️ a fuité, rotation à faire). Morts : `OPENAI_API_KEY`, `GEMINI_KEY`, `SA_JSON`.
- ⚠️ Toute requête D1 avec jointure : mesurer `meta.rows_read` sur la vraie base (`wrangler d1 execute vocab --remote --json --command "…"`) — un `GET /api/groups` sans `INDEXED BY` a mangé 82 % du quota gratuit.

## D1 (base `vocab`)
Toutes les tables portent `user_id`. `words` (`word` peut être `base (note)`), `progress` (correct, incorrect, last_practiced, next_review), `history` (date **UTC**), `sessions`, `usage`, `rounds`, `round_log`, `free_quota`, `examples` (toutes les questions écrites par le modèle, `shown`/`picked`/`ok`), `blacklist`, `grammar_forms`, `groups` (`kind` : `mine` = créé par l'utilisateur ; `theme`/`lot` = anciens groupes de l'IA, **cachés**), `word_groups`.
`language` ∈ English · Spanish · French · Greek (codées en dur dans `LANGS`).

## Clés et limites
- Clé de l'utilisateur : `X-OpenAI-Key`, garde-fou `DAILY_TOKEN_LIMIT` = **250 000** tokens/jour = ce qu'OpenAI offre gratuitement chaque jour au propriétaire. **Ne pas relever** (essayé à 500 000 le 2026-11-26, refusé).
- Sans clé : `FREE_WORDS_PER_DAY` = 10 dans l'app, `FREE_AI_PER_DAY` 40 / `FREE_ADDS_PER_DAY` 30 dans le Worker.
- `sanitizeKey()` sur chaque clé (un caractère parasite cassait l'en-tête en Safari).
- Compte du propriétaire : `body.owner` (SHA-256 de l'email, jamais l'email en clair dans le dépôt).

## Modèle IA
- `reasoning: { effort: 'none' }` **toujours envoyé** (l'omettre = défaut plus lent). `max_output_tokens` compte raisonnement + texte.
- `usage.output_tokens` inclut déjà le raisonnement : ne pas l'additionner deux fois.
- `callAIJson` = `json_schema` strict (QCM, « quel mot ? », « tape le mot », lecteur aveugle). Les autres appels lisent le JSON à la main.
- ⚠️ Streaming : **un rendu par frame** (`coalesceChunks`), jamais un rendu par delta.

## Mode « pratique quotidienne » (le seul visible, `VISIBLE_MODES = ['practice']`)
Les autres modes (espacé, Situation, libre, image) sont cachés, code intact.
- Écran de départ : bascule **diaria / grupos**, deux curseurs (*mots par manche*, *dont neufs*), « Commencer », manches du jour. Rien n'appelle l'IA avant « Commencer ». `planRound()` est la **source unique** de la composition (neufs demandés → rappels dus du plus en retard → mots pas encore dus).
- Exercice selon le **net** (`sessionLevel`) : < 2 → QCM ; 2 à 5 → alternance « quel mot ? » (pair) / « tape le mot » (impair) ; ≥ 6 → « tape le mot ».
- Progression : SM-2 sur le net (`calcNextReview`). Un mot neuf revient demain, réussi ou non, net inchangé. **Étoiles une fois par jour** par mot (`practicedToday`). Réussi avec piste = sans étoile.
- **Limite de tokens atteinte → questions gardées** (`fetchStored`, `/api/examples/available` et `/stored`) : d'abord une jamais affichée, sinon la resservie il y a le plus longtemps (`examples.reused_at`) ; un QCM est re-tiré parmi ses 7 scénarios. Une question n'existe que pour un mot déjà sorti dans une manche : la manche se compose alors parmi ces mots (`storedRoundWords`). ⚠️ `examples.user_id` est en TEXT et vaut `'1.0'` (lié depuis un nombre JS) : dans `wrangler d1 execute`, écrire `user_id = '1.0'`.
- Toute la manche est préparée d'avance (`pumpPrefetch`, 3 à la fois) et gardée avec elle (`prep` dans `saveRound`). Reprise d'un appareil à l'autre (`/api/round`) ; à la reprise, chaque mot restant est revérifié contre la base.
- **Revoir une question** : le compteur « 5 / 12 » ouvre la liste des questions ; une question passée se relit en lecture seule (`#session-past`), « volver a la pregunta actual » ramène à la question en cours, intacte.
- **Tape le mot** : une case par lettre, clavier à l'écran (`TYPE_KEYS`), « ocultar / mostrar teclado », caché tout seul quand on ouvre la définition. Accents ignorés sauf ñ. « tenía razón » retourne un échec en réussite.
- **Groupes** (2026-11-26) : créés par l'utilisateur, façon playlist (`renderGroupsView`). « añadir palabras » rouvre le sélecteur « chercher un mot » (`_freeSearchFor = 'group'`). « Practicar » = une manche de **« mots par manche »** mots du groupe (`groupRoundWords` : à revoir, puis neufs, puis les autres ; choix du 2026-11-26, « jerga » a 123 mots), `_roundGroup` : pas de remplaçant, pas d'« autre mot neuf », ne marque pas la journée faite. ⚠️ Elle remplace une manche quotidienne laissée en plan (une seule manche reprenable par langue).

## ⚠️ Pièges qui ont déjà coûté cher
- **Ne jamais vider `#hint-box.innerHTML`** (seulement `#hint-text`, `#hint-translation`) : sa structure disparaît et la définition ne s'ouvre plus.
- Une question ne reçoit **qu'une** réponse (`item.answered`) ; un re-rendu redessine l'état répondu sans rien réenregistrer.
- Le minuteur de « second appui = suivant » appartient à **sa** question (garde `sessionItems[sessionIdx] !== mine`).
- `history.date` est UTC : le client envoie **son** minuit local.
- Une valeur de curseur **affichée** (bornée par le stock) ne se persiste jamais ; seul le geste de l'utilisateur écrit le réglage.
- `collectSettings()` ramasse toutes les clés `vocab_*` : tout état local qui n'est pas un réglage (manche, brouillon, `vocab_device_id`, mémoire des QCM) doit être exclu par `_isSyncableSettingKey`.
- Entrées annotées `base (note)` : la clé de progression est l'entrée **complète** ; la note n'entre jamais dans la réponse attendue ; parenthèses validées (`assertParens`), jamais retirées en silence.
- Accents dans les regex : `(^|[^\p{L}])mot([^\p{L}]|$)` avec `u`, jamais `\b`.
- QCM : la bonne réponse ne doit se reconnaître ni à sa **longueur** (`pickQcmShown` tire son rang), ni à un **intrus à part** (lecteur aveugle `blindScores`), ni parce qu'elle **définit** le mot. Le modèle peut avouer ne pas connaître un mot (`unknown`) : rien n'est enregistré.
- iOS : pas d'autoscroll au focus ; `#scroll-spacer` ne grandit que par `growSpacer` ; survol enfermé dans `@media (hover: hover)` (sinon l'appui reste « collé »).
- Oublier une **déclaration avant usage** au chargement fige l'app (TDZ) : tester le démarrage après tout ajout de `const` au niveau global.

## Reste à faire
- Réserve de questions préparées la nuit par le Worker (voir `docs/historique.md`, « Réserve de questions »).
- File d'attente hors ligne pour le raccourci iPhone (conçue, voir historique).
- Rotation de `WORKER_SECRET`, suppression des secrets morts.
- Mode Imagen : poussé, jamais essayé.
