#!/usr/bin/env python3
"""
kindle_import.py — Importe le vocabulaire Kindle vers Google Sheets.
Usage : python3 kindle_import.py
"""

import os, re, sys, json, sqlite3, shutil, glob
from datetime import datetime
from pathlib import Path
from difflib import SequenceMatcher

LONG_CLIP_THRESHOLD = 6  # mots

# ── Dépendances Google ──────────────────────────────────────────────────────
try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    import urllib.request
except ImportError:
    print("❌ Bibliothèques manquantes. Lance d'abord :")
    print("   pip3 install google-auth-oauthlib google-auth-httplib2")
    sys.exit(1)

# ── Config ──────────────────────────────────────────────────────────────────
SHEET_ID       = "1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc"
SCOPES         = ["https://www.googleapis.com/auth/spreadsheets"]
SCRIPT_DIR     = Path(__file__).parent
CREDENTIALS    = SCRIPT_DIR / "credentials.json"
TOKEN          = SCRIPT_DIR / "token.json"

LANG_TO_SHEET  = {"es": "Spanish", "fr": "French", "en": "English", "el": "Greek"}
LANG_NAMES     = {"es": "Espagnol", "fr": "Français", "en": "Anglais", "el": "Grec"}

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
                while True:
                    r = input("   Lequel garder ? (1/2/les deux) : ").strip().lower()
                    if r == "1":
                        to_remove.add(j)
                        break
                    elif r == "2":
                        to_remove.add(i)
                        break
                    elif r in ("les deux", "2", "1 2", "1,2"):
                        break
                    else:
                        print("   ⚠️  Tape 1, 2 ou 'les deux'")

    return [c for idx, c in enumerate(clips) if idx not in to_remove]

# ── Auth Google ─────────────────────────────────────────────────────────────
def get_credentials():
    if not CREDENTIALS.exists():
        print(f"❌ Fichier credentials.json introuvable dans {SCRIPT_DIR}")
        sys.exit(1)
    creds = None
    if TOKEN.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN.write_text(creds.to_json())
    return creds

# ── Sheets API ───────────────────────────────────────────────────────────────
def sheets_get(creds, range_):
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{urllib.request.quote(range_)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {creds.token}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def sheets_append(creds, range_, values):
    url = (f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}"
           f"/values/{urllib.request.quote(range_)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS")
    data = json.dumps({"values": values}).encode()
    req = urllib.request.Request(url, data=data, method="POST",
          headers={"Authorization": f"Bearer {creds.token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def get_existing_words(creds, sheet_name):
    try:
        data = sheets_get(creds, f"{sheet_name}!B:B")
        return {r[0].strip().lower() for r in data.get("values", []) if r}
    except Exception:
        return set()

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
            clip = lines[2].strip('.,;:—-«»¡!¿?"\' ')
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
    """Supprime les entrées des livres choisis dans vocab.db."""
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    for title in books_to_remove:
        cur.execute("SELECT id FROM BOOK_INFO WHERE title LIKE ?", (f"%{title[:30]}%",))
        rows = cur.fetchall()
        for (book_id,) in rows:
            cur.execute("DELETE FROM LOOKUPS WHERE book_key = ?", (book_id,))
            cur.execute("""
                DELETE FROM WORDS WHERE id NOT IN (
                    SELECT DISTINCT word_key FROM LOOKUPS
                )
            """)
    conn.commit()
    conn.close()

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
def main():
    sep("═")
    print("  📖  Kindle → Google Sheets Import")
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
    creds = get_credentials()

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

    # 7. Déduplication et résumé avant import
    sep()
    print("☁️  Vérification des doublons dans Google Sheets...\n")
    today = datetime.today().strftime("%Y-%m-%d")
    ready = {}  # {sheet: [[date, word], ...]}
    total_new = 0
    total_dup = 0

    for sheet, words in final.items():
        existing = get_existing_words(creds, sheet)
        new_words = []
        dups = 0
        for w in words:
            if w.strip().lower() not in existing:
                new_words.append([today, w])
            else:
                dups += 1
        ready[sheet] = new_words
        total_new += len(new_words)
        total_dup += dups
        print(f"   {sheet}: {len(new_words)} nouveaux, {dups} doublons ignorés")

    if total_new == 0:
        print("\n✅ Tous les mots existent déjà dans Sheets — rien à importer.")
    else:
        sep()
        print(f"\n📊 Résumé avant import :")
        print(f"   • {total_new} nouvelles entrées à importer")
        print(f"   • {total_dup} doublons ignorés")
        print(f"   • {flagged_total} mots communs détectés")
        print()
        if ask("Importer maintenant dans Google Sheets ?"):
            for sheet, rows in ready.items():
                if rows:
                    sheets_append(creds, f"{sheet}!A:B", rows)
                    print(f"   ✅ {len(rows)} entrées ajoutées dans '{sheet}'")

    # 8. Réinitialisation Kindle
    sep()
    print("\n🗑️  Réinitialisation de la Kindle :\n")
    books_to_reset = chosen_titles

    do_reset = ask("Supprimer les mots importés de vocab.db sur la Kindle ?")
    if do_reset and has_db:
        reset_vocab_db(db_path, books_to_reset)
        print("   ✅ vocab.db réinitialisé")

    do_reset_clips = ask("Supprimer les surlignements importés de My Clippings.txt ?")
    if do_reset_clips and has_clips:
        n = reset_clippings(clip_path, books_to_reset)
        print(f"   ✅ My Clippings.txt nettoyé ({n} entrées supprimées)")

    # 9. Résumé final
    sep("═")
    print("\n✨ Import terminé !\n")
    print(f"   📥 {total_new} entrées importées dans Google Sheets")
    print(f"   🚫 {total_dup} doublons ignorés")
    if do_reset:   print("   🗑️  vocab.db réinitialisé")
    if do_reset_clips: print("   🗑️  My Clippings.txt nettoyé")
    sep("═")
    print()

if __name__ == "__main__":
    main()
