-- Historique des manches de pratique quotidienne (2026-11-14). `history` dit quel
-- mot a été répondu et quand, mais pas dans quelle manche : une ligne par manche,
-- avec ses mots dans l'ordre où ils ont été répondus.
-- Écrite à chaque réponse (une manche quittée en route y reste, « pas finie »),
-- donc aussi d'un appareil à l'autre quand on reprend une manche ailleurs.
CREATE TABLE IF NOT EXISTS round_log (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,             -- tiré par l'app au début de la manche, gardé à la reprise
  language   TEXT NOT NULL,
  day        TEXT NOT NULL,             -- date LOCALE du début (YYYY-MM-DD)
  started_at TEXT NOT NULL,             -- ISO : ordonne les manches d'un jour
  total      INTEGER NOT NULL,          -- taille de la manche
  done       INTEGER NOT NULL DEFAULT 0,-- 1 = dernière question répondue
  items      TEXT NOT NULL DEFAULT '[]',-- [{w, n (neuf 0/1), ok (0/1)}…]
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_round_log_day ON round_log(user_id, day);
