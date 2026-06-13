-- Sync des réglages utilisateur (sliders, modèle, niveaux de raisonnement…) entre appareils.
-- Blob JSON sérialisé côté front, stocké tel quel.
ALTER TABLE users ADD COLUMN settings TEXT;
