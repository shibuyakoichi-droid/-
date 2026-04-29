// ============================================================
// mofmofu 工程管理 — Google Apps Script バックエンド
// ============================================================
// 【デプロイ手順】
// 1. スプレッドシートを新規作成し、そのIDを SS_ID に設定
// 2. スクリプトエディタで setupSheets() を一度だけ手動実行
// 3. デプロイ → 新しいデプロイ → ウェブアプリ
//    実行ユーザー: 自分 / アクセスできるユーザー: 全員
// 4. 発行されたURLを index.html の GAS_API_URL に設定
// ============================================================

const SS_ID = '1l9QyWxdYcyTTqR7ZMBs-VQS0rj8c2qUp9q399jmy-30';

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
    if (payload.action === 'recordEntry') {
      return respond(recordEntry(payload));
    }
    return respond({ error: 'Unknown action: ' + payload.action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// getMasters — 商品・SKU・工程・在庫スナップショット・受注を返す
// ============================================================

function getMasters() {
  const ss = SpreadsheetApp.openById(SS_ID);

  const products = sheetToObjects(ss.getSheetByName('Products'));
  const skus     = sheetToObjects(ss.getSheetByName('SKUs'));
  const stages   = sheetToObjects(ss.getSheetByName('Stages'));
  const snapshot = buildSnapshot(ss);
  const orders   = getOpenOrders(ss);

  // Stages の型変換
  stages.forEach(s => {
    s.order    = Number(s.order);
    s.extInput = (s.extInput === true || s.extInput === 'TRUE');
    s.next     = s.next ? String(s.next).split(',').map(x => x.trim()).filter(Boolean) : [];
  });

  return { products, skus, stages, snapshot, orders };
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

// Snapshot シートから { skuCode: { stageName: qty, backlog, diff } } を生成
function buildSnapshot(ss) {
  const snapSheet   = ss.getSheetByName('Snapshot');
  const ordersSheet = ss.getSheetByName('Orders');
  const snapshot    = {};

  if (snapSheet && snapSheet.getLastRow() > 1) {
    const rows = snapSheet.getDataRange().getValues().slice(1);
    rows.forEach(([skuCode, stage, qty]) => {
      if (!skuCode) return;
      if (!snapshot[skuCode]) snapshot[skuCode] = {};
      snapshot[skuCode][stage] = Number(qty) || 0;
    });
  }

  // 出荷残（未出荷受注合計）を集計
  if (ordersSheet && ordersSheet.getLastRow() > 1) {
    const orders = sheetToObjects(ordersSheet);
    orders.forEach(o => {
      const unshipped = Number(o.unshipped) || 0;
      if (unshipped <= 0) return;
      if (!snapshot[o.sku]) snapshot[o.sku] = {};
      snapshot[o.sku].backlog = (snapshot[o.sku].backlog || 0) + unshipped;
    });
  }

  // diff = 実在庫 − backlog
  Object.keys(snapshot).forEach(sku => {
    const stock  = snapshot[sku]['実在庫'] || 0;
    const backlog = snapshot[sku].backlog  || 0;
    snapshot[sku].diff = stock - backlog;
  });

  return snapshot;
}

// 未出荷残がある受注のみ返す
function getOpenOrders(ss) {
  const sheet = ss.getSheetByName('Orders');
  if (!sheet) return [];
  return sheetToObjects(sheet)
    .filter(o => Number(o.unshipped) > 0)
    .map(o => ({
      id:        o.id,
      sku:       o.sku,
      channel:   o.channel,
      totalQty:  Number(o.totalQty),
      unshipped: Number(o.unshipped),
      createdAt: o.createdAt
    }));
}

// ============================================================
// recordEntry — ログ記録 + スナップショット更新
// ============================================================

function recordEntry(payload) {
  const ss   = SpreadsheetApp.openById(SS_ID);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000); // 同時書き込み防止

  try {
    appendLog(ss, payload);
    updateSnapshot(ss, payload);

    if (payload.mode === '受注追加') {
      addOrder(ss, payload);
    } else if (payload.mode === '出荷' && payload.orderId) {
      consumeOrder(ss, payload);
    }

    return { success: true };
  } finally {
    lock.releaseLock();
  }
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
    p.source  || '',
    p.dest    || '',
    Number(p.qty),
    p.unit,
    p.memo    || '',
    p.channel || '',
    p.orderId || ''
  ]);
}

// Snapshot シートの在庫数を更新
function updateSnapshot(ss, p) {
  const sheet = ss.getSheetByName('Snapshot');
  const qty   = Number(p.qty);

  if (p.mode === '外部入荷') {
    addToSnapshot(sheet, p.skuCode, p.dest, qty);

  } else if (p.mode === '工程移動') {
    addToSnapshot(sheet, p.skuCode, p.source, -qty);
    addToSnapshot(sheet, p.skuCode, p.dest,    qty);

  } else if (p.mode === '出荷') {
    // 実在庫から出荷 → 実在庫を減らすのみ（出荷は在庫外）
    addToSnapshot(sheet, p.skuCode, '実在庫', -qty);
  }
  // 受注追加は Orders のみ変更（Snapshot は変わらない）
}

// Snapshot の特定セルに加算（行がなければ新規追加）
function addToSnapshot(sheet, skuCode, stage, delta) {
  if (!stage || stage === '—' || stage === '出荷残' || stage === '出荷') return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === skuCode && data[i][1] === stage) {
      const newVal = Math.max(0, Number(data[i][2]) + delta);
      sheet.getRange(i + 1, 3).setValue(newVal);
      return;
    }
  }
  // 行が存在しない場合 — 加算のみ追加（マイナスは在庫なしのため無視）
  if (delta > 0) {
    sheet.appendRow([skuCode, stage, delta]);
  }
}

// 受注追加: Orders に新規行を追加
function addOrder(ss, p) {
  const date = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
  const id   = 'ORD-' + date + '-' + rand;

  ss.getSheetByName('Orders').appendRow([
    id,
    p.skuCode,
    p.channel,
    Number(p.qty),
    Number(p.qty), // unshipped = totalQty（初期値）
    p.timestamp
  ]);
}

// 出荷: Orders の unshipped を減算
function consumeOrder(ss, p) {
  const sheet = ss.getSheetByName('Orders');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === p.orderId) {
      const newVal = Math.max(0, Number(data[i][4]) - Number(p.qty));
      sheet.getRange(i + 1, 5).setValue(newVal);
      return;
    }
  }
}

// ============================================================
// setupSheets — 初回セットアップ（手動で一度だけ実行）
// ============================================================

function setupSheets() {
  const ss = SpreadsheetApp.openById(SS_ID);

  createSheet(ss, 'Log', [
    'timestamp','user','userId','mode','product',
    'skuCode','skuName','source','dest','qty',
    'unit','memo','channel','orderId'
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
      ['S06', '実在庫',       5, '個', false, '出荷'],
      ['S07', '出荷',         6, '個', false, '']
    ]
  );

  createSheet(ss, 'Snapshot', ['skuCode', 'stage', 'qty']);
  createSheet(ss, 'Orders',   ['id', 'sku', 'channel', 'totalQty', 'unshipped', 'createdAt']);

  Logger.log('✅ setupSheets 完了');
}

function createSheet(ss, name, headers, rows) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    if (rows) rows.forEach(r => sheet.appendRow(r));
    // ヘッダー行を太字・背景色で装飾
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#f3f0e8');
  }
  return sheet;
}
