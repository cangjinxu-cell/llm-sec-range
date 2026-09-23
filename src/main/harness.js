'use strict';

/**
 * harness 发现与启动：
 * - 探测本机哪些端口上已经有 harness 在服务（未授权也能看到 401，说明端口活着）
 * - 定位 `dsh` 可执行文件
 * - 由桌面端自己拉起一个实例（`dsh web --no-open --port 0`）并从 stdout/stderr
 *   里解析出带 token 的登录地址
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const CANDIDATE_PORTS = [3080, 3081, 3082, 3083, 3090, 8080];
const URL_LINE = /dsh web:\s*(https?:\/\/\S+)/i;

/** 从一段文本中解析 `dsh web: <url>` 形式的登录地址。 */
function parseAuthUrl(text) {
  const match = URL_LINE.exec(text);
  if (!match) return undefined;
  try {
    return new URL(match[1]);
  } catch {
    return undefined;
  }
}

/** 把用户输入（整行日志、裸地址、只填端口）规范化成 URL。 */
function normalizeInput(input) {
  if (typeof input !== 'string') return undefined;
  let text = input.trim();
  if (!text) return undefined;
  const authUrl = parseAuthUrl(text);
  if (authUrl !== undefined) return authUrl;
  if (/^\d+$/.test(text)) text = `http://${DEFAULT_HOST}:${text}`;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** 去掉查询串与 hash，得到不带 token 的根地址。 */
function baseUrlOf(url) {
  const base = new URL(url.href);
  base.search = '';
  base.hash = '';
  return base.href.replace(/\/$/, '');
}

/** 该地址是否只是一次性登录地址（带 token）。 */
function hasLaunchToken(url) {
  return url.searchParams.has('token');
}

/**
 * 隐藏窗口要加载的地址。调用方有时传入字符串，有时传入 URL；
 * 不能对字符串再取 `.href`（那会得到 undefined）。
 * @param {string | URL | undefined} target
 * @returns {string | undefined}
 */
function coerceNavigationUrl(target) {
  if (typeof target === 'string') {
    const text = target.trim();
    return text || undefined;
  }
  if (target instanceof URL) return target.href;
  return undefined;
}

/**
 * 结束 harness 进程。Windows 上 `dsh.cmd` 经 cmd.exe 再拉起 node，
 * `child.kill()` 只杀壳，孙进程会继续占着 session 写句柄。
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 */
function killChildTree(child) {
  if (!child || typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* 进程已经不在 */
    }
    return;
  }
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
}

/**
 * 用普通 fetch 探测端口是否有服务在监听（401/200/303 都算“活着”）。
 * @returns {Promise<{listening: boolean, status?: number}>}
 */
async function probeListening(baseUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'text/html' },
    });
    return { listening: true, status: response.status };
  } catch {
    return { listening: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 扫描候选端口，返回第一个有服务在监听的根地址。 */
async function discoverRunning(extraPorts = []) {
  const ports = [...new Set([DEFAULT_PORT, ...extraPorts, ...CANDIDATE_PORTS])];
  const results = await Promise.all(
    ports.map(async (port) => ({ port, ...(await probeListening(`http://${DEFAULT_HOST}:${port}`)) })),
  );
  const alive = results.filter((item) => item.listening).map((item) => item.port);
  return { alive, ports };
}

function fileExists(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 中查找可执行的 dsh（Windows 上是 .cmd/.ps1/.exe）。 */
function searchPath(names = ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh']) {
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 定位 dsh 命令：显式配置 → PATH → 常见安装位置 → 本项目 node_modules。
 * @returns {string|undefined}
 */
function locateDsh(explicit) {
  if (explicit && fileExists(explicit)) return explicit;

  const fromPath = searchPath();
  if (fromPath !== undefined) return fromPath;

  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'dsh'),
    path.join(os.homedir(), '.local', 'bin', 'dsh'),
    path.join('/usr/local/bin', 'dsh'),
    path.join(app_root(), 'node_modules', '.bin', 'dsh.cmd'),
    path.join(app_root(), 'node_modules', '.bin', 'dsh'),
  ];

  // 本 harness 通常运行在 npx 缓存里：扫描其中的 dsh 命令 shim。
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const npxRoot = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
    try {
      for (const hashDir of fs.readdirSync(npxRoot)) {
        const shim = path.join(npxRoot, hashDir, 'node_modules', '.bin', 'dsh.cmd');
        if (fileExists(shim)) candidates.push(shim);
      }
    } catch {
      /* 目录不存在则跳过 */
    }
  }

  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) return candidate;
  }
  return undefined;
}

/** 桌面端自身的安装目录（打包后是 resources/app，开发时是项目根）。 */
function app_root() {
  return path.resolve(__dirname, '..', '..');
}

/** 该命令是否需要在 shell / cmd.exe 里执行（Windows 脚本）。 */
function needsShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/**
 * 由桌面端启动一个 harness Web 实例。
 * @param {{command: string, workspace?: string, dshHome?: string, port?: number,
 *          onLog?: (chunk: string) => void, onExit?: (code: number|null) => void}} options
 * @returns {{child: import('node:child_process').ChildProcess, ready: Promise<URL>}}
 */
function launchHarness(options) {
  const args = ['web', '--no-open', '--port', String(options.port ?? 0)];
  const env = { ...process.env };
  if (options.dshHome) env.DSH_HOME = options.dshHome;

  const cwd = options.workspace && fs.existsSync(options.workspace) ? options.workspace : app_root();
  const child = needsShell(options.command)
    ? spawn(`"${options.command}" ${args.join(' ')}`, {
        cwd,
        env,
        shell: true,
        windowsHide: true,
      })
    : spawn(options.command, args, { cwd, env, windowsHide: true });

  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onChunk = (chunk) => {
      const text = String(chunk);
      buffer += text;
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
      options.onLog?.(text);
      const url = parseAuthUrl(buffer);
      if (url !== undefined && !settled) {
        settled = true;
        resolve(url);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', fail);
    child.on('exit', (code) => {
      options.onExit?.(code);
      fail(new Error(`dsh 进程已退出（code=${code}）`));
    });
    setTimeout(() => fail(new Error('等待 dsh 启动地址超时')), 90_000).unref?.();
  });

  return { child, ready };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  CANDIDATE_PORTS,
  parseAuthUrl,
  normalizeInput,
  baseUrlOf,
  hasLaunchToken,
  coerceNavigationUrl,
  killChildTree,
  probeListening,
  discoverRunning,
  locateDsh,
  launchHarness,
  app_root,
  execFileSync,
};