'use strict';

/**
 * 通过 Node 的 fetch 流式下载 Electron 二进制。
 * 这个环境里 PowerShell/curl 的 schannel 取不到凭据，而 Node 的 TLS 栈正常，
 * 所以二进制下载必须走 Node。
 *
 * 用法: node scripts/_get-electron.js <url> <dest.zip>
 */

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function main() {
  const url = process.argv[2] || 'https://npmmirror.com/mirrors/electron/44.4.3/electron-v44.4.3-win32-x64.zip';
  const dest = process.argv[3] || path.join(__dirname, '..', '.electron-cache', path.basename(new URL(url).pathname));
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024 * 1024) {
    console.log(`already downloaded: ${dest} (${fs.statSync(dest).size} bytes)`);
    return;
  }

  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') || 0);

  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (received - lastReport > 20 * 1024 * 1024) {
      lastReport = received;
      const percent = total ? ((received / total) * 100).toFixed(1) : '?';
      console.log(`  ${percent}%  ${(received / 1024 / 1024).toFixed(1)} MB`);
    }
  });

  await pipeline(body, fs.createWriteStream(dest));
  console.log(`done: ${dest} (${fs.statSync(dest).size} bytes)`);
}

main().catch((error) => {
  console.error('download failed:', error.message);
  process.exit(1);
});