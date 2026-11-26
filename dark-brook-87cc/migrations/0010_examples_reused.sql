-- Questions gardées ressorties quand la limite de tokens du jour est atteinte
-- (2026-11-26) : `reused_at` = dernière fois qu'une question a été resservie, pour
-- tourner entre les questions d'un mot au lieu de reservir toujours la même.
ALTER TABLE examples ADD COLUMN reused_at TEXT;
