import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync('index.html','utf8');
const js   = fs.readFileSync('main.js','utf8');

// --- 呼ばれたリクエストを記録するモックfetch ---
const calls = [];
const responses = [];

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
const w = dom.window;
w.fetch = async (url, opts) => {
  calls.push({ url, opts });
  const r = responses.shift();
  return {
    ok: r.status < 400, status: r.status, statusText: r.statusText || '',
    text: async () => r.body,
  };
};
w.navigator.clipboard = { writeText: async () => {} };
w.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
// FileReader stub
class FR {
  readAsArrayBuffer(file){ this.result = file._buf; setTimeout(()=>this.onload(),0); }
}
w.FileReader = FR;

let pass = 0, fail = 0;
const t = (name, cond, extra='') => { if(cond){pass++;console.log('  ✅',name);} else {fail++;console.log('  ❌',name,extra);} };

w.eval(js);
const d = w.document;

console.log('--- 1. 起動時の状態 ---');
t('キーバッジ=未設定', d.getElementById('keyBadge').textContent === '未設定');
t('進捗カードは非表示', d.getElementById('progressCard').hidden);
t('結果カードは非表示', d.getElementById('summaryCard').hidden && d.getElementById('transcriptCard').hidden);

console.log('--- 2. APIキー保存（空白混入を除去できるか） ---');
d.getElementById('apiKey').value = '  AIzaTESTKEY_12345 \n';
d.getElementById('saveKey').click();
t('localStorageに空白なしで保存', w.localStorage.getItem('lectureNoteAi.apiKey') === 'AIzaTESTKEY_12345',
   w.localStorage.getItem('lectureNoteAi.apiKey'));
t('バッジ=保存済み', d.getElementById('keyBadge').textContent === '保存済み');

console.log('--- 3. 表示切替 ---');
d.getElementById('toggleKey').click();
t('type=text になる', d.getElementById('apiKey').type === 'text');
d.getElementById('toggleKey').click();
t('type=password に戻る', d.getElementById('apiKey').type === 'password');

console.log('--- 4. 接続テスト（テキストのみ） ---');
responses.push({status:200, body: JSON.stringify({candidates:[{content:{parts:[{text:'OK'}]}}]})});
d.getElementById('testKey').click();
await new Promise(r=>setTimeout(r,50));
const c0 = calls[0];
t('エンドポイントが公式形式', c0.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', c0.url);
t('x-goog-api-key ヘッダ', c0.opts.headers['x-goog-api-key'] === 'AIzaTESTKEY_12345');
t('Bearerを使っていない', !c0.opts.headers['Authorization']);
t('URLにkeyクエリを付けていない', !c0.url.includes('key='));
t('接続OKメッセージ', d.getElementById('keyMsg').textContent.includes('接続OK'), d.getElementById('keyMsg').textContent);

console.log('--- 5. 入力バリデーション ---');
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,10));
t('ファイル未選択でエラー', d.getElementById('errorMsg').textContent.includes('音声ファイルを選択'), d.getElementById('errorMsg').textContent);
t('APIは呼ばれていない', calls.length === 1);

console.log('--- 6. 音声の本処理（mp3） ---');
const buf = new Uint8Array([1,2,3,4,5,6,7,8]);
const file = { name:'lecture.mp3', size: buf.length, type:'audio/mpeg', _buf: buf };
Object.defineProperty(d.getElementById('audioFile'), 'files', { value:[file], configurable:true });
d.getElementById('audioFile').dispatchEvent(new w.Event('change'));
t('選択時に✅表示', d.getElementById('fileInfo').textContent.includes('audio/mp3'), d.getElementById('fileInfo').textContent);

d.getElementById('lectureName').value = '情報理論 第5回';
responses.push({status:200, body: JSON.stringify({candidates:[{content:{parts:[{text:'本日は'},{text:'エントロピーについて説明します。'}]}}]})});
responses.push({status:200, body: JSON.stringify({candidates:[{content:{parts:[{text:'```json\n{"summary":"エントロピーの定義を扱った。","points":["定義","単位はビット","符号化との関係"]}\n```'}]}}]})});
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,120));

const body1 = JSON.parse(calls[1].opts.body);
const parts1 = body1.contents[0].parts;
t('文字起こしリクエストにinline_data', !!parts1[1].inline_data);
t('mime_typeがaudio/mp3（audio/mpegでない）', parts1[1].inline_data.mime_type === 'audio/mp3', parts1[1].inline_data.mime_type);
t('base64が入っている', parts1[1].inline_data.data === Buffer.from(buf).toString('base64'));
t('講義名がプロンプトに入る', parts1[0].text.includes('情報理論 第5回'));
t('temperature=0', body1.generation_config.temperature === 0);

t('parts複数を連結して表示', d.getElementById('transcriptText').textContent === '本日はエントロピーについて説明します。', d.getElementById('transcriptText').textContent);
t('文字起こしカード表示', !d.getElementById('transcriptCard').hidden);

const body2 = JSON.parse(calls[2].opts.body);
t('要約は文字起こしテキストを送る（音声は再送しない）', body2.contents[0].parts.length===1 && !body2.contents[0].parts[0].inline_data);
t('要約プロンプトに文字起こし本文', body2.contents[0].parts[0].text.includes('エントロピーについて説明します'));

t('```json 囲みをパースできる', d.getElementById('summaryText').textContent === 'エントロピーの定義を扱った。', d.getElementById('summaryText').textContent);
t('要点3件', d.getElementById('pointsList').children.length === 3);
t('要約カード表示', !d.getElementById('summaryCard').hidden);
t('進捗カードは閉じた', d.getElementById('progressCard').hidden);
t('エラーは出ていない', d.getElementById('errorCard').hidden);

console.log('--- 7. 非対応形式 m4a ---');
const m4a = { name:'voice.m4a', size:1000, type:'audio/mp4', _buf:new Uint8Array([1]) };
Object.defineProperty(d.getElementById('audioFile'),'files',{value:[m4a],configurable:true});
d.getElementById('audioFile').dispatchEvent(new w.Event('change'));
t('選択時に⚠️警告', d.getElementById('fileInfo').textContent.includes('対応外'), d.getElementById('fileInfo').textContent);
const before = calls.length;
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,20));
t('m4aでエラー表示', d.getElementById('errorMsg').textContent.includes('対応していません'));
t('APIを呼ばずに止める', calls.length === before);

console.log('--- 8. サイズ超過 ---');
const big = { name:'long.mp3', size: 20*1024*1024, type:'audio/mpeg', _buf:new Uint8Array([1]) };
Object.defineProperty(d.getElementById('audioFile'),'files',{value:[big],configurable:true});
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,20));
t('サイズ超過エラー', d.getElementById('errorMsg').textContent.includes('大きすぎます'));
t('APIを呼ばずに止める', calls.length === before);

console.log('--- 9. HTTPエラーの表示 ---');
Object.defineProperty(d.getElementById('audioFile'),'files',{value:[file],configurable:true});
responses.push({status:403, statusText:'Forbidden', body:'{"error":{"code":403,"message":"API key not valid"}}'});
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,80));
t('403の日本語メッセージ', d.getElementById('errorMsg').textContent.includes('APIキーが無効'), d.getElementById('errorMsg').textContent);
t('レスポンス全文を詳細に表示', d.getElementById('errorDetail').textContent.includes('API key not valid'));
t('詳細セクションが開ける', !d.getElementById('errorDetailWrap').hidden);
t('ボタンが復帰', d.getElementById('runBtn').disabled === false);

console.log('--- 10. 空レスポンス ---');
responses.push({status:200, body: JSON.stringify({candidates:[{content:{parts:[]},finishReason:'SAFETY'}]})});
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,80));
t('空レスポンスを検知', d.getElementById('errorMsg').textContent.includes('本文が返りませんでした'), d.getElementById('errorMsg').textContent);
t('finishReasonを表示', d.getElementById('errorMsg').textContent.includes('SAFETY'));

console.log('--- 11. JSONで返らなかった場合のフォールバック ---');
responses.push({status:200, body: JSON.stringify({candidates:[{content:{parts:[{text:'テスト'}]}}]})});
responses.push({status:200, body: JSON.stringify({candidates:[{content:{parts:[{text:'この講義はエントロピーの話でした。\n- 定義\n- 単位\n- 応用'}]}}]})});
d.getElementById('runBtn').click();
await new Promise(r=>setTimeout(r,80));
t('本文を要約として拾う', d.getElementById('summaryText').textContent.includes('エントロピーの話'), d.getElementById('summaryText').textContent);
t('箇条書きを要点として拾う', d.getElementById('pointsList').children.length === 3, d.getElementById('pointsList').children.length);

console.log('--- 12. キー削除 ---');
d.getElementById('clearKey').click();
t('localStorageから消える', w.localStorage.getItem('lectureNoteAi.apiKey') === null);
t('バッジ=未設定', d.getElementById('keyBadge').textContent === '未設定');

console.log('\n============================');
console.log(`PASS ${pass} / FAIL ${fail}`);
console.log('============================');
process.exit(fail ? 1 : 0);
