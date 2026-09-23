/**
 * Locating and enumerating the on-disk DSH session store.
 *
 * Layout (documented in `@deepseek-ai/dsh-session-persistence-jsonl`):
 *
 * ```text
 * <DSH_HOME>/sessions/
 *   --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
 *     <escaped-session-id>/        # session-owned directory
 *       session.jsonl.zstd         # released v0 generation (compressed)
 *       session.v1.jsonl.zstd      # released v1 generation
 *       session.v2.jsonl.zstd      # released v2 generation
 *       session.v3.jsonl.zstd      # released v3 generation (current)
 *       session.jsonl              # the same generations, uncompressed
 * ```
 *
 * The session id is injectively escaped into one path segment, so a directory
 * name is not always the raw id. We therefore read the authoritative id from the
 * artifact's own header rather than trusting the directory name.
 *
 * @module dsh-sessions-diagnosis/core/store
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { readSessionHeader } from './frames.js'

/**
 * The format version this build of DSH writes (see `sessionFormatCatalog.currentVersion`).
 *
 * A **fallback**, not the authority: when DSH's own catalog can be reached its
 * `currentVersion` wins, because the tool may be running under an older harness
 * than the one it was written against (see `diagnose.js`).
 */
export const CURRENT_FORMAT_VERSION = 3

/** Canonical basename of one generation, without the compression suffix. */
const LOG_NAME = /^session(?:\.(v\d+))?\.jsonl$/

/**
 * Name the canonical basename of one Session format generation.
 * Version zero keeps `session.jsonl`; later generations carry `.vN`.
 * @param {number} version - non-negative safe integer format version.
 * @returns {string} the basename without any compression suffix.
 */
export function sessionFormatLogFilename (version) {
  return version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
}

/**
 * Read the generation named by one log basename.
 *
 * Rejects the names DSH itself rejects as non-canonical: uppercase `V`,
 * leading-zero versions, and an explicit `.v0`.
 *
 * @param {string} filename - one basename from a session directory.
 * @returns {{ version: number, compression: 'zstd'|'none' }|undefined} the generation, or undefined.
 */
export function parseSessionFormatLogFilename (filename) {
  let stem = filename
  let compression = 'none'
  if (stem.endsWith('.zstd')) {
    stem = stem.slice(0, -'.zstd'.length)
    compression = 'zstd'
  }
  const match = LOG_NAME.exec(stem)
  if (match === null) return undefined
  if (match[1] === undefined) return { version: 0, compression }
  const digits = match[1].slice(1)
  if (digits.length === 0 || digits.length > 1 && digits.startsWith('0')) return undefined
  const version = Number(digits)
  if (version === 0 || !Number.isSafeInteger(version)) return undefined
  return { version, compression }
}

/**
 * Resolve the DSH home directory.
 *
 * Order: an explicit override, then `DSH_HOME`, then the two conventional
 * dot-directories. The first candidate that actually contains a `sessions`
 * directory wins, so an exported-but-stale `DSH_HOME` does not hide a real store.
 *
 * @param {string} [override] - explicit home directory from plugin config.
 * @returns {string|undefined} the resolved home, or undefined when none exists.
 */
export function resolveDshHome (override) {
  const candidates = []
  if (typeof override === 'string' && override.length > 0) candidates.push(override)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    candidates.push(process.env.DSH_HOME)
  }
  candidates.push(join(homedir(), '.dsh'), join(homedir(), '.deepseek-harness'))

  let firstExisting = undefined
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (firstExisting === undefined) firstExisting = candidate
    if (existsSync(join(candidate, 'sessions'))) return candidate
  }
  return firstExisting
}

/**
 * Resolve the session-store root (`<DSH_HOME>/sessions`).
 * @param {string} [override] - explicit DSH home directory.
 * @returns {string|undefined} the sessions root, or undefined when it does not exist.
 */
export function resolveSessionsRoot (override) {
  const home = resolveDshHome(override)
  if (home === undefined) return undefined
  const root = join(home, 'sessions')
  return existsSync(root) ? root : undefined
}

/**
 * One generation artifact found in a session directory.
 * @typedef {object} SessionGeneration
 * @property {number} version - format version named by the filename.
 * @property {'zstd'|'none'} compression - physical encoding.
 * @property {string} path - absolute path.
 * @property {number} sizeBytes - file size.
 * @property {number} mtimeMs - last-write time.
 * @property {boolean} canonical - whether DSH's naming rules accept the name.
 */

/**
 * One session directory and every artifact inside it.
 * @typedef {object} SessionEntry
 * @property {string} id - session id (from the directory name; corrected from the header when readable).
 * @property {string} dir - absolute session directory.
 * @property {string} projectDir - the enclosing `--<cwd>--` directory name.
 * @property {SessionGeneration[]} generations - canonical generation artifacts, ascending by version.
 * @property {SessionGeneration[]} foreign - files DSH would not select (backups, torn temp files).
 * @property {number} highestVersion - highest canonical generation present.
 * @property {string|undefined} selectedPath - the artifact DSH would open.
 * @property {number} totalBytes - bytes across all artifacts.
 */

/**
 * Enumerate every session in the store.
 *
 * Unreadable project or session directories are skipped rather than failing the
 * whole scan — a diagnosis tool must still work on a store with one bad entry.
 *
 * @param {object} [options]
 * @param {string} [options.root] - explicit sessions root.
 * @param {string} [options.dshHome] - explicit DSH home (used to derive `root`).
 * @returns {{ root: string|undefined, sessions: SessionEntry[], errors: Array<{ path: string, message: string }> }}
 *   the scan result.
 */
export function listSessions (options = {}) {
  const root = options.root ?? resolveSessionsRoot(options.dshHome)
  if (root === undefined) return { root: undefined, sessions: [], errors: [] }

  /** @type {SessionEntry[]} */
  const sessions = []
  const errors = []

  let projectDirs
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return { root, sessions, errors: [{ path: root, message: message(error) }] }
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const projectPath = join(root, projectDir.name)
    let sessionDirs
    try {
      sessionDirs = readdirSync(projectPath, { withFileTypes: true })
    } catch (error) {
      errors.push({ path: projectPath, message: message(error) })
      continue
    }

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const dir = join(projectPath, sessionDir.name)
      const entry = inspectSessionDir(dir, projectDir.name, sessionDir.name, errors)
      if (entry !== undefined) sessions.push(entry)
    }
  }

  sessions.sort((a, b) => a.id.localeCompare(b.id))
  return { root, sessions, errors }
}

/**
 * Inspect one session directory: collect generations and select the winner.
 * @param {string} dir - absolute session directory.
 * @param {string} projectDir - enclosing project directory name.
 * @param {string} dirName - the session directory's own name.
 * @param {Array<{ path: string, message: string }>} errors - error sink.
 * @returns {SessionEntry|undefined} the entry, or undefined when the directory is unusable.
 */
function inspectSessionDir (dir, projectDir, dirName, errors) {
  let files
  try {
    files = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    errors.push({ path: dir, message: message(error) })
    return undefined
  }

  /** @type {SessionGeneration[]} */
  const generations = []
  /** @type {SessionGeneration[]} */
  const foreign = []

  for (const file of files) {
    if (!file.isFile()) continue
    const path = join(dir, file.name)
    let info
    try {
      info = statSync(path)
    } catch (error) {
      errors.push({ path, message: message(error) })
      continue
    }
    const parsed = parseSessionFormatLogFilename(file.name)
    const generation = {
      version: parsed?.version ?? -1,
      compression: parsed?.compression ?? detectCompression(file.name),
      path,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      canonical: parsed !== undefined
    }
    if (parsed === undefined) foreign.push(generation)
    else generations.push(generation)
  }

  generations.sort((a, b) => a.version - b.version || a.compression.localeCompare(b.compression))
  foreign.sort((a, b) => a.path.localeCompare(b.path))

  const selected = generations.length > 0 ? generations[generations.length - 1] : undefined
  return {
    id: dirName,
    dir,
    projectDir,
    generations,
    foreign,
    highestVersion: selected?.version ?? -1,
    selectedPath: selected?.path,
    totalBytes: [...generations, ...foreign].reduce((sum, g) => sum + g.sizeBytes, 0)
  }
}

/**
 * Best-effort compression detection for a file DSH would not select anyway.
 * @param {string} name - file basename.
 * @returns {'zstd'|'none'} the guessed encoding.
 */
function detectCompression (name) {
  return name.includes('.zstd') ? 'zstd' : 'none'
}

/**
 * The catalogue of `source.kind` values the released V2-to-V3 migration admits.
 *
 * Reproduced from `@deepseek-ai/dsh-session-format-v2-to-v3` (`SOURCE_KINDS`).
 * A user message carrying any other kind makes the whole migration refuse, which
 * is the failure this plugin exists to diagnose and repair.
 *
 * @type {ReadonlySet<string>}
 */
export const ADMITTED_MESSAGE_SOURCE_KINDS = new Set([
  'user',
  'plugin',
  'model',
  'tool',
  'agent-instructions',
  'session-reference',
  'team-message',
  'goal',
  'skill-invocation',
  'skill-catalog',
  'coordinator',
  'subagent-report',
  'subagent-settled',
  'webhook',
  'agent-message'
])

/**
 * The five released Message slots that carry a `source`, and how to reach each.
 *
 * Mirrors `assertEvent()` in the V2-to-V3 edge: only these positions are
 * audited, so only these positions can make a migration refuse.
 *
 * @type {ReadonlyArray<{ type: string, path: string, list?: string }>}
 */
export const MESSAGE_SLOTS = Object.freeze([
  { type: 'user/message', path: 'data' },
  { type: 'assistant/message', path: 'data.message' },
  { type: 'tool/result', path: 'data.message' },
  { type: 'agent/inbox/spliced', path: 'data.inserted', list: 'inserted' },
  { type: 'session/title-llm-request', path: 'data.messages', list: 'messages' }
])

/**
 * Visit every message object that the V2-to-V3 source audit inspects.
 *
 * @param {any} row - one parsed session row.
 * @param {(message: any, where: { seq: number|undefined, type: string, path: string }) => void} visit
 *   called once per message slot found on the row.
 */
export function visitMessageSources (row, visit) {
  const type = row?.type
  const data = row?.data
  if (typeof type !== 'string') return
  const seq = typeof row.seq === 'number' ? row.seq : undefined

  if (type === 'user/message') {
    visit(data, { seq, type, path: 'data' })
    return
  }
  if (type === 'assistant/message' || type === 'tool/result') {
    visit(data?.message, { seq, type, path: 'data.message' })
    return
  }
  if (type === 'agent/inbox/spliced' || type === 'session/title-llm-request') {
    const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
    const list = data?.[key]
    if (!Array.isArray(list)) return
    for (let i = 0; i < list.length; i++) {
      visit(list[i], { seq, type, path: `data.${key}[${i}]` })
    }
  }
}

/**
 * Read only the header frame of a session's selected artifact.
 *
 * Cheap enough for a store census: it never decompresses event frames and never
 * starts a migration, mirroring DSH's own `list`/`stat` behaviour.
 *
 * @param {SessionEntry} entry - the session entry.
 * @returns {{ header: any, version: number }|undefined} the header, or undefined when unreadable.
 */
export function readEntryHeader (entry) {
  if (entry.selectedPath === undefined) return undefined
  try {
    const { header } = readSessionHeader(entry.selectedPath)
    return { header, version: typeof header?.version === 'number' ? header.version : -1 }
  } catch {
    return undefined
  }
}

/**
 * The basename of a path, re-exported so callers need not import `node:path`.
 * @param {string} path - any path.
 * @returns {string} its final segment.
 */
export function baseName (path) {
  return basename(path)
}

/** @param {unknown} error @returns {string} */
function message (error) {
  return error instanceof Error ? error.message : String(error)
}
