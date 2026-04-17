# プロジェクト概要

株式会社エル・アイ・シー / mofmofu の社内業務ツール群。
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

## 納品書管理システム（未作成・予定）

将来作成予定。以下のテーブル追加を想定：

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

| ファイル | 役割 |
|---|---|
| `top.html` | ポータル（各ツールへのリンク集） |
| `order_management.html` | 発注管理システム（Supabase連携済） |
| `production_sort.html` | 生産管理ソートツール（ローカル動作） |
| `flow.html` | フロー図系ツール |
| `item.html` | アイテム管理 |
| `summary.html` | サマリ表示 |
| `tiktok_daily_report.html` | TikTok日次レポート |
| `sort_by_sales.py` | 売上順ソートスクリプト |

---

## 開発規則

- シングルHTML形式を維持する（CSS・JS・HTMLをすべて1ファイルに）
- UIデザインは既存ファイルのスタイル（`#f5f4f0` ベース、`border-radius:12px` カード）に合わせる
- 新しいSupabase連携ファイルを作る場合は上記の接続情報・RLSポリシーパターンをそのまま使う
- 非同期処理は `async/await` で統一
