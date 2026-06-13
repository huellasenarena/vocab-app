#!/usr/bin/env python3
"""
kindle_import.py — Importe le vocabulaire Kindle vers Google Sheets.
Usage : python3 kindle_import.py
"""

import os, re, sys, json, sqlite3, shutil, glob, unicodedata
from datetime import datetime
from pathlib import Path
from difflib import SequenceMatcher

LONG_CLIP_THRESHOLD = 5  # mots

import urllib.request, urllib.parse

# ── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR     = Path(__file__).parent
WORKER_URL     = "https://dark-brook-87cc.georg-dreym.workers.dev"
# Token d'ajout perso (le même que le raccourci iPhone) — visible dans ⚙️ de l'app
# ou via la réponse de /me. L'import passe désormais par la route /add (D1), pas Sheets.
ADD_TOKEN      = os.environ.get("ADD_TOKEN", "")
if not ADD_TOKEN:
    sys.exit("ADD_TOKEN manquant — exporte-le avant de lancer : export ADD_TOKEN=...")
# En-tête navigateur requis (sinon 403 Cloudflare 1010)
_UA            = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

LANG_TO_SHEET  = {"es": "Spanish", "fr": "French", "en": "English", "el": "Greek"}
LANG_NAMES     = {"es": "Espagnol", "fr": "Français", "en": "Anglais", "el": "Grec"}
SHEET_TO_LANG_FULL = {"Spanish": "Spanish", "French": "French", "English": "English", "Greek": "Modern Greek"}
AI_BATCH_SIZE  = 30

# Mots trop communs par langue
TOO_COMMON = {
    "es": {"que","haber","caber","ser","estar","tener","hacer","ir","poder","querer",
           "saber","ver","dar","decir","volver","hablar","venir","muy","bien","mal",
           "todo","nada","algo","también","pero","porque","como","más","menos","ya",
           "así","cuando","donde","mismo","cada","otro","uno","una","del","nos",
           "casar","crecer","tratar","soler","mantener","proponer","superar","cuidar",
           "seguir","temer","ano","me","te","se","lo","la","le","su"},
    "fr": {"être","avoir","faire","aller","pouvoir","vouloir","savoir","voir","venir",
           "lui","leur","très","bien","mais","donc","car","si","tout","rien","quelque",
           "plus","moins","aussi","puis","alors","encore","même","comme","quand","où"},
    "en": {"the","be","have","do","say","get","make","go","know","take","see","come",
           "think","look","want","give","use","find","tell","ask","seem","feel","try",
           "leave","call","very","just","but","also","than","then","when","where"},
    "el": set()
}

# ── Helpers ─────────────────────────────────────────────────────────────────
def sep(char="─", n=55):
    print(char * n)

def norm_sim(w):
    w = unicodedata.normalize('NFD', w)
    w = ''.join(c for c in w if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z]', '', w.lower())

def similarity_score(w_norm, e_norm):
    if not e_norm or len(e_norm) < 2:
        return 0
    score = 0
    min_len = min(len(w_norm), len(e_norm))
    if len(w_norm) >= 4 and w_norm in e_norm:
        score += 10
    elif len(e_norm) >= 4 and e_norm in w_norm:
        score += 10
    if min_len >= 5 and w_norm[:4] == e_norm[:4]:
        score += 5
    if min_len >= 6 and w_norm[-4:] == e_norm[-4:]:
        score += 3
    len_diff = abs(len(w_norm) - len(e_norm))
    if len_diff <= 2:
        score += 2
    elif len_diff <= 4:
        score += 1
    return score

def find_top_candidates(word, existing_set, n=5):
    """Retourne les N mots existants les plus similaires (même logique que l'Apps Script)."""
    w_norm = norm_sim(word)
    scored = []
    for e in existing_set:
        s = similarity_score(w_norm, norm_sim(e.lower()))
        if s > 0:
            scored.append((e, s))
    scored.sort(key=lambda x: -x[1])
    return [e for e, _ in scored[:n]]

def normalize_word(w):
    """
    Normalise un mot avant import :
    - strip whitespace
    - première lettre en minuscule
    Exception : questions (se terminent par ?) → première lettre conservée.
    """
    w = w.strip()
    if not w:
        return w
    if w.endswith('?'):
        return w
    return w[0].lower() + w[1:]

def ask(prompt, choices=("o","n")):
    """Pose une question o/n. Entrée seule = oui (premier choix)."""
    label = f"[Entrée=oui/{choices[1]}]"
    while True:
        r = input(f"{prompt} {label} : ").strip().lower()
        if r == "":
            return True
        if r in choices:
            return r == choices[0]

def ask_choice(prompt, options):
    """Affiche une liste numérotée. Entrée seule = tous les livres."""
    while True:
        raw = input(f"{prompt} [Entrée=tous] : ").strip()
        if raw == "":
            return list(range(len(options)))
        try:
            indices = [int(x.strip()) - 1 for x in raw.split(",")]
            if all(0 <= i < len(options) for i in indices):
                return indices
        except ValueError:
            pass
        print("   ⚠️  Entrée invalide, réessaie (ex: 1 ou 1,2,3)")

# ── Déduplication clips ──────────────────────────────────────────────────────
def similarity(a, b):
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()

def deduplicate_clips(clips):
    """
    Nettoie une liste de clips en demandant confirmation pour :
    - Doublons partiels (l'un contient l'autre)
    - Quasi-doublons (similarité > 0.80)
    Les doublons exacts sont supprimés silencieusement.
    Retourne la liste nettoyée.
    """
    # 1. Doublons exacts → silencieux
    seen = {}
    for c in clips:
        key = c.strip().lower()
        if key not in seen:
            seen[key] = c
    clips = list(seen.values())

    # 2. Doublons partiels et quasi-doublons → avec confirmation
    to_remove = set()
    pairs_shown = set()

    for i in range(len(clips)):
        if i in to_remove:
            continue
        for j in range(i + 1, len(clips)):
            if j in to_remove:
                continue

            a, b = clips[i], clips[j]
            pair_key = (min(i,j), max(i,j))
            if pair_key in pairs_shown:
                continue

            a_low, b_low = a.lower(), b.lower()
            is_partial  = a_low in b_low or b_low in a_low
            sim_score   = similarity(a, b)
            is_similar  = sim_score >= 0.80 and not is_partial

            if is_partial or is_similar:
                pairs_shown.add(pair_key)
                sep()
                if is_partial:
                    print("⚠️  Doublon partiel détecté :")
                else:
                    print(f"⚠️  Phrases très similaires (similarité {sim_score:.0%}) :")
                print(f"   [1] « {a} »")
                print(f"   [2] « {b} »")
                print()
                print("   1  = garder [1], supprimer [2]")
                print("   2  = garder [2], supprimer [1]")
                print("   +  = garder les deux")
                print("   -  = ignorer les deux")
                while True:
                    r = input("   Choix [1/2/+/-] : ").strip().lower()
                    if r == "1":
                        to_remove.add(j)
                        break
                    elif r == "2":
                        to_remove.add(i)
                        break
                    elif r in ("+", "les deux"):
                        break
                    elif r in ("-", "aucun"):
                        to_remove.add(i)
                        to_remove.add(j)
                        break
                    else:
                        print("   ⚠️  Tape 1, 2, + ou -")

    return [c for idx, c in enumerate(clips) if idx not in to_remove]

# ── Revue des mots par pages ─────────────────────────────────────────────────
PAGE_SIZE = 10

def review_words(ready, suspects=None):
    """Affiche les mots page par page et laisse l'utilisateur en exclure. suspects = {word_lower: reason}"""
    suspects = suspects or {}
    updated = {}
    for sheet, rows in ready.items():
        if not rows:
            updated[sheet] = rows
            continue
        sep()
        print(f"📋 Revue des mots pour '{sheet}' ({len(rows)} entrées)\n")
        kept = list(rows)
        page = 0
        while page * PAGE_SIZE < len(kept):
            chunk = kept[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
            for i, (_, word) in enumerate(chunk, start=1):
                marker = ""
                if word.lower().strip() in suspects:
                    marker = f"  ⚠️  {suspects[word.lower().strip()]}"
                print(f"   {i + page * PAGE_SIZE:>3}. {word}{marker}")
            total_pages = (len(kept) + PAGE_SIZE - 1) // PAGE_SIZE
            print(f"\n   Page {page + 1}/{total_pages}")
            raw = input("   Numéros à supprimer, Entrée pour continuer, q pour terminer la revue : ").strip()
            if raw.lower() == 'q':
                print(f"   → Revue interrompue, {len(kept)} mots conservés pour la suite.")
                break
            if raw:
                to_remove = set()
                for token in re.split(r"[\s,;]+", raw):
                    try:
                        n = int(token)
                        if 1 <= n <= len(kept):
                            to_remove.add(n - 1)
                    except ValueError:
                        pass
                if to_remove:
                    removed = [kept[i][1] for i in sorted(to_remove)]
                    kept = [r for i, r in enumerate(kept) if i not in to_remove]
                    print(f"   → Supprimé : {', '.join(removed)}")
                    page = max(0, page - (len(to_remove) // PAGE_SIZE))
                    continue
            page += 1
        updated[sheet] = kept
        print(f"\n   ✓ {len(kept)} mots conservés pour '{sheet}'")
    return updated

# ── Sheets API (via Cloudflare Worker) ──────────────────────────────────────
TIMEOUT = 15

def call_openai(prompt, max_tokens=600):
    """Appelle gpt-4.1-mini via la route /openai-script du Worker."""
    payload = {"prompt": prompt, "maxTokens": max_tokens, "model": "gpt-4.1-mini"}
    data = json.dumps(payload).encode()
    for attempt in range(3):
        if attempt > 0:
            import time; time.sleep(3 * attempt)
        try:
            req = urllib.request.Request(
                f"{WORKER_URL}/openai-script",
                data=data,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-Worker-Secret": WORKER_SECRET,
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                result = json.loads(r.read())
            if "error" in result:
                raise Exception(result["error"])
            return result.get("text", "")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 2:
                continue
            raise
    raise Exception("Erreur après 3 tentatives")


def llm_decide_similar_batch(items, sheet_name):
    """
    items: list of (new_word, [candidate1, candidate2, ...])
    Returns list of (new_word, candidates, 'import'|'skip')
    Fallback 'import' si l'IA échoue (moins de pertes).
    """
    if not items:
        return []
    lang = SHEET_TO_LANG_FULL.get(sheet_name, sheet_name)
    decisions = {}

    for start in range(0, len(items), AI_BATCH_SIZE):
        batch = items[start : start + AI_BATCH_SIZE]
        lines = "\n".join(
            f'{start + i + 1}. nouveau: "{new}", existants: {", ".join(repr(c) for c in candidates)}'
            for i, (new, candidates) in enumerate(batch)
        )
        prompt = (
            f"These are {lang} words where a new word resembles existing vocabulary.\n"
            f"Decide for each:\n"
            f"- 'skip': the new word is merely an inflected form of one of the existing words "
            f"(conjugation, plural, gender, diminutive, same meaning)\n"
            f"- 'import': genuinely different vocabulary value\n"
            f"When in doubt, choose 'import'.\n"
            f"Return ONLY a JSON array: [{{\"i\": 1, \"d\": \"import\"}},...]\n\n{lines}"
        )
        try:
            text = call_openai(prompt, max_tokens=400)
            match = re.search(r"\[.*\]", text, re.DOTALL)
            if match:
                for r in json.loads(match.group()):
                    decisions[r["i"] - 1] = r["d"]
        except Exception as e:
            print(f"   ⚠️  Batch IA similaires échoué : {e}")

    return [
        (new, candidates, decisions.get(i, "import"))
        for i, (new, candidates) in enumerate(items)
    ]


def validate_words_ai(ready):
    """Valide les mots avec Gemma. Retourne {word_lower: reason} pour les suspects."""
    suspects = {}
    for sheet, rows in ready.items():
        if not rows:
            continue
        lang = SHEET_TO_LANG_FULL.get(sheet, sheet)
        words = [word for _, word in rows]
        for i in range(0, len(words), AI_BATCH_SIZE):
            batch = words[i : i + AI_BATCH_SIZE]
            word_list = ", ".join(f'"{w}"' for w in batch)
            prompt = (
                f"Among these {lang} words/expressions, identify any that are NOT valid {lang}.\n"
                f"Accept: real words, conjugated forms, multi-word expressions, phrases, slang, archaic terms.\n"
                f"Flag ONLY: gibberish, typos producing no real word, or text clearly in a different language.\n"
                f"Return ONLY a JSON array: "
                f'[{{"word": "...", "reason": "..."}}] for suspicious ones only. '
                f"If all look valid, return [].\nWords: {word_list}"
            )
            try:
                text = call_openai(prompt)
                match = re.search(r"\[.*\]", text, re.DOTALL)
                if match:
                    items = json.loads(match.group())
                    for item in items:
                        w = item.get("word", "").lower().strip()
                        if w:
                            suspects[w] = item.get("reason", "?")
            except Exception as e:
                print(f"   ⚠️  Batch IA échoué pour '{sheet}' : {e}")
    return suspects


def sheets_call(sheet_path, method="GET", body=None):
    payload = {"sheetPath": sheet_path, "method": method}
    if body is not None:
        payload["body"] = body
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{WORKER_URL}/sheets",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Worker-Secret": WORKER_SECRET,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())

def sheets_get(range_):
    path = f"/v4/spreadsheets/{SHEET_ID}/values/{urllib.parse.quote(range_)}"
    return sheets_call(path, "GET")

def sheets_append(range_, values):
    path = (f"/v4/spreadsheets/{SHEET_ID}/values/{urllib.parse.quote(range_)}"
            f":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS")
    return sheets_call(path, "POST", {"values": values})

def sheets_clear(range_):
    path = f"/v4/spreadsheets/{SHEET_ID}/values/{urllib.parse.quote(range_)}:clear"
    return sheets_call(path, "POST")

def get_existing_words(sheet_name):
    """Retourne {mot_lower: numéro_ligne_1based}."""
    try:
        data = sheets_get(f"{sheet_name}!B:B")
        result = {}
        for i, row in enumerate(data.get("values", []), start=1):
            if row and row[0].strip():
                result[row[0].strip().lower()] = i
        return result
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="ignore")
        print(f"\n❌ Erreur HTTP {e.code} en lisant '{sheet_name}' : {body[:200]}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"\n❌ Impossible de joindre le Worker : {e.reason}")
        print("   → Vérifie ta connexion internet.")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Erreur inattendue : {e}")
        sys.exit(1)

# ── Détection Kindle ─────────────────────────────────────────────────────────
def find_kindle():
    candidates = glob.glob("/Volumes/Kindle*") + glob.glob("/Volumes/KOB*")
    for path in candidates:
        if os.path.isdir(path):
            return Path(path)
    return None

# ── Lecture vocab.db ─────────────────────────────────────────────────────────
def read_vocab_db(db_path):
    """Retourne {book_title: {"lang": str, "words": [stem, ...]}}"""
    books = {}
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute("""
            SELECT b.title, b.authors, w.lang, w.stem
            FROM WORDS w
            JOIN LOOKUPS l ON l.word_key = w.id
            JOIN BOOK_INFO b ON l.book_key = b.id
            WHERE w.category = 0
        """)
        for title, authors, lang, stem in cur.fetchall():
            if not stem:
                continue
            key = title.strip()
            if key not in books:
                books[key] = {"lang": lang, "authors": authors, "words": []}
            if stem not in books[key]["words"]:
                books[key]["words"].append(stem)
        conn.close()
    except Exception as e:
        print(f"   ⚠️  Erreur lecture vocab.db : {e}")
    return books

# ── Lecture My Clippings ──────────────────────────────────────────────────────
def read_clippings(clip_path):
    """Retourne {book_title: {"clips": [str, ...]}}"""
    books = {}
    try:
        content = clip_path.read_text(encoding="utf-8-sig", errors="ignore")
        entries = content.strip().split("==========")
        for entry in entries:
            lines = [l.strip() for l in entry.strip().splitlines() if l.strip()]
            if len(lines) < 3 or "surlignement" not in lines[1]:
                continue
            title = lines[0].strip()
            # Enlever "(Author Name)" à la fin du titre
            title = re.sub(r'\s*\([^)]+\)\s*$', '', title).strip()
            clip = lines[2].strip('.,;:—-«»¡!"\' ')
            clip = re.sub(r'\s+', ' ', clip).strip()
            if not clip:
                continue
            if title not in books:
                books[title] = {"clips": []}
            if clip not in books[title]["clips"]:
                books[title]["clips"].append(clip)
    except Exception as e:
        print(f"   ⚠️  Erreur lecture My Clippings : {e}")
    return books

# ── Réinitialisation Kindle ───────────────────────────────────────────────────
def reset_vocab_db(db_path, books_to_remove):
    """Marque les mots des livres choisis comme maîtrisés (category = 100) dans vocab.db."""
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    for title in books_to_remove:
        cur.execute("SELECT id FROM BOOK_INFO WHERE title LIKE ?", (f"%{title[:30]}%",))
        rows = cur.fetchall()
        for (book_id,) in rows:
            cur.execute("""
                UPDATE WORDS SET category = 100 
                WHERE id IN (SELECT word_key FROM LOOKUPS WHERE book_key = ?)
            """, (book_id,))
    conn.commit()
    conn.close()
    
    # Nettoyage des journaux pour forcer la liseuse à relire la base
    for ext in ['-journal', '-wal', '-shm']:
        journal_path = db_path.with_name(db_path.name + ext)
        if journal_path.exists():
            try:
                journal_path.unlink()
            except:
                pass

def reset_clippings(clip_path, books_to_remove):
    """Supprime les surlignements des livres choisis dans My Clippings.txt."""
    content = clip_path.read_text(encoding="utf-8-sig", errors="ignore")
    entries = content.strip().split("==========")
    kept = []
    removed = 0
    for entry in entries:
        lines = [l.strip() for l in entry.strip().splitlines() if l.strip()]
        if not lines:
            continue
        title = lines[0].strip()
        title_clean = re.sub(r'\s*\([^)]+\)\s*$', '', title).strip()
        if any(b.lower() in title_clean.lower() or title_clean.lower() in b.lower()
               for b in books_to_remove):
            removed += 1
        else:
            kept.append(entry)
    new_content = "==========".join(kept)
    clip_path.write_text(new_content, encoding="utf-8")
    return removed

# ── Main ──────────────────────────────────────────────────────────────────────
# ── Import via la route /add (D1) ────────────────────────────────────────────
def add_word(word, lang_code, ignore_sens=False, ignore_sim=False):
    """Ajoute un mot via /add. Retourne la réponse texte du Worker
    (Succès… / Doublon… / INVALID:… / SIMILAR:… / Erreur…)."""
    params = {"token": ADD_TOKEN, "word": word, "lang": lang_code or "auto"}
    if ignore_sens: params["ignore_sens"] = "true"
    if ignore_sim:  params["ignore_sim"]  = "true"
    url = WORKER_URL + "/add?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8").strip()
        except Exception as e:
            if attempt == 2:
                return f"Erreur : {e}"


def main():
    sep("═")
    print("  📖  Kindle → base BYOV (D1) via /add")
    sep("═")

    # 1. Détection Kindle
    print("\n🔍 Recherche de la Kindle...")
    kindle = find_kindle()
    if not kindle:
        print("❌ Kindle non trouvée. Assure-toi qu'elle est branchée et déverrouillée.")
        sys.exit(1)
    print(f"   ✅ Kindle trouvée : {kindle}")

    db_path   = kindle / "system" / "vocabulary" / "vocab.db"
    clip_path = None
    for candidate in ["documents/My Clippings.txt", "My Clippings.txt"]:
        p = kindle / candidate
        if p.exists():
            clip_path = p
            break

    has_db    = db_path.exists()
    has_clips = clip_path is not None

    if not has_db and not has_clips:
        print("❌ Aucun fichier vocab.db ni My Clippings.txt trouvé.")
        sys.exit(1)

    # 2. Lecture des fichiers
    print("\n📂 Lecture des fichiers...")
    db_books   = read_vocab_db(db_path) if has_db else {}
    clip_books = read_clippings(clip_path) if has_clips else {}

    # Fusionner par titre (approx)
    all_titles = set(db_books.keys()) | set(clip_books.keys())
    if not all_titles:
        print("❌ Aucun mot ni surlignement trouvé dans les fichiers.")
        sys.exit(1)

    # 3. Affichage des livres
    sep()
    print("📚 Livres trouvés :\n")
    titles = sorted(all_titles)
    for i, title in enumerate(titles, 1):
        parts = []
        if title in db_books:
            parts.append(f"{len(db_books[title]['words'])} mots (vocab.db)")
        # Chercher dans clip_books avec matching souple
        for ctitle, cdata in clip_books.items():
            if title.lower()[:20] in ctitle.lower() or ctitle.lower()[:20] in title.lower():
                parts.append(f"{len(cdata['clips'])} expressions (My Clippings)")
                break
        lang = db_books.get(title, {}).get("lang", "?")
        lang_str = LANG_NAMES.get(lang, lang)
        print(f"  [{i}] {title[:50]}")
        print(f"       Langue détectée : {lang_str} | {' + '.join(parts)}")

    sep()
    indices = ask_choice("\nQuels livres importer ? (ex: 1 ou 1,2,3)", titles)
    chosen_titles = [titles[i] for i in indices]

    # 4. Confirmation des langues
    print()
    sep()
    print("🌐 Confirme la langue de chaque livre :\n")
    lang_options = list(LANG_NAMES.keys())
    lang_labels  = [f"{LANG_NAMES[l]} ({l})" for l in lang_options]
    book_langs = {}
    for title in chosen_titles:
        detected = db_books.get(title, {}).get("lang", "es")
        print(f"  📖 {title[:50]}")
        print(f"     Langue détectée : {LANG_NAMES.get(detected, detected)}")
        for j, label in enumerate(lang_labels, 1):
            print(f"     [{j}] {label}")
        while True:
            choice = input(f"     Choix (Entrée pour confirmer '{LANG_NAMES.get(detected)}'): ").strip()
            if choice == "":
                book_langs[title] = detected
                break
            try:
                idx = int(choice) - 1
                if 0 <= idx < len(lang_options):
                    book_langs[title] = lang_options[idx]
                    break
            except ValueError:
                pass
            print("     ⚠️  Entrée invalide")
        print()

    # 5. Collecte des mots
    sep()
    print("🔎 Analyse des mots...\n")
    # Regrouper par langue→sheet
    to_import = {}  # {sheet_name: [words]}

    for title in chosen_titles:
        lang = book_langs[title]
        sheet = LANG_TO_SHEET.get(lang)
        if not sheet:
            print(f"   ⚠️  Langue '{lang}' non reconnue pour '{title}', ignoré.")
            continue
        if sheet not in to_import:
            to_import[sheet] = []

        common = TOO_COMMON.get(lang, set())

        # Mots depuis vocab.db
        if title in db_books:
            for word in db_books[title]["words"]:
                to_import[sheet].append(("word", word, word.lower() in common))

        # Expressions depuis My Clippings (avec déduplication)
        for ctitle, cdata in clip_books.items():
            if title.lower()[:20] in ctitle.lower() or ctitle.lower()[:20] in title.lower():
                raw_clips = cdata["clips"]
                if raw_clips:
                    sep()
                    print(f"🔁 Déduplication des expressions de « {title[:40]} »...\n")
                    clean_clips = deduplicate_clips(raw_clips)
                    removed_dups = len(raw_clips) - len(clean_clips)
                    if removed_dups:
                        print(f"\n   → {removed_dups} doublon(s) supprimé(s) silencieusement")
                    for clip in clean_clips:
                        word_count = len(clip.split())
                        if word_count > LONG_CLIP_THRESHOLD:
                            sep()
                            print(f"⚠️  Expression longue ({word_count} mots) :")
                            print(f"   « {clip} »")
                            if ask("   Importer quand même ?"):
                                to_import[sheet].append(("clip", clip, False))
                        else:
                            to_import[sheet].append(("clip", clip, False))
                break

    # 6. Validation des ⚠️
    final = {}  # {sheet_name: [entry]}
    flagged_total = 0

    for sheet, entries in to_import.items():
        flagged = [(t, w) for t, w, flag in entries if flag]
        normal  = [(t, w) for t, w, flag in entries if not flag]
        flagged_total += len(flagged)

        if flagged:
            sep()
            print(f"⚠️  Mots très communs détectés pour l'onglet '{sheet}' :\n")
            kept_flagged = []
            for _, word in flagged:
                if ask(f"   « {word} »  — importer quand même ?"):
                    kept_flagged.append(word)
            final[sheet] = [w for _, w in normal] + kept_flagged
        else:
            final[sheet] = [w for _, w in normal]

    # 7. Import vers la base (D1) via la route /add
    #    /add fait lui-même : détection langue, validité, doublon, similarité (juge LLM).
    sep()
    SHEET_TO_CODE = {"Spanish": "es", "French": "fr", "English": "en", "Greek": "el"}
    total_words = sum(len(w) for w in final.values())
    print(f"☁️  Import de {total_words} mot(s) vers la base via /add...\n")
    if not ask("Lancer l'import maintenant ?"):
        print("   Import annulé.")
        return

    total_new = total_dup = total_invalid = total_similar = total_err = 0

    for sheet, words in final.items():
        code = SHEET_TO_CODE.get(sheet, "auto")
        # dédoublonne localement (insensible à la casse) avant d'appeler /add
        uniq, seen = [], set()
        for w in words:
            w = normalize_word(w); wl = w.lower()
            if w and wl not in seen:
                seen.add(wl); uniq.append(w)
        sep()
        print(f"— {sheet} : {len(uniq)} mot(s) —")
        for w in uniq:
            txt = add_word(w, code)
            if txt.startswith("Succès"):
                total_new += 1; print(f"   ✓ {w}")
            elif txt.startswith("Doublon"):
                total_dup += 1; print(f"   = {w} (déjà présent)")
            elif txt.startswith("INVALID:"):
                reason = txt[len("INVALID:"):].split("|")[0].strip()
                print(f"   ⚠️  {w} — {reason}")
                if ask("      importer quand même ?"):
                    t2 = add_word(w, code, ignore_sens=True)
                    if t2.startswith("Succès"):   total_new += 1; print("      ✓ ajouté")
                    elif t2.startswith("Doublon"): total_dup += 1; print("      = déjà présent")
                    else:                          total_err += 1; print(f"      ✗ {t2}")
                else:
                    total_invalid += 1
            elif txt.startswith("SIMILAR:"):
                sim = txt[len("SIMILAR:"):].split("|")[0].strip()
                print(f"   ⚠️  {w} — proche de « {sim} »")
                if ask("      importer quand même ?"):
                    t2 = add_word(w, code, ignore_sim=True)
                    if t2.startswith("Succès"):   total_new += 1; print("      ✓ ajouté")
                    elif t2.startswith("Doublon"): total_dup += 1; print("      = déjà présent")
                    else:                          total_err += 1; print(f"      ✗ {t2}")
                else:
                    total_similar += 1
            else:
                total_err += 1; print(f"   ✗ {w} — {txt}")

    # 8. Mise à jour de la Kindle
    sep()
    print("\n📖  Mise à jour de la Kindle :\n")
    books_to_reset = chosen_titles

    do_reset = ask("Marquer les mots importés comme maîtrisés dans vocab.db ?")
    if do_reset and has_db:
        reset_vocab_db(db_path, books_to_reset)
        print("   ✅ Mots marqués comme maîtrisés")

    do_reset_clips = ask("Supprimer les surlignements importés de My Clippings.txt ?")
    if do_reset_clips and has_clips:
        n = reset_clippings(clip_path, books_to_reset)
        print(f"   ✅ My Clippings.txt nettoyé ({n} entrées supprimées)")

    # 9. Résumé final
    sep("═")
    print("\n✨ Import terminé !\n")
    print(f"   📥 {total_new} mot(s) ajouté(s) dans la base")
    print(f"   🚫 {total_dup} doublon(s) ignoré(s)")
    if total_invalid: print(f"   ⚠️  {total_invalid} invalide(s) ignoré(s)")
    if total_similar: print(f"   ⚠️  {total_similar} variante(s) ignorée(s)")
    if total_err:     print(f"   ✗ {total_err} erreur(s)")
    if do_reset:   print("   ✅ Mots marqués comme maîtrisés")
    if do_reset_clips: print("   🗑️  My Clippings.txt nettoyé")
    sep("═")
    print()

if __name__ == "__main__":
    main()
