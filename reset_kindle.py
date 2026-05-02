#!/usr/bin/env python3
"""
reset_kindle.py — Réinitialise complètement le vocabulaire et les surlignements de la Kindle.
"""

import os, sqlite3, sys, glob
from pathlib import Path

def find_kindle():
    candidates = glob.glob("/Volumes/Kindle*") + glob.glob("/Volumes/KOB*")
    for path in candidates:
        if os.path.isdir(path):
            return Path(path)
    return None

def reset_vocab(db_path):
    if not db_path.exists():
        print(f"⚠️ Fichier non trouvé : {db_path}")
        return False
    
    print(f"🧹 Nettoyage de la base de données : {db_path}")
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        
        # Vider les 3 tables principales
        cur.execute("DELETE FROM LOOKUPS;")
        cur.execute("DELETE FROM WORDS;")
        cur.execute("DELETE FROM BOOK_INFO;")
        
        # Compacter la base de données
        cur.execute("VACUUM;")
        
        conn.commit()
        conn.close()
        
        # Supprimer les fichiers de journalisation (WAL, SHM, JOURNAL) s'ils existent
        for ext in ['-journal', '-wal', '-shm']:
            journal_path = db_path.with_name(db_path.name + ext)
            if journal_path.exists():
                try:
                    journal_path.unlink()
                    print(f"   🧹 Fichier temporaire supprimé : {journal_path.name}")
                except Exception as e:
                    print(f"   ⚠️ Impossible de supprimer {journal_path.name} : {e}")
                    
        print("   ✅ Base de données vocab.db réinitialisée et compactée avec succès.")
        return True
    except Exception as e:
        print(f"   ❌ Erreur lors du nettoyage de vocab.db : {e}")
        return False

def reset_clippings(clip_path):
    if not clip_path.exists():
        print(f"⚠️ Fichier non trouvé : {clip_path}")
        return False
    
    print(f"🧹 Nettoyage des surlignements : {clip_path}")
    try:
        # Ouvrir en mode écriture (w) vide le fichier complètement
        with open(clip_path, 'w', encoding="utf-8") as f:
            pass # On le vide juste
        print("   ✅ Fichier My Clippings.txt vidé avec succès.")
        return True
    except Exception as e:
        print(f"   ❌ Erreur lors du nettoyage de My Clippings.txt : {e}")
        return False

def main():
    print("═" * 55)
    print("  🚨  Réinitialisation Kindle (Vocabulaire & Surlignements)")
    print("═" * 55)

    print("\n🔍 Recherche de la Kindle...")
    kindle = find_kindle()
    if not kindle:
        print("❌ Kindle non trouvée. Assure-toi qu'elle est branchée et déverrouillée.")
        sys.exit(1)
    
    print(f"   ✅ Kindle trouvée : {kindle}\n")
    
    # Chemins
    db_path = kindle / "system" / "vocabulary" / "vocab.db"
    
    clip_path = None
    for candidate in ["documents/My Clippings.txt", "My Clippings.txt"]:
        p = kindle / candidate
        if p.exists():
            clip_path = p
            break
            
    # Confirmation
    print("⚠️ ATTENTION : Cette action va supprimer TOUS les mots du Vocabulary Builder")
    print("   et TOUS les surlignements de My Clippings.txt de manière permanente.")
    rep = input("\nContinuer ? (oui/n) : ").strip().lower()
    if rep != "oui":
        print("Annulation.")
        sys.exit(0)
        
    print()
    reset_vocab(db_path)
    
    if clip_path:
        reset_clippings(clip_path)
    else:
        print("⚠️ Fichier My Clippings.txt introuvable sur la Kindle.")
        
    print("\n🎉 Terminé ! Tu peux éjecter ta Kindle en toute sécurité.")
    print("💡 Astuce : Il est parfois nécessaire de redémarrer la Kindle après cette opération pour éviter les problèmes de synchronisation Cloud d'Amazon.")

if __name__ == "__main__":
    main()