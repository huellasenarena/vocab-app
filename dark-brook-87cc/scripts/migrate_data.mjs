// Migration complète : Google Sheets (prod) → SQL pour Cloudflare D1.
// Mots + Progression (SM-2, étoiles) + Session (compteur nouveaux/jour).
//
// Usage :
//   node scripts/migrate_data.mjs <user_id> > /tmp/data.sql
//   wrangler d1 execute vocab --local  --file=/tmp/data.sql      (local)
//   wrangler d1 execute vocab --remote --file=/tmp/data.sql      (prod, plus tard)

const PROD     = 'https://dark-brook-87cc.georg-dreym.workers.dev';
const SECRET   = process.env.WORKER_SECRET || '';
if (!SECRET) { console.error('WORKER_SECRET manquant — export WORKER_SECRET=... avant de lancer'); process.exit(1); }
const SHEET_ID = '1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc';
const LANGS    = ['English', 'Spanish', 'French', 'Greek'];
const SESSION_COL = { English: 1, Spanish: 2, French: 3, Greek: 4 };

const userId = process.argv[2];
if (!userId || !/^\d+$/.test(userId)) {
  console.error('usage: node scripts/migrate_data.mjs <user_id>');
  process.exit(1);
}

async function sheets(sheetPath) {
  const r = await fetch(`${PROD}/sheets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': SECRET,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    },
    body: JSON.stringify({ sheetPath })
  });
  if (!r.ok) throw new Error(`Sheets HTTP ${r.status} pour ${sheetPath}`);
  return r.json();
}

const esc = s => String(s).replace(/'/g, "''");
let sql = '-- Migration complète Sheets → D1\nBEGIN TRANSACTION;\n';

// ── Mots ──────────────────────────────────────────────────────
let totalWords = 0;
for (const lang of LANGS) {
  const data  = await sheets(`/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(lang)}!B:B`);
  const words = (data.values || []).map(r => r[0]).filter(w => w && w.trim());
  for (const w of words) {
    sql += `INSERT OR IGNORE INTO words (user_id, language, word, created_at) VALUES (${userId}, '${lang}', '${esc(w.trim())}', datetime('now'));\n`;
  }
  console.error(`mots ${lang.padEnd(8)} : ${words.length}`);
  totalWords += words.length;
}

// ── Progression (Progress!A:G) ────────────────────────────────
const prog = await sheets(`/v4/spreadsheets/${SHEET_ID}/values/Progress!A:G`);
const progRows = (prog.values || []).slice(1); // skip header
let totalProg = 0;
for (const r of progRows) {
  const word = r[0], lang = r[1];
  if (!word || !LANGS.includes(lang)) continue;
  const correct    = parseInt(r[2]) || 0;
  const incorrect  = parseInt(r[3]) || 0;
  const lastPrac   = r[4] ? `'${esc(r[4])}'` : 'NULL';
  const hintUsed   = parseInt(r[5]) || 0;
  const nextReview = r[6] ? `'${esc(r[6])}'` : 'NULL';
  sql += `INSERT OR REPLACE INTO progress (user_id, language, word, correct, incorrect, last_practiced, hint_used, next_review) VALUES (${userId}, '${esc(lang)}', '${esc(word)}', ${correct}, ${incorrect}, ${lastPrac}, ${hintUsed}, ${nextReview});\n`;
  totalProg++;
}
console.error(`progression       : ${totalProg} lignes`);

// ── Session (Session!A:E, normalisée en lignes par langue) ─────
const sess = await sheets(`/v4/spreadsheets/${SHEET_ID}/values/Session!A:E`);
const sessRows = (sess.values || []).slice(1); // skip header
let totalSess = 0;
for (const r of sessRows) {
  const date = r[0];
  if (!date) continue;
  for (const lang of LANGS) {
    const count = parseInt(r[SESSION_COL[lang]]) || 0;
    if (count > 0) {
      sql += `INSERT OR REPLACE INTO sessions (user_id, date, language, new_count) VALUES (${userId}, '${esc(date)}', '${lang}', ${count});\n`;
      totalSess++;
    }
  }
}
console.error(`session           : ${totalSess} lignes`);

// ── Blacklist (Blacklist!A:D, normalisée) ─────────────────────
const bl = await sheets(`/v4/spreadsheets/${SHEET_ID}/values/Blacklist!A:D`);
const blRows = (bl.values || []).slice(1); // skip header
let totalBl = 0;
for (const r of blRows) {
  for (let c = 0; c < LANGS.length; c++) {
    const w = (r[c] || '').trim();
    if (w) {
      sql += `INSERT OR IGNORE INTO blacklist (user_id, language, word) VALUES (${userId}, '${LANGS[c]}', '${esc(w)}');\n`;
      totalBl++;
    }
  }
}
console.error(`blacklist         : ${totalBl} lignes`);

// ── Grammaire (Grammar: Spanish, formes non barrées) ──────────
const gfields = 'sheets(data(rowData(values(userEnteredValue/stringValue,userEnteredFormat/textFormat/strikethrough))))';
const gram = await sheets(`/v4/spreadsheets/${SHEET_ID}?ranges=${encodeURIComponent('Grammar: Spanish!A:G')}&fields=${encodeURIComponent(gfields)}`);
const gRowData = gram.sheets?.[0]?.data?.[0]?.rowData || [];
let totalGram = 0;
if (gRowData.length >= 2) {
  sql += `DELETE FROM grammar_forms WHERE user_id = ${userId};\n`;
  const header = gRowData[0].values || [];
  for (let r = 1; r < gRowData.length; r++) {
    const cells = gRowData[r].values || [];
    for (let c = 0; c < header.length; c++) {
      const cat  = (header[c]?.userEnteredValue?.stringValue || '').trim();
      const cell = cells[c] || {};
      const form = (cell.userEnteredValue?.stringValue || '').trim();
      const struck = cell.userEnteredFormat?.textFormat?.strikethrough === true;
      if (cat && form && !struck) {
        sql += `INSERT INTO grammar_forms (user_id, language, category, form) VALUES (${userId}, 'Spanish', '${esc(cat)}', '${esc(form)}');\n`;
        totalGram++;
      }
    }
  }
}
console.error(`grammaire         : ${totalGram} formes`);

// ── Historique (History!A:D) ──────────────────────────────────
const hist = await sheets(`/v4/spreadsheets/${SHEET_ID}/values/History!A:D`);
const histRows = (hist.values || []).slice(1); // skip header
let totalHist = 0;
sql += `DELETE FROM history WHERE user_id = ${userId};\n`;
for (const r of histRows) {
  const date = r[0], word = r[1], lang = r[2], result = r[3];
  if (!date || !word || !LANGS.includes(lang)) continue;
  sql += `INSERT INTO history (user_id, date, word, language, result) VALUES (${userId}, '${esc(date)}', '${esc(word)}', '${esc(lang)}', ${result === '✓' ? 1 : 0});\n`;
  totalHist++;
}
console.error(`historique        : ${totalHist} lignes`);

sql += 'COMMIT;\n';
console.error(`Total : ${totalWords} mots, ${totalProg} progressions, ${totalSess} sessions, ${totalBl} blacklist, ${totalGram} grammaire, ${totalHist} historique pour user_id=${userId}`);
process.stdout.write(sql);
