// Migration des mots : Google Sheets (prod) → SQL pour Cloudflare D1.
// Lit chaque onglet langue (colonne B) via le Worker de prod, génère des INSERT.
//
// Usage :
//   node scripts/migrate_words.mjs <user_id> > /tmp/words.sql
//   wrangler d1 execute vocab --local --file=/tmp/words.sql      (local)
//   wrangler d1 execute vocab --remote --file=/tmp/words.sql     (prod, plus tard)

const PROD     = 'https://dark-brook-87cc.georg-dreym.workers.dev';
const SECRET   = process.env.WORKER_SECRET || '';
if (!SECRET) { console.error('WORKER_SECRET manquant — export WORKER_SECRET=... avant de lancer'); process.exit(1); }
const SHEET_ID = '1PlDftzA1wQYikkSRc-GDS0jvY_mOaj-M673TfAqxVxc';
const LANGS    = ['English', 'Spanish', 'French', 'Greek'];

const userId = process.argv[2];
if (!userId || !/^\d+$/.test(userId)) {
  console.error('usage: node scripts/migrate_words.mjs <user_id>');
  process.exit(1);
}

async function sheets(sheetPath) {
  const r = await fetch(`${PROD}/sheets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': SECRET,
      // User-Agent navigateur requis sinon Cloudflare 1010
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    },
    body: JSON.stringify({ sheetPath })
  });
  if (!r.ok) throw new Error(`Sheets HTTP ${r.status} pour ${sheetPath}`);
  return r.json();
}

let sql = '-- Mots migrés depuis Google Sheets\nBEGIN TRANSACTION;\n';
let total = 0;
for (const lang of LANGS) {
  const data  = await sheets(`/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(lang)}!B:B`);
  const words = (data.values || []).map(r => r[0]).filter(w => w && w.trim());
  for (const w of words) {
    const esc = w.trim().replace(/'/g, "''");
    sql += `INSERT OR IGNORE INTO words (user_id, language, word, created_at) VALUES (${userId}, '${lang}', '${esc}', datetime('now'));\n`;
  }
  console.error(`${lang.padEnd(8)} : ${words.length} mots`);
  total += words.length;
}
sql += 'COMMIT;\n';
console.error(`Total : ${total} mots pour user_id=${userId}`);
process.stdout.write(sql);
