// ============================================================
// mofmofu 工程管理 — Google Apps Script バックエンド (v3)
// ============================================================
// v3変更: 西尾さん工場追加・セット品対応（出荷時に構成色から自動引き落とし）
// ============================================================

const SS_ID = '1l9QyWxdYcyTTqR7ZMBs-VQS0rj8c2qUp9q399jmy-30';

// LINE設定
const LINE_TOKEN = 'D+dfSKKq9S3ZXx2xUDAE9r1b8Syt1tgRyGzddtMKHuhMJTDV1EDg+TsZNUfmW+XyszQpXshH9n9xBZ3XA5naGpcWT4a/xjl+bNtPxha2HSFbORUNrbZzYMJ/2Tl382QkDejinEoA8R0wGbVoeAdCzgdB04t89/1o/w1cDnyilFU=';
const GROUP_ID   = 'Cba1029b36b497b2840668bb08b7e7405';
const KG_PER_PCS = 0.030;

// ============================================================
// HTTP ハンドラ
// ============================================================

function doGet(e) {
  try {
    if (e.parameter.action === 'getMasters') {
      return respond(getMasters());
    }
    return respond({ error: 'Unknown action: ' + e.parameter.action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (payload.events) return handleLineWebhook(payload);
    if (payload.action === 'recordEntry') return respond(recordEntry(payload));
    return respond({ error: 'Unknown action: ' + payload.action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function handleLineWebhook(payload) {
  payload.events.forEach(function(event) {
    if (event.source && event.source.type === 'group') {
      const gid = event.source.groupId;
      Logger.log('🎯 GROUP_ID: ' + gid);
      const ss = SpreadsheetApp.openById(SS_ID);
      let sheet = ss.getSheetByName('_GroupIdLog');
      if (!sheet) sheet = ss.insertSheet('_GroupIdLog');
      sheet.appendRow([new Date(), gid, event.source.userId || '']);
    }
  });
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// getMasters — 商品・SKU・工程・在庫スナップショットを返す
// ============================================================

function getMasters() {
  const ss = SpreadsheetApp.openById(SS_ID);

  const products = sheetToObjects(ss.getSheetByName('Products'));
  const skus     = sheetToObjects(ss.getSheetByName('SKUs'));
  const stages   = sheetToObjects(ss.getSheetByName('Stages'));
  const snapshot = buildSnapshot(ss);

  stages.forEach(function(s) {
    s.order    = Number(s.order);
    s.extInput = (s.extInput === true || s.extInput === 'TRUE');
    s.next     = s.next ? String(s.next).split(',').map(function(x) { return x.trim(); }).filter(Boolean) : [];
  });

  // isSet と components をパース
  skus.forEach(function(s) {
    s.isSet      = (s.isSet === true || s.isSet === 'TRUE');
    s.components = s.components
      ? String(s.components).split(',').map(function(c) { return c.trim(); }).filter(Boolean)
      : [];
  });

  return { products, skus, stages, snapshot };
}

function sheetToObjects(sheet) {
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows    = values.slice(1);
  return rows
    .filter(function(r) { return r[0] !== '' && r[0] !== null; })
    .map(function(r) {
      const obj = {};
      headers.forEach(function(h, i) { obj[h] = r[i]; });
      return obj;
    });
}

// ============================================================
// buildSnapshot — 在庫・工程合計・差分を生成
// ============================================================

function buildSnapshot(ss) {
  const snapSheet = ss.getSheetByName('Snapshot');
  const snapshot  = {};
  if (snapSheet && snapSheet.getLastRow() > 1) {
    const rows = snapSheet.getDataRange().getValues().slice(1);
    rows.forEach(function(row) {
      const skuCode = row[0], stage = row[1], qty = row[2];
      if (!skuCode) return;
      if (!snapshot[skuCode]) snapshot[skuCode] = {};
      snapshot[skuCode][stage] = Number(qty) || 0;
    });
  }

  const processStages = ['エルアイシー(未縫製)', '池本さん', '刑務所', 'エルアイシー(加工前)', '内職', '実在庫'];
  Object.keys(snapshot).forEach(function(sku) {
    const s = snapshot[sku];
    // 神木・西尾どちらの工場でも kg → 個 換算して合算
    const factoryKg   = (s['神木さん'] || 0) + (s['西尾さん'] || 0);
    const factoryPcs  = Math.round(factoryKg / KG_PER_PCS);
    const stagePcs    = processStages.reduce(function(sum, st) { return sum + (s[st] || 0); }, 0);
    const processTotal = factoryPcs + stagePcs;
    const backlog     = s['backlog'] || 0;
    const target      = s['target']  || 0;
    const shipped     = s['出荷数']  || 0;
    const physStock   = s['実在庫']  || 0;
    const produced    = physStock + shipped;

    s.factoryKg    = factoryKg;
    s.factoryPcs   = factoryPcs;
    s.kamikiPcs    = factoryPcs; // 後方互換
    s.processTotal = processTotal;
    s.backlog      = backlog;
    s.target       = target;
    s.shipped      = shipped;
    s.physStock    = physStock;
    s.produced     = produced;
    s.diff         = backlog - processTotal;
    s.progress     = target > 0 ? Math.round(produced / target * 100) : null;
  });

  return snapshot;
}

// ============================================================
// recordEntry — ログ記録 + スナップショット更新
// ============================================================

function recordEntry(payload) {
  const ss   = SpreadsheetApp.openById(SS_ID);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    appendLog(ss, payload);

    if (payload.mode === '出荷数更新') {
      recordShipment(ss, payload.skuCode, Number(payload.qty));
    } else if (payload.mode === '生産目標更新') {
      setTarget(ss, payload.skuCode, Number(payload.qty));
    } else if (payload.mode === '在庫修正') {
      setStageValue(ss, payload.skuCode, payload.dest, Number(payload.qty));
    } else {
      updateSnapshot(ss, payload);
    }

    // セット品は構成色のアラートを個別にチェック
    const comps = getSetComponents(ss, payload.skuCode);
    if (comps.length > 0) {
      comps.forEach(function(c) { checkAndAlert(c, c); });
    } else {
      checkAndAlert(payload.skuCode, payload.skuName);
    }

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// セット品の構成SKUコードを返す（セットでなければ空配列）
function getSetComponents(ss, skuCode) {
  const skus = sheetToObjects(ss.getSheetByName('SKUs'));
  const sku  = skus.find(function(s) { return s.code === skuCode; });
  if (!sku || !(sku.isSet === true || sku.isSet === 'TRUE') || !sku.components) return [];
  return String(sku.components).split(',').map(function(c) { return c.trim(); }).filter(Boolean);
}

function checkAndAlert(skuCode, skuName) {
  if (!LINE_TOKEN || !GROUP_ID) return;
  const ss   = SpreadsheetApp.openById(SS_ID);
  const snap = buildSnapshot(ss);
  if (snap[skuCode] && snap[skuCode].diff > 0) {
    const d = snap[skuCode];
    sendLineAlert(
      '⚠️ 不足アラート\n' +
      skuName + '\n' +
      '工程合計: ' + d.processTotal + '個 / 出荷残: ' + d.backlog + '個\n' +
      '不足: ' + d.diff + '個\n' +
      '追加発注を検討してください'
    );
  }
}

function sendLineAlert(text) {
  if (!LINE_TOKEN || !GROUP_ID) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify({ to: GROUP_ID, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('LINE送信エラー: ' + e);
  }
}

function sendDailyReminder() {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日');
  const liffUrl = 'https://liff.line.me/2009935318-eq7U4Fuc';
  sendLineAlert('📦 ' + today + ' 入力リマインド\n本日の進捗を入力してください。\n▼ ' + liffUrl);
}

function appendLog(ss, p) {
  ss.getSheetByName('Log').appendRow([
    p.timestamp, p.user, p.userId, p.mode, p.product,
    p.skuCode, p.skuName,
    p.source || '', p.dest || '',
    Number(p.qty), p.unit, p.memo || ''
  ]);
}

// ============================================================
// Snapshot 更新
// ============================================================

function updateSnapshot(ss, p) {
  const sheet = ss.getSheetByName('Snapshot');
  const qty   = Number(p.qty);

  if (p.mode === '外部入荷') {
    addToSnapshot(sheet, p.skuCode, p.dest, qty);

  } else if (p.mode === '工程移動') {
    // 神木さん or 西尾さんからの移動はkg換算
    if (p.source === '神木さん' || p.source === '西尾さん') {
      const kgDelta = Math.round(qty * KG_PER_PCS * 1000) / 1000;
      addToSnapshot(sheet, p.skuCode, p.source, -kgDelta);
      addToSnapshot(sheet, p.skuCode, p.dest,    qty);
    } else {
      addToSnapshot(sheet, p.skuCode, p.source, -qty);
      addToSnapshot(sheet, p.skuCode, p.dest,    qty);
    }
  }
}

function setTarget(ss, skuCode, qty) {
  const sheet = ss.getSheetByName('Snapshot');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === skuCode && data[i][1] === 'target') {
      sheet.getRange(i + 1, 3).setValue(qty);
      return;
    }
  }
  sheet.appendRow([skuCode, 'target', qty]);
}

function setStageValue(ss, skuCode, stage, qty) {
  const sheet = ss.getSheetByName('Snapshot');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === skuCode && data[i][1] === stage) {
      sheet.getRange(i + 1, 3).setValue(qty);
      return;
    }
  }
  sheet.appendRow([skuCode, stage, qty]);
}

// 出荷数更新: セット品は構成色から引き落とし、単品は直接処理
function recordShipment(ss, skuCode, qty) {
  const components = getSetComponents(ss, skuCode);
  const sheet = ss.getSheetByName('Snapshot');

  if (components.length > 0) {
    components.forEach(function(compCode) {
      addToSnapshot(sheet, compCode, '実在庫', -qty);
      addToSnapshot(sheet, compCode, '出荷数',  qty);
    });
    return;
  }

  addToSnapshot(sheet, skuCode, '実在庫', -qty);
  addToSnapshot(sheet, skuCode, '出荷数',  qty);
}

function addToSnapshot(sheet, skuCode, stage, delta) {
  if (!stage || stage === '—') return;
  if (stage === '出荷') {
    if (delta <= 0) return;
    stage = '出荷数';
  }
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === skuCode && data[i][1] === stage) {
      const newVal = Math.max(0, Number(data[i][2]) + delta);
      sheet.getRange(i + 1, 3).setValue(newVal);
      return;
    }
  }
  if (delta > 0) sheet.appendRow([skuCode, stage, delta]);
}

// ============================================================
// setupNishioAndSets — 初回セットアップ（手動で一度だけ実行）
// ============================================================

function setupNishioAndSets() {
  setupProductsNew();
  updateSKUsSheet();
  updateStagesSheet();
  Logger.log('✅ 西尾・セット品セットアップ完了');
}

function setupProductsNew() {
  const ss = SpreadsheetApp.openById(SS_ID);
  let sheet = ss.getSheetByName('Products');
  if (!sheet) sheet = ss.insertSheet('Products');
  sheet.clearContents();
  const headers = ['code', 'name', 'factory'];
  sheet.appendRow(headers);
  sheet.appendRow(['tubutubu-babyleg-kamiki', 'つぶつぶベビーレッグ（神木）', '神木さん']);
  sheet.appendRow(['tubutubu-babyleg-nishio', 'つぶつぶベビーレッグ（西尾）', '西尾さん']);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#f3f0e8');
  Logger.log('✅ Products更新完了');
}

function updateSKUsSheet() {
  const ss    = SpreadsheetApp.openById(SS_ID);
  let sheet   = ss.getSheetByName('SKUs');
  if (!sheet) sheet = ss.insertSheet('SKUs');
  sheet.clearContents();

  const headers = ['product', 'code', 'name', 'isSet', 'components'];
  sheet.appendRow(headers);

  const rows = [
    // ── 神木 単色 ───────────────────────────────────────────────
    ['tubutubu-babyleg-kamiki', 'TBL-KN',   '【神木】キナリ',           false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-KNT',  '【神木】キナリツブ',       false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-SRT',  '【神木】シロツブ',         false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-CNP',  '【神木】カラーネップ',     false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-MOM',  '【神木】杢オートミール',   false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-CG',   '【神木】チャコールグレー', false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-GR',   '【神木】グレー',           false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-DP',   '【神木】ダスティピンク',   false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-OL',   '【神木】オリーブ',         false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-MG',   '【神木】杢グレー',         false, ''],
    ['tubutubu-babyleg-kamiki', 'TBL-MC',   '【神木】杢チャコール',     false, ''],
    // ── 神木 セット ─────────────────────────────────────────────
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET01', '【セット①】キナリ・ダスティ・グレー',       true, 'TBL-KN,TBL-DP,TBL-GR'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET02', '【セット②】グレー・チャコール・オリーブ',   true, 'TBL-GR,TBL-CG,TBL-OL'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET03', '【セット③】オリーブ・キナリ・ダスティ',     true, 'TBL-OL,TBL-KN,TBL-DP'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET04', '【セット④】チャコール・キナリ・グレー',     true, 'TBL-CG,TBL-KN,TBL-GR'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET05', '【セット⑤】ダスティ・グレー・オリーブ',     true, 'TBL-DP,TBL-GR,TBL-OL'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET06', '【セット⑥】オリーブ・グレー・キナリ',       true, 'TBL-OL,TBL-GR,TBL-KN'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET07', '【セット⑦】ダスティ・チャコール・オリーブ', true, 'TBL-DP,TBL-CG,TBL-OL'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET08', '【セット⑧】キナリ・チャコール・オリーブ',   true, 'TBL-KN,TBL-CG,TBL-OL'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET09', '【セット⑨】チャコール・ダスティ・グレー',   true, 'TBL-CG,TBL-DP,TBL-GR'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-SET10', '【セット⑩】キナリ・ダスティ・チャコール',   true, 'TBL-KN,TBL-DP,TBL-CG'],
    ['tubutubu-babyleg-kamiki', 'TBL-KMK-MOKU',  '【杢セット】杢チャコール・杢OAT・杢グレー', true, 'TBL-MC,TBL-MOM,TBL-MG'],
    // ── 西尾 単色 ───────────────────────────────────────────────
    ['tubutubu-babyleg-nishio', 'TBL-WSO-KN',  '【西尾】キナリ',           false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-CG',  '【西尾】チャコールグレー', false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-GR',  '【西尾】グレー',           false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-DP',  '【西尾】ダスティピンク',   false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-OL',  '【西尾】オリーブ',         false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-MOM', '【西尾】杢オートミール',   false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-MG',  '【西尾】杢グレー',         false, ''],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-MC',  '【西尾】杢チャコール',     false, ''],
    // ── 西尾 セット ─────────────────────────────────────────────
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET01', '【セット①】キナリ・ダスティ・グレー',       true, 'TBL-WSO-KN,TBL-WSO-DP,TBL-WSO-GR'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET02', '【セット②】グレー・チャコール・オリーブ',   true, 'TBL-WSO-GR,TBL-WSO-CG,TBL-WSO-OL'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET03', '【セット③】オリーブ・キナリ・ダスティ',     true, 'TBL-WSO-OL,TBL-WSO-KN,TBL-WSO-DP'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET04', '【セット④】チャコール・キナリ・グレー',     true, 'TBL-WSO-CG,TBL-WSO-KN,TBL-WSO-GR'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET05', '【セット⑤】ダスティ・グレー・オリーブ',     true, 'TBL-WSO-DP,TBL-WSO-GR,TBL-WSO-OL'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET06', '【セット⑥】オリーブ・グレー・キナリ',       true, 'TBL-WSO-OL,TBL-WSO-GR,TBL-WSO-KN'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET07', '【セット⑦】ダスティ・チャコール・オリーブ', true, 'TBL-WSO-DP,TBL-WSO-CG,TBL-WSO-OL'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET08', '【セット⑧】キナリ・チャコール・オリーブ',   true, 'TBL-WSO-KN,TBL-WSO-CG,TBL-WSO-OL'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET09', '【セット⑨】チャコール・ダスティ・グレー',   true, 'TBL-WSO-CG,TBL-WSO-DP,TBL-WSO-GR'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-SET10', '【セット⑩】キナリ・ダスティ・チャコール',   true, 'TBL-WSO-KN,TBL-WSO-DP,TBL-WSO-CG'],
    ['tubutubu-babyleg-nishio', 'TBL-WSO-MOKU',  '【杢セット】杢チャコール・杢OAT・杢グレー', true, 'TBL-WSO-MC,TBL-WSO-MOM,TBL-WSO-MG']
  ];

  rows.forEach(function(r) { sheet.appendRow(r); });
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f0e8');
  Logger.log('✅ SKUs更新完了: ' + rows.length + '件');
}

function updateStagesSheet() {
  const ss    = SpreadsheetApp.openById(SS_ID);
  let sheet   = ss.getSheetByName('Stages');
  if (!sheet) sheet = ss.insertSheet('Stages');
  sheet.clearContents();

  const headers = ['code', 'name', 'order', 'unit', 'extInput', 'next'];
  const rows = [
    ['S01',  '神木さん',             1, 'kg', true,  'エルアイシー(未縫製)'],
    ['S01B', '西尾さん',             1, 'kg', true,  'エルアイシー(未縫製)'],
    ['S02',  'エルアイシー(未縫製)', 2, '個', false, '池本さん,刑務所,出荷'],
    ['S03',  '池本さん',             3, '個', false, 'エルアイシー(加工前),出荷'],
    ['S04',  '刑務所',               3, '個', false, 'エルアイシー(加工前),出荷'],
    ['S05',  'エルアイシー(加工前)', 4, '個', false, '内職,出荷'],
    ['S06',  '内職',                 5, '個', false, '実在庫,出荷'],
    ['S07',  '実在庫',               6, '個', false, '出荷']
  ];
  sheet.appendRow(headers);
  rows.forEach(function(r) { sheet.appendRow(r); });
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f0e8');
  Logger.log('✅ Stages更新完了');
}

// ============================================================
// resetSnapshot — 最新数字に一括書き換え（手動で1回だけ実行）
// ============================================================

function resetSnapshot() {
  const ss    = SpreadsheetApp.openById(SS_ID);
  const sheet = ss.getSheetByName('Snapshot');

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 3).clearContent();

  const data = [
    ['TBL-MOM', '内職',  920],
    ['TBL-CNP', '内職', 1190],
    ['TBL-KNT', '内職',  920],
    ['TBL-SRT', '内職', 1120],
    ['TBL-CG',  '内職', 1014],
    ['TBL-OL',  '内職',  671],
    ['TBL-GR',  '内職',  420],
    ['TBL-CG',  '実在庫',  973],
    ['TBL-OL',  '実在庫',  710],
    ['TBL-DP',  '実在庫',  587],
    ['TBL-GR',  '実在庫',  290],
    ['TBL-KN',  '実在庫',  100],
    ['TBL-GR',  'target', 4000],
    ['TBL-OL',  'target', 4000],
    ['TBL-DP',  'target', 3200],
    ['TBL-KN',  'target', 4800],
    ['TBL-CG',  'target', 1600],
    ['TBL-KNT', 'target', 3200],
    ['TBL-MOM', 'target', 1600],
    ['TBL-SRT', 'target', 1600],
    ['TBL-CNP', 'target', 1600],
  ];

  sheet.getRange(2, 1, data.length, 3).setValues(data);
  Logger.log('✅ Snapshot reset完了: ' + data.length + '行');
}
