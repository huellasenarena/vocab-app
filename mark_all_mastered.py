#!/usr/bin/env python3
"""
mark_all_mastered.py — Marque tous les mots du Vocabulary Builder comme "maîtrisés".
"""

import os, sqlite3, sys, glob
from pathlib import Path

def find_kindle():
    candidates = glob.glob("/Volumes/Kindle*") + glob.glob("/Volumes/KOB*")
    for path in candidates:
        if os.path.isdir(path):
            return Path(path)
    return None

def mark_all_mastered(db_path):
    if not db_path.exists():
        print(f"⚠️ Fichier non trouvé : {db_path}")
        return False
    
    print(f"📖 Mise à jour de la base de données : {db_path}")
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        
        # Mettre à jour la catégorie de tous les mots pour les passer en "Mastered" (100)
        cur.execute("UPDATE WORDS SET category = 100 WHERE category != 100;")
        rowcount = cur.rowcount
        
        conn.commit()
        conn.close()
        
        # Supprimer les fichiers de journalisation temporaires s'ils existent
        # Cela force la Kindle à relire la base principale et non le cache
        for ext in ['-journal', '-wal', '-shm']:
            journal_path = db_path.with_name(db_path.name + ext)
            if journal_path.exists():
                try:
                    journal_path.unlink()
                except:
                    pass

        print(f"   ✅ {rowcount} mots ont été marqués comme 'maîtrisés'.")
        return True
    except Exception as e:
        print(f"   ❌ Erreur lors de la mise à jour de vocab.db : {e}")
        return False

def main():
    print("═" * 55)
    print("  🎓  Marquer tout le vocabulaire comme Maîtrisé")
    print("═" * 55)

    print("\n🔍 Recherche de la Kindle...")
    kindle = find_kindle()
    if not kindle:
        print("❌ Kindle non trouvée. Assure-toi qu'elle est branchée et déverrouillée.")
        sys.exit(1)
    
    print(f"   ✅ Kindle trouvée : {kindle}\n")
    
    db_path = kindle / "system" / "vocabulary" / "vocab.db"
    
    print("Cette action va marquer tous les mots actuels de ta Kindle comme 'maîtrisés' (Mastered).")
    print("Ils n'apparaîtront plus dans la liste d'apprentissage active de ton Vocabulary Builder.")
    rep = input("\nContinuer ? (oui/n) : ").strip().lower()
    if rep not in ["oui", "o", "y", "yes", ""]:
        print("Annulation.")
        sys.exit(0)
        
    print()
    mark_all_mastered(db_path)
    
    print("\n🎉 Terminé ! Tu peux éjecter ta Kindle en toute sécurité.")
    print("💡 Astuce : Il est fortement conseillé de redémarrer ta Kindle pour que les changements s'affichent correctement.")

if __name__ == "__main__":
    main()
