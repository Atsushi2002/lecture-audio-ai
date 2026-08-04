# API_NOTES.md — Gemini API 調査メモ（根拠URL付き）

調査日: 2026-08-04（公式ドキュメントを直接参照して作成）

> このファイルの目的は「AIの記憶（古い情報）ではなく、公式ドキュメントを根拠にする」こと。
> API周りで詰まったら、まずここに戻る。

---

## 1. 使うモデル名

**根拠:** https://ai.google.dev/gemini-api/docs/models （ページ最終更新: 2026-07-30）

公式Models一覧に載っている **Stable** モデル（Gemini 3系）:

| モデル文字列 | 位置づけ |
|---|---|
| `gemini-3.6-flash` | 最新。速度と知能のバランス型 |
| `gemini-3.5-flash` | エージェント/コーディング向けの高知能モデル。**公式の音声ガイドのサンプルがこれ** |
| `gemini-3.5-flash-lite` | 3.5系で最速・最安 |
| `gemini-3.1-flash-lite` | 低コスト帯 |

**本アプリの既定値: `gemini-3.5-flash`**
理由: 公式の Audio understanding ガイドのサンプルコードがすべてこのモデルを使っており、音声入力での動作実績が公式に示されているため。

### ⚠️ 使ってはいけない古いモデル名

AIが提案しがちだが、公式の「Previous models」で **Shut down / Deprecated** 扱いのもの:

- `gemini-1.5-pro` / `gemini-1.5-flash` … 一覧に存在しない（AIのハルシネーション常連）
- `gemini-2.0-flash` / `gemini-2.0-flash-lite` … Shut down
- `gemini-3-pro-preview` / `gemini-3.1-flash-lite-preview` … Shut down

**ルール: モデル名は必ず https://ai.google.dev/gemini-api/docs/models の一覧からコピーする。**

### バージョン命名規則

**根拠:** 同上「Model version name patterns」

- Stable（例 `gemini-3.6-flash`）… 本番はこれ
- Preview（例 `gemini-2.5-flash-preview-09-2025`）… 廃止2週間前通知あり
- Latest（例 `gemini-flash-latest`）… 常に最新へ差し替わる
- Experimental … 本番非推奨

---

## 2. エンドポイントとリクエスト形式

**根拠:** https://ai.google.dev/gemini-api/docs/audio （REST タブ）

```
POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
Header: x-goog-api-key: <APIキー>
Header: Content-Type: application/json
```

**重要:** 認証は `Authorization: Bearer` ではなく **`x-goog-api-key` ヘッダ**。
（AIが `?key=` クエリや Bearer を出すことがあるが、公式RESTサンプルはヘッダ方式）

### ボディ（テキストのみ = 疎通確認用）

```json
{
  "contents": [
    { "parts": [ { "text": "こんにちは、と返してください" } ] }
  ]
}
```

### ボディ（音声インライン送信）

```json
{
  "contents": [
    {
      "parts": [
        { "text": "Generate a transcript of the speech." },
        { "inline_data": { "mime_type": "audio/mp3", "data": "<base64>" } }
      ]
    }
  ]
}
```

- REST（JSON）では snake_case の `inline_data` / `mime_type` を使う
- JavaScript SDK では camelCase の `inlineData` / `mimeType`
- 本アプリは SDK を使わず fetch で直接叩くため **snake_case** を採用（公式RESTサンプル準拠）
- Gemini API は同一JSON内で camelCase も受け付けるが、公式RESTサンプルに合わせておくのが安全

### レスポンスからの本文取り出し

```
candidates[0].content.parts[*].text  ← これを連結する
```

`parts` が複数返る場合があるので、**1個目だけ取ると欠ける**ことがある。全部連結する。

---

## 3. 音声入力の制限（超重要）

**根拠:** https://ai.google.dev/gemini-api/docs/audio （"Input audio" / "Technical details about audio"）

| 項目 | 制限 |
|---|---|
| インライン送信の最大リクエストサイズ | **20MB**（テキスト・system instruction・ファイルすべて込み） |
| 20MBを超える場合 | **Files API** を使う（https://ai.google.dev/gemini-api/docs/files） |
| 対応MIMEタイプ | `audio/wav`, `audio/mp3`, `audio/aiff`, `audio/aac`, `audio/ogg`, `audio/flac` |
| 音声の最大長 | 単一プロンプトあたり合計 **9.5時間** |
| トークン換算 | 音声1秒 = 32トークン（1分 = 1,920トークン） |
| 前処理 | 16 Kbps にダウンサンプル。マルチチャンネルは1chに合成 |
| リアルタイム文字起こし | **generateContent では非対応**（Live API または Cloud Speech-to-Text） |

### 実装上の注意（ここでハマる）

1. **base64はサイズが約1.33倍に膨らむ。**
   20MBのファイルは base64 で約27MB になり 400 エラー。
   → 本アプリでは **元ファイル15MB** を上限のガードにしている（15MB × 1.33 ≒ 20MB）。
2. **`m4a` は公式リストに無い。** iPhoneのボイスメモは m4a なので、mp3 か wav に変換してから使う。
3. まずは **30秒〜2分の短い音声** で通す。長い音声はMVPが通ってから。

---

## 4. エラーの読み方

**根拠:** https://ai.google.dev/gemini-api/docs/troubleshooting

| コード | よくある原因 |
|---|---|
| 400 INVALID_ARGUMENT | リクエストJSONの形が違う / モデル名が存在しない / base64が壊れている・大きすぎる |
| 401・403 | APIキーが無効、コピー時に空白や改行が混入、キーの権限不足 |
| 404 | モデル名の綴り間違い（古いモデル名を指定したときもここ） |
| 429 RESOURCE_EXHAUSTED | 無料枠のレート上限。少し待つ（https://ai.google.dev/gemini-api/docs/rate-limits） |
| 500 / 503 | サーバー側。リトライ |

**切り分けの順番（公式トラブルシュートと同じ）**

1. テキストだけで `generateContent` が通るか → 通らなければ「キー or エンドポイント」の問題
2. 短い音声（30秒）で通るか → 通らなければ「MIME or base64 or サイズ」の問題
3. そこから要約・UIへ

本アプリには 1. を実行する **「接続テスト（テキストのみ）」ボタン** を実装済み。

---

## 5. CORS（ブラウザから直接叩けるか）

`https://generativelanguage.googleapis.com` はブラウザからの `fetch` を許可している（AI Studio の Web アプリが同じ方式）。
そのため **GitHub Pages（静的ホスティング）だけで完結** できる。

代償として **APIキーがブラウザに露出する**。
→ 自分専用の利用に限定する。不特定多数に配る場合はサーバー（Cloud Runなど）を挟んでキーを隠す必要がある。

---

## 6. 参照した公式URL一覧

- Models（モデル一覧・命名規則） https://ai.google.dev/gemini-api/docs/models
- Audio understanding（音声入力・制限・REST例） https://ai.google.dev/gemini-api/docs/audio
- Files API（20MB超のとき） https://ai.google.dev/gemini-api/docs/files
- File input methods https://ai.google.dev/gemini-api/docs/file-input-methods
- API troubleshooting https://ai.google.dev/gemini-api/docs/troubleshooting
- Rate limits https://ai.google.dev/gemini-api/docs/rate-limits
- API keys の取得 https://aistudio.google.com/apikey
