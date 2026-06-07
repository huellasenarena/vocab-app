-- Migration 0001 — schéma initial multi-utilisateur (Cloudflare D1)
-- Remplace les onglets Google Sheets. Toutes les tables de données portent user_id.

-- Utilisateurs : supporte OAuth Google ET email/mot de passe
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,                       -- NULL si compte OAuth seul
  google_id     TEXT UNIQUE,                -- NULL si compte email/mdp seul
  add_token     TEXT UNIQUE,                -- token perso pour la route /add (Phase 4)
  created_at    TEXT NOT NULL
);

-- Mots (remplace les onglets English/Spanish/French/Greek)
CREATE TABLE words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language   TEXT NOT NULL,                 -- 'English' | 'Spanish' | 'French' | 'Greek'
  word       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, language, word)
);

-- Progression SM-2 (onglet Progress)
CREATE TABLE progress (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language       TEXT NOT NULL,
  word           TEXT NOT NULL,
  correct        INTEGER NOT NULL DEFAULT 0,
  incorrect      INTEGER NOT NULL DEFAULT 0,
  last_practiced TEXT,
  hint_used      INTEGER NOT NULL DEFAULT 0,
  next_review    TEXT,
  PRIMARY KEY (user_id, language, word)
);

-- Journal des tentatives (onglet History)
CREATE TABLE history (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date     TEXT NOT NULL,
  word     TEXT NOT NULL,
  language TEXT NOT NULL,
  result   INTEGER NOT NULL                 -- 1 = ✓, 0 = ✗
);

-- Compteur de nouveaux mots par jour (onglet Session, normalisé en lignes)
CREATE TABLE sessions (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,                  -- YYYY-MM-DD (heure locale)
  language  TEXT NOT NULL,
  new_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, language)
);

-- Stats d'usage IA par user et par jour (onglet Tokens)
CREATE TABLE usage (
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,
  openai_input        INTEGER NOT NULL DEFAULT 0,
  openai_output       INTEGER NOT NULL DEFAULT 0,
  openai_requests     INTEGER NOT NULL DEFAULT 0,
  gemma_requests      INTEGER NOT NULL DEFAULT 0,
  geminiflash_req     INTEGER NOT NULL DEFAULT 0,
  geminiflashlite_req INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- Mots à ne plus suggérer (onglet Blacklist, normalisé en lignes)
CREATE TABLE blacklist (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  word     TEXT NOT NULL,
  PRIMARY KEY (user_id, language, word)
);

-- Formes grammaticales PAR UTILISATEUR (usages/conditionnels personnels)
CREATE TABLE grammar_forms (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,                   -- 'Spanish' pour l'instant
  category TEXT NOT NULL,                   -- presente, pasado, futuro, subjuntivo...
  form     TEXT NOT NULL
);

CREATE INDEX idx_words_user_lang    ON words(user_id, language);
CREATE INDEX idx_progress_user_lang ON progress(user_id, language);
CREATE INDEX idx_history_user_date  ON history(user_id, date);
CREATE INDEX idx_grammar_user_lang  ON grammar_forms(user_id, language);
