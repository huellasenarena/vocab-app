-- Compteur du jour pour les comptes SANS clé OpenAI, qui passent par la clé du
-- propriétaire. Le plafond se compte côté Worker : celui de l'app (10 mots par
-- jour) se contourne en appelant la route directement. Une ligne par compte, par
-- jour (UTC) et par usage — `ai` pour les exercices, `add` pour l'ajout de mots.
CREATE TABLE IF NOT EXISTS free_quota (
  user_id TEXT NOT NULL,
  date    TEXT NOT NULL,   -- YYYY-MM-DD, UTC
  kind    TEXT NOT NULL,   -- 'ai' | 'add'
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, kind)
);
