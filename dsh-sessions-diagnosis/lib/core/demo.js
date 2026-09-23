/**
 * Synthetic demo sessions.
 *
 * A repair tool is hard to trust without something to repair, and the honest
 * sample — your own broken conversation — is exactly the thing you must not
 * share. So this module builds a **synthetic** session log that reproduces the
 * real failure faithfully: it is a genuine released-v0 artifact, so DSH's own
 * migration refuses it for the same reason it refuses a real one, and the same
 * rule repairs it.
 *
 * Two scenarios are available:
 *
 * - `mention`    — a retired `source.kind` (`at-file-mention`), the common case,
 *                  fixed by the low-risk rule;
 * - `descriptor` — a stale `subagent/descriptor.data.version`, fixed by the
 *                  medium-risk rule, which must be requested explicitly.
 *
 * The rows are constructed against the frozen v0 payload schema (required and
 * optional members, literal domains), so they are not a caricature: a real
 * harness reads them.
 *
 * @module dsh-sessions-diagnosis/core/demo
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { encodeSessionLog } from './frames.js'
import { parseSessionFormatLogFilename } from './store.js'
import { REPAIR_MANIFEST_NAME } from './repair.js'

/** Project directory for a demo session whose `cwd` is not set. */
const NO_CWD = '_no-cwd'

/** The source kind a retired `@`-mention plugin wrote. */
const RETIRED_MENTION_KIND = 'at-file-mention'

/**
 * Every demo session id starts with this, and removal matches on it and nothing
 * else — so a cleanup can never touch a real session.
 */
export const DEMO_ID_PREFIX = 'session-00000000-demo-'

/**
 * The demo session id. Recognisable on sight, and a valid path segment.
 * @param {string} scenario - `mention` or `descriptor`.
 * @returns {string} the session id.
 */
export function demoSessionId (scenario) {
  return `${DEMO_ID_PREFIX}${scenario}-000000000000`
}

/**
 * Mint a usable demo id for a fresh session.
 *
 * A demo store has no sidebar, so it has no archive set and the deterministic id
 * from {@link demoSessionId} is normally returned — readable on sight, and
 * reproducible for a first run. The archive set is still honoured when a caller
 * supplies one, because DSH hides every archived id in every surface, and a
 * session created under an archived id would be invisible from birth: no error,
 * no row. `demoSessionId` stays the preferred id so callers keep one predictable
 * spelling to reach for.
 *
 * Whether a directory already holds a session is deliberately *not* consulted:
 * that case must keep raising the "already exists" refusal rather than quietly
 * picking another id after the user has been working with one.
 *
 * @param {string} scenario - `mention` or `descriptor`.
 * @param {number} [now] - epoch ms stamped into a minted id.
 * @param {ReadonlySet<string>} [archived] - archived ids to avoid.
 * @returns {string} a usable session id.
 */
export function freshDemoId (scenario, now = Date.now(), archived) {
  const taken = archived ?? new Set()
  const base = demoSessionId(scenario)
  if (!taken.has(base)) return base
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = `${DEMO_ID_PREFIX}${scenario}-${now.toString(36)}-${randomBytes(3).toString('hex')}`
    if (!taken.has(candidate)) return candidate
  }
  /* v8 ignore next -- unreachable while randomBytes supplies entropy */
  throw new Error('could not mint an unarchived demo session id')
}

/**
 * Encode a working directory into DSH's readable project directory name.
 *
 * A faithful port of DSH's own `projectKey`, which is deliberately lossy in three
 * ways that matter if you want a demo session to land in the same directory DSH
 * would choose:
 *
 * - a **run** of separators collapses to a single `-`, so `D:\x` becomes
 *   `--D-x--` rather than `--D--x--`;
 * - leading dashes are stripped, and an empty result becomes `root`;
 * - any character outside `[A-Za-z0-9._-]` is escaped as `~XXXX` (uppercase hex),
 *   so a non-ASCII path stays filesystem-safe.
 *
 * @param {string|undefined} cwd - the session's working directory; `undefined`
 *   selects DSH's `_no-cwd` directory.
 * @returns {string} the project directory name.
 * @throws {Error} on an empty string, which DSH also refuses.
 */
export function projectKey (cwd) {
  if (cwd === undefined) return NO_CWD
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')

  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Build the rows of a synthetic broken session.
 *
 * The timestamp matters more than it looks. DSH's session list is ordered by
 * activity, newest first, so a demo carrying a fixed historical date sorts to the
 * very bottom — behind every real conversation, and easy to conclude is missing.
 * By default the demo is therefore created "just now" and appears at the top,
 * where you went looking for it. Pass an explicit `createdAt` when you need
 * reproducible bytes.
 *
 * @param {object} [options]
 * @param {'mention'|'descriptor'} [options.scenario] - which defect to plant.
 * @param {string} [options.id] - session id.
 * @param {string} [options.cwd] - working directory recorded in the header.
 * @param {number} [options.createdAt] - creation timestamp; defaults to one minute ago.
 * @returns {unknown[]} rows, header first, in the released v0 format.
 */
export function buildDemoSession (options = {}) {
  const scenario = options.scenario ?? 'mention'
  const id = options.id ?? demoSessionId(scenario)
  const cwd = options.cwd ?? 'C:\\dsh-diagnosis-demo'
  const createdAt = options.createdAt ?? recentTimestamp()

  let seq = 0
  const row = (type, data) => ({ type, seq: seq++, time: createdAt + seq * 1000, data })

  const rows = [
    { type: 'session', version: 0, id, createdAt, cwd, delegationDepth: 0, agentPreset: 'standard' },
    row('permission/preset', { preset: 'workspace-write' }),
    row('sandbox/mode', { mode: 'workspace-write' }),
    row('approval/policy', { policy: 'ask' }),
    row('turn/start', { turn: 1 }),
    row('step/start', { turn: 1, step: 1 })
  ]

  // The defect, planted where the released audit will find it.
  if (scenario === 'descriptor') {
    rows.push(row('subagent/descriptor', {
      mode: 'one-shot',
      version: 2,                 // the frozen v0 codec requires exactly 3
      provider: 'deepseek-official',
      label: 'demo subagent'
    }))
  }

  const firstMessage = scenario === 'mention'
    ? {
        content: [{ type: 'text', text: '<workspace-reference path="docs/notes.md" kind="file" />' }],
        source: { kind: RETIRED_MENTION_KIND, relative: 'docs/notes.md' },
        role: 'user',
        id: 'demo-user-1'
      }
    : {
        content: [{ type: 'text', text: 'Please summarise the notes in this project.' }],
        source: { kind: 'user', rpcId: 'demo-rpc-1', clientTimeZone: 'UTC' },
        role: 'user',
        id: 'demo-user-1'
      }

  rows.push(row('user/message', firstMessage))
  rows.push(row('request/header', {
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      system: 'You are a demo agent used to exercise dsh-sessions-diagnosis.'
    },
    reason: 'initial'
  }))
  rows.push(row('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [{ type: 'text', text: 'This is a synthetic demo reply; no real conversation is involved.' }],
      role: 'assistant',
      id: 'demo-assistant-1'
    }
  }))
  rows.push(row('step/end', { turn: 1, step: 1 }))
  rows.push(row('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  // Surface events must carry their placement; migration does not invent it.
  for (const r of rows) {
    if (r.type === 'user/message' || r.type === 'assistant/message') r.surfaceOp = 'append'
  }

  return rows
}

/**
 * Where a demo session would be written.
 *
 * @param {object} options
 * @param {string} options.root - the sessions root.
 * @param {string} [options.cwd] - recorded working directory.
 * @param {string} [options.id] - session id.
 * @param {'mention'|'descriptor'} [options.scenario] - which defect to plant.
 * @returns {{ dir: string, path: string, id: string }} the target paths.
 */
export function demoSessionPath (options) {
  const scenario = options.scenario ?? 'mention'
  const id = options.id ?? demoSessionId(scenario)
  const dir = join(options.root, projectKey(options.cwd ?? 'C:\\dsh-diagnosis-demo'), id)
  return { dir, path: join(dir, 'session.jsonl.zstd'), id }
}

/**
 * Marker written beside every demo session.
 *
 * Ownership has to be *proved*, not inferred from a name. A session id is just a
 * string: a future harness could mint ids in another shape, an SDK caller could
 * pass its own, and a real conversation could end up with a demo-looking id. So
 * cleanup requires this file — written only by {@link createDemoSession} — and
 * never trusts the id prefix, which is now only a naming convenience.
 */
export const DEMO_MARKER_NAME = 'session.diag-demo.json'

/** Marker identity, so a foreign file of the same name is not mistaken for ours. */
const DEMO_MARKER_KIND = 'demo-session'

/**
 * Write a synthetic broken session into a store.
 *
 * Refuses to overwrite an existing one, so running it twice cannot destroy a
 * session you were part-way through repairing.
 *
 * The store is expected to be a throwaway one — {@link assertDemoStoreIsNotReal}
 * is what keeps the real session store out of reach at the CLI. A demo is
 * deliberately unreadable, so it must never be created where the harness reads.
 *
 * @param {object} options
 * @param {string} options.root - the sessions root.
 * @param {'mention'|'descriptor'} [options.scenario] - which defect to plant.
 * @param {string} [options.cwd] - recorded working directory.
 * @param {string} [options.id] - session id (default: a deterministic, collision-free demo id).
 * @param {ReadonlySet<string>} [options.archived] - archived ids this store must avoid
 *   (default: none — a demo store has no sidebar).
 * @param {number} [options.createdAt] - creation timestamp; defaults to one minute ago.
 * @returns {{ id: string, requestedId: string, idRedeemed: boolean, dir: string, path: string,
 *   markerPath: string, scenario: string, bytes: number, defect: string, removalCommand: string }}
 *   what was created.
 */
export function createDemoSession (options) {
  const scenario = options.scenario ?? 'mention'
  // The id a caller gets when they name none — deterministic, and never used
  // blindly: `freshDemoId` redeems it only while it is not archived.
  const requestedId = options.id ?? demoSessionId(scenario)
  const id = options.id ?? freshDemoId(scenario, Date.now(), options.archived)
  const target = demoSessionPath({ ...options, id, scenario })
  if (existsSync(target.path)) {
    throw new Error(`a demo session already exists at ${target.path}; repair or remove it first`)
  }

  const rows = buildDemoSession({ scenario, id: target.id, cwd: options.cwd, createdAt: options.createdAt })
  const bytes = encodeSessionLog(rows)

  mkdirSync(target.dir, { recursive: true })
  const markerPath = join(target.dir, DEMO_MARKER_NAME)
  try {
    writeFileSync(target.path, bytes)
    // The marker records the exact bytes we wrote, so a later cleanup can tell an
    // untouched demo from one that has been repaired, resumed, or talked in.
    writeFileSync(markerPath, JSON.stringify({
      tool: 'dsh-sessions-diagnosis',
      schemaVersion: 1,
      kind: DEMO_MARKER_KIND,
      sessionId: target.id,
      scenario,
      createdAt: new Date().toISOString(),
      source: { name: 'session.jsonl.zstd', sha256: sha256(bytes), sizeBytes: bytes.length }
    }, null, 2))
  } catch (error) {
    rmSync(target.dir, { recursive: true, force: true })
    throw error
  }

  return {
    id: target.id,
    requestedId,
    idRedeemed: target.id === requestedId,
    dir: target.dir,
    path: target.path,
    markerPath,
    scenario,
    bytes: bytes.length,
    defect: scenario === 'mention'
      ? `a user message whose source.kind is ${JSON.stringify(RETIRED_MENTION_KIND)}, a value the released migration vocabulary does not admit`
      : 'a subagent/descriptor row recording version 2, where the frozen v0 codec requires 3',
    removalCommand: 'dsh-session-doctor demo --remove --apply'
  }
}

/**
 * The store every demo lives in: a throwaway DSH home outside the real one.
 *
 * A demo is a deliberately unreadable session. Writing one into the store DSH
 * actually reads would put a broken conversation next to yours, add a row to a
 * sidebar the demo has no business being in, and make the demo's own id part of
 * the harness's durable state (the workspace registry archive set is keyed by id
 * and never pruned, so an id archived once stays archived forever). None of that
 * is necessary to practise a repair, so the default is a store DSH never opens —
 * and {@link assertDemoStoreIsNotReal} refuses the real store outright rather
 * than trusting a flag to be typed carefully.
 *
 * The parent is a DSH home in its own right (`sessions/` inside it), so pointing
 * DSH at it is a single environment variable.
 *
 * @param {object} [options]
 * @param {string} [options.root] - explicit store, used verbatim.
 * @param {string} [options.tmp] - temporary directory (defaults to the OS one).
 * @param {string} [options.env] - demo-home override (defaults to `DSH_DEMO_HOME`).
 * @returns {{ root: string, home: string|undefined, scratch: boolean, source: string }} the demo store.
 */
export function resolveDemoStore (options = {}) {
  if (options.root !== undefined) {
    return { root: options.root, home: undefined, scratch: false, source: '--root' }
  }
  const override = options.env ?? process.env.DSH_DEMO_HOME
  const home = typeof override === 'string' && override.length > 0
    ? override
    : join(options.tmp ?? tmpdir(), 'dsh-session-doctor-demo')
  return {
    root: join(home, 'sessions'),
    home,
    scratch: true,
    source: typeof override === 'string' && override.length > 0 ? 'DSH_DEMO_HOME' : 'default'
  }
}

/**
 * Refuse a demo target that is the real session store.
 *
 * Deleting a session is a supported operation; *creating* a broken one inside the
 * store the harness reads is not something this tool will do on request. Paths are
 * resolved before comparison — and folded on the platforms whose filesystems are
 * case-insensitive — so `--root` cannot reach the real store by spelling it
 * differently.
 *
 * @param {string} root - the store a demo would be written to.
 * @param {string|undefined} realRoot - the real store root, or undefined when unknown.
 * @param {NodeJS.Platform} [platform] - platform whose path rules apply (defaults to this one).
 * @throws {Error} when `root` and `realRoot` name the same directory.
 */
export function assertDemoStoreIsNotReal (root, realRoot, platform = process.platform) {
  if (realRoot === undefined) return
  const fold = (path) => {
    const resolved = resolve(path)
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
  }
  if (fold(realRoot) === fold(root)) {
    throw new Error(
      `refusing to create a demo in the real session store (${realRoot}).\n` +
      'A demo is a deliberately broken session; it must not join your conversations.\n' +
      'Run it without --root to use the throwaway demo store instead.'
    )
  }
}

/**
 * Read and validate a directory's demo marker.
 *
 * @param {string} dir - a session directory.
 * @returns {any|undefined} the marker, or undefined when this tool did not create it.
 */
export function readDemoMarker (dir) {
  const path = join(dir, DEMO_MARKER_NAME)
  if (!existsSync(path)) return undefined
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8'))
    if (marker?.tool !== 'dsh-sessions-diagnosis') return undefined
    if (marker?.kind !== DEMO_MARKER_KIND) return undefined
    if (typeof marker?.sessionId !== 'string') return undefined
    return marker
  } catch {
    return undefined
  }
}

/**
 * Decide whether a demo session is still only what this tool created.
 *
 * A demo is a *live* session: DSH will happily resume it and you can keep talking
 * in it. Deleting one then would destroy real conversation, so cleanup has to
 * distinguish three states:
 *
 * - `pristine` — the source generation is byte-identical to what we generated;
 * - `repaired` — a successor exists and is exactly the one our repair published,
 *   so nothing has been written since;
 * - `used`     — anything else, meaning content exists that we did not create.
 *
 * @param {string} dir - the session directory.
 * @param {any} marker - its validated marker.
 * @returns {{ state: 'pristine'|'repaired'|'used', detail: string }} the classification.
 */
function classifyDemo (dir, marker) {
  const sourcePath = join(dir, marker.source.name)
  if (!existsSync(sourcePath)) {
    return { state: 'used', detail: 'the source generation recorded by the marker is gone' }
  }
  if (sha256(readFileSync(sourcePath)) !== marker.source.sha256) {
    return { state: 'used', detail: 'the source generation was modified after the demo was created' }
  }

  const generations = readdirSync(dir)
    .map((name) => ({ name, parsed: parseSessionFormatLogFilename(name) }))
    .filter((entry) => entry.parsed !== undefined)
    .sort((a, b) => a.parsed.version - b.parsed.version)

  const newest = generations[generations.length - 1]
  if (newest === undefined || newest.name === marker.source.name) {
    return { state: 'pristine', detail: 'only the generation this tool wrote is present' }
  }

  const repairPath = join(dir, REPAIR_MANIFEST_NAME)
  if (existsSync(repairPath)) {
    try {
      const repair = JSON.parse(readFileSync(repairPath, 'utf8'))
      if (repair?.published?.sha256 !== undefined &&
          sha256(readFileSync(join(dir, newest.name))) === repair.published.sha256) {
        return { state: 'repaired', detail: 'repaired by this tool and not written to since' }
      }
      return { state: 'used', detail: 'the repaired session was written to afterwards' }
    } catch {
      return { state: 'used', detail: 'a repair record is present but unreadable' }
    }
  }
  return { state: 'used', detail: `a generation this tool did not publish exists (${newest.name})` }
}

/**
 * List the demo sessions present in a store.
 *
 * A session counts only when it carries a valid {@link DEMO_MARKER_NAME} that
 * names it. The id prefix is not consulted, so a real conversation — whatever its
 * id looks like — can never be selected.
 *
 * @param {object} options
 * @param {string} options.root - the sessions root.
 * @param {'mention'|'descriptor'} [options.scenario] - restrict to one scenario.
 * @returns {Array<{ id: string, dir: string, files: string[], bytes: number, scenario: string,
 *   state: 'pristine'|'repaired'|'used', detail: string, removable: boolean }>} what was found.
 */
export function findDemoSessions (options) {
  const found = []

  let projects
  try {
    projects = readdirSync(options.root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(options.root, project.name)
    let sessions
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir, session.name)

      const marker = readDemoMarker(dir)
      if (marker === undefined) continue
      // The marker must name this directory: a copied marker proves nothing.
      if (marker.sessionId !== session.name) continue
      if (options.scenario !== undefined && marker.scenario !== options.scenario) continue

      let files = []
      let bytes = 0
      try {
        files = readdirSync(dir)
        for (const file of files) bytes += statSync(join(dir, file)).size
      } catch {
        // A directory we cannot read is still worth reporting.
      }

      const { state, detail } = classifyDemo(dir, marker)
      found.push({
        id: session.name,
        dir,
        files,
        bytes,
        scenario: marker.scenario ?? 'unknown',
        state,
        detail,
        // `used` means real content exists that this tool did not write.
        removable: state !== 'used'
      })
    }
  }
  return found
}

/**
 * Remove the demo sessions from a store.
 *
 * Deletes only what {@link findDemoSessions} returned with `removable: true`, and
 * only when `apply` is true — the caller prints the list first. A demo that has
 * been talked in is reported instead of deleted unless `force` is set, because a
 * demo session is a real session once you use it.
 *
 * @param {object} options
 * @param {string} options.root - the sessions root.
 * @param {'mention'|'descriptor'} [options.scenario] - restrict to one scenario.
 * @param {boolean} [options.apply] - actually delete.
 * @param {boolean} [options.force] - also delete demos that have been used.
 * @returns {{ removed: Array<{ id: string, dir: string }>, kept: Array<{ id: string, detail: string }>,
 *   skipped: boolean }} the outcome.
 */
export function removeDemoSessions (options) {
  const found = findDemoSessions(options)
  if (options.apply !== true) return { removed: [], kept: [], skipped: true }

  const removed = []
  const kept = []
  for (const demo of found) {
    if (!demo.removable && options.force !== true) {
      kept.push({ id: demo.id, detail: demo.detail })
      continue
    }
    rmSync(demo.dir, { recursive: true, force: true })
    removed.push({ id: demo.id, dir: demo.dir })
    // Remove the project directory too when it held only demos.
    const parent = join(demo.dir, '..')
    try {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
    } catch {
      // Leaving an empty project directory behind is harmless.
    }
  }
  return { removed, kept, skipped: false }
}

/** SHA-256 of a buffer, as lowercase hex. */
function sha256 (buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * A creation timestamp that reads as "just now" in DSH's activity-ordered list.
 *
 * Backdated by a minute so the final `turn/end` does not sit in the future
 * relative to the header, which would look odd in a trajectory view.
 *
 * @returns {number} epoch milliseconds.
 */
function recentTimestamp () {
  return Date.now() - 60_000
}
