// 依存なしの簡易チェック：サーバーと画面内スクリプトの構文、favicon の存在
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['--check', 'server.mjs'], { stdio: 'inherit' });

const html = readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) throw new Error('index.html に <script> が見つかりません');
for (const js of scripts) new Function(js);

if (!existsSync('public/favicon.svg')) throw new Error('public/favicon.svg がありません');
console.log('ok');
