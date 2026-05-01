var WORKER_URL    = 'https://dark-brook-87cc.georg-dreym.workers.dev';
var WORKER_SECRET = PropertiesService.getScriptProperties().getProperty('WORKER_SECRET');
var LANG_FULL     = { Spanish: 'Spanish', French: 'French', English: 'English', Greek: 'Modern Greek' };

function doPost_old(e) {
  // ── Récupère et nettoie les paramètres ───────────────────
  var rawWord = (e.parameter.word  || '').trim();
  var lang    = (e.parameter.lang  || '').toLowerCase().trim();
  var force   = (e.parameter.force || '') === 'true';

  var word = rawWord
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M} '¿?]/gu, '')
    .trim()
    .toLowerCase();

  if (!word) {
    return ContentService.createTextOutput('Erreur : le mot est vide.');
  }

  // ── Trouve l'onglet ───────────────────────────────────────
  var tabMap = {
    'english': 'English', 'anglais': 'English', 'en': 'English',
    'spanish': 'Spanish', 'espagnol': 'Spanish', 'es': 'Spanish',
    'greek':   'Greek',   'grec':    'Greek',    'el': 'Greek',
    'french':  'French',  'français': 'French',  'fr': 'French'
  };

  var sheetName = tabMap[lang] || 'Spanish';
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheet     = ss.getSheetByName(sheetName);

  if (!sheet) {
    return ContentService.createTextOutput(
      "Erreur : l'onglet '" + sheetName + "' est introuvable."
    );
  }

  // ── Validation IA (Gemma) — avant tout le reste ──────────
  if (!force) {
    var validation = validateWordWithGemma(word, sheetName);
    if (!validation.valid) {
      return ContentService.createTextOutput('INVALID:' + validation.reason);
    }
  }

  // ── Lit les mots existants (colonne B) ────────────────────
  var data = sheet.getRange('B:B').getValues();

  var ARTICLES_RE = /^(el|la|los|las|un|una|unos|unas|the|a|an|le|la|les|un|une|des|o|η|τα|τον|την)\s+/i;

  function stripArticle(s) {
    return s.replace(ARTICLES_RE, '').trim();
  }

  function areSimilar(newWord, existing) {
    var a = newWord.toLowerCase().trim();
    var b = existing.toLowerCase().trim();
    if (!b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    var aCore = stripArticle(a);
    var bCore = stripArticle(b);
    if (aCore.length >= 3 && aCore === bCore) return true;
    return false;
  }

  // ── Vérifie doublons et similarités ──────────────────────
  for (var i = 0; i < data.length; i++) {
    var existing = (data[i][0] || '').toString().trim();
    if (!existing) continue;
    if (existing.toLowerCase() === word) {
      return ContentService.createTextOutput(
        "Doublon : '" + word + "' existe déjà dans " + sheetName + '.'
      );
    }
    if (!force && areSimilar(word, existing)) {
      return ContentService.createTextOutput('SIMILAR:' + existing);
    }
  }

  // ── Ajoute le mot ─────────────────────────────────────────
  sheet.appendRow([new Date(), word]);
  return ContentService.createTextOutput(
    "Succès : '" + word + "' ajouté à " + sheetName + '.'
  );
}

function validateWordWithGemma(word, sheetName) {
  var langName = LANG_FULL[sheetName] || sheetName;
  var prompt =
    'Is "' + word + '" a valid ' + langName + ' word or expression? ' +
    'Answer with YES or NO followed by a brief reason if NO. ' +
    'Example: "NO — this is an English word, not Spanish."';
  var payload = {
    prompt:        prompt,
    maxTokens:     120,
    stream:        false,
    geminiModel:   'gemma-4-31b-it',
    thinkingLevel: 'minimal'
  };
  try {
    var response = UrlFetchApp.fetch(WORKER_URL + '/gemini', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'X-Worker-Secret': WORKER_SECRET },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var data = JSON.parse(response.getContentText());
    var text = (data.text || '').trim();
    if (/^NO\b/i.test(text)) {
      var reason = text.replace(/^NO[,.\s—-]*/i, '').trim() || 'Mot non reconnu';
      return { valid: false, reason: reason };
    }
    return { valid: true };
  } catch (e) {
    return { valid: true }; // fail open en cas d'erreur réseau
  }
}
