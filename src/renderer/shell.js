'use strict';

/**
 * 桌面端「连接面板」渲染逻辑。
 * 只做展示与转调，所有文件/进程/网络能力都在主进程的 IPC 后面。
 */

const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $('status-pill'),
  topmost: $('btn-topmost'),
  openBrowser: $('btn-open-browser'),
  connUrl: $('conn-url'),
  paste: $('btn-paste'),
  connect: $('btn-connect'),
  probeLine: $('probe-line'),
  dshCmd: $('dsh-cmd'),
  locate: $('btn-locate'),
  dshFound: $('dsh-found-line'),
  ws: $('launch-ws'),
  browseWs: $('btn-browse-ws'),
  home: $('launch-home'),
  port: $('launch-port'),
  launch: $('btn-launch'),
  stopChild: $('btn-stop-child'),
  log: $('harness-log'),
  refresh: $('btn-refresh'),
  list: $('session-list'),
  foot: $('foot-status'),
};

let current = {};

/* ---------------- 展示工具 ---------------- */

function setFoot(text, kind = '') {
  els.foot.textContent = text;
  els.foot.style.color = kind === 'err' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

function relativeTime(ms) {
  const delta = Date.now() - ms;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function span(className, text) {
  const element = document.createElement('span');
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderStatus(status) {
  current = status;
  const pill = els.statusPill;
  if (status.connected) {
    pill.textContent = '已连接';
    pill.className = 'pill ok';
  } else if (status.launching) {
    pill.textContent = '启动中…';
    pill.className = 'pill warn';
  } else {
    pill.textContent = '未连接';
    pill.className = 'pill';
  }

  if (status.baseUrl && document.activeElement !== els.connUrl) els.connUrl.value = status.baseUrl;
  if (document.activeElement !== els.ws) els.ws.value = status.workspace || '';
  if (document.activeElement !== els.home) els.home.value = status.dshHome || '';
  if (status.dshCommand && document.activeElement !== els.dshCmd) els.dshCmd.value = status.dshCommand;
  if (status.port !== undefined && document.activeElement !== els.port) els.port.value = String(status.port);

  els.dshFound.textContent = status.defaultDsh
    ? `已找到：${status.defaultDsh}`
    : '未在 PATH 中找到 dsh，请手动填写路径';
  els.topmost.style.borderColor = status.alwaysOnTop ? 'var(--accent)' : '';
  els.stopChild.disabled = !status.childPid;
  els.openBrowser.disabled = !/^https?:\/\//.test(status.baseUrl || '');
  if (status.reason) setFoot(status.reason, /失败|无法|未/.test(status.reason) ? 'err' : '');
}

function renderSessions(sessions) {
  if (!sessions || sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '暂无会话（或该 DSH_HOME 下还没有会话记录）';
    els.list.replaceChildren(empty);
    return;
  }

  const rows = sessions.map((session) => {
    const row = document.createElement('div');
    row.className = 'session';

    const main = document.createElement('div');
    main.style.minWidth = '0';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = session.title;

    const meta = document.createElement('div');
    meta.setAttribute('class', 'session-meta');
    const path = span('path', session.cwd || '（未知工作目录）');
    path.title = session.cwd || '';
    meta.append(
      path,
      span('', relativeTime(session.updatedAt)),
      span('', `${session.recordCount} 条记录 · ${formatBytes(session.bytes)}`),
      span('', session.agentPreset ? `预设 ${session.agentPreset}` : ''),
    );
    main.append(title, meta);

    const ops = document.createElement('div');
    ops.className = 'ops';

    const openBtn = document.createElement('button');
    openBtn.className = 'ghost';
    openBtn.textContent = '打开目录';
    openBtn.onclick = () => session.cwd && window.dsh.openDir(session.cwd);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ghost';
    copyBtn.textContent = '复制 ID';
    copyBtn.onclick = async () => {
      await window.dsh.copy(session.id);
      setFoot(`已复制会话 ID：${session.id}`, 'ok');
    };

    ops.append(openBtn, copyBtn);
    row.append(main, ops);
    return row;
  });

  els.list.replaceChildren(...rows);
}

/* ---------------- 交互 ---------------- */

async function refreshSessions() {
  const sessions = await window.dsh.sessions(30);
  renderSessions(sessions);
}

async function refreshProbe() {
  const base = (els.connUrl.value || '').trim() || current.baseUrl;
  const [probe, discover] = await Promise.all([window.dsh.probe(base), window.dsh.discover()]);
  const alive = discover.alive ?? [];

  const line = document.createElement('div');
  line.className = 'row muted';
  const summary = document.createElement('span');
  if (probe.authorized) {
    summary.innerHTML = `<span style="color:var(--ok)">${base} 已授权，可直接连接</span>`;
  } else if (probe.listening) {
    summary.innerHTML = `<span style="color:var(--warn)">${base} 端口在监听，但需要带 token 的地址</span>`;
  } else {
    summary.textContent = `${base} 无响应`;
  }
  line.append(summary);

  if (alive.length > 0) {
    const detail = span('', ` · 检测到监听端口：${alive.join(', ')}`);
    const fill = document.createElement('button');
    fill.className = 'ghost';
    fill.style.padding = '3px 8px';
    fill.style.fontSize = '11.5px';
    fill.textContent = `填入 :${alive[0]}`;
    fill.onclick = () => {
      els.connUrl.value = `http://127.0.0.1:${alive[0]}`;
      refreshProbe();
    };
    line.append(detail, fill);
  }

  els.probeLine.replaceWith(line);
  line.id = 'probe-line';
  els.probeLine = line;
}

async function doConnect() {
  const input = els.connUrl.value.trim();
  if (!input) {
    setFoot('请先填写地址', 'err');
    return;
  }
  setFoot('正在连接…');
  els.connect.disabled = true;
  try {
    const result = await window.dsh.connect(input);
    if (result.ok) setFoot('已连接，正在打开 harness 界面…', 'ok');
    else {
      setFoot(current.reason || '连接失败', 'err');
      await refreshProbe();
    }
  } finally {
    els.connect.disabled = false;
  }
}

async function doLaunch() {
  const opts = {
    workspace: els.ws.value.trim() || undefined,
    dshHome: els.home.value.trim() || undefined,
    dshCommand: els.dshCmd.value.trim() || undefined,
    port: Number.parseInt(els.port.value, 10) || 0,
  };
  setFoot('正在启动 harness…');
  els.launch.disabled = true;
  els.log.textContent = '';
  try {
    const result = await window.dsh.launch(opts);
    if (!result.ok) setFoot(current.reason || '启动失败', 'err');
  } finally {
    els.launch.disabled = false;
  }
}

function wire() {
  els.connect.onclick = doConnect;
  els.connUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doConnect();
  });
  els.paste.onclick = async () => {
    const text = await window.dsh.paste();
    if (!text) {
      setFoot('剪贴板为空', 'err');
      return;
    }
    els.connUrl.value = text.trim().split(/\r?\n/)[0];
    setFoot('已从剪贴板粘贴，点击「连接」');
  };
  els.openBrowser.onclick = () => window.dsh.openExternal(current.baseUrl);
  els.topmost.onclick = async () => {
    const status = await window.dsh.saveSettings({ alwaysOnTop: !current.alwaysOnTop });
    renderStatus(status);
  };
  els.locate.onclick = async () => {
    const found = await window.dsh.locateDsh(els.dshCmd.value.trim() || undefined);
    if (found) {
      els.dshCmd.value = found;
      els.dshFound.textContent = `已找到：${found}`;
      setFoot('已定位 dsh', 'ok');
    } else {
      els.dshFound.textContent = '未找到 dsh，请手动填写路径';
      setFoot('未找到 dsh', 'err');
    }
  };
  els.browseWs.onclick = async () => {
    const dir = await window.dsh.pickDir();
    if (dir) els.ws.value = dir;
  };
  els.launch.onclick = doLaunch;
  els.stopChild.onclick = async () => {
    await window.dsh.stopChild();
    setFoot('已停止桌面端启动的 harness 实例');
  };
  els.refresh.onclick = async () => {
    await refreshSessions();
    setFoot('会话列表已刷新');
  };
}

/* ---------------- 启动 ---------------- */

async function init() {
  wire();
  const status = await window.dsh.status();
  renderStatus(status);
  await Promise.all([refreshSessions(), refreshProbe()]);

  window.dsh.onStatus((next) => renderStatus(next));

  window.dsh.onHarnessLog((lines) => {
    if (!lines?.length) return;
    els.log.textContent = `${els.log.textContent}${lines.join('\n')}\n`.slice(-4000);
    els.log.scrollTop = els.log.scrollHeight;
  });

  setInterval(refreshSessions, 10_000);
}

window.addEventListener('DOMContentLoaded', init);