var WORKER_URL    = 'https://dark-brook-87cc.georg-dreym.workers.dev';
var WORKER_SECRET = PropertiesService.getScriptProperties().getProperty('WORKER_SECRET');
var LANG_FULL     = { Spanish: 'Spanish', French: 'French', English: 'English', Greek: 'Modern Greek' };

var _gemmaCallCount = 0;
var _lastGemmaError = null;

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
    .replace(/[‘’`ʼ]/g, "'")
    .replace(/…/g, '...') // Normaliser le vrai caractère de points de suspension
    .replace(/(?<!\.)\.(?!\.)/g, '') // Supprimer les points uniques (qui n'ont pas de point avant ou après)
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M} '¿?\.\-\+]/gu, '') // Conserver les points restants (qui font partie de ...)
    .trim()
    .toLowerCase();

  if (!word) return ContentService.createTextOutput('Erreur : le mot est vide.');

  // 1 & 2. DÉTECTION DE LANGUE ET VÉRIFICATION DU SENS
  var tabMap = {
    'english': 'English', 'anglais': 'English', 'en': 'English',
    'spanish': 'Spanish', 'espagnol': 'Spanish', 'es': 'Spanish',
    'greek':   'Greek',   'grec':    'Greek',    'el': 'Greek',
    'french':  'French',  'français': 'French',  'fr': 'French'
  };

  var sheetName = (lang !== 'auto' && tabMap[lang]) ? tabMap[lang] : null;

  if (!sheetName && !ignoreSens) {
    // Cas principal du raccourci : on fait détection + validation en 1 seul appel IA
    var analysis = analyzeWordLanguageAndSenseWithGemma(word);
    if (!analysis.sheetName) {
      var detail = _lastGemmaError ? ' (' + _lastGemmaError + ')' : '';
      return ContentService.createTextOutput('Erreur : langue non détectée' + detail + '. Réessaie ou précise la langue.');
    }
    sheetName = analysis.sheetName;
    if (!analysis.valid) return ContentService.createTextOutput('INVALID:' + analysis.reason + ' | ' + sheetName);
  } else {
    // Cas spécifiques : langue déjà connue OU on veut juste la langue (ignoreSens = true)
    if (!sheetName) {
      sheetName = identifyLanguageWithGemma(word);
      if (!sheetName) {
        var detail = _lastGemmaError ? ' (' + _lastGemmaError + ')' : '';
        return ContentService.createTextOutput('Erreur : langue non détectée' + detail + '. Réessaie ou précise la langue.');
      }
    }
    if (!ignoreSens) {
      var validation = validateWordWithGemma(word, sheetName);
      if (!validation.valid) {
        return ContentService.createTextOutput('INVALID:' + validation.reason + ' | ' + sheetName);
      }
    }
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return ContentService.createTextOutput("Erreur : onglet '" + sheetName + "' introuvable.");

  // 3. DOUBLONS
  var lastRow = sheet.getLastRow();
  var data = lastRow > 0 ? sheet.getRange(1, 2, lastRow, 1).getValues() : [];

  for (var i = 0; i < data.length; i++) {
    if ((data[i][0] || '').toString().trim().toLowerCase() === word) {
      return ContentService.createTextOutput("Doublon : '" + word + "' existe déjà dans " + sheetName + ".");
    }
  }

  if (!ignoreSim) {
    var wNorm = normSim(word);
    var scored = [];
    for (var i = 0; i < data.length; i++) {
      var existing = (data[i][0] || '').toString().trim();
      if (!existing || existing.length < 2) continue;
      var s = similarityScore(wNorm, normSim(existing.toLowerCase()));
      if (s > 0) scored.push({ word: existing, score: s });
    }
    scored.sort(function(a, b) { return b.score - a.score; });
    var candidates = scored.slice(0, 5).map(function(x) { return x.word; });

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
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Tokens');
    if (!sheet) return;
    var today   = todayPT();
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
      sheet.getRange(rowIdx, 1).setValue(new Date());
    }
    var cell = sheet.getRange(rowIdx, 5);
    cell.setValue((Number(cell.getValue()) || 0) + count);
  } finally {
    lock.releaseLock();
  }
}

// ── Gemma ────────────────────────────────────────────────────────────────────

function normSim(w) {
  return w.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
}

function similarityScore(wNorm, eNorm) {
  if (!eNorm || eNorm.length < 2) return 0;
  var score = 0;
  var minLen = Math.min(wNorm.length, eNorm.length);
  if (wNorm.length >= 4 && eNorm.indexOf(wNorm) !== -1) score += 10;
  else if (eNorm.length >= 4 && wNorm.indexOf(eNorm) !== -1) score += 10;
  if (minLen >= 5 && wNorm.substring(0, 4) === eNorm.substring(0, 4)) score += 5;
  if (minLen >= 6 && wNorm.slice(-4) === eNorm.slice(-4)) score += 3;
  var lenDiff = Math.abs(wNorm.length - eNorm.length);
  if (lenDiff <= 2) score += 2;
  else if (lenDiff <= 4) score += 1;
  return score;
}

function callOpenAI(prompt, maxTokens) {
  _gemmaCallCount++;
  var payload = { prompt: prompt, maxTokens: maxTokens, model: 'gpt-4.1-mini' };
  var waits = [0, 2000, 5000];
  for (var attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt] > 0) Utilities.sleep(waits[attempt]);
    try {
      var response = UrlFetchApp.fetch(WORKER_URL + '/openai-script', {
        method: 'post', contentType: 'application/json',
        headers: { 'X-Worker-Secret': WORKER_SECRET },
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      var body = response.getContentText();
      Logger.log('OpenAI ' + code + ': ' + body.substring(0, 300));
      if (code === 429 || (code >= 500 && code < 600)) {
        _lastGemmaError = 'HTTP ' + code + ' (tentative ' + (attempt + 1) + ')';
        continue;
      }
      if (code !== 200) { _lastGemmaError = 'HTTP ' + code + ': ' + body.substring(0, 100); return null; }
      _lastGemmaError = null;
      return (JSON.parse(body).text || '').trim();
    } catch (e) { Logger.log('OpenAI exception: ' + e); _lastGemmaError = String(e); return null; }
  }
  _lastGemmaError = 'Erreur après 3 tentatives';
  return null;
}

function analyzeWordLanguageAndSenseWithGemma(word) {
  var prompt =
    'Analyze the expression: "' + word + '".\n' +
    '1. Identify its language (must be one of: French, English, Spanish, Greek).\n' +
    '2. Check if it is a valid word or expression in that language (allow real words, conjugated forms, phrases, slang).\n' +
    'Answer NO only for gibberish, typos producing no real word, or text clearly in a different language.\n' +
    'Reply STRICTLY in one of these two formats:\n' +
    'VALID | <LanguageName>\n' +
    'INVALID: <brief reason> | <LanguageName>';

  var res = callOpenAI(prompt, 60);
  if (!res) return { valid: false, reason: 'Erreur API OpenAI', sheetName: null };

  var parts = res.split('|');
  var statusPart = (parts[0] || '').trim();
  var langPart = (parts[1] || '').trim();

  var validLangs = ['English', 'Spanish', 'French', 'Greek'];
  var sheetName = null;
  for (var i = 0; i < validLangs.length; i++) {
    if (langPart.toLowerCase().indexOf(validLangs[i].toLowerCase()) !== -1) {
      sheetName = validLangs[i];
      break;
    }
  }

  if (/^INVALID/i.test(statusPart)) {
    return { valid: false, reason: statusPart.replace(/^INVALID[:\s]*/i, '').trim(), sheetName: sheetName };
  }

  return { valid: true, sheetName: sheetName };
}

function identifyLanguageWithGemma(word) {
  var prompt =
    'Which language is "' + word + '" from? Options: French, English, Spanish, Greek.\n' +
    'Reply with ONLY the language name, nothing else.';
  var res = callOpenAI(prompt, 10);
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
  var res = callOpenAI(prompt, 60);
  if (res === null) return { valid: false, reason: 'Erreur API OpenAI' };
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
  var res = callOpenAI(prompt, 30);
  if (res && /^YES:/i.test(res)) return res.replace(/^YES:\s*/i, '').trim();
  return null;
}

function testOpenAI() {
  var res = callOpenAI('Which language is "l\'historien" from? Options: French, English, Spanish, Greek. Reply with ONLY the language name, nothing else.', 10);
  Logger.log('Résultat: ' + res);
}
