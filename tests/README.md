# tests/

`smoke.test.mjs` は、**APIキーを消費せずに** アプリのロジックを検証する自動テストです。
`fetch` をモックに差し替えて、Gemini API に送られる**リクエストの中身**を検証します。

## 実行

```bash
cd day5-lecture-audio-ai
npm install jsdom
node tests/smoke.test.mjs
```

## 検証している内容（44項目）

| # | 観点 |
|---|---|
| 1 | 起動時、結果・進捗カードが非表示 |
| 2 | APIキー保存時に前後の空白・改行を除去する（401の定番原因） |
| 3 | キーの表示／マスク切替 |
| 4 | **エンドポイントが `v1beta/models/{model}:generateContent`** |
| 4 | **認証が `x-goog-api-key` ヘッダ**（Bearer でも `?key=` でもない） |
| 5 | ファイル未選択時にAPIを呼ばずに止める |
| 6 | 音声が `inline_data` + base64 で送られる |
| 6 | **MIMEが `audio/mp3`**（ブラウザが返す `audio/mpeg` を公式表記に変換） |
| 6 | 講義名がプロンプトに反映される／文字起こしは `temperature: 0` |
| 6 | `parts` が複数返っても全部連結する |
| 6 | 要約時に音声を再送しない（テキストのみ送る＝無駄な通信をしない） |
| 6 | ` ```json ` で囲まれた応答をパースできる |
| 7 | `.m4a` を選ぶと警告し、APIを呼ばない |
| 8 | 15MB超でAPIを呼ばずに止める |
| 9 | HTTP 403 を日本語メッセージ＋レスポンス全文で表示する |
| 10 | 空レスポンス（`finishReason: SAFETY` 等）を検知する |
| 11 | JSONで返らなかった場合に箇条書きへフォールバックする |
| 12 | キー削除で localStorage から消える |

## 最終結果

```
PASS 44 / FAIL 0
```

> これは自動テストです。**合格判定に必要なスマホ実機テストは別途 `docs/TESTCASES.md` を実施**してください。
