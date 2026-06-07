let cachedToken = null;
let tokenExpiry = 0;

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

async function getServiceAccountToken(env) {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const sa  = JSON.parse(env.SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64json({ alg: 'RS256', typ: 'JWT' })}.${b64json({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  })}`;
  const pemBody   = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyBytes  = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error_description || d.error);
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + d.expires_in * 1000;
  return cachedToken;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret, Authorization',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

const ALLOWED_SHEET_IDS = [
  '1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc',
  '1xRaN0cp4gMHifiBVJ_f1S1Qbyn5krmzWYHJ5Kd6oqzs',
];

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

    if (path === '/me') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      const user = await env.DB.prepare('SELECT id, email, created_at FROM users WHERE id = ?').bind(auth.uid).first();
      if (!user) return json({ error: { message: 'utilisateur introuvable' } }, 404);
      return json({ user });
    }

    // ---- Données utilisateur (D1, protégées par JWT, filtrées par user_id) ----

    if (path === '/api/words') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const lang = new URL(request.url).searchParams.get('lang');
          const { results } = await env.DB.prepare(
            'SELECT word FROM words WHERE user_id = ? AND language = ? ORDER BY created_at'
          ).bind(auth.uid, lang).all();
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
          const { lang, word } = await request.json();
          await env.DB.batch([
            env.DB.prepare('DELETE FROM words WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, lang, word),
            env.DB.prepare('DELETE FROM progress WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, lang, word)
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

    // ---- Routes héritées (gated par X-Worker-Secret, inchangées) ----

    if (request.headers.get('X-Worker-Secret') !== env.WORKER_SECRET) {
      return new Response(JSON.stringify({ error: { message: 'Unauthorized — secret manquant ou incorrect' } }), {
        status: 403, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    if (path === '/sheets') {
      try {
        const { sheetPath, method, body } = await request.json();
        if (!ALLOWED_SHEET_IDS.some(id => sheetPath.includes(id))) {
          return new Response(JSON.stringify({ error: { message: 'Sheet non autorisé' } }), {
            status: 403, headers: { ...CORS, 'Content-Type': 'application/json' }
          });
        }
        const token = await getServiceAccountToken(env);
        const res = await fetch(`https://sheets.googleapis.com${sheetPath}`, {
          method: method || 'GET',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    if (path === '/unsplash') {
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
          ? `streamGenerateContent?alt=sse&key=${env.GEMINI_KEY}`
          : `generateContent?key=${env.GEMINI_KEY}`;
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

    if (path === '/openai-script') {
      try {
        const { prompt, maxTokens = 200, model = 'gpt-4.1-mini' } = await request.json();
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.OPENAI_API_KEY_SCRIPT}`
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

    // OpenAI proxy
    try {
      const body = await request.text();
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
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
