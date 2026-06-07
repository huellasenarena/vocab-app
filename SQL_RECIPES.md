# Recettes SQL — base D1 `vocab`

Commandes prêtes à coller pour gérer ta base **Cloudflare D1** (remplace les anciens onglets Google Sheets).

## Deux façons de les lancer

**1. Dashboard Cloudflare** (le plus simple pour explorer)
Dashboard → **Storage & Databases → D1 SQL Database → `vocab`** → onglet **Console** → colle la requête → *Execute*.

**2. Terminal** (`wrangler`)
```bash
cd ~/Desktop/vocab-app/dark-brook-87cc
wrangler d1 execute vocab --remote --command "LA_REQUÊTE_ICI"
# ⚠️ --remote = prod. Sans --remote (ou --local) = base de dev locale.
```

> **Ton `user_id` en prod = `1`** (jackstefanou@gmail.com). Les exemples ci-dessous l'utilisent — adapte si besoin.
>
> ⚠️ **Toujours** garder `WHERE user_id = 1` sur les `UPDATE`/`DELETE` pour ne toucher que tes données.

---

## Tables

| Table | Contenu | Colonnes utiles |
|---|---|---|
| `users` | comptes | `id, email, google_id, add_token` |
| `words` | mots (remplace les onglets langue) | `user_id, language, word` |
| `progress` | scores SM-2 / étoiles | `word, language, correct, incorrect, next_review, hint_used` |
| `history` | journal des tentatives | `date, word, language, result` |
| `sessions` | nouveaux mots/jour | `date, language, new_count` |
| `blacklist` | mots à ne plus suggérer | `language, word` |
| `grammar_forms` | formes grammaticales (Español) | `category, form` |
| `usage` | compteurs tokens/requêtes | `date, openai_input, ...` |

`language` ∈ `English` · `Spanish` · `French` · `Greek`.

---

## CONSULTER

```sql
-- Combien de mots par langue
SELECT language, COUNT(*) AS mots FROM words WHERE user_id = 1 GROUP BY language;

-- Lister tous les mots espagnols (ordre alphabétique)
SELECT word FROM words WHERE user_id = 1 AND language = 'Spanish' ORDER BY word;

-- Chercher un mot (contient "cora")
SELECT language, word FROM words WHERE user_id = 1 AND word LIKE '%cora%';

-- Les mots les mieux maîtrisés (★★★ = correct - incorrect >= 3)
SELECT word, language, correct, incorrect FROM progress
WHERE user_id = 1 AND (correct - incorrect) >= 3 ORDER BY (correct - incorrect) DESC;

-- Mots à réviser aujourd'hui (next_review <= aujourd'hui)
SELECT word, language, next_review FROM progress
WHERE user_id = 1 AND next_review IS NOT NULL AND date(next_review) <= date('now')
ORDER BY next_review;

-- Mots jamais pratiqués (présents dans words mais absents de progress)
SELECT w.word, w.language FROM words w
LEFT JOIN progress p ON p.user_id = w.user_id AND p.language = w.language AND p.word = w.word
WHERE w.user_id = 1 AND p.word IS NULL;
```

---

## AJOUTER

```sql
-- Ajouter un mot (ignore si déjà présent)
INSERT OR IGNORE INTO words (user_id, language, word, created_at)
VALUES (1, 'Spanish', 'madrugada', datetime('now'));

-- Ajouter plusieurs mots d'un coup
INSERT OR IGNORE INTO words (user_id, language, word, created_at) VALUES
  (1, 'French', 'crépuscule', datetime('now')),
  (1, 'French', 'aube',       datetime('now'));
```

> 💡 Au quotidien, utilise plutôt l'**app** (champ d'ajout / raccourci iPhone) ou la route `/add` — le SQL direct est pour les corrections en masse.

---

## MODIFIER

```sql
-- Corriger l'orthographe d'un mot (dans words ET progress)
UPDATE words    SET word = 'corazón' WHERE user_id = 1 AND language = 'Spanish' AND word = 'corazon';
UPDATE progress SET word = 'corazón' WHERE user_id = 1 AND language = 'Spanish' AND word = 'corazon';

-- Déplacer un mot vers une autre langue
UPDATE words SET language = 'French' WHERE user_id = 1 AND word = 'menu' AND language = 'English';

-- Réinitialiser la progression d'un mot (repart de zéro)
DELETE FROM progress WHERE user_id = 1 AND word = 'corazón' AND language = 'Spanish';

-- Forcer un mot "à réviser maintenant"
UPDATE progress SET next_review = date('now') WHERE user_id = 1 AND word = 'corazón' AND language = 'Spanish';
```

---

## SUPPRIMER ⚠️ (destructif)

```sql
-- Supprimer UN mot (et sa progression)
DELETE FROM words    WHERE user_id = 1 AND language = 'Spanish' AND word = 'erreur';
DELETE FROM progress WHERE user_id = 1 AND language = 'Spanish' AND word = 'erreur';

-- Supprimer TOUS les mots d'une langue (⚠️ irréversible)
DELETE FROM words WHERE user_id = 1 AND language = 'Greek';

-- Vider la blacklist d'une langue
DELETE FROM blacklist WHERE user_id = 1 AND language = 'Spanish';

-- Effacer tout l'historique
DELETE FROM history WHERE user_id = 1;
```

> 💡 **Avant un gros DELETE**, fais un `SELECT COUNT(*) …` avec le même `WHERE` pour vérifier combien de lignes seront touchées.

---

## TON COMPTE

```sql
-- Voir ton compte + ton token d'ajout
SELECT id, email, google_id, add_token FROM users WHERE id = 1;

-- Régénérer ton token d'ajout (invalide l'ancien lien du raccourci)
UPDATE users SET add_token = NULL WHERE id = 1;
-- (l'app en regénère un automatiquement au prochain ⚙️ / appel /me)
```

---

## EXPORT (sauvegarde rapide)

```sql
-- Exporter tous tes mots (copie le résultat depuis la Console)
SELECT language, word FROM words WHERE user_id = 1 ORDER BY language, word;
```

Pour une sauvegarde complète de la base :
```bash
cd ~/Desktop/vocab-app/dark-brook-87cc
wrangler d1 export vocab --remote --output=backup.sql
```
