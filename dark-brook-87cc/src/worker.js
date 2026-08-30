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

// Appel LLM raisonnement (gpt-5.6-luna via Responses API), pour les jugements fins
// (similarité). `env.OPENAI_API_KEY_SCRIPT` = clé propriétaire OU clé appelant
// (aiEnv). max_output_tokens compte reasoning + texte → budget large requis.
async function callScriptReasoning(prompt, maxOutputTokens, env, effort = 'low', model = 'gpt-5.6-luna') {
  const waits = [0, 2000, 5000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise(r => setTimeout(r, waits[attempt]));
    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY_SCRIPT}` },
        body: JSON.stringify({
          model,
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

// Similarité groupée (1 appel gpt-5.6-luna pour N mots) — utilisée par l'import Kindle.
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
// GPT-5.6 luna « low » : gpt-4.1-mini rejetait à tort des mots rares/littéraires
// (mêmes faux INVALID qui ont fait retirer la validation IA de l'import Kindle).
// Luna a remplacé terra le 2026-08-27 : réponses identiques sur 23 mots rares /
// dialectaux des 4 langues et sur 12 cas de similarité, pour ~10× moins cher.
// Contexte commun aux prompts d'ajout : une entrée multi-mots est une expression
// figée (jamais à lire mot à mot) et la note de l'utilisateur précise la variété
// régionale / le registre / le sens visé.
function entryContext(base, note) {
  const parts = [];
  if (/\s/.test(String(base).trim())) parts.push('This entry is a multi-word expression: treat it as a fixed idiomatic unit, never literally word by word.');
  if (note) parts.push(`The learner added this note about it: "${note}". Take it into account (regional variety, register, intended sense). The note is a comment, NOT part of the expression itself.`);
  return parts.length ? '\n' + parts.join('\n') : '';
}

// Graphie proposée par le modèle quand le mot est invalide : on ne garde que
// ce qui est exploitable en un clic (« ajouter le mot proposé »). NONE, une
// réponse vide, ou une suggestion identique au mot saisi → rien à proposer.
function cleanSuggestion(raw, word) {
  const s = String(raw || '').trim().replace(/^["'«»\s]+|["'«».\s]+$/g, '');
  if (!s || s.length > 80) return null;
  if (/^(none|aucun|n\/a|-)$/i.test(s)) return null;
  if (s.toLowerCase() === String(word || '').trim().toLowerCase()) return null;
  return s;
}

// ---- Proposition d'une taxonomie à partir du corpus réel ----
//
// Un seul appel : même 7 000 entrées tiennent largement dans la fenêtre, et le
// modèle voit alors TOUT le corpus au lieu d'un échantillon — c'est ce qui lui
// fait sortir « colombianismos » ou « fórmulas del ensayo » plutôt qu'une liste
// générique de manuel. Plafonné à 5000 entrées tirées au hasard pour borner la
// latence ; au-delà, l'échantillon suffit largement à dessiner des catégories.
const PROPOSE_MAX = 5000;
function targetGroupCount(n) {
  if (n < 500)  return 12;
  if (n < 1500) return 18;
  if (n < 4000) return 24;
  return 38;
}

async function proposeTaxonomy(words, existing, langName, env, model) {
  let sample = words;
  if (sample.length > PROPOSE_MAX) {
    sample = [...words];
    for (let i = sample.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sample[i], sample[j]] = [sample[j], sample[i]];
    }
    sample = sample.slice(0, PROPOSE_MAX);
  }
  const target = targetGroupCount(words.length);
  const per = Math.max(10, Math.round(words.length / target));

  const prompt = `You design the thematic taxonomy of a learner's personal vocabulary list of ${langName}.

Here is the whole list (${sample.length} entries):
${sample.join(' | ')}

Propose about ${target} groups covering this corpus, roughly ${per} entries each.

Rules:
- Name every group IN ${langName}, lowercase, short (2 to 5 words).
- Give each group a one-line scope: what it holds and, when the name is ambiguous, what it does NOT hold.
- Look at what this corpus actually contains. If a large share of the entries are fixed phrases, connectors or sentence fragments rather than single words, some groups MUST be functional (discourse, time, manner, judgement...) and not thematic — a purely thematic taxonomy would leave them homeless.
- Give a group to any distinctive layer you notice (a regional variety, a register, a recurring source).
- Reuse the EXACT name of an existing group whenever it still fits: ${existing.length ? existing.join(' | ') : '(none yet)'}.
- No group that would hold fewer than 5 entries.

Reply with ONLY a JSON array, no prose, no code fences:
[{"name":"...","scope":"..."}]`;

  const res = await callScriptReasoning(prompt, 16000, env, 'low', model);
  if (!res) return null;
  const m = res.match(/\[[\s\S]*\]/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set();
  return parsed
    .map(g => ({ name: String(g && g.name || '').trim(), scope: String(g && g.scope || '').trim() }))
    .filter(g => {
      const k = g.name.toLowerCase();
      if (!g.name || g.name.length > 80 || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ---- Classement d'un lot d'entrées dans une liste FERMÉE de groupes ----
//
// Numéros des deux côtés (groupes ET entrées) : c'est 3x moins de tokens qu'un
// échange de libellés, et surtout ça supprime le rapprochement de chaînes —
// un nom de groupe re-tapé avec un accent en moins n'est plus un groupe perdu.
// Le modèle ne peut donc PAS inventer de groupe : hors de la liste, l'index est
// simplement ignoré.
// Verdict du modèle PUIS écriture des rattachements. Point de passage unique :
// la route /api/autogroup et l'ajout d'un mot (/add) l'appellent toutes les
// deux, pour qu'un mot soit rangé quel que soit le client qui l'a ajouté.
// Rend { assigned } (mot -> noms de groupes) ou null si le modèle est illisible.
async function classifyAndStore(env, uid, language, groups, entries, aiEnv, model, dry) {
  const verdict = await classifyBatch(entries, groups, LANG_FULL[language] || language, aiEnv, model);
  if (!verdict) return null;

  const nameById = new Map(groups.map(g => [g.id, g.name]));
  const assigned = {};
  const stmts = [];
  const insert = env.DB.prepare(
    'INSERT OR IGNORE INTO word_groups (user_id, language, word, group_id, auto) VALUES (?, ?, ?, ?, 1)'
  );
  const mark = env.DB.prepare(
    'UPDATE words SET grouped = 1 WHERE user_id = ? AND language = ? AND word = ?'
  );
  for (let i = 0; i < entries.length; i++) {
    const ids = verdict.get(i) || [];
    assigned[entries[i]] = ids.map(id => nameById.get(id));
    for (const id of ids) stmts.push(insert.bind(uid, language, entries[i], id));
    stmts.push(mark.bind(uid, language, entries[i]));
  }
  // `dry` : verdict rendu sans rien écrire — sert à juger un lot témoin.
  if (!dry && stmts.length) await env.DB.batch(stmts);
  return { assigned };
}

// Classement d'un mot qui vient d'être ajouté (/add). Lit les groupes de sa
// langue et délègue. Sans groupe défini pour la langue, il n'y a rien à faire :
// le mot reste `grouped = 0` et la prochaine passe le reprendra.
async function autogroupOnAdd(env, uid, language, word, aiEnv) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, scope FROM groups WHERE user_id = ? AND language = ? AND kind = 'theme' ORDER BY id"
  ).bind(uid, language).all();
  const groups = results || [];
  if (!groups.length) return;
  await classifyAndStore(env, uid, language, groups, [word], aiEnv, 'gpt-5.6-luna', false);
}

async function classifyBatch(entries, groups, langName, env, model) {
  // Nom + ligne de portée : le seul nom est ambigu (« fórmulas del ensayo »
  // attirait les adjectifs, « locuciones de modo » attirait le nom « modos »).
  const list = groups.map((g, i) =>
    `${i + 1}. ${g.name}` + (g.scope ? `\n   -> ${g.scope}` : '')).join('\n');
  const items = entries.map((e, i) => {
    const { base, note } = splitEntry(e);
    return `${i + 1}. ${base}${note ? `   [note: ${note}]` : ''}`;
  }).join('\n');

  const prompt = `You are sorting a learner's personal vocabulary list of ${langName}.

Assign each ENTRY to 0, 1, 2 or 3 groups from this CLOSED list:
${list}

Rules:
- Pick the group(s) the entry would most naturally be practised with.
- Prefer ONE group, but add a second (rarely a third) whenever the entry plainly belongs to two of them at once.
- An empty array is for entries that genuinely fit nothing: bare inflected fragments, ambiguous forms. An ordinary noun, verb or adjective almost always fits at least one group — look again before giving up.
- Match on what the entry IS, not on words it shares with a group name.
- A multi-word entry is a fixed expression: classify it as a whole, never word by word.
- A [note: ...] is the learner's own comment (regional variety, register, intended sense). Use it as context; it is not part of the expression.
- Use ONLY numbers from the list above.

ENTRIES:
${items}

Reply with ONLY a JSON object mapping each entry number (as a string) to an array of group numbers.
Example: {"1":[8],"2":[3,34],"3":[]}
No prose, no code fences, one key per entry.`;

  const res = await callScriptReasoning(prompt, 12000, env, 'low', model);
  if (!res) return null;
  const m = res.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }

  // index d'entrée -> [group_id], borné à 3 et filtré sur la liste fermée
  const out = new Map();
  for (let i = 0; i < entries.length; i++) {
    const raw = parsed[String(i + 1)];
    const ids = (Array.isArray(raw) ? raw : [])
      .map(n => groups[Number(n) - 1])
      .filter(Boolean)
      .map(g => g.id);
    out.set(i, [...new Set(ids)].slice(0, 3));
  }
  return out;
}

async function analyzeWordLangSense(word, note, env) {
  const prompt = `Analyze the expression: "${word}".${entryContext(word, note)}
1. Identify its language (must be one of: French, English, Spanish, Greek).
2. Check if it is a valid word or expression in that language (allow real words, conjugated forms, phrases, slang, and rare/archaic/literary/dialectal terms).
Answer NO only for gibberish, typos producing no real word, or text clearly in a different language.
3. If it is INVALID and looks like a typo for a real word of that language, give the corrected spelling. Otherwise write NONE.
Reply STRICTLY in one of these two formats (never use the "|" character inside the reason):
VALID | <LanguageName>
INVALID: <brief reason> | <LanguageName> | <corrected spelling or NONE>`;
  const res = await callScriptReasoning(prompt, 2000, env, 'low');
  if (!res) return { valid: false, reason: 'Erreur API OpenAI', lang: null };
  const parts = res.split('|');
  const statusPart = (parts[0] || '').trim();
  const langPart = (parts[1] || '').trim();
  const lang = ADD_LANGS.find(l => langPart.toLowerCase().includes(l.toLowerCase())) || null;
  if (/^INVALID/i.test(statusPart)) return {
    valid: false,
    reason: statusPart.replace(/^INVALID[:\s]*/i, '').trim(),
    lang,
    suggestion: cleanSuggestion(parts[2], word),
  };
  return { valid: true, lang };
}

async function identifyLang(word, env) {
  const prompt = `Which language is "${word}" from? Options: French, English, Spanish, Greek.
Reply with ONLY the language name, nothing else.`;
  const res = await callScriptReasoning(prompt, 1500, env, 'low');
  if (!res) return null;
  return ADD_LANGS.find(l => res.toLowerCase().includes(l.toLowerCase())) || null;
}

async function validateWord(word, note, lang, env) {
  const langName = LANG_FULL[lang] || lang;
  const prompt = `Is "${word}" a valid ${langName} word or expression?${entryContext(word, note)}
Answer YES for: real words, conjugated forms, multi-word expressions, phrases, slang, archaic, literary, dialectal or rare terms.
Answer NO only for: gibberish, typos producing no real word, or text clearly in a different language.
If the answer is NO and it looks like a typo for a real ${langName} word, give the corrected spelling after the "|"; otherwise write NONE.
Reply with "YES", or "NO: <brief reason> | <corrected spelling or NONE>" (never use "|" inside the reason).`;
  const res = await callScriptReasoning(prompt, 2000, env, 'low');
  if (res === null) return { valid: false, reason: 'Erreur API OpenAI' };
  if (/^NO\b/i.test(res)) {
    const parts = res.split('|');
    return {
      valid: false,
      reason: (parts[0] || '').replace(/^NO[:\s]*/i, '').trim(),
      suggestion: cleanSuggestion(parts[1], word),
    };
  }
  return { valid: true };
}

async function judgeSimilarity(word, note, candidates, lang, env) {
  const langName = LANG_FULL[lang] || lang;
  const prompt = `Language: ${langName}.
I want to add "${word}" to my vocabulary list.${entryContext(word, note)}
Existing words: ${candidates.join(', ')}.
Is "${word}" merely an inflected form of an existing word (same lemma: conjugation, plural, gender, diminutive)?${note ? `
IMPORTANT: the note means this entry is a deliberately distinct sense. If an existing entry has the same base word but a different (or no) note, they are NOT duplicates — reply "NO".` : ''}
If YES, reply exactly "YES: <existing_word>". If it has distinct vocabulary value, reply "NO".`;
  const res = await callScriptReasoning(prompt, 1500, env, 'low');
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

// Une entrée peut porter une note entre parenthèses en fin de chaîne :
// « hacer el oso (expresión colombiana) ». La note est du CONTEXTE (variété
// régionale, registre, désambiguïsation d'homonyme), jamais du vocabulaire à
// réviser : on la sépare partout de la base avant de la donner aux prompts,
// de l'afficher ou de la comparer.
// Une parenthèse COLLÉE au mot fait partie du mot (« asomar(se) ») ; seule une
// parenthèse détachée par un espace est une note.
function splitEntry(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*\S)\s+\(([^()]*)\)$/);
  if (!m) return { base: s, note: '' };
  return { base: m[1].trim(), note: m[2].trim() };
}

// Le mot lui-même : jeu de caractères étroit (lettres, espaces, apostrophes…).
// Chiffres et virgule admis : sans eux « los años 70 » perdait son année et
// « cabe inferir, aunque…, que... » ses virgules. La virgule n'est plus un
// séparateur de saisie (voir splitAddInput côté front), elle peut donc entrer
// dans une entrée.
function cleanBase(s) {
  return s
    .replace(/(?<!\.)\.(?!\.)/g, '')
    .replace(/[^\p{L}\p{M}\p{N} '¿?,\.\-\+()]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// La note est du texte libre : on garde chiffres et ponctuation courante
// (« expresión colombiana, informal », « sens 2 »).
function cleanNote(s) {
  return s
    .replace(/[^\p{L}\p{M}\p{N} '¿?¡!,;:\.\-\+\/]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const NOTE_MAX = 120;

// Une seule paire de parenthèses, équilibrée. Si elle est détachée du mot par un
// espace, c'est une NOTE : elle doit alors clore l'entrée et ne pas être vide.
// Collée au mot (« asomar(se) »), elle fait partie du mot et passe telle quelle.
// Throw sinon — aussi utilisée au renommage (PUT /api/words), qui ne normalise
// pas la casse.
function assertParens(s) {
  const opens  = (s.match(/\(/g) || []).length;
  const closes = (s.match(/\)/g) || []).length;
  if (!opens && !closes) return;
  if (opens !== closes) throw new Error("parenthèse non fermée — écris par exemple « hacer el oso (expresión colombiana) ».");
  if (opens > 1)        throw new Error("une seule parenthèse est acceptée par entrée.");
  if (/^\s*\([^()]*\)\s*$/.test(s)) throw new Error("il manque le mot avant la parenthèse.");
  if (/\s\([^()]*\)/.test(s)) { // c'est une note
    if (!/\s\([^()]*\)$/.test(s)) throw new Error("la parenthèse doit être à la fin de l'entrée.");
    if (/\(\s*\)$/.test(s))       throw new Error("la parenthèse est vide.");
  }
}

// Normalisation du mot (port de l'Apps Script)
// Parenthèses mal formées → throw : l'appelant renvoie l'erreur à l'utilisateur
// au lieu de les supprimer en silence. C'est cette suppression silencieuse qui
// avait fait perdre la note des expressions ajoutées avant août 2026.
function normalizeWord(raw) {
  const pre = (raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[‘’`ʼ]/g, "'")
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

  assertParens(pre);

  // Note = parenthèse finale détachée. Un espace manquant est toléré à la
  // saisie (« vaina(cosa) ») uniquement si le contenu ressemble à une note :
  // plusieurs mots. Sinon c'est une flexion collée (« asomar(se) »).
  const m = pre.match(/^(.*\S)\s+\(([^()]*)\)$/) || pre.match(/^(.*\S)\(([^()]*\s[^()]*)\)$/);
  if (!m) return cleanBase(pre);

  const base = cleanBase(m[1]);
  const note = cleanNote(m[2]);
  if (!base)                 throw new Error("il manque le mot avant la parenthèse.");
  if (note.length > NOTE_MAX) throw new Error(`la note entre parenthèses est trop longue (max ${NOTE_MAX} caractères).`);
  return note ? `${base} (${note})` : base;
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
  async fetch(request, env, ctx) {
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
        const user = await env.DB.prepare('SELECT id, openai_key FROM users WHERE add_token = ?').bind(token).first();
        if (!user) return textOut('Erreur : token invalide.');

        // Parenthèses mal formées → message d'erreur explicite (throw attrapé ici)
        let word;
        try { word = normalizeWord(rawWord); }
        catch (e) { return textOut('Erreur : ' + e.message); }
        if (!word) return textOut('Erreur : le mot est vide.');
        // `word` = texte complet stocké (« base (note) ») ; `base`/`note` servent
        // à la validation IA et à la similarité, qui ne doivent jamais porter sur
        // le commentaire de l'utilisateur.
        const { base, note } = splitEntry(word);

        // BYOK intégral : clé de l'appelant (kindle_import.py via X-OpenAI-Key),
        // sinon la clé OpenAI que l'utilisateur a enregistrée dans ⚙️ (D1).
        // Plus de repli sur la clé propriétaire : sans clé → NOKEY (voir plus bas).
        const callerKey = sanitizeScriptKey(request.headers.get('X-OpenAI-Key')) || sanitizeScriptKey(user.openai_key);
        const aiEnv = { ...env, OPENAI_API_KEY_SCRIPT: callerKey };

        const tabMap = {
          english: 'English', anglais: 'English', en: 'English',
          spanish: 'Spanish', espagnol: 'Spanish', es: 'Spanish',
          greek: 'Greek', grec: 'Greek', el: 'Greek',
          french: 'French', 'français': 'French', fr: 'French'
        };
        let language = (lang && lang !== 'auto' && tabMap[lang]) ? tabMap[lang] : null;

        // Sans clé, aucune vérification IA n'est possible :
        // - langue inconnue → impossible d'ajouter (on ne sait pas où)
        // - langue connue → avertissement NOKEY ; l'appelant confirme en renvoyant
        //   ignore_sens=true & ignore_sim=true (« ajouter quand même »)
        if (!callerKey) {
          if (!language) return textOut("NOKEY:Aucune clé OpenAI enregistrée — impossible de détecter la langue. Précise la langue ou ajoute ta clé dans les réglages. | ?");
          if (!(ignoreSens && ignoreSim)) return textOut('NOKEY:Aucune clé OpenAI enregistrée — le mot ne sera pas vérifié. | ' + language);
        }

        // Réponse INVALID : la graphie proposée est renvoyée en 3e segment
        // (`| SUGGEST:<entrée>`), entrée COMPLÈTE — note comprise, sinon
        // « ajouter le mot proposé » perdrait la note. Segment ajouté en fin :
        // le raccourci iPhone, qui ne lit que [0] et [1], n'est pas affecté.
        const invalidOut = (reason, sugg) => {
          const full = sugg ? (note ? sugg + ' (' + note + ')' : sugg) : null;
          return textOut('INVALID:' + reason + ' | ' + language + (full ? ' | SUGGEST:' + full : ''));
        };

        // 1 & 2 — détection langue + validité
        if (!language && !ignoreSens) {
          const analysis = await analyzeWordLangSense(base, note, aiEnv);
          if (!analysis.lang) return textOut('Erreur : langue non détectée. Réessaie ou précise la langue.');
          language = analysis.lang;
          if (!analysis.valid) return invalidOut(analysis.reason, analysis.suggestion);
        } else {
          if (!language) {
            language = await identifyLang(base, aiEnv);
            if (!language) return textOut('Erreur : langue non détectée. Réessaie ou précise la langue.');
          }
          if (!ignoreSens) {
            const v = await validateWord(base, note, language, aiEnv);
            if (!v.valid) return invalidOut(v.reason, v.suggestion);
          }
        }

        // mots existants pour cette langue (D1)
        const { results } = await env.DB.prepare(
          'SELECT word FROM words WHERE user_id = ? AND language = ?'
        ).bind(user.id, language).all();
        const existing = results.map(r => r.word);

        // 3 — doublon exact (sur le texte complet : « berraco (enojo) » et
        // « berraco (inteligencia) » sont deux entrées légitimes)
        if (existing.some(e => (e || '').trim().toLowerCase() === word)) {
          return textOut("Doublon : '" + word + "' existe déjà dans " + language + ".");
        }

        // similarité (top 5 candidats → juge LLM) — score calculé sur les BASES,
        // sinon deux notes identiques suffisent à faire passer deux mots sans
        // rapport pour des variantes l'un de l'autre.
        if (!ignoreSim) {
          const wNorm = normSim(base);
          const scored = [];
          for (const e of existing) {
            const ex = (e || '').trim();
            if (ex.length < 2) continue;
            const s = similarityScore(wNorm, normSim(splitEntry(ex).base.toLowerCase()));
            if (s > 0) scored.push({ word: ex, score: s });
          }
          scored.sort((a, b) => b.score - a.score);
          const candidates = scored.slice(0, 5).map(x => x.word);
          if (candidates.length > 0) {
            const sim = await judgeSimilarity(base, note, candidates, language, aiEnv);
            if (sim) return textOut('SIMILAR:' + sim + ' | ' + language);
          }
        }

        // 4 — ajout
        await env.DB.prepare(
          'INSERT OR IGNORE INTO words (user_id, language, word, created_at) VALUES (?, ?, ?, ?)'
        ).bind(user.id, language, word, new Date().toISOString()).run();

        // Classement automatique ICI et nulle part ailleurs : le mot est rangé
        // quel que soit le client (app, raccourci iPhone, import Kindle). Hors
        // du chemin de réponse — l'ajout n'attend pas le modèle, et un échec
        // laisse simplement `grouped = 0`, repris par la passe « classer les
        // mots sans groupe ».
        if (callerKey && ctx && ctx.waitUntil) {
          ctx.waitUntil(autogroupOnAdd(env, user.id, language, word, aiEnv).catch(() => {}));
        }
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
          const wNorm = normSim(splitEntry(w).base);
          const scored = [];
          for (const e of existing) {
            const ex = (e || '').trim();
            if (ex.length < 2) continue;
            // score sur la base : la note entre parenthèses n'est pas du vocabulaire
            const s = similarityScore(wNorm, normSim(splitEntry(ex).base.toLowerCase()));
            if (s > 0) scored.push({ word: ex, score: s });
          }
          scored.sort((a, b) => b.score - a.score);
          const candidates = scored.slice(0, 3).map(x => x.word);
          if (candidates.length) items.push({ word: w, candidates });
        }

        // Découpe en lots de 40 → 1 appel gpt-5.6-luna chacun
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
            stmts.push(env.DB.prepare('DELETE FROM word_groups WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, it.lang, it.word));
          }
          if (stmts.length) await env.DB.batch(stmts);
          return json({ ok: true, deleted: stmts.length / 3 });
        }
        if (request.method === 'PUT') {
          // Renommage (`newWord`) et/ou transfert de langue (`newLang`) — la
          // progression, l'historique et les étoiles suivent le mot.
          const { lang, oldWord, newWord, newLang } = await request.json();
          const nw = (newWord || oldWord || '').trim().replace(/\s+/g, ' ');
          const nl = (newLang || lang || '').trim();
          if (!lang || !oldWord || !nw) return json({ error: { message: 'lang, oldWord, newWord requis' } }, 400);
          if (newLang && !ADD_LANGS.includes(nl)) return json({ error: { message: 'langue cible inconnue' } }, 400);
          if (nw === oldWord && nl === lang) return json({ ok: true, unchanged: true });
          // Même règle qu'à l'ajout, sans normaliser la casse (renommage manuel)
          try { assertParens(nw); }
          catch (e) { return json({ error: { message: e.message } }, 400); }
          if (splitEntry(nw).note.length > NOTE_MAX) return json({ error: { message: `la note entre parenthèses est trop longue (max ${NOTE_MAX} caractères).` } }, 400);
          const exists = await env.DB.prepare('SELECT 1 FROM words WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, nl, nw).first();
          if (exists) return json({ error: { message: nl === lang ? 'ce mot existe déjà' : `ce mot existe déjà en ${nl}` } }, 409);
          await env.DB.batch([
            // `progress` a la PK (user_id, language, word) : une ligne cible ne peut
            // être qu'orpheline ici (le mot n'existe pas dans `words`, vérifié
            // ci-dessus) — on la retire pour ne pas violer la contrainte.
            env.DB.prepare('DELETE FROM progress WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, nl, nw),
            env.DB.prepare('UPDATE words SET word = ?, language = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, nl, auth.uid, lang, oldWord),
            env.DB.prepare('UPDATE progress SET word = ?, language = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, nl, auth.uid, lang, oldWord),
            env.DB.prepare('UPDATE history SET word = ?, language = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, nl, auth.uid, lang, oldWord),
            // Les groupes appartiennent à la taxonomie d'UNE langue : un simple
            // renommage les garde, un changement de langue les fait tomber (le
            // mot repasse à grouped = 0 et la prochaine passe le reclasse dans
            // la taxonomie de sa nouvelle langue).
            nl === lang
              ? env.DB.prepare('UPDATE word_groups SET word = ? WHERE user_id = ? AND language = ? AND word = ?').bind(nw, auth.uid, lang, oldWord)
              : env.DB.prepare('DELETE FROM word_groups WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, lang, oldWord),
            ...(nl === lang ? [] : [
              env.DB.prepare('UPDATE words SET grouped = 0 WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, nl, nw)
            ])
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
          // `last_practiced` sert aux tris « vus récemment / jamais vus » du front.
          const { results } = lang
            ? await env.DB.prepare(
                'SELECT word, language, correct, incorrect, hint_used, next_review, last_practiced FROM progress WHERE user_id = ? AND language = ?'
              ).bind(auth.uid, lang).all()
            : await env.DB.prepare(
                'SELECT word, language, correct, incorrect, hint_used, next_review, last_practiced FROM progress WHERE user_id = ?'
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
        if (request.method === 'DELETE') {
          // Réinitialise la progression (le mot redevient « nouveau »). L'historique n'est pas touché.
          // Corps : { items: [{lang, word}, ...] } (mots précis, multi-langues)
          //      ou { langs: ['Spanish', ...] } / { lang: 'Spanish' } (langue(s) entière(s)).
          const body = await request.json();
          const stmts = [];
          if (Array.isArray(body.items)) {
            for (const it of body.items) {
              if (!it || !it.lang || !it.word) continue;
              stmts.push(env.DB.prepare('DELETE FROM progress WHERE user_id = ? AND language = ? AND word = ?').bind(auth.uid, it.lang, it.word));
            }
          } else {
            const langs = Array.isArray(body.langs) ? body.langs : (body.lang ? [body.lang] : []);
            for (const lg of langs) {
              if (!lg) continue;
              stmts.push(env.DB.prepare('DELETE FROM progress WHERE user_id = ? AND language = ?').bind(auth.uid, lg));
            }
          }
          if (stmts.length) await env.DB.batch(stmts);
          return json({ ok: true, reset: stmts.length });
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

    // Classement automatique dans les groupes (liste fermée).
    // Deux authentifications acceptées : le JWT (appel depuis l'app) OU le jeton
    // perso (traitement par lots hors navigateur, comme /judge-similar).
    // La clé OpenAI est celle de L'UTILISATEUR (header, sinon celle stockée en
    // D1) : aucun repli sur la clé du propriétaire, ce serait lui faire payer
    // le classement de la base d'un autre.
    if (path === '/api/autogroup') {
      if (request.method !== 'POST') return json({ error: { message: 'méthode non supportée' } }, 405);
      try {
        const body = await request.json().catch(() => ({}));
        const auth = await requireAuth(request, env);
        let uid = auth ? auth.uid : null;
        if (!uid) {
          const token = new URL(request.url).searchParams.get('token') || body.token;
          if (!token) return json({ error: { message: 'non authentifié' } }, 401);
          const u = await env.DB.prepare('SELECT id FROM users WHERE add_token = ?').bind(token).first();
          if (!u) return json({ error: { message: 'token invalide' } }, 403);
          uid = u.id;
        }

        const language = ADD_LANGS.includes(body.lang) ? body.lang : null;
        if (!language) return json({ error: { message: 'langue inconnue' } }, 400);

        // Rouvre les mots restés SANS groupe pour qu'une nouvelle passe les
        // reprenne. On ne touche pas aux mots déjà rangés : c'est ce qui rend un
        // ajout de groupes rattrapable sans tout reclasser.
        if (body.reopen === 'orphans') {
          const r = await env.DB.prepare(
            `UPDATE words SET grouped = 0
              WHERE user_id = ? AND language = ? AND grouped = 1
                AND NOT EXISTS (SELECT 1 FROM word_groups wg
                                 WHERE wg.user_id = ? AND wg.language = ? AND wg.word = words.word)`
          ).bind(uid, language, uid, language).run();
          return json({ ok: true, reopened: r.meta.changes || 0 });
        }

        let key = sanitizeScriptKey(request.headers.get('X-OpenAI-Key'));
        if (!key) {
          const row = await env.DB.prepare('SELECT openai_key FROM users WHERE id = ?').bind(uid).first();
          key = sanitizeScriptKey(row && row.openai_key);
        }
        if (!key) return json({ error: { message: 'aucune clé OpenAI enregistrée' } }, 400);
        const aiEnv = { ...env, OPENAI_API_KEY_SCRIPT: key };

        const { results: gRows } = await env.DB.prepare(
          "SELECT id, name, scope FROM groups WHERE user_id = ? AND language = ? AND kind = 'theme' ORDER BY id"
        ).bind(uid, language).all();
        const groups = gRows || [];

        // Modèle au choix pour comparer sur un lot témoin ; luna par défaut.
        const model = ['gpt-5.6-luna', 'gpt-5.6-terra'].includes(body.model) ? body.model : 'gpt-5.6-luna';

        // Mode « refaire la taxonomie » : PROPOSE, n'écrit jamais. La liste
        // actuelle n'est pas remplacée — le front affiche les deux et
        // l'utilisateur accepte groupe par groupe. Supprimer reste son geste :
        // une suppression automatique emporterait aussi ses rangements manuels.
        if (body.mode === 'propose') {
          const { results: wRows } = await env.DB.prepare(
            'SELECT word FROM words WHERE user_id = ? AND language = ?'
          ).bind(uid, language).all();
          const words = (wRows || []).map(r => r.word);
          if (!words.length) return json({ error: { message: 'aucun mot dans cette langue' } }, 400);
          const proposed = await proposeTaxonomy(
            words, groups.map(g => g.name), LANG_FULL[language] || language, aiEnv, model
          );
          if (!proposed) return json({ error: { message: 'réponse illisible du modèle' } }, 502);
          const have = new Set(groups.map(g => g.name.toLowerCase()));
          const kept = new Set(proposed.map(g => g.name.toLowerCase()));
          return json({
            mode: 'propose',
            total: words.length,
            proposed: proposed.map(g => ({ ...g, isNew: !have.has(g.name.toLowerCase()) })),
            dropped: groups.filter(g => !kept.has(g.name.toLowerCase())).map(g => ({ id: g.id, name: g.name })),
          });
        }

        if (!groups.length) return json({ error: { message: 'aucun groupe pour cette langue' } }, 400);

        // Mots à traiter : ceux fournis, sinon les non encore classés.
        const limit = Math.min(Math.max(parseInt(body.limit) || 100, 1), 200);
        let entries;
        if (Array.isArray(body.words) && body.words.length) {
          entries = body.words.map(w => String(w || '').trim()).filter(Boolean).slice(0, limit);
        } else {
          const { results } = await env.DB.prepare(
            'SELECT word FROM words WHERE user_id = ? AND language = ? AND grouped = 0 ORDER BY rowid LIMIT ?'
          ).bind(uid, language, limit).all();
          entries = (results || []).map(r => r.word);
        }
        if (!entries.length) return json({ processed: 0, remaining: 0, assigned: {} });

        const out = await classifyAndStore(env, uid, language, groups, entries, aiEnv, model, !!body.dry);
        if (!out) return json({ error: { message: 'réponse illisible du modèle' } }, 502);
        const assigned = out.assigned;

        const rest = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM words WHERE user_id = ? AND language = ? AND grouped = 0'
        ).bind(uid, language).first();

        return json({
          processed: entries.length,
          remaining: rest ? rest.n : 0,
          dry: !!body.dry,
          assigned,
        });
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    // Groupes : liste (avec effectif et jauge de maîtrise), création, renommage,
    // suppression. `kind` distingue le groupe thématique du lot d'étude.
    if (path === '/api/groups') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const lang = new URL(request.url).searchParams.get('lang');
          if (!lang) return json({ error: { message: 'lang requis' } }, 400);
          // La jauge « N/M ★★★ » se calcule ici : le front n'a pas à recroiser
          // les groupes avec la progression pour afficher une liste.
          const { results } = await env.DB.prepare(
            `SELECT g.id, g.name, g.scope, g.kind,
                    COUNT(wg.word) AS n,
                    SUM(CASE WHEN COALESCE(p.correct,0) - COALESCE(p.incorrect,0) >= 3 THEN 1 ELSE 0 END) AS mastered
               FROM groups g
               LEFT JOIN word_groups wg ON wg.group_id = g.id AND wg.user_id = g.user_id
               LEFT JOIN progress p ON p.user_id = g.user_id AND p.language = g.language AND p.word = wg.word
              WHERE g.user_id = ? AND g.language = ?
              GROUP BY g.id
              ORDER BY g.kind DESC, g.name COLLATE NOCASE`
          ).bind(auth.uid, lang).all();
          return json({ groups: (results || []).map(r => ({ ...r, mastered: r.mastered || 0 })) });
        }
        if (request.method === 'POST') {
          const { lang, name, kind, scope } = await request.json();
          const nm = (name || '').trim();
          if (!lang || !ADD_LANGS.includes(lang) || !nm) return json({ error: { message: 'lang et name requis' } }, 400);
          const k = kind === 'lot' ? 'lot' : 'theme';
          const dup = await env.DB.prepare('SELECT id FROM groups WHERE user_id = ? AND language = ? AND name = ?')
            .bind(auth.uid, lang, nm).first();
          if (dup) return json({ error: { message: 'ce groupe existe déjà' } }, 409);
          const res = await env.DB.prepare(
            'INSERT INTO groups (user_id, language, name, kind, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(auth.uid, lang, nm, k, (scope || '').trim() || null, new Date().toISOString()).run();
          return json({ ok: true, id: res.meta.last_row_id });
        }
        if (request.method === 'PUT') {
          const { id, name, scope } = await request.json();
          if (!id) return json({ error: { message: 'id requis' } }, 400);
          const g = await env.DB.prepare('SELECT id, language FROM groups WHERE id = ? AND user_id = ?').bind(id, auth.uid).first();
          if (!g) return json({ error: { message: 'groupe introuvable' } }, 404);
          const nm = name === undefined ? null : (name || '').trim();
          if (nm !== null && !nm) return json({ error: { message: 'nom vide' } }, 400);
          if (nm !== null) {
            const dup = await env.DB.prepare('SELECT id FROM groups WHERE user_id = ? AND language = ? AND name = ? AND id <> ?')
              .bind(auth.uid, g.language, nm, id).first();
            if (dup) return json({ error: { message: 'ce nom est déjà pris' } }, 409);
            await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ? AND user_id = ?').bind(nm, id, auth.uid).run();
          }
          if (scope !== undefined) {
            await env.DB.prepare('UPDATE groups SET scope = ? WHERE id = ? AND user_id = ?')
              .bind((scope || '').trim() || null, id, auth.uid).run();
          }
          return json({ ok: true });
        }
        if (request.method === 'DELETE') {
          const { id } = await request.json();
          if (!id) return json({ error: { message: 'id requis' } }, 400);
          const g = await env.DB.prepare('SELECT id, language FROM groups WHERE id = ? AND user_id = ?').bind(id, auth.uid).first();
          if (!g) return json({ error: { message: 'groupe introuvable' } }, 404);
          // Les mots qui n'étaient QUE dans ce groupe repassent à grouped = 0 :
          // la prochaine passe les reclassera. On ne touche pas aux mots que le
          // modèle avait délibérément laissés sans groupe (ils n'étaient pas ici).
          const { results } = await env.DB.prepare(
            'SELECT word FROM word_groups WHERE user_id = ? AND group_id = ?'
          ).bind(auth.uid, id).all();
          const words = (results || []).map(r => r.word);
          await env.DB.prepare('DELETE FROM word_groups WHERE user_id = ? AND group_id = ?').bind(auth.uid, id).run();
          await env.DB.prepare('DELETE FROM groups WHERE id = ? AND user_id = ?').bind(id, auth.uid).run();
          if (words.length) {
            const reset = env.DB.prepare(
              `UPDATE words SET grouped = 0
                WHERE user_id = ? AND language = ? AND word = ?
                  AND NOT EXISTS (SELECT 1 FROM word_groups wg
                                   WHERE wg.user_id = ? AND wg.language = ? AND wg.word = ?)`
            );
            await env.DB.batch(words.map(w => reset.bind(auth.uid, g.language, w, auth.uid, g.language, w)));
          }
          return json({ ok: true, released: words.length });
        }
        return json({ error: { message: 'méthode non supportée' } }, 405);
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    // Appartenance d'un mot à un groupe. Tout ce qui passe par ici est un geste
    // de l'utilisateur → auto = 0, donc protégé d'un reclassement automatique.
    if (path === '/api/word-groups') {
      const auth = await requireAuth(request, env);
      if (!auth) return json({ error: { message: 'non authentifié' } }, 401);
      try {
        if (request.method === 'GET') {
          const u = new URL(request.url).searchParams;
          // ?lang=&word= → les groupes d'UN mot (pour cocher le menu 🏷).
          // ?lang=&ungrouped=1 → les mots d'une langue qui ne sont dans AUCUN
          // groupe (pilule « sans groupe » de « mes mots » et du sélecteur).
          if (u.get('ungrouped') && u.get('lang')) {
            const { results } = await env.DB.prepare(
              `SELECT w.word FROM words w
                WHERE w.user_id = ? AND w.language = ?
                  AND NOT EXISTS (SELECT 1 FROM word_groups wg
                                   WHERE wg.user_id = w.user_id AND wg.language = w.language AND wg.word = w.word)`
            ).bind(auth.uid, u.get('lang')).all();
            return json({ words: (results || []).map(r => r.word) });
          }
          // ?lang=&words=a\nb\nc → les groupes de PLUSIEURS mots d'un coup
          // (pastilles de « mes mots » : une requête par page affichée, jamais
          // les 10 000 rattachements de la langue).
          const many = u.get('words');
          if (many && u.get('lang')) {
            const list = many.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 200);
            if (!list.length) return json({ map: {} });
            const ph = list.map(() => '?').join(',');
            const { results } = await env.DB.prepare(
              `SELECT word, group_id FROM word_groups
                 WHERE user_id = ? AND language = ? AND word IN (${ph})`
            ).bind(auth.uid, u.get('lang'), ...list).all();
            const map = {};
            for (const r of (results || [])) (map[r.word] = map[r.word] || []).push(r.group_id);
            return json({ map });
          }
          const w = u.get('word'), wl = u.get('lang');
          if (w && wl) {
            const { results } = await env.DB.prepare(
              'SELECT group_id FROM word_groups WHERE user_id = ? AND language = ? AND word = ?'
            ).bind(auth.uid, wl, w).all();
            return json({ group_ids: (results || []).map(r => r.group_id) });
          }
          const gid = parseInt(u.get('group_id'));
          if (!gid) return json({ error: { message: 'group_id ou (lang, word) requis' } }, 400);
          const { results } = await env.DB.prepare(
            'SELECT word FROM word_groups WHERE user_id = ? AND group_id = ? ORDER BY word COLLATE NOCASE'
          ).bind(auth.uid, gid).all();
          return json({ words: (results || []).map(r => r.word) });
        }
        const { lang, group_id, words } = await request.json();
        const list = Array.isArray(words) ? words.map(w => String(w || '').trim()).filter(Boolean) : [];
        if (!lang || !group_id || !list.length) return json({ error: { message: 'lang, group_id et words requis' } }, 400);
        const g = await env.DB.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ? AND language = ?')
          .bind(group_id, auth.uid, lang).first();
        if (!g) return json({ error: { message: 'groupe introuvable' } }, 404);

        if (request.method === 'POST') {
          const ins = env.DB.prepare(
            'INSERT OR REPLACE INTO word_groups (user_id, language, word, group_id, auto) VALUES (?, ?, ?, ?, 0)'
          );
          const mark = env.DB.prepare('UPDATE words SET grouped = 1 WHERE user_id = ? AND language = ? AND word = ?');
          await env.DB.batch(list.flatMap(w => [
            ins.bind(auth.uid, lang, w, group_id),
            mark.bind(auth.uid, lang, w),
          ]));
          return json({ ok: true, added: list.length });
        }
        if (request.method === 'DELETE') {
          const del = env.DB.prepare('DELETE FROM word_groups WHERE user_id = ? AND language = ? AND word = ? AND group_id = ?');
          await env.DB.batch(list.map(w => del.bind(auth.uid, lang, w, group_id)));
          return json({ ok: true, removed: list.length });
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
