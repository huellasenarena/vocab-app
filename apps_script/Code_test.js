var WORKER_URL    = 'https://dark-brook-87cc.georg-dreym.workers.dev';
var WORKER_SECRET = PropertiesService.getScriptProperties().getProperty('WORKER_SECRET');
var LANG_FULL     = { Spanish: 'Spanish', French: 'French', English: 'English', Greek: 'Modern Greek' };

var _gemmaCallCount = 0;

function doPost(e) {
  _gemmaCallCount = 0;
  var result = _doPost(e);
  if (_gemmaCallCount > 0) {
    try { updateTokensGemma(_gemmaCallCount); } catch (_) {}
  }
  return result;
}

function _doPost(e) {
  var rawWord    = (e.parameter.word || '').trim();
  var lang       = (e.parameter.lang || 'auto').toLowerCase().trim();
  var ignoreSens = (e.parameter.ignore_sens === 'true');
  var ignoreSim  = (e.parameter.ignore_sim  === 'true');

  var word = rawWord
    .replace(/[\r\n]+/g, ' ')
    .replace(/[''ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M} '¿?-]/gu, '')
    .trim()
    .toLowerCase();

  if (!word) return ContentService.createTextOutput('Erreur : le mot est vide.');

  // 1. DÉTECTION DE LANGUE
  var tabMap = {
    'english': 'English', 'anglais': 'English', 'en': 'English',
    'spanish': 'Spanish', 'espagnol': 'Spanish', 'es': 'Spanish',
    'greek':   'Greek',   'grec':    'Greek',    'el': 'Greek',
    'french':  'French',  'français': 'French',  'fr': 'French'
  };

  var sheetName;
  if (lang !== 'auto' && tabMap[lang]) {
    sheetName = tabMap[lang];
  } else {
    var detected = identifyLanguageWithGemma(word);
    if (!detected) return ContentService.createTextOutput('Erreur : langue non détectée. Réessaie ou précise la langue.');
    sheetName = detected;
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return ContentService.createTextOutput("Erreur : onglet '" + sheetName + "' introuvable.");

  // 2. VÉRIFICATION DU SENS
  if (!ignoreSens) {
    var validation = validateWordWithGemma(word, sheetName);
    if (!validation.valid) {
      return ContentService.createTextOutput('INVALID:' + validation.reason + ' | ' + sheetName);
    }
  }

  // 3. DOUBLONS
  var lastRow = sheet.getLastRow();
  var data = lastRow > 0 ? sheet.getRange(1, 2, lastRow, 1).getValues() : [];

  for (var i = 0; i < data.length; i++) {
    if ((data[i][0] || '').toString().trim().toLowerCase() === word) {
      return ContentService.createTextOutput("Doublon : '" + word + "' existe déjà dans " + sheetName + ".");
    }
  }

  if (!ignoreSim) {
    var candidates = [];
    var wNorm = normSim(word);
    for (var i = 0; i < data.length; i++) {
      var existing = (data[i][0] || '').toString().trim();
      if (!existing || existing.length < 2) continue;
      if (isSimilarCandidate(wNorm, normSim(existing.toLowerCase()))) {
        candidates.push(existing);
      }
      if (candidates.length >= 15) break;
    }

    if (candidates.length > 0) {
      var similarWord = judgeSimilarityWithGemma(word, candidates, sheetName);
      if (similarWord) {
        return ContentService.createTextOutput('SIMILAR:' + similarWord + ' | ' + sheetName);
      }
    }
  }

  // 4. AJOUT
  sheet.appendRow([new Date(), word]);
  return ContentService.createTextOutput("Succès (" + sheetName + ") : '" + word + "' ajouté.");
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function todayPT() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

function updateTokensGemma(count) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Tokens');
  if (!sheet) return;
  var today  = todayPT();
  var lastRow = sheet.getLastRow();
  var rowIdx  = -1;
  if (lastRow > 0) {
    var dates = sheet.getRange(1, 1, lastRow, 1).getValues();
    for (var i = 0; i < dates.length; i++) {
      var d    = dates[i][0];
      var dStr = (d instanceof Date)
        ? Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd')
        : String(d).trim();
      if (dStr === today) { rowIdx = i + 1; break; }
    }
  }
  if (rowIdx === -1) {
    rowIdx = lastRow + 1;
    sheet.getRange(rowIdx, 1).setValue(today);
  }
  var cell = sheet.getRange(rowIdx, 5); // col E = GemmaRequests
  cell.setValue((Number(cell.getValue()) || 0) + count);
}

// ── Gemma ────────────────────────────────────────────────────────────────────

function normSim(w) {
  return w.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
}

function isSimilarCandidate(wNorm, eNorm) {
  if (!eNorm || eNorm.length < 2) return false;
  // substring bidirectionnel
  if (wNorm.length >= 3 && eNorm.indexOf(wNorm) !== -1) return true;
  if (eNorm.length >= 3 && wNorm.indexOf(eNorm) !== -1) return true;
  // préfixe commun 4 chars
  var minLen = Math.min(wNorm.length, eNorm.length);
  if (minLen >= 4 && wNorm.substring(0, 4) === eNorm.substring(0, 4)) return true;
  // suffixe commun 3 chars (conjugaisons, -ción, -ment...)
  if (minLen >= 4 && wNorm.slice(-3) === eNorm.slice(-3)) return true;
  return false;
}

function callGemma(prompt, maxTokens) {
  _gemmaCallCount++;
  var payload = { prompt: prompt, maxTokens: maxTokens, stream: false, geminiModel: 'gemma-4-31b-it', thinkingLevel: 'minimal' };
  try {
    var response = UrlFetchApp.fetch(WORKER_URL + '/gemini', {
      method: 'post', contentType: 'application/json',
      headers: { 'X-Worker-Secret': WORKER_SECRET },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    Logger.log('Gemma ' + code + ': ' + body.substring(0, 300));
    if (code !== 200) return null;
    return (JSON.parse(body).text || '').trim();
  } catch (e) { Logger.log('Gemma exception: ' + e); return null; }
}

function identifyLanguageWithGemma(word) {
  var prompt =
    'Which language is "' + word + '" from? Options: French, English, Spanish, Greek.\n' +
    'Reply with ONLY the language name, nothing else.';
  var res = callGemma(prompt, 10);
  if (!res) return null;
  var valid = ['English', 'Spanish', 'French', 'Greek'];
  for (var i = 0; i < valid.length; i++) {
    if (res.toLowerCase().indexOf(valid[i].toLowerCase()) !== -1) return valid[i];
  }
  return null;
}

function validateWordWithGemma(word, sheetName) {
  var langName = LANG_FULL[sheetName] || sheetName;
  var prompt =
    'Is "' + word + '" a valid ' + langName + ' word or expression?\n' +
    'Answer YES for: real words, conjugated forms, multi-word expressions, phrases, slang, archaic terms.\n' +
    'Answer NO only for: gibberish, typos producing no real word, or text clearly in a different language.\n' +
    'Reply with YES or NO: <brief reason if NO>.';
  var res = callGemma(prompt, 60);
  if (res === null) return { valid: false, reason: 'Erreur API Gemma' };
  if (/^NO\b/i.test(res)) return { valid: false, reason: res.replace(/^NO[:\s]*/i, '').trim() };
  return { valid: true };
}

function judgeSimilarityWithGemma(word, candidates, sheetName) {
  var langName = LANG_FULL[sheetName] || sheetName;
  var prompt =
    'Language: ' + langName + '.\n' +
    'I want to add "' + word + '" to my vocabulary list.\n' +
    'Existing words: ' + candidates.join(', ') + '.\n' +
    'Is "' + word + '" merely an inflected form of an existing word (same lemma: conjugation, plural, gender, diminutive)?\n' +
    'If YES, reply exactly "YES: <existing_word>". If it has distinct vocabulary value, reply "NO".';
  var res = callGemma(prompt, 30);
  if (res && /^YES:/i.test(res)) return res.replace(/^YES:\s*/i, '').trim();
  return null;
}

function testGemma() {
  var res = callGemma('Which language is "l\'historien" from? Options: French, English, Spanish, Greek. Reply with ONLY the language name, nothing else.', 10);
  Logger.log('Résultat: ' + res);
}
