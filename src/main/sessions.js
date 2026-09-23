'use strict';

/**
 * 会话读取：把 `$DSH_HOME/sessions` 下的多帧 zstd JSONL 会话日志还原成
 * 可展示的元数据（工作目录、标题、最近活动、消息数）。
 *
 * 关键事实：harness 以 *追加* 方式写会话日志，每个追加片段是一个独立的
 * zstd 帧，因此 `zlib.zstdDecompressSync` 只能解出第一帧。这里用「魔数扫描 +
 * 逐候选边界试解」的方式自校验地还原全部帧：只有真正解压成功，才认为该边界
 * 是一帧的结尾。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/** 扫描缓冲区里所有 zstd 帧魔数候选位置。 */
function magicOffsets(buf) {
  const offsets = [];
  const end = buf.length - 3;
  for (let i = 0; i < end; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

/**
 * 解压一个多帧 zstd 缓冲区。
 * @param {Buffer} buf 原始文件内容
 * @param {{maxFrames?: number, maxBytes?: number}} [options]
 * @returns {Buffer}
 */
function decodeFrames(buf, options = {}) {
  const maxFrames = options.maxFrames ?? 4000;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const offsets = magicOffsets(buf);
  if (offsets.length === 0) return Buffer.alloc(0);

  const parts = [];
  let cursor = 0;
  let total = 0;
  let frames = 0;

  while (cursor < offsets.length && frames < maxFrames && total < maxBytes) {
    const start = offsets[cursor];
    let advanced = false;
    for (let next = cursor + 1; next <= offsets.length; next++) {
      const end = next < offsets.length ? offsets[next] : buf.length;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(start, end));
        parts.push(out);
        total += out.length;
        frames += 1;
        cursor = next;
        advanced = true;
        break;
      } catch {
        // 该边界不是帧尾（魔数为误报或还没到帧尾），继续向后延伸。
      }
    }
    if (!advanced) break;
  }

  return Buffer.concat(parts);
}

/** 从任意 JSON 值里抽取人类可读文本，容忍多种记录形状。 */
function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const pieces = [];
    for (const item of value) {
      const text = extractText(item);
      if (text) pieces.push(text);
    }
    return pieces.join('\n');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.content !== undefined) return extractText(value.content);
    if (value.message !== undefined && typeof value.message !== 'object') return extractText(value.message);
  }
  return '';
}

function isUserRecord(record) {
  if (record && record.type === 'user/message') return true;
  const role = record ? record.role ?? record.data?.role : undefined;
  return role === 'user';
}

function recordText(record) {
  if (!record) return '';
  const source =
    record.content ??
    record.data?.content ??
    record.data?.message?.content ??
    record.message ??
    record.text;
  return extractText(source);
}

function firstUserText(records) {
  for (const record of records) {
    if (!isUserRecord(record)) continue;
    const trimmed = recordText(record).replace(/\s+/g, ' ').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function sessionTitle(records) {
  const titleRecords = records.filter((record) => record && record.type === 'session/title');
  const last = titleRecords[titleRecords.length - 1];
  if (last && typeof last.data?.title === 'string' && last.data.title.trim()) {
    return condense(last.data.title);
  }
  return condense(firstUserText(records)) || '（无用户消息）';
}

function condense(text, limit = 72) {
  const clean = text.replace(/`+/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

function pickLogFile(sessionDir) {
  for (const name of ['session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
    const candidate = path.join(sessionDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readLog(file) {
  const buf = fs.readFileSync(file);
  const text = decodeFrames(buf).toString('utf8');
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // 半截或损坏的行直接跳过，会话面板不应因此整体失败。
    }
  }
  return records;
}

/**
 * 读出一个会话目录的摘要。
 * @param {string} sessionDir
 * @returns {object|undefined}
 */
function readSession(sessionDir) {
  const logFile = pickLogFile(sessionDir);
  if (logFile === undefined) return undefined;
  const stat = fs.statSync(logFile);
  let records;
  try {
    records = readLog(logFile);
  } catch {
    return undefined;
  }
  const header = records.find((record) => record && record.type === 'session') ?? {};
  const messages = records.filter((record) => record && record.type !== 'session');
  const fallbackId = path.basename(sessionDir).replace(/^session-/, '');
  const title = sessionTitle(records);
  return {
    id: typeof header.id === 'string' ? header.id : fallbackId,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : stat.birthtimeMs,
    updatedAt: stat.mtimeMs,
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
    title,
    recordCount: messages.length,
    bytes: stat.size,
    logFile,
    dir: sessionDir,
  };
}

/**
 * 列出最近会话，按最近活动时间倒序。
 * @param {{limit?: number}} [options]
 * @returns {object[]}
 */
function listSessions(options = {}) {
  const limit = options.limit ?? 25;
  const root = sessionsRoot();
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const workspaceEntry of workspaceDirs) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspaceDir = path.join(root, workspaceEntry.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory() || !sessionEntry.name.startsWith('session-')) continue;
      const summary = readSession(path.join(workspaceDir, sessionEntry.name));
      if (summary !== undefined) found.push(summary);
    }
  }

  found.sort((a, b) => b.updatedAt - a.updatedAt);
  return found.slice(0, limit);
}

/** 最近一次会话使用的工作目录，用于推断默认工作目录。 */
function mostRecentWorkspace() {
  const [latest] = listSessions({ limit: 1 });
  return latest?.cwd;
}

module.exports = {
  dshHome,
  sessionsRoot,
  decodeFrames,
  listSessions,
  readSession,
  mostRecentWorkspace,
};

if (require.main === module) {
  const sessions = listSessions({ limit: 10 });
  console.log(`DSH_HOME: ${dshHome()}`);
  console.log(`found ${sessions.length} session(s)`);
  for (const session of sessions) {
    console.log(
      [
        new Date(session.updatedAt).toISOString(),
        session.cwd ?? '?',
        `records=${session.recordCount}`,
        `${Math.round(session.bytes / 1024)}KB`,
        session.title,
      ].join(' | '),
    );
  }
}
