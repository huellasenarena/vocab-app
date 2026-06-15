function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64json(obj) {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)));
}

// ---- Auth multi-utilisateur (Phase 1) ----

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const PBKDF2_ITER = 100000;

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, keyMaterial, 256
  );
  return `pbkdf2$${PBKDF2_ITER}$${base64url(salt.buffer)}$${base64url(bits)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterStr, saltB64, hashB64] = (stored || '').split('$');
  if (scheme !== 'pbkdf2') return false;
  const salt = b64urlToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: parseInt(iterStr, 10), hash: 'SHA-256' }, keyMaterial, 256
  );
  return timingSafeEqual(base64url(bits), hashB64);
}

async function signJWT(payload, secret, expSeconds = 60 * 60 * 24 * 30) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64json({ alg: 'HS256', typ: 'JWT' })}.${b64json({ ...payload, iat: now, exp: now + expSeconds })}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64url(sig)}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

// Token perso (route /add) — URL-safe, ~32 caractères
function genToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)).buffer);
}

// Nettoie une clé OpenAI fournie par un appelant (header) : ASCII imprimable
// uniquement, sinon la construction de l'en-tête Authorization plante.
function sanitizeScriptKey(k) {
  if (!k) return '';
  const clean = String(k).replace(/[^\x20-\x7E]/g, '').trim();
  return clean.startsWith('sk-') ? clean : '';
}

const ADD_LANGS = ['English', 'Spanish', 'French', 'Greek'];

// ── Logique d'ajout intelligent (portée de l'Apps Script, lecture D1) ──
const LANG_FULL = { Spanish: 'Spanish', French: 'French', English: 'English', Greek: 'Modern Greek' };

// Appel LLM serveur (gpt-4.1-mini via OPENAI_API_KEY_SCRIPT), retries sur 429/5xx
async function callScriptLLM(prompt, maxTokens, env) {
  const waits = [0, 2000, 5000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise(r => setTimeout(r, waits[attempt]));
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY_SCRIPT}` },
        body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0 })
      });
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || '').trim();
    } catch {
      return null;
    }
  }
  return null;
}

// Appel LLM raisonnement (gpt-5.4 via Responses API), pour les jugements fins
// (similarité). `env.OPENAI_API_KEY_SCRIPT` = clé propriétaire OU clé appelant
// (aiEnv). max_output_tokens compte reasoning + texte → budget large requis.
async function callScriptReasoning(prompt, maxOutputTokens, env, effort = 'low') {
  const waits = [0, 2000, 5000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise(r => setTimeout(r, waits[attempt]));
    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY_SCRIPT}` },
        body: JSON.stringify({
          model: 'gpt-5.4',
          input: [{ role: 'user', content: prompt }],
          max_output_tokens: maxOutputTokens,
          ...(effort !== 'none' && { reasoning: { effort } })
        })
      });
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;
      const data = await res.json();
      let text = data.output_text;
      if (!text && Array.isArray(data.output)) {
        text = data.output
          .flatMap(o => o.content || [])
          .filter(c => c.type === 'output_text')
          .map(c => c.text).join('');
      }
      return (text || '').trim();
    } catch {
      return null;
    }
  }
  return null;
}

// Similarité groupée (1 appel gpt-5.4 pour N mots) — utilisée par l'import Kindle.
// items = [{ word, candidates: [...] }] ; renvoie un Set de mots à IGNORER (flexions).
async function judgeSimilarBatch(items, langName, env) {
  if (!items.length) return {};
  const lines = items.map((it, i) =>
    `${i + 1}. nouveau: "${it.word}" | existants: ${it.candidates.map(c => `"${c}"`).join(', ')}`
  ).join('\n');
  const prompt = `Language: ${langName}.
For each numbered line, decide if the NEW word is merely an inflected form / spelling variant of one of the EXISTING words (same lemma: conjugation, plural, gender, diminutive, accent variant). It it adds distinct vocabulary value, keep it.
Reply ONLY with a JSON array, one object per line:
[{"i": 1, "skip": true, "match": "<existing word>"}, {"i": 2, "skip": false}, ...]
"skip": true means it's a duplicate-ish inflection to drop.

${lines}`;
  const res = await callScriptReasoning(prompt, 8000, env, 'low');
  const out = {};
  if (!res) return out;
  const m = res.match(/\[[\s\S]*\]/);
  if (!m) return out;
  try {
    for (const r of JSON.parse(m[0])) {
      const it = items[(r.i || 0) - 1];
      if (it && r.skip) out[it.word] = r.match || '';
    }
  } catch {}
  return out;
}

// Détection langue + validité en un appel → { valid, reason, lang }
async function analyzeWordLangSense(word, env) {
  const prompt = `Analyze the expression: "${word}".
1. Identify its language (must be one of: French, English, Spanish, Greek).
2. Check if it is a valid word or expression in that language (allow real words, conjugated forms, phrases, slang).
Answer NO only for gibberish, typos producing no real word, or text clearly in a different language.
Reply STRICTLY in one of these two formats:
VALID | <LanguageName>
INVALID: <brief reason> | <LanguageName>`;
  const res = await callScriptLLM(prompt, 60, env);
  if (!res) return { valid: false, reason: 'Erreur API OpenAI', lang: null };
  const parts = res.split('|');
  const statusPart = (parts[0] || '').trim();
  const langPart = (parts[1] || '').trim();
  const lang = ADD_LANGS.find(l => langPart.toLowerCase().includes(l.toLowerCase())) || null;
  if (/^INVALID/i.test(statusPart)) return { valid: false, reason: statusPart.replace(/^INVALID[:\s]*/i, '').trim(), lang };
  return { valid: true, lang };
}

async function identifyLang(word, env) {
  const prompt = `Which language is "${word}" from? Options: French, English, Spanish, Greek.
Reply with ONLY the language name, nothing else.`;
  const res = await callScriptLLM(prompt, 10, env);
  if (!res) return null;
  return ADD_LANGS.find(l => res.toLowerCase().includes(l.toLowerCase())) || null;
}

async function validateWord(word, lang, env) {
  const langName = LANG_FULL[lang] || lang;
  const prompt = `Is "${word}" a valid ${langName} word or expression?
Answer YES for: real words, conjugated forms, multi-word expressions, phrases, slang, archaic terms.
Answer NO only for: gibberish, typos producing no real word, or text clearly in a different language.
Reply with YES or NO: <brief reason if NO>.`;
  const res = await callScriptLLM(prompt, 60, env);
  if (res === null) return { valid: false, reason: 'Erreur API OpenAI' };
  if (/^NO\b/i.test(res)) return { valid: false, reason: res.replace(/^NO[:\s]*/i, '').trim() };
  return { valid: true };
}

async function judgeSimilarity(word, candidates, lang, env) {
  const langName = LANG_FULL[lang] || lang;
  const prompt = `Language: ${langName}.
I want to add "${word}" to my vocabulary list.
Existing words: ${candidates.join(', ')}.
Is "${word}" merely an inflected form of an existing word (same lemma: conjugation, plural, gender, diminutive)?
If YES, reply exactly "YES: <existing_word>". If it has distinct vocabulary value, reply "NO".`;
  const res = await callScriptLLM(prompt, 30, env);
  if (res && /^YES:/i.test(res)) return res.replace(/^YES:\s*/i, '').trim();
  return null;
}

function normSim(w) {
  // Garde latin ET grec (sinon les mots grecs deviennent "" → similarité morte).
  // NFD + suppression des accents (tonos grec inclus), sigma final ς → σ.
  return w.normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ς/g, 'σ')
    .replace(/[^a-zα-ω]/g, '');
}

function similarityScore(wNorm, eNorm) {
  if (!eNorm || eNorm.length < 2) return 0;
  let score = 0;
  const minLen = Math.min(wNorm.length, eNorm.length);
  if (wNorm.length >= 4 && eNorm.indexOf(wNorm) !== -1) score += 10;
  else if (eNorm.length >= 4 && wNorm.indexOf(eNorm) !== -1) score += 10;
  if (minLen >= 5 && wNorm.substring(0, 4) === eNorm.substring(0, 4)) score += 5;
  if (minLen >= 6 && wNorm.slice(-4) === eNorm.slice(-4)) score += 3;
  const lenDiff = Math.abs(wNorm.length - eNorm.length);
  if (lenDiff <= 2) score += 2;
  else if (lenDiff <= 4) score += 1;
  return score;
}

// Normalisation du mot (port de l'Apps Script)
function normalizeWord(raw) {
  return (raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[‘’`ʼ]/g, "'")
    .replace(/…/g, '...')
    .replace(/(?<!\.)\.(?!\.)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M} '¿?\.\-\+]/gu, '')
    .trim()
    .toLowerCase();
}

// ---- Vérification ID token Google (OAuth, JWKS RS256) ----

let _googleJwks = null;
let _googleJwksExp = 0;

async function getGoogleJwks() {
  const now = Date.now();
  if (_googleJwks && now < _googleJwksExp) return _googleJwks;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const data = await res.json();
  const maxAge = parseInt((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || '3600', 10);
  _googleJwks = data.keys;
  _googleJwksExp = now + maxAge * 1000;
  return _googleJwks;
}

async function verifyGoogleIdToken(idToken, clientId) {
  try {
    const parts = (idToken || '').split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (header.alg !== 'RS256') return null;
    const keys = await getGoogleJwks();
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;
    if (payload.aud !== clientId) return null;
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    if (!payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret, Authorization, X-OpenAI-Key, X-Gemini-Key',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const path = new URL(request.url).pathname;

    // ---- Routes multi-utilisateur (publiques ou JWT, pas de X-Worker-Secret) ----

    if (path === '/auth/signup') {
      try {
        const { email, password } = await request.json();
        const mail = (email || '').trim().toLowerCase();
        if (!mail || !password) return json({ error: { message: 'email et mot de passe requis' } }, 400);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return json({ error: { message: 'email invalide' } }, 400);
        if (password.length < 8) return json({ error: { message: 'mot de passe trop court (min 8 caractères)' } }, 400);
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(mail).first();
        if (existing) return json({ error: { message: 'un compte existe déjà avec cet email' } }, 409);
        const res = await env.DB.prepare(
          'INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'
        ).bind(mail, await hashPassword(password), new Date().toISOString()).run();
        const uid = res.meta.last_row_id;
        return json({ token: await signJWT({ uid, email: mail }, env.JWT_SECRET), user: { id: uid, email: mail } });
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/auth/login') {
      try {
        const { email, password } = await request.json();
        const mail = (email || '').trim().toLowerCase();
        const user = await env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').bind(mail).first();
        if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
          return json({ error: { message: 'identifiants invalides' } }, 401);
        }
        return json({ token: await signJWT({ uid: user.id, email: user.email }, env.JWT_SECRET), user: { id: user.id, email: user.email } });
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/auth/google') {
      try {
        const { idToken } = await request.json();
        const gp = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
        if (!gp) return json({ error: { message: 'token Google invalide' } }, 401);
        const email = (gp.email || '').trim().toLowerCase();
        const googleId = gp.sub;
        let user = await env.DB.prepare('SELECT id, email FROM users WHERE google_id = ?').bind(googleId).first();
        if (!user) {
          const existing = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
          if (existing) {
            // Liaison : email déjà inscrit (mdp) → on rattache le compte Google
            await env.DB.prepare('UPDATE users SET google_id = ? WHERE id = ?').bind(googleId, existing.id).run();
            user = existing;
          } else {
            const res = await env.DB.prepare(
              'INSERT INTO users (email, google_id, created_at) VALUES (?, ?, ?)'
            ).bind(email, googleId, new Date().toISOString()).run();
            user = { id: res.meta.last_row_id, email };
          }
        }
        return json({ token: await signJWT({ uid: user.id, email: user.email }, env.JWT_SECRET), user: { id: user.id, email: user.email } });
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/me') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      const user = await env.DB.prepare('SELECT id, email, created_at, add_token, openai_key, gemini_key, settings FROM users WHERE id = ?').bind(auth.uid).first();
      if (!user) return json({ error: { message: 'utilisateur introuvable' } }, 404);
      if (!user.add_token) {
        const tok = genToken();
        await env.DB.prepare('UPDATE users SET add_token = ? WHERE id = ?').bind(tok, user.id).run();
        user.add_token = tok;
      }
      return json({ user });
    }

    // Sync des réglages (sliders, modèle, niveaux…) entre appareils — blob JSON en D1
    if (path === '/api/settings') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      if (request.method === 'POST') {
        try {
          const { settings } = await request.json();
          await env.DB.prepare('UPDATE users SET settings = ? WHERE id = ?')
            .bind(JSON.stringify(settings || {}), auth.uid).run();
          return json({ ok: true });
        } catch (err) {
          return json({ error: { message: err.message } }, 500);
        }
      }
      return json({ error: { message: 'méthode non supportée' } }, 405);
    }

    // BYOK : sync des clés IA entre appareils (stockées en D1)
    if (path === '/api/keys') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      if (request.method === 'POST') {
        try {
          const { openaiKey, geminiKey } = await request.json();
          await env.DB.prepare('UPDATE users SET openai_key = ?, gemini_key = ? WHERE id = ?')
            .bind(openaiKey || null, geminiKey || null, auth.uid).run();
          return json({ ok: true });
        } catch (err) {
          return json({ error: { message: err.message } }, 500);
        }
      }
      return json({ error: { message: 'méthode non supportée' } }, 405);
    }

    // Ajout de mot par token perso (raccourci iPhone / outils externes) → D1.
    // Porte la logique de l'Apps Script : langue + validité + similarité, réponses texte identiques.
    if (path === '/add') {
      const textOut = (s) => new Response(s, { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
      try {
        const params = new URL(request.url).searchParams;
        let token = params.get('token');
        let rawWord = params.get('word');
        let lang = (params.get('lang') || '').toLowerCase().trim();
        let ignoreSens = params.get('ignore_sens') === 'true';
        let ignoreSim = params.get('ignore_sim') === 'true';
        if (request.method === 'POST') {
          let body = {};
          const ct = request.headers.get('content-type') || '';
          try {
            if (ct.includes('application/json')) body = await request.json();
            else { const fd = await request.formData(); fd.forEach((v, k) => { body[k] = v; }); }
          } catch {}
          token = token || body.token;
          rawWord = rawWord || body.word;
          if (!lang) lang = (body.lang || '').toLowerCase().trim();
          if (!ignoreSens) ignoreSens = body.ignore_sens === 'true';
          if (!ignoreSim) ignoreSim = body.ignore_sim === 'true';
        }
        if (!token) return textOut('Erreur : token manquant.');
        const user = await env.DB.prepare('SELECT id FROM users WHERE add_token = ?').bind(token).first();
        if (!user) return textOut('Erreur : token invalide.');

        const word = normalizeWord(rawWord);
        if (!word) return textOut('Erreur : le mot est vide.');

        // BYOK de l'entonnoir : si l'appelant fournit sa propre clé OpenAI
        // (kindle_import.py via X-OpenAI-Key), on l'utilise pour les appels LLM ;
        // sinon repli sur OPENAI_API_KEY_SCRIPT (raccourci iPhone). Voir api_keys_mapping.
        const callerKey = sanitizeScriptKey(request.headers.get('X-OpenAI-Key'));
        const aiEnv = callerKey ? { ...env, OPENAI_API_KEY_SCRIPT: callerKey } : env;

        const tabMap = {
          english: 'English', anglais: 'English', en: 'English',
          spanish: 'Spanish', espagnol: 'Spanish', es: 'Spanish',
          greek: 'Greek', grec: 'Greek', el: 'Greek',
          french: 'French', 'français': 'French', fr: 'French'
        };
        let language = (lang && lang !== 'auto' && tabMap[lang]) ? tabMap[lang] : null;

        // 1 & 2 — détection langue + validité
        if (!language && !ignoreSens) {
          const analysis = await analyzeWordLangSense(word, aiEnv);
          if (!analysis.lang) return textOut('Erreur : langue non détectée. Réessaie ou précise la langue.');
          language = analysis.lang;
          if (!analysis.valid) return textOut('INVALID:' + analysis.reason + ' | ' + language);
        } else {
          if (!language) {
            language = await identifyLang(word, aiEnv);
            if (!language) return textOut('Erreur : langue non détectée. Réessaie ou précise la langue.');
          }
          if (!ignoreSens) {
            const v = await validateWord(word, language, aiEnv);
            if (!v.valid) return textOut('INVALID:' + v.reason + ' | ' + language);
          }
        }

        // mots existants pour cette langue (D1)
        const { results } = await env.DB.prepare(
          'SELECT word FROM words WHERE user_id = ? AND language = ?'
        ).bind(user.id, language).all();
        const existing = results.map(r => r.word);

        // 3 — doublon exact
        if (existing.some(e => (e || '').trim().toLowerCase() === word)) {
          return textOut("Doublon : '" + word + "' existe déjà dans " + language + ".");
        }

        // similarité (top 5 candidats → juge LLM)
        if (!ignoreSim) {
          const wNorm = normSim(word);
          const scored = [];
          for (const e of existing) {
            const ex = (e || '').trim();
            if (ex.length < 2) continue;
            const s = similarityScore(wNorm, normSim(ex.toLowerCase()));
            if (s > 0) scored.push({ word: ex, score: s });
          }
          scored.sort((a, b) => b.score - a.score);
          const candidates = scored.slice(0, 5).map(x => x.word);
          if (candidates.length > 0) {
            const sim = await judgeSimilarity(word, candidates, language, aiEnv);
            if (sim) return textOut('SIMILAR:' + sim + ' | ' + language);
          }
        }

        // 4 — ajout
        await env.DB.prepare(
          'INSERT OR IGNORE INTO words (user_id, language, word, created_at) VALUES (?, ?, ?, ?)'
        ).bind(user.id, language, word, new Date().toISOString()).run();
        return textOut("Succès (" + language + ") : '" + word + "' ajouté.");
      } catch (err) {
        return textOut('Erreur : ' + err.message);
      }
    }

    // Similarité groupée (token perso, pas de JWT) — import Kindle batch.
    // Body: { token, lang, words: [...] } ; header X-OpenAI-Key (clé Kindle).
    // Renvoie { skip: { "<mot>": "<mot existant>" } } pour les flexions à ignorer.
    if (path === '/judge-similar') {
      try {
        const body = await request.json().catch(() => ({}));
        const token = new URL(request.url).searchParams.get('token') || body.token;
        if (!token) return json({ error: { message: 'token manquant' } }, 400);
        const user = await env.DB.prepare('SELECT id FROM users WHERE add_token = ?').bind(token).first();
        if (!user) return json({ error: { message: 'token invalide' } }, 403);

        const tabMap = {
          english: 'English', anglais: 'English', en: 'English',
          spanish: 'Spanish', espagnol: 'Spanish', es: 'Spanish',
          greek: 'Greek', grec: 'Greek', el: 'Greek',
          french: 'French', 'français': 'French', fr: 'French'
        };
        const lang = (body.lang || '').toLowerCase().trim();
        const language = tabMap[lang] || (ADD_LANGS.includes(body.lang) ? body.lang : null);
        if (!language) return json({ error: { message: 'langue inconnue' } }, 400);
        const words = Array.isArray(body.words) ? body.words.map(w => String(w || '').trim()).filter(Boolean) : [];
        if (!words.length) return json({ skip: {} });

        const callerKey = sanitizeScriptKey(request.headers.get('X-OpenAI-Key'));
        const aiEnv = callerKey ? { ...env, OPENAI_API_KEY_SCRIPT: callerKey } : env;

        const { results } = await env.DB.prepare(
          'SELECT word FROM words WHERE user_id = ? AND language = ?'
        ).bind(user.id, language).all();
        const existing = (results || []).map(r => r.word);

        // Pour chaque mot, top candidats similaires (score > 0)
        const items = [];
        for (const w of words) {
          const wNorm = normSim(w);
          const scored = [];
          for (const e of existing) {
            const ex = (e || '').trim();
            if (ex.length < 2) continue;
            const s = similarityScore(wNorm, normSim(ex.toLowerCase()));
            if (s > 0) scored.push({ word: ex, score: s });
          }
          scored.sort((a, b) => b.score - a.score);
          const candidates = scored.slice(0, 3).map(x => x.word);
          if (candidates.length) items.push({ word: w, candidates });
        }

        // Découpe en lots de 40 → 1 appel gpt-5.4 chacun
        const skip = {};
        for (let i = 0; i < items.length; i += 40) {
          const chunk = items.slice(i, i + 40);
          Object.assign(skip, await judgeSimilarBatch(chunk, language, aiEnv));
        }
        return json({ skip });
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    // ---- Données utilisateur (D1, protégées par JWT, filtrées par user_id) ----

    if (path === '/api/words') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const sp = new URL(request.url).searchParams;
          const lang = sp.get('lang');
          const { results } = await env.DB.prepare(
            'SELECT word, created_at FROM words WHERE user_id = ? AND language = ? ORDER BY created_at'
          ).bind(auth.uid, lang).all();
          if (sp.get('detail')) return json({ words: results });
          return json({ words: results.map(r => r.word) });
        }
        if (request.method === 'POST') {
          const { lang, word } = await request.json();
          if (!lang || !word || !word.trim()) return json({ error: { message: 'lang et word requis' } }, 400);
          await env.DB.prepare(
            'INSERT OR IGNORE INTO words (user_id, language, word, created_at) VALUES (?, ?, ?, ?)'
          ).bind(auth.uid, lang, word.trim(), new Date().toISOString()).run();
          return json({ ok: true });
        }
        if (request.method === 'DELETE') {
          const body = await request.json();
          // Suppression groupée : { items: [{lang, word}, ...] } (peut mélanger les langues)
          // ou unitaire : { lang, word }.
          const items = Array.isArray(body.items) ? body.items : [{ lang: body.lang, word: body.word }];
          const stmts = [];
          for (const it of items) {
            if (!it || !it.lang || !it.word) continue;
            stmts.push(env.DB.prepare('DELETE FROM words WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, it.lang, it.word));
            stmts.push(env.DB.prepare('DELETE FROM progress WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, it.lang, it.word));
          }
          if (stmts.length) await env.DB.batch(stmts);
          return json({ ok: true, deleted: stmts.length / 2 });
        }
        if (request.method === 'PUT') {
          const { lang, oldWord, newWord } = await request.json();
          const nw = (newWord || '').trim();
          if (!lang || !oldWord || !nw) return json({ error: { message: 'lang, oldWord, newWord requis' } }, 400);
          const exists = await env.DB.prepare('SELECT 1 FROM words WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, lang, nw).first();
          if (exists) return json({ error: { message: 'ce mot existe déjà' } }, 409);
          await env.DB.batch([
            env.DB.prepare('UPDATE words SET word = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, auth.uid, lang, oldWord),
            env.DB.prepare('UPDATE progress SET word = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, auth.uid, lang, oldWord),
            env.DB.prepare('UPDATE history SET word = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, auth.uid, lang, oldWord)
          ]);
          return json({ ok: true });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/api/progress') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const lang = new URL(request.url).searchParams.get('lang');
          const { results } = lang
            ? await env.DB.prepare(
                'SELECT word, language, correct, incorrect, hint_used, next_review FROM progress WHERE user_id = ? AND language = ?'
              ).bind(auth.uid, lang).all()
            : await env.DB.prepare(
                'SELECT word, language, correct, incorrect, hint_used, next_review FROM progress WHERE user_id = ?'
              ).bind(auth.uid).all();
          return json({ progress: results });
        }
        if (request.method === 'POST') {
          const { lang, word, correct, incorrect, hintUsed, nextReview } = await request.json();
          if (!lang || !word) return json({ error: { message: 'lang et word requis' } }, 400);
          await env.DB.prepare(
            `INSERT INTO progress (user_id, language, word, correct, incorrect, last_practiced, hint_used, next_review)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, language, word) DO UPDATE SET
               correct = excluded.correct, incorrect = excluded.incorrect,
               last_practiced = excluded.last_practiced, hint_used = excluded.hint_used,
               next_review = excluded.next_review`
          ).bind(auth.uid, lang, word, correct || 0, incorrect || 0, new Date().toISOString(), hintUsed || 0, nextReview || null).run();
          return json({ ok: true });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/api/session') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const params = new URL(request.url).searchParams;
          const row = await env.DB.prepare(
            'SELECT new_count FROM sessions WHERE user_id = ? AND date = ? AND language = ?'
          ).bind(auth.uid, params.get('date'), params.get('lang')).first();
          return json({ count: row ? row.new_count : 0 });
        }
        if (request.method === 'POST') {
          const { lang, date, count } = await request.json();
          if (!lang || !date) return json({ error: { message: 'lang et date requis' } }, 400);
          await env.DB.prepare(
            `INSERT INTO sessions (user_id, date, language, new_count) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, date, language) DO UPDATE SET new_count = excluded.new_count`
          ).bind(auth.uid, date, lang, count || 0).run();
          return json({ ok: true });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/api/history') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT date, word, language AS lang, result FROM history WHERE user_id = ? ORDER BY id'
          ).bind(auth.uid).all();
          return json({ history: results.map(r => ({ ...r, result: r.result ? '✓' : '✗' })) });
        }
        if (request.method === 'POST') {
          const { rows } = await request.json(); // [[date, word, lang, '✓'|'✗'], ...]
          if (!Array.isArray(rows) || rows.length === 0) return json({ ok: true });
          const stmt = env.DB.prepare('INSERT INTO history (user_id, date, word, language, result) VALUES (?, ?, ?, ?, ?)');
          await env.DB.batch(rows.map(r => stmt.bind(auth.uid, r[0], r[1], r[2], r[3] === '✓' ? 1 : 0)));
          return json({ ok: true });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/api/blacklist') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const lang = new URL(request.url).searchParams.get('lang');
          const { results } = await env.DB.prepare(
            'SELECT word FROM blacklist WHERE user_id = ? AND language = ?'
          ).bind(auth.uid, lang).all();
          return json({ words: results.map(r => r.word) });
        }
        if (request.method === 'POST') {
          const { lang, words } = await request.json();
          if (!lang || !Array.isArray(words) || words.length === 0) return json({ ok: true });
          const stmt = env.DB.prepare('INSERT OR IGNORE INTO blacklist (user_id, language, word) VALUES (?, ?, ?)');
          await env.DB.batch(words.map(w => stmt.bind(auth.uid, lang, w)));
          return json({ ok: true });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/api/grammar') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const lang = new URL(request.url).searchParams.get('lang');
          const { results } = await env.DB.prepare(
            'SELECT category, form FROM grammar_forms WHERE user_id = ? AND language = ?'
          ).bind(auth.uid, lang).all();
          return json({ forms: results });
        }
        if (request.method === 'POST') {
          const { lang, category, form } = await request.json();
          const cat = (category || '').trim(), frm = (form || '').trim();
          if (!lang || !cat || !frm) return json({ error: { message: 'lang, category, form requis' } }, 400);
          const exists = await env.DB.prepare(
            'SELECT 1 FROM grammar_forms WHERE user_id = ? AND language = ? AND category = ? AND form = ?'
          ).bind(auth.uid, lang, cat, frm).first();
          if (exists) return json({ error: { message: 'cette forme existe déjà' } }, 409);
          await env.DB.prepare(
            'INSERT INTO grammar_forms (user_id, language, category, form) VALUES (?, ?, ?, ?)'
          ).bind(auth.uid, lang, cat, frm).run();
          return json({ ok: true });
        }
        if (request.method === 'DELETE') {
          const { lang, category, form } = await request.json();
          await env.DB.prepare(
            'DELETE FROM grammar_forms WHERE user_id = ? AND language = ? AND category = ? AND form = ?'
          ).bind(auth.uid, lang, category, form).run();
          return json({ ok: true });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    if (path === '/api/usage') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      const ZERO = { openai_input: 0, openai_output: 0, openai_requests: 0, gemma_requests: 0, geminiflash_req: 0, geminiflashlite_req: 0 };
      try {
        if (request.method === 'GET') {
          const date = new URL(request.url).searchParams.get('date');
          const row = await env.DB.prepare(
            'SELECT openai_input, openai_output, openai_requests, gemma_requests, geminiflash_req, geminiflashlite_req FROM usage WHERE user_id = ? AND date = ?'
          ).bind(auth.uid, date).first();
          return json({ usage: row || ZERO });
        }
        if (request.method === 'POST') {
          const b = await request.json();
          if (!b.date) return json({ error: { message: 'date requise' } }, 400);
          const d = {
            i: b.openaiInput || 0, o: b.openaiOutput || 0, r: b.openaiRequests || 0,
            g: b.gemmaRequests || 0, f: b.geminiflashReq || 0, l: b.geminiflashliteReq || 0
          };
          await env.DB.prepare(
            `INSERT INTO usage (user_id, date, openai_input, openai_output, openai_requests, gemma_requests, geminiflash_req, geminiflashlite_req)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, date) DO UPDATE SET
               openai_input = openai_input + excluded.openai_input,
               openai_output = openai_output + excluded.openai_output,
               openai_requests = openai_requests + excluded.openai_requests,
               gemma_requests = gemma_requests + excluded.gemma_requests,
               geminiflash_req = geminiflash_req + excluded.geminiflash_req,
               geminiflashlite_req = geminiflashlite_req + excluded.geminiflashlite_req`
          ).bind(auth.uid, b.date, d.i, d.o, d.r, d.g, d.f, d.l).run();
          const row = await env.DB.prepare(
            'SELECT openai_input, openai_output, openai_requests, gemma_requests, geminiflash_req, geminiflashlite_req FROM usage WHERE user_id = ? AND date = ?'
          ).bind(auth.uid, b.date).first();
          return json({ usage: row || ZERO });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    // ---- Routes IA (JWT + BYOK : clé utilisateur passée par header) ----

    // /unsplash : clé propriétaire (gratuite), protégée par JWT
    if (path === '/unsplash') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        const { query } = await request.json();
        const apiUrl = `https://api.unsplash.com/photos/random?orientation=landscape&content_filter=high${query ? `&query=${encodeURIComponent(query)}` : ''}`;
        const resp = await fetch(apiUrl, {
          headers: { 'Authorization': `Client-ID ${env.UNSPLASH_KEY}` }
        });
        const data = await resp.json();
        return new Response(JSON.stringify({
          url: data.urls.regular,
          description: data.alt_description || ''
        }), { status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    if (path === '/gemini') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      const geminiKey = request.headers.get('X-Gemini-Key');
      if (!geminiKey) return json({ error: { message: 'Clé Gemini manquante — ajoute-la dans ⚙️' } }, 400);
      try {
        const { prompt, maxTokens = 1000, imageUrl, stream = false, geminiModel = 'gemini-2.5-pro', thinkingLevel } = await request.json();

        const parts = [{ text: prompt }];

        if (imageUrl) {
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
          const imgBuffer = await imgRes.arrayBuffer();
          const bytes = new Uint8Array(imgBuffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const mimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
          parts.push({ inlineData: { mimeType, data: base64 } });
        }

        const generationConfig = { maxOutputTokens: maxTokens };
        if (thinkingLevel) {
          // Quand thinking est actif, ne pas fixer temperature (recommandation Google : garder 1.0)
          generationConfig.thinkingConfig = { thinkingLevel: thinkingLevel.toUpperCase() };
        } else {
          generationConfig.temperature = 0.2;
        }
        const body = {
          contents: [{ role: 'user', parts }],
          generationConfig
        };

        const action = stream
          ? `streamGenerateContent?alt=sse&key=${geminiKey}`
          : `generateContent?key=${geminiKey}`;
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:${action}`;

        const geminiRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (stream) {
          if (!geminiRes.ok) {
            const errData = await geminiRes.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Gemini HTTP ${geminiRes.status}`);
          }
          // Filtrer les thinking parts (thought: true) du stream SSE pour Gemma
          const sourceStream = geminiRes.body;
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          (async () => {
            const reader = sourceStream.getReader();
            let buffer = '';
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                  if (!line.startsWith('data: ')) {
                    if (line.trim()) await writer.write(encoder.encode(line + '\n'));
                    continue;
                  }
                  const jsonStr = line.slice(6).trim();
                  if (!jsonStr || jsonStr === '[DONE]') {
                    await writer.write(encoder.encode(line + '\n\n'));
                    continue;
                  }
                  try {
                    const chunk = JSON.parse(jsonStr);
                    const isThought = chunk.candidates?.[0]?.content?.parts?.some(p => p.thought);
                    if (!isThought) await writer.write(encoder.encode(line + '\n\n'));
                  } catch {
                    await writer.write(encoder.encode(line + '\n\n'));
                  }
                }
              }
            } finally {
              writer.close().catch(() => {});
            }
          })();
          return new Response(readable, {
            headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
          });
        } else {
          const data = await geminiRes.json();
          if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
          // Filtrer les thinking parts pour ne garder que la réponse
          const allParts = data.candidates?.[0]?.content?.parts ?? [];
          const text = allParts.filter(p => !p.thought).map(p => p.text ?? '').join('');
          const usage = data.usageMetadata ?? {};
          return new Response(JSON.stringify({ text, usage }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // /openai-script : externe (Apps Script + kindle_import.py), gardé par X-Worker-Secret + clé propriétaire
    if (path === '/openai-script') {
      if (request.headers.get('X-Worker-Secret') !== env.WORKER_SECRET) {
        return json({ error: { message: 'Unauthorized — secret manquant ou incorrect' } }, 403);
      }
      try {
        const { prompt, maxTokens = 200, model = 'gpt-4.1-mini' } = await request.json();
        // BYOK : clé fournie par l'appelant (kindle_import.py) sinon clé propriétaire.
        const scriptKey = sanitizeScriptKey(request.headers.get('X-OpenAI-Key')) || env.OPENAI_API_KEY_SCRIPT;
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${scriptKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        const text = data.choices?.[0]?.message?.content?.trim() ?? '';
        return new Response(JSON.stringify({ text }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // OpenAI proxy (route par défaut, BYOK : JWT + clé utilisateur)
    const auth = await requireAuth(request, env);
    if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
    const openaiKey = request.headers.get('X-OpenAI-Key');
    if (!openaiKey) return json({ error: { message: 'Clé OpenAI manquante — ajoute-la dans ⚙️' } }, 400);
    try {
      const body = await request.text();
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body
      });
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }
  }
};
