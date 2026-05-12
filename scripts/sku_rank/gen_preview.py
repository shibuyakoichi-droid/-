import pandas as pd, json

df = pd.read_excel(r'c:\Users\81804\Downloads\SKU運用ランク_20260412-20260512.xlsx')

rows = []
for _, r in df.iterrows():
    last_val = r.iloc[3]
    yoy_val  = r.iloc[6]
    rows.append({
        'rank':  int(r.iloc[4]),
        'sku':   str(r.iloc[0]),
        'name':  str(r.iloc[1]),
        'this':  int(r.iloc[2]),
        'last':  int(last_val) if pd.notna(last_val) else None,
        'srank': str(r.iloc[5]),
        'yoy':   round(float(yoy_val), 1) if pd.notna(yoy_val) else None,
        'yrank': str(r.iloc[7]),
    })

dist_s = df.iloc[:,5].value_counts().to_dict()
dist_y = df.iloc[:,7].value_counts().to_dict()
t_this = int(df.iloc[:,2].sum())
t_last = int(df[df.iloc[:,3].notna()].iloc[:,3].sum())
with_last = int(df.iloc[:,3].notna().sum())
new_prod  = int((df.iloc[:,7] == '新商品').sum())

data_obj = {
    'rows': rows, 'dist_s': dist_s, 'dist_y': dist_y,
    'tt': t_this, 'tl': t_last, 'wl': with_last, 'np': new_prod
}
data_json = json.dumps(data_obj, ensure_ascii=False)

# テンプレートを読み込んでデータを埋め込む
with open(r'c:\Users\81804\Downloads\sku_preview_template.html', encoding='utf-8') as f:
    html = f.read()

# プレースホルダーをJSONデータで置換
html = html.replace('var INLINE_DATA = null;', 'var INLINE_DATA = ' + data_json + ';')

with open(r'c:\Users\81804\Downloads\SKU運用ランク_プレビュー.html', 'w', encoding='utf-8') as f:
    f.write(html)

print('完了:', len(rows), '件')
