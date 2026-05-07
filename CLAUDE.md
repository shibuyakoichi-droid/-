# プロジェクト概要

**SOWAN**（ブランド名）の社内業務ツール群。株式会社エル・アイ・シー運営。
「mofmofu」はSOWANの商品名であり、ブランド名ではない。

すべてシングルHTML形式で、`top.html` がポータルとして各ツールをまとめている。

---

## Supabase 接続情報

| 項目 | 値 |
|---|---|
| Project URL | `https://yukcdqnnevomhdcpsvms.supabase.co` |
| Anon Key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1a2NkcW5uZXZvbWhkY3Bzdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0Mjc2MTUsImV4cCI6MjA5MjAwMzYxNX0.XBSc2kQNwR_bleSwrfYZD8l0fbKTbL1Z3S7ewEtSkDc` |
| SDK | `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2` (CDN) |

新しいHTMLファイルでSupabaseを使う場合は上記URL・Keyをそのまま使う。

---

## データベース設計

### `factories`（工場マスタ）

```sql
create table factories (
  id text primary key,          -- 'f' + timestamp
  name text not null,
  contact text default '',
  category text not null,       -- 編み/染色/裁断/縫製/糸/靴下/その他
  tel text default '',
  email text default ''
);
```

### `orders`（発注書）

```sql
create table orders (
  id text primary key,          -- 'o' + timestamp + random
  number text not null,         -- PO-YYYYMM-NNN 形式
  factory_id text,              -- factories.id 参照（外部キー制約なし）
  category text not null,       -- 工場のcategoryをコピー
  date text not null,           -- YYYY-MM-DD
  due text default '',          -- 希望納期 YYYY-MM-DD
  memo text default '',
  items jsonb default '[]',     -- 発注明細（配列、スキーマはカテゴリ依存）
  created_at timestamptz default now()
);
```

#### `items` の構造（カテゴリ別）

| カテゴリ | フィールド |
|---|---|
| 編み・染色 | fabricNo, color, tan |
| 裁断 | fabricNo, color, productName, tan, cutQty |
| 縫製 | fabricNo, color, productName, cutQty |
| 糸・靴下 | yarnNo, color, count, qty, qtyUnit, (productName) |
| その他 | fabricNo, color, note, qty |

### RLS ポリシー

```sql
alter table factories enable row level security;
alter table orders enable row level security;
create policy "anon_all" on factories for all to anon using (true) with check (true);
create policy "anon_all" on orders for all to anon using (true) with check (true);
```

---

## 発注管理システム（`order_management.html`）

### 概要

4タブ構成のブラウザ完結型発注管理アプリ。

| タブ | 内容 |
|---|---|
| 概要 | 当月の発注件数・数量・工場数サマリ＋一覧 |
| 発注履歴 | 月別・工場別・品番別の切替表示、フィルタ・ソート対応 |
| 集計 | 工場別・品番別の数量集計と構成比バー |
| 工場マスタ | 工場の追加・削除 |

### 発注番号の採番ルール

`PO-YYYYMM-NNN`（同月内の連番。Supabaseからカウント）

### データフロー

- 起動時に `load()` でSupabaseから全データ取得
- 工場が0件の場合はデフォルト6社をシードとして挿入
- 発注保存 → `orders` テーブルに INSERT
- 工場追加・削除 → `factories` テーブルに INSERT / DELETE
- `factory_id`（DB）↔ `factoryId`（JS）のマッピングあり

### カテゴリバッジ対応表

| カテゴリ | CSSクラス |
|---|---|
| 編み | badge-knit |
| 染色 | badge-dye |
| 裁断 | badge-cut |
| 縫製 | badge-sew |
| 糸 | badge-yarn |
| 靴下 | badge-socks |
| その他 | badge-other |

---

## 納品書管理システム（運用中）

取引先から入ってきた納品内容を記録・蓄積していくシステム。以下のテーブル追加を想定：

```sql
-- 予定スキーマ（作成時に確定すること）
create table deliveries (
  id text primary key,
  order_id text,        -- orders.id 参照
  factory_id text,      -- factories.id 参照
  date text not null,
  items jsonb default '[]',
  memo text default '',
  created_at timestamptz default now()
);
```

- `factories` テーブルは発注管理と共有する
- 発注書との紐付けは `order_id` で行う予定

---

## ファイル構成

### ポータル
| ファイル | 役割 |
|---|---|
| `top.html` | ポータル（各ツールへのリンク集） |

### 発注・生産管理（Supabase連携）
| ファイル | 役割 |
|---|---|
| `order_management.html` | 発注管理システム。工場マスタ・発注書作成・集計・履歴の4タブ構成。生地管理も対応 |
| `production_forecast.html` | 生産予測ツール。クロスモール販売実績＋在庫数＋セット組CSVを掛け合わせて生産必要数を予測。要改良 |

### 分析ツール（楽天RMS系・詳細は後日確認）
| ファイル | 役割 |
|---|---|
| `flow.html` | 楽天RMS分析系ツール（詳細後日確認） |
| `item.html` | 楽天RMS分析系ツール（詳細後日確認） |
| `summary.html` | 楽天RMS分析系ツール（詳細後日確認） |

### その他ツール
| ファイル | 役割 |
|---|---|
| `tiktok_daily_report.html` | TikTok日次レポート |
| `mail_reply_tool.html` | SOWAN問い合わせ回答ツール（楽天CSVをアップロードして回答文作成） |
| `sort_by_sales.py` | 売上順ソートスクリプト（Python） |

### 工程管理LIFFアプリ（LINE内で動作）
| ファイル | 役割 |
|---|---|
| `genba/index.html` | 工程進捗入力フォーム。LIFF ID: `2009935318-eq7U4Fuc`。外部入荷・工程移動・出荷残更新の3モード |
| `genba/dashboard.html` | 工程ダッシュボード（各SKUの在庫・進捗一覧） |
| `genba/gas_backend.gs` | GASバックエンド。Googleスプレッドシート（SS_ID: `1l9QyWxdYcyTTqR7ZMBs-VQS0rj8c2qUp9q399jmy-30`）と連携 |

#### LIFFアプリのSKU一覧（tubutubu-babyleg / つぶつぶベビーレッグ）
| コード | カラー名 |
|--------|---------|
| TBL-KN | キナリ |
| TBL-KNT | キナリツブ |
| TBL-SRT | シロツブ |
| TBL-CNP | カラーネップ |
| TBL-MOM | 杢オートミール |
| TBL-CG | チャコールグレー |
| TBL-GR | グレー |
| TBL-DP | ダスティピンク |
| TBL-OL | オリーブ |

#### 工程フロー
神木さん（糸・kg） → エルアイシー → 池本さん / 刑務所 → 内職 → 実在庫 → 出荷

#### GAS更新手順
1. ローカルの `genba/gas_backend.gs` を編集
2. [script.google.com](https://script.google.com) でスクリプトに貼り付け・保存・デプロイ

---

## 開発規則

- シングルHTML形式を維持する（CSS・JS・HTMLをすべて1ファイルに）
- UIデザインは既存ファイルのスタイル（`#f5f4f0` ベース、`border-radius:12px` カード）に合わせる
- 新しいSupabase連携ファイルを作る場合は上記の接続情報・RLSポリシーパターンをそのまま使う
- 非同期処理は `async/await` で統一
- ブランド名は「SOWAN」に統一する（「mofmofu」は商品名なので混同しない）
