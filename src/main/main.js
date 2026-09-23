'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  dialog,
  session,
  clipboard,
  nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const harness = require('./harness');
const sessionsMod = require('./sessions');

const PARTITION = 'persist:dsh-desktop';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const isSelftest = process.argv.includes('--selftest');
const isDebug = process.argv.includes('--debug');

const state = {
  connected: false,
  baseUrl: '',
  reason: '',
  launching: false,
  childPid: null,
  childReady: false,
};

let win = null;
let tray = null;
let harnessChild = null;
let watchdogTimer = null;
let statusSink = null; // 当前主窗口 webContents

/* ------------------------------------------------------------------ */
/*  基础工具                                                            */
/* ------------------------------------------------------------------ */

function getSes() {
  return session.fromPartition(PARTITION);
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  }
}

function safeSend(contents, channel, payload) {
  if (!contents || contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch (error) {
    diagLog('safeSend', error?.message || String(error));
  }
}

function pushStatus(extra = {}) {
  safeSend(statusSink, 'dsh:status', { ...snapshotStatus(), ...extra });
  updateTrayTooltip();
  scheduleTrayRefresh();
}

function snapshotStatus() {
  const cfg = config.load();
  const foundDsh = harness.locateDsh(cfg.dshCommand);
  return {
    connected: state.connected,
    baseUrl: state.baseUrl || cfg.baseUrl,
    reason: state.reason,
    launching: state.launching,
    childPid: state.childPid,
    childReady: state.childReady,
    workspace: cfg.workspace,
    dshHome: cfg.dshHome,
    dshCommand: cfg.dshCommand,
    port: cfg.port,
    alwaysOnTop: cfg.alwaysOnTop,
    dshFound: foundDsh !== undefined,
    defaultDsh: foundDsh || '',
  };
}

/* ------------------------------------------------------------------ */
/*  探测与鉴权                                                          */
/* ------------------------------------------------------------------ */

async function probeAuthorized(baseUrl) {
  if (!baseUrl) return { listening: false, authorized: false };
  try {
    const response = await getSes().fetch(`${baseUrl}/`, {
      method: 'GET',
      redirect: 'manual',
    });
    return {
      listening: true,
      status: response.status,
      authorized: response.status === 200 || response.status === 303,
    };
  } catch (error) {
    return { listening: false, authorized: false, error: String(error?.message ?? error) };
  }
}

/** dsh 浏览器会话 cookie。名字是 `dsh-auth-` + authority 的哈希，属性为 SameSite=Strict。 */
const AUTH_COOKIE_PREFIX = 'dsh-auth-';

async function hasAuthCookie(baseUrl) {
  if (!baseUrl) return false;
  try {
    const cookies = await getSes().cookies.get({ url: baseUrl });
    const now = Date.now() / 1000;
    return cookies.some((cookie) => (
      cookie.name.startsWith(AUTH_COOKIE_PREFIX)
      && (cookie.expirationDate == null || cookie.expirationDate > now)
    ));
  } catch {
    return false;
  }
}

/**
 * 主进程 `session.fetch` 没有文档站点，Chromium 不会附带 SameSite=Strict 的
 * `dsh-auth-*`。因此 401 不能单独当成「未授权」：cookie 已在 session 里时，
 * 真正的窗口导航仍然能进。
 */
async function sessionAuthorized(baseUrl) {
  const probe = await probeAuthorized(baseUrl);
  if (probe.authorized || !probe.listening) return probe;
  if (await hasAuthCookie(baseUrl)) return { ...probe, authorized: true, via: 'cookie' };
  return probe;
}

async function pageRequiresAuth() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const text = (document.body && document.body.innerText || '').trim();
      return text.length < 400 && text.includes('dsh web authentication required');
    })()`);
  } catch {
    return false;
  }
}

async function finishAuthorized(baseUrl, token) {
  config.save({ baseUrl, lastToken: token || config.load().lastToken });
  await loadRemote();
  if (await pageRequiresAuth()) {
    state.connected = false;
    state.reason = `${baseUrl} 在运行，但未授权（需要带 token 的地址）`;
    showShell();
    pushStatus();
    return { ok: false, reason: 'unauthorized' };
  }
  state.connected = true;
  state.reason = '';
  pushStatus();
  return { ok: true };
}

/**
 * 连接目标地址。带 token 时先用隐藏窗口做一次真实导航，让 SameSite=Strict
 * 的 `dsh-auth-*` 落进桌面端自己的 session；之后主窗口加载根地址会自动带上。
 * @param {string} input
 */
async function connectTo(input) {
  const url = harness.normalizeInput(input);
  if (url === undefined) {
    state.reason = '地址无法解析';
    pushStatus();
    return { ok: false, reason: 'bad-url' };
  }
  const baseUrl = harness.baseUrlOf(url);
  const token = url.searchParams.get('token') || '';
  state.baseUrl = baseUrl;
  state.connected = false;

  if (harness.hasLaunchToken(url)) {
    await exchangeViaWindow(url.href);
  }

  let auth = await sessionAuthorized(baseUrl);
  if (!auth.authorized && harness.hasLaunchToken(url)) {
    // 窗口没换到 cookie 时再走一遍 manual，避免 follow 把 303 上的 Set-Cookie 丢掉。
    try {
      await getSes().fetch(url.href, { redirect: 'manual' });
    } catch (error) {
      if (!auth.listening) {
        state.reason = `无法连接 ${baseUrl}（${error?.message ?? error}）`;
        config.save({ baseUrl, lastToken: token });
        pushStatus();
        return { ok: false, reason: 'unreachable' };
      }
    }
    auth = await sessionAuthorized(baseUrl);
  }

  if (auth.authorized) return finishAuthorized(baseUrl, token);

  state.reason = auth.listening
    ? `${baseUrl} 在运行，但未授权（需要带 token 的地址）`
    : `${baseUrl} 无法连接，请确认 harness 已启动`;
  pushStatus();
  return { ok: false, reason: auth.listening ? 'unauthorized' : 'unreachable' };
}

/** 用隐藏窗口加载带 token 的地址，借助浏览器自身逻辑完成 cookie 换签。 */
function exchangeViaWindow(target) {
  const navigationUrl = harness.coerceNavigationUrl(target);
  return new Promise((resolve) => {
    if (!navigationUrl) {
      resolve(false);
      return;
    }
    const hidden = new BrowserWindow({
      show: false,
      webPreferences: {
        session: getSes(),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (!hidden.isDestroyed()) hidden.destroy();
      resolve(value);
    };
    // 303 换签经常伴随 ERR_ABORTED(-3)。把它当成失败会在 cookie 落地前拆掉窗口。
    hidden.webContents.on('did-fail-load', (_event, errorCode, _description, _validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      if (errorCode === -3) return;
      finish(false);
    });
    hidden.webContents.once('did-finish-load', () => finish(true));
    hidden.once('closed', () => finish(false));
    setTimeout(() => finish(false), 20_000);
    hidden.loadURL(navigationUrl).catch(() => finish(false));
  });
}

async function loadRemote() {
  if (!win) return;
  await win.loadURL(`${state.baseUrl}/`);
  win.setTitle('DSH Desktop');
}

function showShell() {
  if (!win) return;
  win.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

/* ------------------------------------------------------------------ */
/*  harness 子进程                                                      */
/* ------------------------------------------------------------------ */

function startHarness(opts = {}) {
  const cfg = config.load();
  const command = harness.locateDsh(opts.dshCommand || cfg.dshCommand);
  if (!command) {
    state.reason = '未找到 dsh 命令，请在下方面板填写 dsh 可执行文件路径';
    pushStatus();
    return { ok: false, reason: 'no-dsh' };
  }
  const workspace = opts.workspace || cfg.workspace || harness.app_root();
  const dshHome = opts.dshHome || cfg.dshHome || undefined;
  // 0 是合法值（交给系统分配空闲端口），因此不能用 || 兜底。
  const port = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : cfg.port ?? 0;

  stopHarness();
  state.launching = true;
  state.childReady = false;
  state.reason = '正在启动 harness…';

  let settled = false;
  const launch = harness.launchHarness({
    command,
    workspace,
    dshHome,
    port,
    onLog(chunk) {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      if (
        win
        && !win.isDestroyed()
        && !win.webContents.isDestroyed()
        && win.isVisible()
        && win.getURL()?.startsWith('file:')
      ) {
        safeSend(win.webContents, 'dsh:harness-log', lines.slice(-20));
      }
    },
    onExit(code) {
      if (!settled) state.reason = `harness 进程退出（code=${code ?? '?'}）`;
      state.launching = false;
      state.childReady = false;
      state.childPid = null;
      harnessChild = null;
      if (
        win
        && !win.isDestroyed()
        && !win.webContents.isDestroyed()
        && win.getURL()?.startsWith('file:')
      ) {
        notify('DSH Desktop', `harness 已停止（code=${code ?? '?'}）`);
      }
      pushStatus();
    },
  });

  harnessChild = launch.child;
  state.childPid = harnessChild.pid ?? null;
  pushStatus();

  launch.ready
    .then(async (url) => {
      settled = true;
      state.launching = false;
      state.childReady = true;
      config.save({ dshCommand: command, workspace, dshHome, port });
      const baseUrl = harness.baseUrlOf(url);
      state.baseUrl = baseUrl;
      state.connected = false;
      pushStatus();
      return connectTo(url.href);
    })
    .then((result) => {
      if (!result.ok) pushStatus();
    })
    .catch((error) => {
      settled = true;
      state.launching = false;
      state.reason = `启动失败：${error?.message ?? error}`;
      pushStatus();
    });

  return { ok: true };
}

function stopHarness() {
  const child = harnessChild;
  harnessChild = null;
  state.childPid = null;
  state.childReady = false;
  state.launching = false;
  if (child) harness.killChildTree(child);
}

/* ------------------------------------------------------------------ */
/*  窗口 / 托盘 / 菜单                                                   */
/* ------------------------------------------------------------------ */

function createWindow() {
  const cfg = config.load();
  const bounds = cfg.windowBounds;
  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d0d12',
    title: 'DSH Desktop',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      session: getSes(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // 不允许离开我们自己的地址（防钓鱼 / 防误导航）。
    const current = state.baseUrl || config.load().baseUrl;
    if (url.startsWith('file:')) return;
    if (current && url.startsWith(current)) return;
    if (url.startsWith('http://') && !/127\.|localhost|\[::1\]/.test(new URL(url).hostname)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on('page-title-updated', (_event, title) => {
    if (!win.isFocused() && !win.isDestroyed() && title && title !== 'DSH Desktop' && !win.getURL().startsWith('file:')) {
      notify('DSH Desktop', title);
    }
  });

  win.on('closed', () => {
    statusSink = null;
    win = null;
  });

  win.on('close', () => {
    if (!win.isDestroyed()) {
      config.save({ windowBounds: win.getBounds() });
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  statusSink = win.webContents;
}

function iconPath() {
  const candidates = [
    path.join(ASSETS_DIR, 'icon.ico'),
    path.join(ASSETS_DIR, 'icon.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function createTray() {
  const icon = iconPath();
  tray = new Tray(icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty());
  tray.setToolTip('DSH Desktop');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleWindow());
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/**
 * 托盘菜单里带「最近会话」，重建它需要解压会话日志，因此节流：
 * 状态变化时只预约一次刷新，避免频繁重算。
 */
let trayRefreshTimer = null;
function scheduleTrayRefresh(delayMs = 800) {
  if (trayRefreshTimer) return;
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    refreshTray();
  }, delayMs);
}

function buildTrayMenu() {
  const status = snapshotStatus();
  const sessions = sessionsMod.listSessions({ limit: 6 });
  return Menu.buildFromTemplate([
    {
      label: status.connected ? '已连接' : '未连接',
      enabled: false,
    },
    { label: status.baseUrl, enabled: false },
    { type: 'separator' },
    { label: '显示 / 隐藏窗口', click: () => toggleWindow() },
    {
      label: '重新连接',
      click: () => {
        showShell();
        setTimeout(() => connectTo(status.baseUrl), 300);
      },
    },
    { label: '在默认浏览器打开', click: () => shell.openExternal(status.baseUrl) },
    { type: 'separator' },
    {
      label: '最近会话',
      submenu:
        sessions.length === 0
          ? [{ label: '（暂无）', enabled: false }]
          : sessions.map((session) => ({
              label: `${session.title.slice(0, 26)}  ·  ${session.cwd ?? '?'}`,
              toolTip: `记录 ${session.recordCount} 条 · ${new Date(session.updatedAt).toLocaleString()}`,
              submenu: [
                {
                  label: '在文件资源管理器中打开工作目录',
                  click: () => session.cwd && shell.openPath(session.cwd),
                },
                { label: '复制会话 ID', click: () => clipboard.writeText(session.id) },
              ],
            })),
    },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(sessionsMod.dshHome()) },
    { label: '打开工作目录', click: () => shell.openPath(config.load().workspace || harness.app_root()) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function buildMenuTemplate() {
  return [
    {
      label: '文件',
      submenu: [
        { label: '显示连接面板', click: () => showShell() },
        { type: 'separator' },
        { label: '在浏览器中打开', click: () => shell.openExternal(state.baseUrl || config.load().baseUrl) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => win?.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => win?.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => win?.webContents.setZoomLevel(0) },
        { type: 'separator' },
        {
          label: '总在最前',
          type: 'checkbox',
          checked: config.load().alwaysOnTop,
          click: (item) => {
            config.save({ alwaysOnTop: item.checked });
            win?.setAlwaysOnTop(item.checked);
          },
        },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于', click: () => showAbout() },
      ],
    },
  ];
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于',
    message: 'DSH Desktop',
    detail: `DeepSeek Harness 桌面端外壳客户端 v${app.getVersion()}\nElectron ${process.versions.electron} / Node ${process.versions.node} / Chromium ${process.versions.chrome}`,
  });
}

/* ------------------------------------------------------------------ */
/*  IPC                                                                */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('dsh:status', () => snapshotStatus());
  ipcMain.handle('dsh:probe', async (_event, baseUrl) => {
    const target = baseUrl || config.load().baseUrl;
    const probe = await sessionAuthorized(target);
    return { ...probe, ...(await harness.probeListening(target)) };
  });
  ipcMain.handle('dsh:discover', async () => harness.discoverRunning());
  ipcMain.handle('dsh:connect', async (_event, input) => connectTo(input));
  ipcMain.handle('dsh:disconnect', () => {
    state.connected = false;
    state.reason = '';
    showShell();
    pushStatus();
    return { ok: true };
  });
  ipcMain.handle('dsh:launch', (_event, opts = {}) => startHarness(opts));
  ipcMain.handle('dsh:stop-child', () => {
    stopHarness();
    state.reason = '已停止由桌面端启动的 harness';
    pushStatus();
    return { ok: true };
  });
  ipcMain.handle('dsh:locate-dsh', (_event, explicit) => harness.locateDsh(explicit));
  ipcMain.handle('dsh:pick-dir', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('dsh:open-dir', (_event, dir) => (dir ? shell.openPath(dir) : undefined));
  ipcMain.handle('dsh:reveal', (_event, file) => (file ? shell.showItemInFolder(file) : undefined));
  ipcMain.handle('dsh:copy', (_event, text) => clipboard.writeText(String(text)));
  ipcMain.handle('dsh:paste', () => clipboard.readText());
  ipcMain.handle('dsh:open-external', (_event, url) => {
    const target = String(url || '');
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
  });
  ipcMain.handle('dsh:sessions', (_event, limit) => sessionsMod.listSessions({ limit }));
  ipcMain.handle('dsh:save-settings', (_event, patch) => {
    const next = config.save(patch);
    if ('alwaysOnTop' in patch) win?.setAlwaysOnTop(!!patch.alwaysOnTop);
    pushStatus();
    return next;
  });
}

/* ------------------------------------------------------------------ */
/*  生命周期                                                            */
/* ------------------------------------------------------------------ */

function updateTrayTooltip() {
  const status = snapshotStatus();
  tray?.setToolTip(
    status.connected ? `DSH Desktop · 已连接 ${status.baseUrl}` : `DSH Desktop · ${status.reason || '未连接'}`,
  );
}

async function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    if (!state.connected) return;
    const probe = await sessionAuthorized(state.baseUrl);
    if (!probe.authorized) {
      state.connected = false;
      state.reason = probe.listening ? '连接已失效（可能需要重新授权）' : '连接已断开';
      pushStatus();
      if (win && !win.isDestroyed() && win.getURL()?.startsWith('http')) {
        notify('DSH Desktop', state.reason);
        showShell();
      }
    }
  }, 5000);
}

async function boot() {
  const lock = app.requestSingleInstanceLock();
  if (!lock && !isSelftest) {
    app.quit();
    return;
  }
  if (isSelftest) return runSelfTest();

  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  await app.whenReady();
  registerIpc();
  createWindow();
  createTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  startWatchdog();
  // 空闲时状态不会变化，托盘里的「最近会话」需要自己定期刷新。
  setInterval(() => refreshTray(), 60_000).unref?.();

  const cfg = config.load();
  // 启动时若有记录且仍能直连，就直接进 GUI；否则展示连接面板。
  const probe = await sessionAuthorized(cfg.baseUrl);
  if (probe.authorized) {
    state.baseUrl = cfg.baseUrl;
    const result = await finishAuthorized(cfg.baseUrl, cfg.lastToken);
    if (!result.ok) showShell();
  } else {
    showShell();
    pushStatus();
  }

  win.webContents.once('did-finish-load', () => {
    if (isDebug && !process.env.DSH_DEBUG_NO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => stopHarness());
}

/* ------------------------------------------------------------------ */
/*  自检：启动外壳界面并截图（供无头验证与开发调试）                          */
/* ------------------------------------------------------------------ */

async function runSelfTest() {
  await app.whenReady();
  registerIpc();
  createWindow();

  const diagnostics = [];
  const warnings = [];

  /** `console-message` 在旧版是 (event, level, message, line, source)，
   *  新版是 (event, details)，这里两种都兼容。 */
  win.webContents.on('console-message', (...args) => {
    const details = args[1];
    const modern = details && typeof details === 'object' && 'message' in details;
    const level = modern ? String(details.level) : Number(args[1]);
    const message = modern ? details.message : args[2];
    const line = modern ? details.lineNumber : args[3];
    const source = modern ? details.sourceId : args[4];
    const isError = level === 'error' || level === 3;
    const isWarning = level === 'warning' || level === 2 || level === 'warn';
    if (isError) diagnostics.push(`console.error ${message} (${source}:${line})`);
    else if (isWarning) warnings.push(`console.warn ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    diagnostics.push(`did-fail-load ${code} ${description}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.push(`render-process-gone ${details.reason}`);
  });

  const shot = path.join(harness.app_root(), 'artifacts', 'selftest-shell.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 2200));

  const dom = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    pill: document.getElementById('status-pill')?.textContent ?? null,
    pillClass: document.getElementById('status-pill')?.className ?? null,
    probe: document.getElementById('probe-line')?.textContent ?? null,
    dshFound: document.getElementById('dsh-found-line')?.textContent ?? null,
    sessionRows: document.querySelectorAll('#session-list .session').length,
    firstSessionTitle: document.querySelector('#session-list .session .title')?.textContent ?? null,
    cardCount: document.querySelectorAll('.card').length,
    dshApiKeys: Object.keys(window.dsh ?? {}).length,
  }))()`);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(shot, image.toPNG());

  const report = {
    dom,
    diagnostics,
    warnings,
    image: shot,
    imageBytes: fs.statSync(shot).size,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
  };

  // Windows 上 Electron 是 GUI 子系统进程，stdout 不回父控制台，
  // 因此自检结果同时写文件，供 CI / 无头验证读取。
  const reportPath = path.join(harness.app_root(), 'artifacts', 'selftest-report.json');
  const pass = diagnostics.length === 0 && dom.cardCount === 3 && dom.dshApiKeys > 5;
  report.result = pass ? 'PASS' : 'FAIL';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('SELFTEST_DOM=' + JSON.stringify(dom));
  console.log('SELFTEST_IMAGE=' + shot);
  console.log('SELFTEST_IMAGE_BYTES=' + report.imageBytes);
  console.log('SELFTEST_DIAGNOSTICS=' + JSON.stringify(diagnostics));
  console.log('SELFTEST_WARNINGS=' + JSON.stringify(warnings));
  console.log('SELFTEST_RESULT=' + report.result);
  app.exit(pass ? 0 : 1);
}

const diagDir = path.join(harness.app_root(), 'artifacts');
function diagLog(tag, value) {
  try {
    fs.mkdirSync(diagDir, { recursive: true });
    fs.appendFileSync(path.join(diagDir, 'error.log'), `[${tag}] ${new Date().toISOString()} ${JSON.stringify(value)}\n`);
  } catch {
    /* 忽略 */
  }
}
process.on('uncaughtException', (error) => {
  diagLog('uncaughtException', error?.stack || error?.message || String(error));
  console.error('UNCAUGHT', error);
});
process.on('unhandledRejection', (reason) => {
  diagLog('unhandledRejection', reason?.stack || reason?.message || String(reason));
  console.error('UNHANDLED_REJECTION', reason);
});

if (process.platform === 'win32') {
  app.setAppUserModelId('com.dsh.desktop');
}

app.whenReady().then(boot).catch((error) => {
  diagLog('boot-rejection', error?.stack || error?.message);
  console.error('boot failed', error);
  app.exit(1);
});