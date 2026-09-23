'use strict';

/**
 * 端到端鉴权协议测试（不依赖 Electron，也不碰正在运行的 harness）：
 *
 * 1. 用独立的临时 DSH_HOME 拉起一个 `dsh web --no-open --port 0` 实例；
 * 2. 从启动日志解析带 token 的登录地址；
 * 3. 请求该地址，取出 Set-Cookie；
 * 4. 带 Cookie 请求根地址，期望 200（授权成功）；
 * 5. 不带 Cookie 请求根地址，期望 401（鉴权确实生效）；
 * 6. 关停实例。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const child_process = require('node:child_process');
const harness = require('../src/main/harness');

(async () => {
  const dsh = harness.locateDsh();
  if (!dsh) throw new Error('dsh 未找到');

  // 临时数据目录，绝不影响正在运行的 harness / 真实 ~/.dsh
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-auth-'));
  const out = [];

  const { child, ready } = harness.launchHarness({
    command: dsh,
    workspace: process.cwd(),
    dshHome: tmpHome,
    port: 0,
    onLog(chunk) {
      const line = String(chunk).trim();
      if (line) out.push(line.slice(0, 160));
    },
  });

  try {
    const url = await ready;
    out.push(`[1] parsed auth url: ${url.href}`);

    const cookieRes = await fetch(url.href, { redirect: 'manual' });
    const setCookie = cookieRes.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    out.push(`[2] token exchange status=${cookieRes.status}, cookie=${cookie.split('=')[0]}=…`);

    if (cookieRes.status !== 303 || !cookie) throw new Error('token 换签失败：未返回 303/Set-Cookie');

    const authorized = await fetch(`${url.origin}/`, {
      headers: cookie ? { cookie } : {},
      redirect: 'manual',
    });
    out.push(`[3] with cookie: root status=${authorized.status}`);

    const blocked = await fetch(`${url.origin}/`, { redirect: 'manual' });
    out.push(`[4] without cookie: root status=${blocked.status}`);

    const pass = authorized.status === 200 && blocked.status === 401;
    out.push(`[5] RESULT=${pass ? 'PASS' : 'FAIL'}`);
    console.log(out.join('\n'));
    process.exitCode = pass ? 0 : 1;
  } catch (error) {
    out.push(`[x] ERROR ${error.message}`);
    console.log(out.join('\n'));
    process.exitCode = 1;
  } finally {
    try {
      if (process.platform === 'win32' && child.pid) {
        child_process.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch {
      /* 忽略 */
    }
    setTimeout(() => {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }, 1500);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});