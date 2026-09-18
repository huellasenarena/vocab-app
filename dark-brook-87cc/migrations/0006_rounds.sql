-- Manche de pratique quotidienne en cours, pour la reprendre d'un appareil à
-- l'autre. Elle vivait en localStorage seulement : commencée sur l'iPhone, elle
-- n'existait pas sur l'iPad. Une ligne par utilisateur et par langue — on ne mène
-- qu'une manche à la fois dans une langue donnée.
CREATE TABLE IF NOT EXISTS rounds (
  user_id    TEXT NOT NULL,
  language   TEXT NOT NULL,
  state      TEXT NOT NULL,   -- le même blob JSON que la sauvegarde locale
  updated_at INTEGER NOT NULL,-- ms epoch : sert à départager les deux appareils
  PRIMARY KEY (user_id, language)
);
