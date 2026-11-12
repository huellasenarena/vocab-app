-- Tous les exemples écrits par le modèle, gardés pour plus tard (rien ne les lit
-- encore). Une ligne par exemple : les 7 scénarios d'un QCM (pas seulement les 4
-- montrés), la situation de « quel mot ? », la phrase de « tape le mot », les
-- phrases d'exemple d'une définition.
--   batch  : une génération (un QCM, une phrase…), identifiant tiré par l'app
--   kept   : l'app l'a retenu pour l'écran (4 scénarios sur 7)
--   shown  : il a vraiment été affiché (un QCM préparé d'avance peut ne jamais l'être)
--   picked : le scénario que l'utilisateur a choisi (QCM)
--   answer : ce qu'il a répondu (« quel mot ? », « tape le mot ») ; '' = « je ne sais pas »
--   ok     : sa réponse était juste (1) ou fausse (0), NULL tant qu'il n'a pas répondu
--   meta   : JSON (mot illustré, explication, note du lecteur aveugle, forme attendue…)
CREATE TABLE IF NOT EXISTS examples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  language   TEXT NOT NULL,
  word       TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- 'qcm' | 'pick' | 'type' | 'definition'
  batch      TEXT NOT NULL,
  role       TEXT NOT NULL,   -- 'correct' | 'wrong' | 'situation' | 'sentence' | 'sense'
  text       TEXT NOT NULL,
  kept       INTEGER NOT NULL DEFAULT 0,
  shown      INTEGER NOT NULL DEFAULT 0,
  picked     INTEGER NOT NULL DEFAULT 0,
  answer     TEXT,
  ok         INTEGER,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_examples_batch ON examples(user_id, batch);
CREATE INDEX IF NOT EXISTS idx_examples_word  ON examples(user_id, language, word);
