var AUDIT_BATCH = 60;
var AUDIT_MODEL = 'gemma-3-4b-it';
var AUDIT_SLEEP = 2200;

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
    'Among these ' + langName + ' words/expressions, identify any that are NOT valid ' + langName + '.\n' +
    'Accept: real words, conjugated forms, multi-word expressions, phrases, slang, archaic terms.\n' +
    'Flag ONLY: gibberish, typos producing no real word, or text clearly in a different language.\n' +
    'Return ONLY a JSON array: [{"word": "...", "reason": "..."}] for suspicious ones only. ' +
    'If all look valid, return [].\nWords: ' + wordList;
  var payload = {
    prompt:        prompt,
    maxTokens:     800,
    stream:        false,
    geminiModel:   AUDIT_MODEL,
    thinkingLevel: 'minimal'
  };
  var response = UrlFetchApp.fetch(WORKER_URL + '/gemini', {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'X-Worker-Secret': WORKER_SECRET },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = response.getContentText();
  var data;
  try { data = JSON.parse(body); } catch (_) { return {}; }
  var text  = data.text || '';
  var match = text.match(/\[[\s\S]*\]/);
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
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var ui      = SpreadsheetApp.getUi();
  var props   = PropertiesService.getScriptProperties();
  var allTabs = ['English', 'Spanish', 'French', 'Greek'];

  // ── ÉTAPE 1 : choix de l'onglet ──────────────────────────────────────────
  var activeTabName = ss.getActiveSheet().getName();
  var activeIdx     = allTabs.indexOf(activeTabName);

  var tabMsg = allTabs.map(function(tab, i) {
    var saved = props.getProperty('AUDIT_END_' + tab);
    var info  = saved ? 'dernier : ligne ' + saved : 'jamais audité';
    return (i + 1) + '. ' + tab + '  (' + info + ')';
  }).join('\n') + '\n5. Tous les onglets';

  var defaultLabel = activeIdx >= 0 ? activeTabName : 'tous';
  var tabResp = ui.prompt(
    'Audit — Onglet',
    tabMsg + '\n\n(Entrée = ' + defaultLabel + ')',
    ui.ButtonSet.OK_CANCEL
  );
  if (tabResp.getSelectedButton() === ui.Button.CANCEL) return;

  var tabInput = tabResp.getResponseText().trim();
  var selectedTabs;
  if (tabInput === '') {
    selectedTabs = activeIdx >= 0 ? [activeTabName] : allTabs;
  } else if (tabInput === '5') {
    selectedTabs = allTabs;
  } else {
    var idx = parseInt(tabInput) - 1;
    if (isNaN(idx) || idx < 0 || idx >= allTabs.length) {
      ui.alert('Choix invalide.'); return;
    }
    selectedTabs = [allTabs[idx]];
  }

  // ── ÉTAPE 2 : plage (par onglet si sélection unique, auto si tous) ────────
  var singleTab = selectedTabs.length === 1;
  var fixedStart = null, fixedEnd = null;

  if (singleTab) {
    var tab      = selectedTabs[0];
    var savedEnd = props.getProperty('AUDIT_END_' + tab);
    var proposed = savedEnd ? (parseInt(savedEnd) + 1) : 2;
    var hint = savedEnd
      ? 'Dernier audit ' + tab + ' : ligne ' + savedEnd + '.\nProposé : ' + proposed + '-' + (proposed + 119) + '.'
      : 'Aucun audit précédent pour ' + tab + '.';

    var rangeResp = ui.prompt(
      'Audit — Plage (' + tab + ')',
      hint + '\n\nPlage (ex: "50-150", "50" = fin, vide = tout) :',
      ui.ButtonSet.OK_CANCEL
    );
    if (rangeResp.getSelectedButton() === ui.Button.CANCEL) return;

    var rangeInput = rangeResp.getResponseText().trim();
    if (rangeInput) {
      var parts  = rangeInput.split('-');
      fixedStart = Math.max(2, parseInt(parts[0]) || 2);
      if (parts.length > 1 && parts[1].trim()) fixedEnd = parseInt(parts[1].trim());
    }
  }
  // En mode "tous les onglets" : chaque onglet reprend depuis sa propre dernière ligne.

  // ── ÉTAPE 3 : audit ──────────────────────────────────────────────────────
  var totalSuspects = 0;

  selectedTabs.forEach(function(tab, tabIdx) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) return;
    var sheetLastRow = sheet.getLastRow();
    if (sheetLastRow < 2) return;

    var tabStart, tabEnd;
    if (singleTab) {
      tabStart = fixedStart !== null ? fixedStart : 2;
      tabEnd   = fixedEnd;
    } else {
      var tabSaved = props.getProperty('AUDIT_END_' + tab);
      tabStart = tabSaved ? (parseInt(tabSaved) + 1) : 2;
      tabEnd   = null;
    }

    if (tabStart > sheetLastRow) return;
    var dataEnd = tabEnd ? Math.min(sheetLastRow, tabEnd) : sheetLastRow;
    var count   = dataEnd - tabStart + 1;
    if (count <= 0) return;

    var values  = sheet.getRange(tabStart, 2, count, 1).getValues();
    var words   = values.map(function(r) { return String(r[0] || '').trim(); }).filter(Boolean);
    if (!words.length) return;

    var suspects = {};
    for (var i = 0; i < words.length; i += AUDIT_BATCH) {
      var batch  = words.slice(i, i + AUDIT_BATCH);
      var result = callGemmaAuditBatch(batch, LANG_FULL[tab]);
      Object.keys(result).forEach(function(k) { suspects[k] = result[k]; });
      if (i + AUDIT_BATCH < words.length) Utilities.sleep(AUDIT_SLEEP);
    }

    for (var r = 0; r < words.length; r++) {
      var key  = words[r].toLowerCase().trim();
      var cell = sheet.getRange(tabStart + r, 2);
      if (suspects[key]) {
        cell.setBackground('#FFCCCC');
        cell.setNote('⚠️ ' + suspects[key]);
        totalSuspects++;
      }
    }

    props.setProperty('AUDIT_END_' + tab, String(dataEnd));

    // Pause entre onglets pour respecter le rate limit
    if (!singleTab && tabIdx < selectedTabs.length - 1) Utilities.sleep(AUDIT_SLEEP);
  });

  ui.alert('Audit terminé — ' + totalSuspects + ' mot(s) suspect(s) surlignés en rouge.');
}
