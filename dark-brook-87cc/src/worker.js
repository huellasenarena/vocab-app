let cachedToken = null;
let tokenExpiry = 0;

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64json(obj) {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)));
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
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
};

const ALLOWED_SHEET_IDS = [
  '1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc',
  '1xRaN0cp4gMHifiBVJ_f1S1Qbyn5krmzWYHJ5Kd6oqzs',
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.headers.get('X-Worker-Secret') !== env.WORKER_SECRET) {
      return new Response(JSON.stringify({ error: { message: 'Unauthorized — secret manquant ou incorrect' } }), {
        status: 403, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const path = new URL(request.url).pathname;

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
