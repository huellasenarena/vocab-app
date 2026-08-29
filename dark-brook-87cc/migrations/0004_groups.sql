-- Groupes de mots (thématiques) et lots d'étude.
--
-- `groups` est la LISTE FERMÉE dans laquelle le classement automatique choisit :
-- elle doit donc exister même quand un groupe est vide, d'où une table à part
-- plutôt qu'un simple libellé porté par word_groups.
--
-- kind = 'theme' : groupe thématique, permanent, alimenté par l'IA + corrections.
-- kind = 'lot'   : lot d'étude (N mots à travailler), jeté une fois terminé,
--                  JAMAIS alimenté par le classement automatique.
--
-- Les groupes sont PAR LANGUE : « comida » en espagnol, « nourriture » en
-- français. Un mot qui change de langue perd donc ses groupes (ils appartiennent
-- à la taxonomie de l'ancienne langue).
CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  language   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'theme',
  created_at TEXT,
  UNIQUE(user_id, language, name)
);

CREATE INDEX IF NOT EXISTS idx_groups_user_lang ON groups(user_id, language);

-- Appartenance d'un mot à un groupe (0..N groupes par mot).
-- auto = 1 : posé par le classement IA — peut être recalculé par une nouvelle passe.
-- auto = 0 : posé à la main — un reclassement ne doit JAMAIS l'écraser.
CREATE TABLE IF NOT EXISTS word_groups (
  user_id  INTEGER NOT NULL,
  language TEXT    NOT NULL,
  word     TEXT    NOT NULL,
  group_id INTEGER NOT NULL,
  auto     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, language, word, group_id)
);

CREATE INDEX IF NOT EXISTS idx_word_groups_group ON word_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_word_groups_word  ON word_groups(user_id, language, word);

-- Un mot classé dans ZÉRO groupe est indiscernable d'un mot jamais traité :
-- sans ce drapeau, une passe de classement reprise repasserait indéfiniment sur
-- les mots que le modèle a délibérément laissés sans groupe.
ALTER TABLE words ADD COLUMN grouped INTEGER NOT NULL DEFAULT 0;
