var AUDIT_BATCH = 30;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔍 Audit')
    .addItem('Auditer les mots', 'auditWords')
    .addItem('Effacer les surlignages', 'clearAuditHighlights')
    .addToUi();
}

function clearAuditHighlights() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = ['English', 'Spanish', 'French', 'Greek'];
  tabs.forEach(function(tab) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var range = sheet.getRange(2, 2, lastRow - 1, 1);
    range.setBackground(null);
    var blank = range.getNotes().map(function(r) { return r.map(function() { return ''; }); });
    range.setNotes(blank);
  });
  SpreadsheetApp.getUi().alert('Surlignages effacés.');
}

function callGemmaAuditBatch(words, langName) {
  var wordList = words.map(function(w) { return '"' + w + '"'; }).join(', ');
  var prompt =
    'Among these ' + langName + ' words/expressions, identify any that are NOT valid ' +
    langName + ' words (typos, words from another language, abbreviations, gibberish, incomplete forms).\n' +
    'Return ONLY a JSON array: [{"word": "...", "reason": "..."}] for suspicious ones only. ' +
    'If all look valid, return [].\nWords: ' + wordList;
  var payload = {
    prompt:        prompt,
    maxTokens:     700,
    stream:        false,
    geminiModel:   'gemma-4-31b-it',
    thinkingLevel: 'minimal'
  };
  var response = UrlFetchApp.fetch(WORKER_URL + '/gemini', {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'X-Worker-Secret': WORKER_SECRET },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var data  = JSON.parse(response.getContentText());
  var text  = data.text || '';
  var match = text.match(/\[[\s\S]*?\]/);
  if (!match) return {};
  try {
    var items  = JSON.parse(match[0]);
    var result = {};
    items.forEach(function(item) {
      if (item.word) result[item.word.toLowerCase().trim()] = item.reason || '?';
    });
    return result;
  } catch (_) {
    return {};
  }
}

function auditWords() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var ui   = SpreadsheetApp.getUi();
  var tabs = ['English', 'Spanish', 'French', 'Greek'];
  var totalSuspects = 0;

  tabs.forEach(function(tab) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    var words  = values.map(function(r) { return String(r[0] || '').trim(); }).filter(Boolean);
    if (!words.length) return;

    var suspects = {};
    for (var i = 0; i < words.length; i += AUDIT_BATCH) {
      var batch  = words.slice(i, i + AUDIT_BATCH);
      var result = callGemmaAuditBatch(batch, LANG_FULL[tab]);
      Object.keys(result).forEach(function(k) { suspects[k] = result[k]; });
    }

    for (var r = 0; r < words.length; r++) {
      var key  = words[r].toLowerCase().trim();
      var cell = sheet.getRange(r + 2, 2);
      if (suspects[key]) {
        cell.setBackground('#FFCCCC');
        cell.setNote('⚠️ ' + suspects[key]);
        totalSuspects++;
      }
    }
  });

  ui.alert('Audit terminé — ' + totalSuspects + ' mot(s) suspect(s) surlignés en rouge.');
}
