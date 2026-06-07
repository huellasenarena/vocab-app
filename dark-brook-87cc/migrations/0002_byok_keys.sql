-- BYOK : stockage des clés IA par utilisateur (sync multi-appareils).
-- Chiffrées au repos par Cloudflare ; accès protégé par le JWT.
ALTER TABLE users ADD COLUMN openai_key TEXT;
ALTER TABLE users ADD COLUMN gemini_key TEXT;
