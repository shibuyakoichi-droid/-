// ============================================================
// mofmofu 工程管理 — Google Apps Script バックエンド (v2)
// ============================================================
// v2変更: 受注管理をクロスモールに移行。
//   「受注追加」「出荷」モード削除。
//   「出荷残更新」モード追加（スタッフが出荷残を直接入力）。
//   backlogの管理をOrdersシートからSnapshotシートに変更。
// ============================================================

const SS_ID = '1l9QyWxdYcyTTqR7ZMBs-VQS0rj8c2qUp9q399jmy-30';

// LINE設定
const LINE_TOKEN = 'D+dfSKKq9S3ZXx2xUDAE9r1b8Syt1tgRyGzddtMKHuhMJTDV1EDg+TsZNUfmW+XyszQpXshH9n9xBZ3XA5naGpcWT4a/xjl+bNtPxha2HSFbORUNrbZzYMJ/2Tl382QkDejinEoA8R0wGbVoeAdCzgdB04t89/1O/w1cDnyilFU=';
const GROUP_ID   = 'Cba1029b36b497b2840668bb08b7e7405';

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

    // LINE Webhook（グループID取得用）
    if (payload.events) {
      return handleLineWebhook(payload);
    }

    if (payload.action === 'recordEntry') {
      return respond(recordEntry(payload));
    }
    return respond({ error: 'Unknown action: ' + payload.action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

// LINE Webhook: groupId をスプレッドシートとログに記録
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

  stages.forEach(s => {
    s.order    = Number(s.order);
    s.extInput = (s.extInput === true || s.extInput === 'TRUE');
    s.next     = s.next ? String(s.next).split(',').map(x => x.trim()).filter(Boolean) : [];
  });

  return { products, skus, stages, snapshot };
}

// シートの1行目をヘッダーとしてオブジェクト配列に変換
function sheetToObjects(sheet) {
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const [headers, ...rows] = values;
  return rows
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i]; });
      return obj;
    });
}

// Snapshotシートから在庫・工程合計・差分を生成
function buildSnapshot(ss) {
  const snapSheet = ss.getSheetByName('Snapshot');
  const snapshot  = {};
  // 神木さんの換算係数: 1足30g = 0.030kg/個
  // 商品が増えてkg_per_unitが変わる場合はここを変更する
  const KG_PER_PCS = 0.030;

  if (snapSheet && snapSheet.getLastRow() > 1) {
    const rows = snapSheet.getDataRange().getValues().slice(1);
    rows.forEach(([skuCode, stage, qty]) => {
      if (!skuCode) return;
      if (!snapshot[skuCode]) snapshot[skuCode] = {};
      snapshot[skuCode][stage] = Number(qty) || 0;
    });
  }

  // 工程合計・差分計算
  // 神木さんはkg→個換算して工程合計に含める（他はすべて個単位）
  const processStages = ['エルアイシー', '池本さん', '刑務所', '内職', '実在庫'];
  Object.keys(snapshot).forEach(sku => {
    const s          = snapshot[sku];
    const kamikiKg   = s['神木さん'] || 0;
    const kamikiPcs  = Math.round(kamikiKg / KG_PER_PCS);
    const stagePcs   = processStages.reduce((sum, st) => sum + (s[st] || 0), 0);
    const processTotal = kamikiPcs + stagePcs;
    const backlog    = s['backlog'] || 0;

    s.kamikiPcs    = kamikiPcs;
    s.processTotal = processTotal;
    s.backlog      = backlog;
    s.diff         = backlog - processTotal; // 出荷残 - 工程合計（プラスが不足）
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

    if (payload.mode === '出荷残更新') {
      setBacklog(ss, payload.skuCode, Number(payload.qty));
    } else {
      updateSnapshot(ss, payload);
    }

    checkAndAlert(payload.skuCode, payload.skuName);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// 不足チェック → LINE通知（diff > 0 = 出荷残 > 工程合計 = 不足）
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
      '神木さんへの追加発注を検討してください'
    );
  }
}

// LINE Push 送信
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

// 毎日17:00リマインダー（時間トリガーで実行）
function sendDailyReminder() {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日');
  const liffUrl = 'https://liff.line.me/2009935318-eq7U4Fuc';
  sendLineAlert('📦 ' + today + ' 入力リマインド\n本日の進捗を入力してください。\n▼ ' + liffUrl);
}

// Log シートに1行追記
function appendLog(ss, p) {
  ss.getSheetByName('Log').appendRow([
    p.timestamp,
    p.user,
    p.userId,
    p.mode,
    p.product,
    p.skuCode,
    p.skuName,
    p.source || '',
    p.dest   || '',
    Number(p.qty),
    p.unit,
    p.memo   || ''
  ]);
}

// Snapshotシートの在庫数を更新（外部入荷・工程移動）
function updateSnapshot(ss, p) {
  const sheet = ss.getSheetByName('Snapshot');
  const qty   = Number(p.qty);

  if (p.mode === '外部入荷') {
    addToSnapshot(sheet, p.skuCode, p.dest, qty);
  } else if (p.mode === '工程移動') {
    addToSnapshot(sheet, p.skuCode, p.source, -qty);
    addToSnapshot(sheet, p.skuCode, p.dest,    qty);
  }
}

// 出荷残更新: Snapshotの 'backlog' 行を上書き
function setBacklog(ss, skuCode, qty) {
  const sheet = ss.getSheetByName('Snapshot');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === skuCode && data[i][1] === 'backlog') {
      sheet.getRange(i + 1, 3).setValue(qty);
      return;
    }
  }
  sheet.appendRow([skuCode, 'backlog', qty]);
}

// Snapshotの特定セルに加算（行がなければ新規追加）
function addToSnapshot(sheet, skuCode, stage, delta) {
  if (!stage || stage === '—' || stage === '出荷') return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === skuCode && data[i][1] === stage) {
      const newVal = Math.max(0, Number(data[i][2]) + delta);
      sheet.getRange(i + 1, 3).setValue(newVal);
      return;
    }
  }
  if (delta > 0) {
    sheet.appendRow([skuCode, stage, delta]);
  }
}

// ============================================================
// setupSheets — 初回セットアップ（手動で一度だけ実行）
// ============================================================

function setupSheets() {
  const ss = SpreadsheetApp.openById(SS_ID);

  createSheet(ss, 'Log', [
    'timestamp','user','userId','mode','product',
    'skuCode','skuName','source','dest','qty','unit','memo'
  ]);

  createSheet(ss, 'Products',
    ['code', 'name'],
    [['tubutubu-babyleg', 'つぶつぶベビーレッグ']]
  );

  createSheet(ss, 'SKUs',
    ['product', 'code', 'name'],
    [
      ['tubutubu-babyleg', 'TBL-KN',  'キナリ'],
      ['tubutubu-babyleg', 'TBL-KNT', 'キナリツブ'],
      ['tubutubu-babyleg', 'TBL-SRT', 'シロツブ'],
      ['tubutubu-babyleg', 'TBL-CNP', 'カラーネップ'],
      ['tubutubu-babyleg', 'TBL-MOM', '杢オートミール']
    ]
  );

  createSheet(ss, 'Stages',
    ['code', 'name', 'order', 'unit', 'extInput', 'next'],
    [
      ['S01', '神木さん',     1, 'kg', true,  'エルアイシー'],
      ['S02', 'エルアイシー', 2, '個', false, '池本さん,刑務所,出荷'],
      ['S03', '池本さん',     3, '個', false, '内職,出荷'],
      ['S04', '刑務所',       3, '個', false, '内職,出荷'],
      ['S05', '内職',         4, '個', false, '実在庫,出荷'],
      ['S06', '実在庫',       5, '個', false, '出荷']
    ]
  );

  createSheet(ss, 'Snapshot', ['skuCode', 'stage', 'qty']);

  Logger.log('✅ setupSheets 完了');
}

function createSheet(ss, name, headers, rows) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    if (rows) rows.forEach(r => sheet.appendRow(r));
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#f3f0e8');
  }
  return sheet;
}
