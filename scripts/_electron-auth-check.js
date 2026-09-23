'use strict';

/**
 * 对照实验：主进程 session.fetch 与隐藏窗口导航，谁能把 dsh-auth cookie 变成可用会话。
 * 使用临时 DSH_HOME 和内存 partition，不碰正在运行的桌面端数据。
 */

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('../src/main/harness');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-electron-auth-'));
app.setPath('userData', userData);

const PARTITION = 'dsh-auth-check';

function cookieNames(cookies) {
  return cookies.map((cookie) => cookie.name).filter((name) => name.startsWith('dsh-auth-'));
}

function navigate(ses, target) {
  const navigationUrl = harness.coerceNavigationUrl(target);
  return new Promise((resolve) => {
    if (!navigationUrl) {
      resolve({ loaded: false, body: '' });
      return;
    }
    const hidden = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const finish = async (loaded) => {
      if (done) return;
      done = true;
      let body = '';
      try {
        body = await hidden.webContents.executeJavaScript(
          "(document.body && document.body.innerText || '').trim().slice(0, 180)",
        );
      } catch {
        body = '';
      }
      if (!hidden.isDestroyed()) hidden.destroy();
      resolve({ loaded, body });
    };
    hidden.webContents.on('did-fail-load', (_event, errorCode, _description, _validatedURL, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return;
      finish(false);
    });
    hidden.webContents.once('did-finish-load', () => finish(true));
    setTimeout(() => finish(false), 20_000);
    hidden.loadURL(navigationUrl).catch(() => finish(false));
  });
}

app.whenReady().then(async () => {
  const report = { steps: [] };
  const out = path.join(harness.app_root(), 'artifacts', 'electron-auth-check.json');
  const dsh = harness.locateDsh();
  if (!dsh) {
    report.result = 'FAIL';
    report.error = 'dsh not found';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    app.exit(1);
    return;
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-auth-'));
  const ses = session.fromPartition(PARTITION);
  const logs = [];
  const { child, ready } = harness.launchHarness({
    command: dsh,
    workspace: harness.app_root(),
    dshHome: tmpHome,
    port: 0,
    onLog(chunk) {
      const line = String(chunk).trim();
      if (line) logs.push(line.slice(0, 300));
    },
  });
  report.logs = logs;
  let code = 1;
  try {
    const url = await ready;
    const base = harness.baseUrlOf(url);
    report.base = base;

    const fetchStep = { name: 'session.fetch' };
    try {
      const fetched = await ses.fetch(url.href, { redirect: 'manual' });
      fetchStep.manualStatus = fetched.status;
    } catch (error) {
      fetchStep.manualError = String(error && error.message ? error.message : error);
    }
    fetchStep.cookiesAfterManual = cookieNames(await ses.cookies.get({ url: base }));
    await ses.clearStorageData({ storages: ['cookies'] });
    try {
      const followed = await ses.fetch(url.href, { redirect: 'follow' });
      fetchStep.followStatus = followed.status;
    } catch (error) {
      fetchStep.followError = String(error && error.message ? error.message : error);
    }
    fetchStep.cookiesAfterFollow = cookieNames(await ses.cookies.get({ url: base }));
    try {
      const probe = await ses.fetch(base + '/', { redirect: 'manual' });
      fetchStep.probeStatus = probe.status;
    } catch (error) {
      fetchStep.probeError = String(error && error.message ? error.message : error);
    }
    report.steps.push(fetchStep);

    await ses.clearStorageData({ storages: ['cookies'] });

    const exchanged = await navigate(ses, url.href);
    const afterWindow = cookieNames(await ses.cookies.get({ url: base }));
    const page = await navigate(ses, base + '/');
    const probeAgain = await ses.fetch(base + '/', { redirect: 'manual' });
    report.steps.push({
      name: 'hidden-window',
      windowLoaded: exchanged.loaded,
      windowBody: exchanged.body,
      cookiesAfterWindow: afterWindow,
      rootLoaded: page.loaded,
      rootBody: page.body,
      probeAfterWindow: probeAgain.status,
    });

    const pass = afterWindow.length > 0
      && page.loaded
      && !String(page.body).includes('dsh web authentication required');
    report.result = pass ? 'PASS' : 'FAIL';
    code = pass ? 0 : 1;
  } catch (error) {
    report.result = 'FAIL';
    report.error = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  } finally {
    harness.killChildTree(child);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    setTimeout(() => {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
      app.exit(code);
    }, 400);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
