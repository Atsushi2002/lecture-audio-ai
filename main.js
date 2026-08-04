/* =====================================================================
 * 講義音声ノートAI — main.js
 *
 * 公式ドキュメント（根拠）:
 *   モデル一覧 : https://ai.google.dev/gemini-api/docs/models
 *   音声理解   : https://ai.google.dev/gemini-api/docs/audio
 *   Files API  : https://ai.google.dev/gemini-api/docs/files
 *
 * 設計方針:
 *   1) 文字起こし と 要約 を別リクエストに分ける（どちらで失敗したか切り分けるため）
 *   2) 音声は inlineData（base64）で送る。合計リクエストは 20MB まで
 *   3) APIキーは localStorage のみ。コードに直書きしない
 * ===================================================================== */
'use strict';

// ---------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const STORAGE_KEY = 'lectureNoteAi.apiKey';
const STORAGE_MODEL = 'lectureNoteAi.model';

// 公式が対応を明記している音声MIME
// https://ai.google.dev/gemini-api/docs/audio  "Supported audio formats"
const EXT_TO_MIME = {
  wav:  'audio/wav',
  mp3:  'audio/mp3',
  aiff: 'audio/aiff',
  aif:  'audio/aiff',
  aac:  'audio/aac',
  ogg:  'audio/ogg',
  oga:  'audio/ogg',
  flac: 'audio/flac',
};

// inline送信は「リクエスト合計20MB」まで。base64は約1.33倍に膨らむので
// 元ファイルは 15MB を上限のガードにする（15 × 1.33 ≒ 20MB）。
const MAX_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------
// 要素の取得
// ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  apiKey: $('apiKey'),
  keyBadge: $('keyBadge'),
  keyMsg: $('keyMsg'),
  toggleKey: $('toggleKey'),
  saveKey: $('saveKey'),
  clearKey: $('clearKey'),
  testKey: $('testKey'),

  lectureName: $('lectureName'),
  audioFile: $('audioFile'),
  fileInfo: $('fileInfo'),
  model: $('model'),
  runBtn: $('runBtn'),
  cancelBtn: $('cancelBtn'),

  progressCard: $('progressCard'),
  step1: $('step1'),
  step2: $('step2'),
  bar: $('bar'),
  progressNote: $('progressNote'),

  errorCard: $('errorCard'),
  errorMsg: $('errorMsg'),
  errorDetailWrap: $('errorDetailWrap'),
  errorDetail: $('errorDetail'),

  summaryCard: $('summaryCard'),
  summaryText: $('summaryText'),
  pointsList: $('pointsList'),
  copySummary: $('copySummary'),

  transcriptCard: $('transcriptCard'),
  transcriptText: $('transcriptText'),
  transcriptMeta: $('transcriptMeta'),

  toast: $('toast'),
};

const FILE_HINT = el.fileInfo.textContent;
let abortController = null;

// ---------------------------------------------------------------------
// 小物ユーティリティ
// ---------------------------------------------------------------------

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function show(node) { node.hidden = false; }
function hide(node) { node.hidden = true; }

/** 対応していない環境でも落ちないようにガードしたスクロール */
function scrollToCard(node) {
  if (node && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/** クリップボードコピー（HTTPS以外・古いSafari向けのフォールバック付き） */
async function copyText(text) {
  if (!text || !text.trim()) { toast('コピーする内容がありません'); return; }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast('コピーしました');
  } catch (e) {
    toast('コピーできませんでした（手動で選択してください）');
  }
}

/** File → base64（大きいファイルでもスタックが溢れないようチャンク処理） */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        resolve(btoa(binary));
      } catch (e) {
        reject(new Error('ファイルのエンコードに失敗しました: ' + e.message));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** 拡張子から公式対応MIMEを決める（ブラウザのtypeは環境差が大きいため） */
function resolveMime(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  // 拡張子で判定できなければブラウザのMIMEを正規化して再挑戦
  const t = (file.type || '').toLowerCase();
  if (t === 'audio/mpeg' || t === 'audio/mp3') return 'audio/mp3';
  if (t === 'audio/x-wav' || t === 'audio/wave' || t === 'audio/wav') return 'audio/wav';
  if (t === 'audio/x-flac' || t === 'audio/flac') return 'audio/flac';
  if (t === 'audio/x-aiff' || t === 'audio/aiff') return 'audio/aiff';
  if (t === 'audio/aac' || t === 'audio/x-aac') return 'audio/aac';
  if (t === 'audio/ogg') return 'audio/ogg';
  return null;
}

// ---------------------------------------------------------------------
// APIキー管理
// ---------------------------------------------------------------------

function loadKey() {
  let saved = '';
  try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { /* プライベートモード等 */ }
  if (saved) {
    el.apiKey.value = saved;
    el.keyBadge.textContent = '保存済み';
    el.keyBadge.classList.add('on');
  } else {
    el.keyBadge.textContent = '未設定';
    el.keyBadge.classList.remove('on');
  }
  try {
    const m = localStorage.getItem(STORAGE_MODEL);
    if (m) el.model.value = m;
  } catch (e) { /* noop */ }
}

/** 前後の空白・改行を除去して取得（コピペ時の空白混入が401の定番原因） */
function currentKey() {
  return el.apiKey.value.replace(/\s+/g, '');
}

function keyMsg(text, ng) {
  el.keyMsg.textContent = text;
  el.keyMsg.classList.toggle('ng', !!ng);
  show(el.keyMsg);
}

el.saveKey.addEventListener('click', () => {
  const key = currentKey();
  if (!key) { keyMsg('APIキーが空です', true); el.apiKey.focus(); return; }
  try {
    localStorage.setItem(STORAGE_KEY, key);
    el.apiKey.value = key;
    el.keyBadge.textContent = '保存済み';
    el.keyBadge.classList.add('on');
    keyMsg('この端末に保存しました（外部には送信していません）', false);
  } catch (e) {
    keyMsg('保存できませんでした。ブラウザのプライベートモードでは保存されません', true);
  }
});

el.clearKey.addEventListener('click', () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
  el.apiKey.value = '';
  el.keyBadge.textContent = '未設定';
  el.keyBadge.classList.remove('on');
  keyMsg('削除しました', false);
});

el.toggleKey.addEventListener('click', () => {
  const isHidden = el.apiKey.type === 'password';
  el.apiKey.type = isHidden ? 'text' : 'password';
  el.toggleKey.textContent = isHidden ? '隠す' : '表示';
});

el.model.addEventListener('change', () => {
  try { localStorage.setItem(STORAGE_MODEL, el.model.value); } catch (e) { /* noop */ }
});

// ---------------------------------------------------------------------
// Gemini API 呼び出し
// ---------------------------------------------------------------------

/**
 * generateContent を叩く。
 * 公式REST例:
 *   POST {API_BASE}/{model}:generateContent
 *   Header: x-goog-api-key: <KEY>
 *   Body:   { "contents":[ { "parts":[ ... ] } ] }
 */
async function generateContent({ model, apiKey, parts, temperature, signal }) {
  const body = {
    contents: [{ parts }],
  };
  if (typeof temperature === 'number') {
    body.generation_config = { temperature };
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(
      '通信に失敗しました。ネットワーク接続を確認してください。',
      String(e && e.message ? e.message : e)
    );
  }

  const raw = await res.text();

  if (!res.ok) {
    throw new ApiError(httpMessage(res.status), `HTTP ${res.status} ${res.statusText}\n\n${raw}`);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ApiError('レスポンスがJSONとして読めませんでした。', raw);
  }

  // candidates[0].content.parts[*].text をすべて連結する
  // （parts が複数返ることがあり、1個目だけ取ると本文が欠ける）
  const cand = json.candidates && json.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.map((p) => p.text || '').join('').trim()
    : '';

  if (!text) {
    const reason = (cand && cand.finishReason) || (json.promptFeedback && json.promptFeedback.blockReason) || '不明';
    throw new ApiError(
      `AIから本文が返りませんでした（理由: ${reason}）。音声が無音・短すぎる、または安全性フィルタの可能性があります。`,
      JSON.stringify(json, null, 2)
    );
  }
  return text;
}

class ApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail || '';
  }
}

/** HTTPステータスを人間の言葉に（docs/API_NOTES.md の表と対応） */
function httpMessage(status) {
  if (status === 400) return 'リクエストが不正です（400）。モデル名・JSON形式・音声サイズを確認してください。';
  if (status === 401 || status === 403) return 'APIキーが無効か権限がありません（' + status + '）。キーの前後に空白が入っていないか確認してください。';
  if (status === 404) return 'モデルが見つかりません（404）。公式Models一覧にあるモデル名か確認してください。';
  if (status === 413) return '送信データが大きすぎます（413）。もっと短い音声で試してください。';
  if (status === 429) return 'レート上限に達しました（429）。少し待ってから再実行してください。';
  if (status >= 500) return 'Google側のサーバーエラーです（' + status + '）。少し待って再実行してください。';
  return 'APIエラーが発生しました（HTTP ' + status + '）。';
}

// ---------------------------------------------------------------------
// プロンプト
// ---------------------------------------------------------------------

function transcribePrompt(lectureName) {
  return [
    'あなたは日本語の講義音声を文字起こしする書記です。',
    lectureName ? `この音声は「${lectureName}」という講義の録音です。` : '',
    '',
    '次のルールで、音声の発話内容を文字起こししてください。',
    '1. 話された内容を省略せず、全文をそのまま書き起こす。',
    '2. 「えー」「あのー」などのフィラーは削り、読みやすい文にする。',
    '3. 話題が変わるところで改行して段落を分ける。',
    '4. 聞き取れない箇所は [聞き取れず] と書く。',
    '5. 要約や感想、前置き、見出しは書かない。文字起こし本文だけを出力する。',
  ].filter(Boolean).join('\n');
}

function summarizePrompt(lectureName, transcript) {
  return [
    'あなたは大学生の学習を助けるノート作成アシスタントです。',
    '次の講義の文字起こしを読み、日本語で要約してください。',
    '',
    '出力は、余計な説明やコードブロック記号を付けず、次のJSONだけを返してください。',
    '{"summary": "3行程度の要約", "points": ["要点1", "要点2", "要点3"]}',
    '',
    '制約:',
    '- summary は3行程度（150〜250字目安）。専門用語はそのまま残す。',
    '- points は3〜5個。各40字以内。試験に出そうな要点を優先する。',
    '- 文字起こしに書かれていないことは書かない（推測しない）。',
    '',
    lectureName ? `講義名: ${lectureName}` : '講義名: （未入力）',
    '',
    '--- 文字起こし ここから ---',
    transcript,
    '--- 文字起こし ここまで ---',
  ].join('\n');
}

/** モデルが ```json ... ``` で包んでくることがあるので、寛容にパースする */
function parseSummaryJson(text) {
  let s = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const tryParse = (str) => {
    try {
      const o = JSON.parse(str);
      if (o && typeof o === 'object') return o;
    } catch (e) { /* noop */ }
    return null;
  };

  let obj = tryParse(s);
  if (!obj) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) obj = tryParse(s.slice(start, end + 1));
  }

  if (obj) {
    return {
      summary: String(obj.summary || '').trim(),
      points: Array.isArray(obj.points) ? obj.points.map((p) => String(p).trim()).filter(Boolean) : [],
    };
  }

  // JSONで返らなかった場合のフォールバック：箇条書き行を要点として拾う
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-*・•]|^\d+[.)]/.test(l))
                       .map((l) => l.replace(/^[-*・•]\s*|^\d+[.)]\s*/, ''));
  const body = lines.filter((l) => !/^[-*・•]|^\d+[.)]/.test(l)).join('\n');
  return { summary: body || s, points: bullets };
}

// ---------------------------------------------------------------------
// 画面制御
// ---------------------------------------------------------------------

function setStep(step) {
  const map = { 1: el.step1, 2: el.step2 };
  [el.step1, el.step2].forEach((n) => n.classList.remove('active', 'done'));
  for (let i = 1; i < step; i++) map[i].classList.add('done');
  if (map[step]) map[step].classList.add('active');
  el.bar.style.width = ({ 1: '35%', 2: '75%', 3: '100%' })[step] || '0%';
}

function showError(message, detail) {
  el.errorMsg.textContent = message;
  if (detail) {
    el.errorDetail.textContent = detail;
    show(el.errorDetailWrap);
  } else {
    hide(el.errorDetailWrap);
  }
  show(el.errorCard);
  scrollToCard(el.errorCard);
}

function resetOutputs() {
  hide(el.errorCard);
  hide(el.summaryCard);
  hide(el.transcriptCard);
  el.pointsList.innerHTML = '';
  el.summaryText.textContent = '';
  el.transcriptText.textContent = '';
}

function setBusy(busy) {
  el.runBtn.disabled = busy;
  el.testKey.disabled = busy;
  el.runBtn.textContent = busy ? '実行中…' : '文字起こし＆要約を実行';
  el.cancelBtn.hidden = !busy;
  el.progressCard.hidden = !busy;
}

// ファイル選択時の即時チェック（実行してから怒られるのは体験が悪い）
el.audioFile.addEventListener('change', () => {
  const file = el.audioFile.files && el.audioFile.files[0];
  if (!file) { el.fileInfo.textContent = FILE_HINT; return; }
  const mime = resolveMime(file);
  const size = formatSize(file.size);
  if (!mime) {
    el.fileInfo.textContent =
      `⚠️ ${file.name}（${size}）は対応外の形式かもしれません。wav / mp3 / aac / ogg / flac / aiff を選んでください。`;
  } else if (file.size > MAX_BYTES) {
    el.fileInfo.textContent =
      `⚠️ ${file.name}（${size}）は大きすぎます。15MB以下（30秒〜数分）に切ってください。`;
  } else {
    el.fileInfo.textContent = `✅ ${file.name}（${size} / ${mime}）`;
  }
});

// ---------------------------------------------------------------------
// 接続テスト（公式トラブルシュートの「まずテキストだけで通す」）
// ---------------------------------------------------------------------

el.testKey.addEventListener('click', async () => {
  const apiKey = currentKey();
  if (!apiKey) { keyMsg('APIキーを入力してください', true); el.apiKey.focus(); return; }

  hide(el.errorCard);
  el.testKey.disabled = true;
  el.testKey.textContent = 'テスト中…';
  try {
    const text = await generateContent({
      model: el.model.value,
      apiKey,
      parts: [{ text: 'OKとだけ返してください。' }],
    });
    keyMsg(`接続OK（${el.model.value} の応答: ${text.slice(0, 30)}）`, false);
  } catch (e) {
    keyMsg('接続に失敗しました。下のエラー詳細を確認してください。', true);
    showError(e.message, e.detail);
  } finally {
    el.testKey.disabled = false;
    el.testKey.textContent = '接続テスト';
  }
});

// ---------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------

el.cancelBtn.addEventListener('click', () => {
  if (abortController) abortController.abort();
});

el.runBtn.addEventListener('click', async () => {
  const apiKey = currentKey();
  const file = el.audioFile.files && el.audioFile.files[0];
  const lectureName = el.lectureName.value.trim();
  const model = el.model.value;

  resetOutputs();

  // --- 入力チェック ---
  if (!apiKey) {
    showError('APIキーを入力してください。「1. APIキー」の欄に入力して「この端末に保存」を押してください。');
    el.apiKey.focus();
    return;
  }
  if (!file) {
    showError('音声ファイルを選択してください。');
    el.audioFile.focus();
    return;
  }
  const mime = resolveMime(file);
  if (!mime) {
    showError(
      'この形式には対応していません。wav / mp3 / aac / ogg / flac / aiff を選んでください。' +
      '（iPhoneのボイスメモは .m4a なので、mp3 か wav に変換してください）',
      `選択されたファイル: ${file.name}\nブラウザが判定したMIME: ${file.type || '(不明)'}\n` +
      '公式の対応形式: https://ai.google.dev/gemini-api/docs/audio'
    );
    return;
  }
  if (file.size > MAX_BYTES) {
    showError(
      `ファイルが大きすぎます（${formatSize(file.size)}）。インライン送信はリクエスト合計20MBまでで、` +
      'base64化で約1.33倍になるため15MB以下にしてください。まずは30秒〜2分の音声で試してください。',
      '根拠: https://ai.google.dev/gemini-api/docs/audio （"The maximum request size is 20 MB"）'
    );
    return;
  }

  abortController = new AbortController();
  const signal = abortController.signal;
  setBusy(true);

  try {
    // ---------- STEP 1: 文字起こし ----------
    setStep(1);
    el.progressNote.textContent = '音声を読み込んでいます…';
    const base64 = await fileToBase64(file);

    el.progressNote.textContent =
      `音声を送信して文字起こし中です（${formatSize(file.size)}）。長さに応じて数十秒かかります…`;

    const transcript = await generateContent({
      model,
      apiKey,
      signal,
      temperature: 0,   // 文字起こしは創作させない
      parts: [
        { text: transcribePrompt(lectureName) },
        { inline_data: { mime_type: mime, data: base64 } },
      ],
    });

    el.transcriptText.textContent = transcript;
    el.transcriptMeta.textContent =
      `${lectureName || '（講義名なし）'} ／ ${file.name} ／ ${model} ／ 約${transcript.length}文字`;
    show(el.transcriptCard);

    // ---------- STEP 2: 要約 ----------
    setStep(2);
    el.progressNote.textContent = '文字起こしを元に要約しています…';

    const summaryRaw = await generateContent({
      model,
      apiKey,
      signal,
      temperature: 0.2,
      parts: [{ text: summarizePrompt(lectureName, transcript) }],
    });

    const { summary, points } = parseSummaryJson(summaryRaw);
    el.summaryText.textContent = summary || '(要約が取得できませんでした)';
    el.pointsList.innerHTML = '';
    points.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p;
      el.pointsList.appendChild(li);
    });
    show(el.summaryCard);

    setStep(3);
    el.progressNote.textContent = '完了しました';
    scrollToCard(el.summaryCard);
    toast('完了しました');

  } catch (e) {
    if (e.name === 'AbortError') {
      toast('キャンセルしました');
    } else if (e instanceof ApiError) {
      showError(e.message, e.detail);
    } else {
      showError(e.message || '予期しないエラーが発生しました', String(e && e.stack ? e.stack : e));
    }
  } finally {
    abortController = null;
    setBusy(false);
  }
});

// ---------------------------------------------------------------------
// コピーボタン
// ---------------------------------------------------------------------

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.copy);
    copyText(target ? target.textContent : '');
  });
});

el.copySummary.addEventListener('click', () => {
  const name = el.lectureName.value.trim();
  const points = Array.from(el.pointsList.querySelectorAll('li')).map((li) => '・' + li.textContent);
  const text = [
    name ? `【${name}】` : '【講義ノート】',
    '',
    '■ 要約',
    el.summaryText.textContent,
    '',
    '■ 要点',
    points.join('\n'),
  ].join('\n');
  copyText(text);
});

// ---------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------

loadKey();
