/**
 * Test suite for the dsh-sessions-diagnosis core.
 *
 * Run with `node test/run.mjs`. Uses only Node's built-in `assert` and a tiny
 * runner, so it needs no dependencies and works in a bare checkout.
 *
 * Tests that need a real broken session read one from `.scratch/fixtures`
 * (populated by `node test/fetch-fixtures.mjs`) and are skipped when it is
 * absent, so the suite still passes on a machine with no DSH session store.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  compressFrame,
  decodeSessionLog,
  encodeSessionLog,
  parseSessionFormatLogFilename,
  probeMigration,
  resolveDshFormatModules,
  scanZstdFrames,
  sessionFormatLogFilename,
  listSessions,
  detectIssues,
  applyIssues,
  LOW_RISK_RULE_IDS,
  diagnoseEntry,
  diagnoseStore,
  DIAGNOSIS_STATUSES,
  planRepair,
  repairSession,
  rollbackSession,
  checkContentPreserved,
  createDemoSession,
  buildDemoSession,
  demoSessionId,
  findDemoSessions,
  freshDemoId,
  removeDemoSessions,
  assertDemoStoreIsNotReal,
  resolveDemoStore,
  DEMO_ID_PREFIX,
  projectKey,
  REPAIR_MODES,
  REPAIR_RULES,
  ADMITTED_MESSAGE_SOURCE_KINDS
} from '../lib/core/index.js'

/**
 * Independently count the message payloads in a log, for cross-checking the
 * repair's own preservation report rather than trusting it.
 * @param {unknown[]} rows - decoded rows.
 * @returns {Map<string, number>} payload fingerprint -> occurrences.
 */
function messagePayloadCounts (rows) {
  const counts = new Map()
  const push = (label, message) => {
    if (message === null || typeof message !== 'object' || !('content' in message)) return
    const key = `${label}\u0000${JSON.stringify(message.content)}\u0000${message.role ?? ''}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const row of rows) {
    const data = row?.data
    if (row?.type === 'user/message') push('user', data)
    else if (row?.type === 'assistant/message') push('assistant', data?.message)
    else if (row?.type === 'tool/result') push('tool', data?.message)
    else if (row?.type === 'system/message') push('system', data?.message)
    else if (row?.type === 'agent/inbox/spliced') for (const m of data?.inserted ?? []) push('inbox', m)
    else if (row?.type === 'session/title-llm-request') for (const m of data?.messages ?? []) push('title', m)
  }
  return counts
}

const HERE = import.meta.dirname
const FIXTURES = join(HERE, '..', '.scratch', 'fixtures')
const BROKEN = join(FIXTURES, 'broken', 'session.jsonl.zstd')
/**
 * Directory label for the synthetic store the tests build. It is arbitrary: the
 * session id a diagnosis reports comes from the directory name, and nothing
 * asserts that it matches the id inside the copied fixture's header.
 */
const FIXTURE_ID = 'session-fixture'

/** Collected results. */
const results = []
let current

/** Register and run one test. */
async function test (name, fn) {
  current = { name, ok: true, error: undefined, skipped: false }
  try {
    await fn()
  } catch (error) {
    if (error?.skip === true) {
      current.skipped = true
    } else {
      current.ok = false
      current.error = error
    }
  }
  results.push(current)
}

/** Skip the current test with a reason. */
function skip (reason) {
  const error = new Error(reason)
  error.skip = true
  throw error
}

/** Build a temporary session-directory tree. */
function makeStore (files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diag-'))
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

const log = (rows) => encodeSessionLog(rows)
const sessionHeader = (version, id = 'session-test') => ({
  type: 'session', version, id, createdAt: 1, cwd: 'C:\\test', isSeeded: false, delegationDepth: 0
})

// ────────────────────────────────────────────────────────────────────────────
// frames
// ────────────────────────────────────────────────────────────────────────────

await test('scanZstdFrames finds every concatenated frame', () => {
  const buffer = Buffer.concat([compressFrame('{"a":1}\n'), compressFrame('{"b":2}\n'), compressFrame('{"c":3}\n')])
  const { frames, tornStart } = scanZstdFrames(buffer)
  assert.equal(frames.length, 3)
  assert.equal(tornStart, undefined)
  assert.equal(frames[0].start, 0)
  assert.equal(frames.at(-1).end, buffer.length)
})

await test('scanZstdFrames reports a torn final frame instead of throwing', () => {
  const whole = Buffer.concat([compressFrame('{"a":1}\n'), compressFrame('{"b":2}\n')])
  const { frames, tornStart } = scanZstdFrames(whole.subarray(0, whole.length - 8))
  assert.equal(frames.length, 1)
  assert.equal(typeof tornStart, 'number')
})

await test('scanZstdFrames rejects a file that is not a zstd container', () => {
  assert.throws(() => scanZstdFrames(Buffer.from('not a session log at all, definitely not')), /invalid frame magic/)
})

await test('encodeSessionLog round-trips rows and keeps the header in its own frame', () => {
  const rows = [sessionHeader(3), { type: 'x', seq: 0, time: 1, data: {} }, { type: 'y', seq: 1, time: 2, data: {} }]
  const encoded = encodeSessionLog(rows)
  const decoded = decodeSessionLog(encoded)
  assert.deepEqual(decoded.rows, rows)
  assert.equal(decoded.badFrames, 0)
  assert.equal(decoded.tornStart, undefined)

  const first = decodeSessionLog(encoded.subarray(decoded.frames[0].start, decoded.frames[0].end))
  assert.equal(first.rows.length, 1, 'the first frame must hold exactly the header line')
})

await test('decodeSessionLog tolerates a frame that fails its checksum', () => {
  const header = compressFrame('{"type":"session","version":3}\n')
  // A structurally complete frame whose payload byte is flipped: the scanner
  // still walks past it, but decompression must fail its checksum.
  const corrupt = Buffer.from(compressFrame('{"seq":0}\n'))
  corrupt[corrupt.length - 3] ^= 0xff
  const tail = compressFrame('{"seq":1}\n')
  const decoded = decodeSessionLog(Buffer.concat([header, corrupt, tail]))
  assert.equal(decoded.badFrames, 1, 'the corrupt frame must be reported, not thrown')
  assert.equal(decoded.frames.length, 3, 'the frames after it must still be found')
  assert.equal(decoded.rows.length, 2, 'the readable rows must still be returned')
})

// ────────────────────────────────────────────────────────────────────────────
// store
// ────────────────────────────────────────────────────────────────────────────

await test('sessionFormatLogFilename / parseSessionFormatLogFilename agree', () => {
  assert.equal(sessionFormatLogFilename(0), 'session.jsonl')
  assert.equal(sessionFormatLogFilename(3), 'session.v3.jsonl')
  assert.deepEqual(parseSessionFormatLogFilename('session.jsonl.zstd'), { version: 0, compression: 'zstd' })
  assert.deepEqual(parseSessionFormatLogFilename('session.v3.jsonl.zstd'), { version: 3, compression: 'zstd' })
  assert.deepEqual(parseSessionFormatLogFilename('session.v2.jsonl'), { version: 2, compression: 'none' })
})

await test('parseSessionFormatLogFilename rejects the names DSH rejects', () => {
  for (const bad of [
    'session.v0.jsonl.zstd',
    'session.V3.jsonl.zstd',
    'session.v03.jsonl.zstd',
    'session.jsonl.zstd.bak.2026-01-01',
    'session.migration.abc.jsonl.zstd.tmp',
    'session.jsonl.zstd.tmp',
    'other.jsonl.zstd'
  ]) {
    assert.equal(parseSessionFormatLogFilename(bad), undefined, `${bad} must not be canonical`)
  }
})

await test('listSessions selects the highest canonical generation', () => {
  const root = makeStore({
    '--C-test--/session-a/session.jsonl.zstd': log([sessionHeader(0, 'session-a'), { type: 'e', seq: 0, time: 1, data: {} }]),
    '--C-test--/session-a/session.v3.jsonl.zstd': log([sessionHeader(3, 'session-a'), { type: 'e', seq: 0, time: 1, data: {} }]),
    '--C-test--/session-a/session.jsonl.zstd.bak.2026': Buffer.from('ignored'),
    '--C-test--/session-b/session.jsonl.zstd': log([sessionHeader(0, 'session-b')])
  })
  try {
    const { sessions } = listSessions({ root })
    assert.equal(sessions.length, 2)
    const a = sessions.find((s) => s.id === 'session-a')
    const b = sessions.find((s) => s.id === 'session-b')
    assert.equal(a.highestVersion, 3)
    assert.match(a.selectedPath, /session\.v3\.jsonl\.zstd$/)
    assert.equal(a.foreign.length, 1, 'the .bak file must be classified as foreign')
    assert.equal(b.highestVersion, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// demo sessions
// ────────────────────────────────────────────────────────────────────────────

await test('projectKey reproduces DSH\'s own project directory names', () => {
  // The shapes below mirror the directory names DSH actually produces, so this
  // pins the port against DSH's real encoding rather than against a reading of
  // it. The paths themselves are illustrative, not taken from any machine.
  assert.equal(projectKey('D:\\work'), '--D-work--')
  assert.equal(projectKey('D:\\work\\projects\\my-app'), '--D-work-projects-my-app--')
  assert.equal(projectKey('C:\\code\\apps\\desktop\\gui'), '--C-code-apps-desktop-gui--')
  // Forward slashes and separator runs collapse the same way.
  assert.equal(projectKey('D:/work'), '--D-work--')
  assert.equal(projectKey('D:\\\\work'), '--D-work--')
  // No cwd selects DSH's dedicated directory.
  assert.equal(projectKey(undefined), '_no-cwd')
  // Unsafe characters are escaped, and an empty path is refused, as in DSH.
  assert.equal(projectKey('D:\\a b'), '--D-a~0020b--')
  assert.throws(() => projectKey(''), /empty project path/)
})

await test('a demo is timestamped now, so it is not buried at the bottom of the list', () => {
  // DSH orders its session list by activity, newest first. A fixed historical
  // timestamp put the demo last of every session in the store, behind real
  // conversations, which reads as "the demo never appeared".
  const rows = buildDemoSession({ scenario: 'mention' })
  const skew = Math.abs(Date.now() - rows[0].createdAt)
  assert.ok(skew < 10 * 60 * 1000, `expected a recent timestamp, got ${new Date(rows[0].createdAt).toISOString()}`)

  // An explicit timestamp is still honoured, for reproducible bytes.
  const fixed = buildDemoSession({ scenario: 'mention', createdAt: 1767268800000 })
  assert.equal(fixed[0].createdAt, 1767268800000)
  assert.equal(fixed[1].time, 1767268801000, 'events follow the header timestamp')
})

/**
 * Run one test against a temporary DSH home.
 *
 * Isolates `process.env.DSH_HOME` for the body so nothing it does can reach the
 * developer's real store. Note that demo *id minting* does not consult any
 * registry: `createDemoSession` takes the archived-id set as an explicit
 * `archived` option (`lib/core/demo.js`), so tests pass it directly rather than
 * inheriting it from a DSH home.
 *
 * The body is awaited inside the `try`, so an async test keeps the temporary
 * home for its whole run: a bare `return fn(home)` would let the `finally`
 * restore `DSH_HOME` and delete the home at the body's first `await`.
 * @param {() => any | Promise<any>} fn - the test body, sync or async.
 */
async function withTempDshHome (fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previous = process.env.DSH_HOME
  mkdirSync(join(home, 'sessions'), { recursive: true })
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

await test('a demo session refuses to overwrite an existing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    // An explicit id pins the behaviour under test: the refusal, not the id choice.
    const first = createDemoSession({ root, scenario: 'mention', id: 'session-demo-refusal' })
    assert.equal(existsSync(first.path), true)
    assert.throws(() => createDemoSession({ root, scenario: 'mention', id: 'session-demo-refusal' }), /already exists/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('freshDemoId keeps the readable id until that id is unusable', () => {
  const now = 1767268800000
  // Nothing archived: the deterministic, readable id is used as-is.
  assert.equal(freshDemoId('mention', now, new Set()), demoSessionId('mention'))

  // An archived id is never handed out again: DSH hides archived ids in every
  // surface, so a demo created with one would be invisible from birth.
  const archived = new Set([demoSessionId('mention')])
  const fresh = freshDemoId('mention', now, archived)
  assert.notEqual(fresh, demoSessionId('mention'))
  assert.ok(fresh.startsWith(DEMO_ID_PREFIX), 'a minted id stays recognisable')
  assert.ok(!archived.has(fresh))
  // Distinct calls stay distinct, and the other scenario is unaffected.
  assert.notEqual(freshDemoId('mention', now, archived), fresh)
  assert.equal(freshDemoId('descriptor', now, archived), demoSessionId('descriptor'))
})

await test('createDemoSession honours an archive set it is given, and needs no DSH home', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-demo-home-'))
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [demoSessionId('mention')] },
      tables: { workspaces: {} }
    }))

    // An explicit archive set is honoured wherever it came from.
    const created = createDemoSession({ root, scenario: 'mention', archived: new Set([demoSessionId('mention')]) })
    assert.notEqual(created.id, demoSessionId('mention'))
    assert.equal(created.requestedId, demoSessionId('mention'))
    assert.equal(created.idRedeemed, false)
    assert.equal(existsSync(created.path), true)

    // With none supplied, nothing about the registry matters —not even a DSH home
    // sitting right next to the store, which must not be consulted.
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const other = createDemoSession({ root: join(root, 'second'), scenario: 'mention' })
      assert.equal(other.id, demoSessionId('mention'), 'a demo store has no sidebar to dodge')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

await test('an explicit id is always honoured exactly', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    const created = createDemoSession({ root, scenario: 'mention', id: 'session-my-own-id' })
    assert.equal(created.id, 'session-my-own-id')
    assert.equal(created.idRedeemed, true)
    assert.equal(created.dir.endsWith('session-my-own-id'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('demo cleanup removes only demos, and never a real session', () => withTempDshHome(() => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    createDemoSession({ root, scenario: 'mention' })
    createDemoSession({ root, scenario: 'descriptor' })
    // A real session in the same store, plus a name that merely looks similar.
    const realDir = join(root, '--D-real--', 'session-real-one')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'session.jsonl.zstd'), log([sessionHeader(0, 'session-real-one')]))
    const lookalikeDir = join(root, '--D-real--', 'session-00000000-demoo-lookalike')
    mkdirSync(lookalikeDir, { recursive: true })
    writeFileSync(join(lookalikeDir, 'session.jsonl.zstd'), log([sessionHeader(0, 'session-00000000-demoo-lookalike')]))

    assert.equal(findDemoSessions({ root }).length, 2)
    for (const demo of findDemoSessions({ root })) {
      assert.equal(demo.state, 'pristine')
      assert.equal(demo.removable, true)
    }

    // A dry run must delete nothing.
    assert.equal(removeDemoSessions({ root }).skipped, true)
    assert.equal(findDemoSessions({ root }).length, 2)

    const { removed } = removeDemoSessions({ root, apply: true })
    assert.equal(removed.length, 2)
    assert.equal(findDemoSessions({ root }).length, 0)

    // Everything that is not a demo survives, including the prefix lookalike.
    assert.equal(existsSync(join(realDir, 'session.jsonl.zstd')), true)
    assert.equal(existsSync(join(lookalikeDir, 'session.jsonl.zstd')), true)
    assert.equal(listSessions({ root }).sessions.length, 2)

    // A per-scenario cleanup narrows further.
    createDemoSession({ root, scenario: 'mention' })
    createDemoSession({ root, scenario: 'descriptor' })
    const one = removeDemoSessions({ root, scenario: 'mention', apply: true })
    assert.deepEqual(one.removed.map((entry) => entry.id), [demoSessionId('mention')])
    assert.equal(findDemoSessions({ root }).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}))

await test('a real session is never removable, even with a demo-looking id', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    // The exact scenario that would defeat a prefix match: a genuine session
    // whose id starts with the demo prefix. Ownership is proved by the marker,
    // so this must be invisible to cleanup.
    const impostorDir = join(root, '--D-real--', demoSessionId('mention'))
    mkdirSync(impostorDir, { recursive: true })
    writeFileSync(join(impostorDir, 'session.jsonl.zstd'), log([sessionHeader(0, demoSessionId('mention'))]))

    assert.deepEqual(findDemoSessions({ root }), [])
    const { removed, kept } = removeDemoSessions({ root, apply: true })
    assert.deepEqual(removed, [])
    assert.deepEqual(kept, [])
    assert.equal(existsSync(join(impostorDir, 'session.jsonl.zstd')), true, 'a real session must survive cleanup')

    // A hand-copied marker does not launder ownership either: it has to name the
    // directory it sits in.
    writeFileSync(join(impostorDir, 'session.diag-demo.json'), JSON.stringify({
      tool: 'dsh-sessions-diagnosis',
      kind: 'demo-session',
      sessionId: 'session-somewhere-else',
      source: { name: 'session.jsonl.zstd', sha256: 'x' }
    }))
    assert.deepEqual(findDemoSessions({ root }), [])
    assert.equal(existsSync(join(impostorDir, 'session.jsonl.zstd')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('a demo you have talked in is kept unless forced', () => withTempDshHome(async () => {
  const modules = await resolveDshFormatModules()
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    const created = createDemoSession({ root, scenario: 'mention' })

    // Stand in for DSH appending after a resume: the log now holds content this
    // tool did not write, so deleting it would destroy a real conversation.
    const grown = Buffer.concat([
      readFileSync(created.path),
      compressFrame('{"type":"turn/start","seq":900,"time":1,"data":{"turn":9}}\n')
    ])
    writeFileSync(created.path, grown)

    const [demo] = findDemoSessions({ root })
    assert.equal(demo.state, 'used')
    assert.equal(demo.removable, false)

    const guarded = removeDemoSessions({ root, apply: true })
    assert.deepEqual(guarded.removed, [], 'a used demo must not be deleted by default')
    assert.equal(guarded.kept.length, 1)
    assert.match(guarded.kept[0].detail, /modified after the demo was created/)
    assert.equal(existsSync(created.path), true)

    // --force is the explicit override.
    const forced = removeDemoSessions({ root, apply: true, force: true })
    assert.equal(forced.removed.length, 1)
    assert.equal(existsSync(created.path), false)

    // A repaired-but-untouched demo stays removable: we know exactly what is in it.
    if (modules !== undefined) {
      createDemoSession({ root, scenario: 'mention' })
      const entry = listSessions({ root }).sessions.find((s) => s.id === demoSessionId('mention'))
      const repaired = await repairSession(entry, { modules })
      assert.equal(repaired.ok, true, repaired.error)
      const afterRepair = findDemoSessions({ root })[0]
      assert.equal(afterRepair.state, 'repaired')
      assert.equal(afterRepair.removable, true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}))

// ────────────────────────────────────────────────────────────────────────────
// rules
// ────────────────────────────────────────────────────────────────────────────

const offendingRow = (seq) => ({
  type: 'user/message',
  seq,
  time: 1,
  data: {
    content: [{ type: 'text', text: '<workspace-reference path="blog" kind="directory" />' }],
    source: { kind: 'at-file-mention', relative: 'blog' },
    role: 'user',
    id: `m${seq}`
  },
  surfaceOp: 'append'
})

await test('the admitted source vocabulary matches DSH 0.1.5', () => {
  assert.equal(ADMITTED_MESSAGE_SOURCE_KINDS.size, 15)
  assert.ok(ADMITTED_MESSAGE_SOURCE_KINDS.has('user'))
  assert.ok(ADMITTED_MESSAGE_SOURCE_KINDS.has('agent-message'))
  assert.ok(!ADMITTED_MESSAGE_SOURCE_KINDS.has('at-file-mention'))
})

await test('rule 1 detects an unclassified message source', () => {
  const rows = [sessionHeader(0), offendingRow(7), { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } }]
  const findings = detectIssues(rows)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, 'unclassified-message-source')
  assert.equal(findings[0].seq, 7)
  assert.deepEqual(findings[0].before, { kind: 'at-file-mention', relative: 'blog' })
  assert.deepEqual(findings[0].after, { kind: 'user' })
})

await test('rule 1 rewrites only the offending sources, leaving content intact', () => {
  const rows = [sessionHeader(0), offendingRow(7), { type: 'user/message', seq: 8, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }]
  const before = JSON.parse(JSON.stringify(rows))
  const findings = detectIssues(rows)
  const { edits } = applyIssues(rows, findings)
  assert.equal(edits, 1)
  assert.deepEqual(rows[1].data.source, { kind: 'user' })
  assert.deepEqual(rows[1].data.content, before[1].data.content)
  assert.deepEqual(rows[1].data.id, before[1].data.id)
  assert.deepEqual(rows[2], before[2], 'a valid source must be untouched')
  assert.deepEqual(detectIssues(rows), [], 'the log must audit clean after the fix')
})

await test('rule 1 also covers the other four audited message slots', () => {
  const bad = { kind: 'at-file-mention', relative: 'x' }
  const rows = [
    sessionHeader(0),
    { type: 'assistant/message', seq: 0, data: { message: { source: { ...bad } } } },
    { type: 'tool/result', seq: 1, data: { message: { source: { ...bad } } } },
    { type: 'agent/inbox/spliced', seq: 2, data: { inserted: [{ source: { ...bad } }, { source: { kind: 'user' } }] } },
    { type: 'session/title-llm-request', seq: 3, data: { messages: [{ source: { ...bad } }] } }
  ]
  const findings = detectIssues(rows)
  assert.equal(findings.length, 4, 'every audited slot must be found')
  applyIssues(rows, findings)
  assert.deepEqual(detectIssues(rows), [])
})

await test('rule 2 detects a stale subagent/descriptor version', () => {
  const rows = [sessionHeader(0), { type: 'subagent/descriptor', seq: 4, time: 1, data: { mode: 'one-shot', version: 2, provider: 'p' } }]
  const findings = detectIssues(rows)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, 'subagent-descriptor-version')
  assert.equal(findings[0].before, 2)
  assert.equal(findings[0].after, 3)
  applyIssues(rows, findings)
  assert.equal(rows[1].data.version, 3)
  assert.equal(rows[1].data.provider, 'p', 'other members must be untouched')
})

await test('detection surfaces every known issue, and the low-risk subset is available for bulk work', () => {
  const rows = [sessionHeader(0), { type: 'subagent/descriptor', seq: 4, data: { mode: 'one-shot', version: 2, provider: 'p' } }]
  // A diagnosis must surface everything it can see...
  assert.equal(detectIssues(rows).length, 1)
  // ...and a repair runs whatever the session actually needs, so a session the
  // diagnosis called repairable is always actionable. The low-risk subset exists
  // only for callers that want the conservative set (a bulk sweep).
  assert.deepEqual(LOW_RISK_RULE_IDS, ['unclassified-message-source'])
  assert.equal(REPAIR_RULES.find((r) => r.id === 'subagent-descriptor-version').risk, 'medium')
  assert.ok(!LOW_RISK_RULE_IDS.includes('subagent-descriptor-version'))
})

await test('every rule declares a complete descriptor', () => {
  for (const rule of REPAIR_RULES) {
    assert.equal(typeof rule.id, 'string')
    assert.equal(typeof rule.title, 'string')
    assert.ok(['low', 'medium'].includes(rule.risk), `${rule.id} risk`)
    assert.ok(rule.rationale.length > 40, `${rule.id} needs a real rationale`)
    assert.equal(typeof rule.detect, 'function')
    assert.equal(typeof rule.apply, 'function')
  }
})

// ────────────────────────────────────────────────────────────────────────────
// end-to-end against a real broken session
// ────────────────────────────────────────────────────────────────────────────

if (!existsSync(BROKEN)) {
  await test('real-session tests', () => skip(`fixtures absent (${BROKEN}); run node test/fetch-fixtures.mjs`))
} else {
  const modules = await resolveDshFormatModules()

  await test('DSH\'s released format catalog is reachable', () => {
    assert.ok(modules !== undefined, 'could not resolve @deepseek-ai/dsh-session-format-catalog')
    assert.equal(modules.currentVersion, 3)
  })

  await test('the real broken session fails DSH\'s own migration', () => {
    const { rows } = decodeSessionLog(readFileSync(BROKEN))
    const probe = probeMigration(modules, rows)
    assert.equal(probe.ok, false)
    assert.equal(probe.errorName, 'SessionFormatUnsupportedMigrationError')
    assert.match(probe.errorMessage, /unclassified message source/)
  })

  await test('patching the source makes DSH\'s own migration succeed', () => {
    const { rows } = decodeSessionLog(readFileSync(BROKEN))
    const findings = detectIssues(rows)
    assert.ok(findings.length > 0)
    applyIssues(rows, findings)
    const probe = probeMigration(modules, rows)
    assert.equal(probe.ok, true, probe.errorMessage)
    assert.ok(probe.events > 0)
  })

  // DSH's restore transfers caller-owned parsed values through its stages
  // WITHOUT copying them, so a failed probe leaves them half-transformed and a
  // second probe on the same array reports a phantom "seq gap". probeMigration
  // must defend against that: every verdict in this tool depends on it.
  await test('probeMigration does not mutate the caller\'s rows and is repeatable', () => {
    const { rows } = decodeSessionLog(readFileSync(BROKEN))
    const snapshot = JSON.stringify(rows)

    const first = probeMigration(modules, rows)
    assert.equal(first.ok, false)
    assert.match(first.errorMessage, /unclassified message source/)
    assert.equal(JSON.stringify(rows), snapshot, 'a probe must not mutate its input')

    const second = probeMigration(modules, rows)
    assert.deepEqual(
      { ok: second.ok, errorName: second.errorName, errorMessage: second.errorMessage },
      { ok: first.ok, errorName: first.errorName, errorMessage: first.errorMessage },
      'a repeated probe must give the identical verdict, not a phantom sequence gap'
    )
    assert.doesNotMatch(second.errorMessage, /seq gap/)
  })

  await test('a probe after a failed probe still sees a genuinely repairable log', () => {
    const { rows } = decodeSessionLog(readFileSync(BROKEN))
    probeMigration(modules, rows)          // consume-and-fail
    applyIssues(rows, detectIssues(rows))  // then repair the same array
    const probe = probeMigration(modules, rows)
    assert.equal(probe.ok, true, probe.errorMessage)
  })

  await test('diagnoseStore classifies the broken session as repairable', async () => {
    const root = makeStore({
      [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN)
    })
    try {
      const report = await diagnoseStore({ root })
      const session = report.sessions[0]
      assert.equal(session.status, 'repairable', JSON.stringify(session.reasons))
      assert.equal(session.openable, false)
      assert.equal(session.repairable, true)
      assert.ok(session.findings.length > 0)
      assert.ok(report.summary.repairable === 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('repair publishes a verified v3 successor and leaves the source byte-identical', async () => {
    const original = readFileSync(BROKEN)
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: original })
    try {
      const { sessions } = listSessions({ root })
      const entry = sessions[0]
      const plan = planRepair(entry, { modules })
      assert.equal(plan.viable, true, plan.blockedBy)

      const result = await repairSession(entry, { modules })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.mode, REPAIR_MODES.PUBLISH)
      assert.match(result.wrote, /session\.v3\.jsonl\.zstd$/)
      assert.equal(result.verification.ok, true)
      assert.equal(result.verification.events > 0, true)

      // The released source generation must be untouched.
      assert.deepEqual(readFileSync(entry.selectedPath), original, 'the source generation must be byte-identical')

      // DSH must now select the successor and read it cleanly.
      const after = listSessions({ root }).sessions[0]
      assert.equal(after.highestVersion, 3)
      const { rows } = decodeSessionLog(readFileSync(after.selectedPath))
      assert.equal(rows[0].version, 3)
      for (const validation of ['transformed', 'current']) {
        const probe = probeMigration(modules, rows, { validation })
        assert.equal(probe.ok, true, `${validation}: ${probe.errorMessage}`)
      }

      // The repaired session must diagnose as healthy.
      const diagnosis = diagnoseEntry(after, { modules })
      assert.equal(diagnosis.status, 'ok', JSON.stringify(diagnosis.reasons))

      // A second repair must refuse rather than clobber.
      const second = await repairSession(after, { modules })
      assert.equal(second.ok, false)
      assert.match(second.error, /already at the current format/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('dry run writes nothing', async () => {
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN) })
    try {
      const entry = listSessions({ root }).sessions[0]
      const result = await repairSession(entry, { modules, dryRun: true })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.wrote, undefined)
      const files = readdirSync(entry.dir)
      assert.deepEqual(files, ['session.jsonl.zstd'], 'a dry run must not create files')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('a repair refuses to publish a generation whose name disagrees with its header', async () => {
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN) })
    try {
      const entry = listSessions({ root }).sessions[0]
      // A v2 build's chain produces v2 payloads. Here the codec in hand produces
      // v3 while claiming to be a v2 install, so neither name would be honest:
      // publishing anyway is how a mislabelled generation — the one thing DSH
      // refuses outright — would reach a session directory.
      const result = await repairSession(entry, { modules: { ...modules, currentVersion: 2 } })
      assert.equal(result.ok, false)
      assert.match(result.error, /mislabelled generation/)
      assert.deepEqual(readdirSync(entry.dir), ['session.jsonl.zstd'], 'no file may appear on failure')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('patch-source mode rewrites in place and keeps a backup', async () => {
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN) })
    try {
      const entry = listSessions({ root }).sessions[0]
      const result = await repairSession(entry, { modules, mode: REPAIR_MODES.PATCH_SOURCE })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.backupPath !== undefined)
      assert.equal(existsSync(result.backupPath), true)

      const { rows } = decodeSessionLog(readFileSync(entry.selectedPath))
      assert.equal(probeMigration(modules, rows).ok, true, 'the patched source must migrate')
      assert.deepEqual(readFileSync(result.backupPath), readFileSync(BROKEN), 'the backup must be the original bytes')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ── the safety guarantees, each asserted rather than assumed ──────────────

  await test('repair proves no conversation content was lost', async () => {
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN) })
    try {
      const entry = listSessions({ root }).sessions[0]
      const result = await repairSession(entry, { modules })
      assert.equal(result.ok, true, result.error)

      const preservation = result.preservation
      assert.ok(preservation !== undefined, 'a repair must report its content check')
      assert.equal(preservation.ok, true, `content was lost: ${JSON.stringify(preservation.missing)}`)
      assert.ok(preservation.sourceCount > 0, 'the check must actually have seen payloads')
      assert.deepEqual(preservation.missing, [])

      // Independently: re-read the published file and confirm, payload by
      // payload, that everything the source said is still there.
      const sourcePayloads = messagePayloadCounts(decodeSessionLog(readFileSync(entry.selectedPath)).rows)
      const targetPayloads = messagePayloadCounts(decodeSessionLog(readFileSync(result.wrote)).rows)
      for (const [payload, want] of sourcePayloads) {
        assert.ok((targetPayloads.get(payload) ?? 0) >= want, `lost payload: ${payload.slice(0, 120)}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('the content gate refuses a migration that drops or rewrites a payload', () => {
    const user = { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'keep me' }] } }
    const assistant = { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'and me' }] } } }

    // Everything preserved; the extra system head is a permitted addition.
    const kept = checkContentPreserved([user, assistant], [
      user, assistant,
      { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [] } } }
    ])
    assert.equal(kept.ok, true)
    assert.equal(kept.missing.length, 0)
    assert.equal(kept.addedCount, 1, 'additions are counted, not treated as loss')

    // A dropped assistant message must be caught.
    const lost = checkContentPreserved([user, assistant], [user])
    assert.equal(lost.ok, false)
    assert.equal(lost.missing.length, 1)
    assert.equal(lost.missing[0].label, 'assistant')

    // A message whose text was silently rewritten must also be caught.
    const rewritten = checkContentPreserved([user], [
      { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'different' }] } }
    ])
    assert.equal(rewritten.ok, false)
  })

  await test('rollback restores the exact pre-repair state, non-destructively', async () => {
    const original = readFileSync(BROKEN)
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: original })
    try {
      const entry = listSessions({ root }).sessions[0]
      const repair = await repairSession(entry, { modules })
      assert.equal(repair.ok, true, repair.error)
      const published = readFileSync(repair.wrote)

      const afterRepair = listSessions({ root }).sessions[0]
      assert.equal(afterRepair.highestVersion, 3)

      const rollback = rollbackSession(afterRepair)
      assert.equal(rollback.ok, true, rollback.error)
      assert.equal(existsSync(repair.wrote), false, 'the successor must no longer be a canonical generation')

      // The session is back to exactly its pre-repair selection.
      const afterRollback = listSessions({ root }).sessions[0]
      assert.equal(afterRollback.highestVersion, 0)
      assert.deepEqual(readFileSync(afterRollback.selectedPath), original, 'the source must still be byte-identical')

      // Nothing was destroyed: the rolled-back successor is still on disk.
      assert.deepEqual(readFileSync(rollback.rolledBack), published, 'the rolled-back file must be intact')
      const names = readdirSync(afterRollback.dir)
      assert.ok(names.some((n) => n.includes('diag-rolled-back')), 'the successor must be preserved, not deleted')
      assert.ok(!names.includes('session.diag-repair.json'), 'the manifest must be cleared')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('rollback refuses once the session was used after the repair', async () => {
    const root = makeStore({ [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN) })
    try {
      const entry = listSessions({ root }).sessions[0]
      const repair = await repairSession(entry, { modules })
      assert.equal(repair.ok, true, repair.error)

      // Stand in for DSH appending to the current generation after a resume: any
      // change to the published bytes must block a rollback, because the new
      // history would be lost.
      const grown = Buffer.concat([
        readFileSync(repair.wrote),
        compressFrame('{"type":"turn/start","seq":999999,"time":1,"data":{}}\n')
      ])
      writeFileSync(repair.wrote, grown)

      const after = listSessions({ root }).sessions[0]
      const before = readdirSync(after.dir).sort()
      const rollback = rollbackSession(after)
      assert.equal(rollback.ok, false)
      assert.match(rollback.error, /has changed since the repair/)
      assert.deepEqual(readdirSync(after.dir).sort(), before, 'a refused rollback must change nothing')
      assert.deepEqual(readFileSync(repair.wrote), grown, 'the newer generation must be untouched')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('rollback refuses a successor this tool did not publish', async () => {
    // A session DSH migrated on its own: a v3 sibling exists, but no manifest
    // explains it, so removing it could discard history.
    const root = makeStore({
      [`--C-test--/${FIXTURE_ID}/session.jsonl.zstd`]: readFileSync(BROKEN),
      [`--C-test--/${FIXTURE_ID}/session.v3.jsonl.zstd`]: log([sessionHeader(3, FIXTURE_ID)])
    })
    try {
      const entry = listSessions({ root }).sessions[0]
      const before = readdirSync(entry.dir).sort()
      const rollback = rollbackSession(entry)
      assert.equal(rollback.ok, false)
      assert.match(rollback.error, /no repair manifest/)
      assert.deepEqual(readdirSync(entry.dir).sort(), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('the agent tool can repair and then roll back, and reports the safety evidence', async () => {
    const host = await import('../lib/index.js')
    const tools = []
    host.apply({
      effect: (fn) => fn(),
      tools: { register: (definition) => { tools.push(definition); return () => {} } },
      inject: () => {}
    }, {})
    const repairTool = tools.find((t) => t.name === 'session_repair')

    const original = readFileSync(BROKEN)
    const home = makeStore({ 'sessions/--C-test--/session-tool/session.jsonl.zstd': original })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const signal = new AbortController().signal

      // Dry run first: writes nothing and says so.
      const plan = await repairTool.execute({ id: 'session-tool' }, { signal })
      assert.equal(plan.ok, true, plan.error)
      assert.equal(plan.dryRun, true)
      assert.equal(plan.wrote, undefined)
      assert.match(plan.report, /Nothing was written/)

      const applied = await repairTool.execute({ id: 'session-tool', apply: true }, { signal })
      assert.equal(applied.ok, true, applied.error)
      assert.equal(applied.preservation.ok, true)
      assert.match(applied.report, /Content preserved/)
      assert.match(applied.report, /rollback/)
      assert.deepEqual(readFileSync(
        join(home, 'sessions', '--C-test--', 'session-tool', 'session.jsonl.zstd')), original)

      const undone = await repairTool.execute({ id: 'session-tool', action: 'rollback' }, { signal })
      assert.equal(undone.ok, true, undone.error)
      assert.equal(undone.restoredTo.includes('session.jsonl.zstd'), true)
      assert.deepEqual(readFileSync(
        join(home, 'sessions', '--C-test--', 'session-tool', 'session.jsonl.zstd')), original)

      // Rolling back again has nothing left to undo.
      const again = await repairTool.execute({ id: 'session-tool', action: 'rollback' }, { signal })
      assert.equal(again.ok, false)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// negative cases
// ────────────────────────────────────────────────────────────────────────────

await test('a session missing events is reported as damaged, not repairable', async () => {
  // Sequence numbers jump from 0 to 5: rows are genuinely absent.
  const rows = [
    sessionHeader(0),
    { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 5, time: 2, data: { turn: 1, step: 2 } }
  ]
  const root = makeStore({ '--C-test--/session-gap/session.jsonl.zstd': log(rows) })
  try {
    const modules = await resolveDshFormatModules()
    if (modules === undefined) return skip('DSH format catalog unavailable')
    const report = await diagnoseStore({ root })
    const session = report.sessions[0]
    assert.notEqual(session.status, 'repairable')
    assert.equal(session.openable, false)
    assert.ok(session.reasons.some((r) => r.severity === 'error'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('a session from a newer harness is reported as too new, not damaged', async () => {
  const root = makeStore({ '--C-test--/session-new/session.v9.jsonl.zstd': log([sessionHeader(9, 'session-new')]) })
  try {
    const report = await diagnoseStore({ root, probe: false })
    const session = report.sessions[0]
    assert.equal(session.status, 'too-new')
    assert.match(session.reasons.find((r) => r.code === 'FORMAT_TOO_NEW').summary, /reads only v3/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('a healthy current-format session diagnoses as ok', async () => {
  // This case lives outside the `existsSync(BROKEN)` gate above, so it must
  // check for itself: the read has to come after the skip, or a bare checkout
  // fails with ENOENT instead of skipping like every other real-session test.
  if (!existsSync(BROKEN)) return skip(`fixtures absent (${BROKEN}); run node test/fetch-fixtures.mjs`)
  const body = readFileSync(BROKEN)
  const modules = await resolveDshFormatModules()
  if (modules === undefined) return skip('DSH format catalog unavailable')

  const { rows } = decodeSessionLog(body)
  const findings = detectIssues(rows)
  applyIssues(rows, findings)
  const probe = probeMigration(modules, rows)
  if (!probe.ok) return skip('fixture did not migrate')

  const encoded = encodeSessionLog([
    modules.catalog.encodeCurrentHeader(probe.artifact.header, probe.artifact.inheritedEventCount),
    ...probe.artifact.events.map((e) => modules.catalog.encodeCurrentEvent(e))
  ])
  const root = makeStore({ '--C-test--/session-ok/session.v3.jsonl.zstd': encoded })
  try {
    const report = await diagnoseStore({ root })
    const session = report.sessions[0]
    assert.equal(session.status, 'ok', JSON.stringify(session.reasons))
    assert.equal(session.openable, true)
    assert.equal(report.summary.ok, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// an environment with no format codec is not a store full of broken sessions
// ────────────────────────────────────────────────────────────────────────────

/** An older-format log carrying a source kind the released rule can rewrite. */
const olderLogRows = (id) => [
  sessionHeader(0, id),
  {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: { role: 'user', content: 'hi', source: { kind: 'at-file-mention', relative: 'a.txt' } }
  }
]

await test('a log that was never checked is unknown, never unrepairable', async () => {
  // The regression this pins: with no codec reachable, `openable` was computed as
  // "not migrated", so every older log came back `unrepairable` with "no known
  // repair rule" — a whole store of sessions accused of failing while the user's
  // own (older) DSH opens every one of them. Nothing was checked, so nothing may
  // be claimed.
  const root = makeStore({ '--C-test--/session-unchecked/session.jsonl.zstd': log(olderLogRows('session-unchecked')) })
  try {
    const entry = listSessions({ root }).sessions[0]
    const diagnosis = diagnoseEntry(entry, { modules: undefined })

    assert.equal(diagnosis.codecAvailable, false)
    assert.equal(diagnosis.status, 'unknown', JSON.stringify(diagnosis.reasons))
    assert.equal(diagnosis.openable, false, 'openable means proven openable')
    assert.equal(diagnosis.repairable, false)
    assert.ok(diagnosis.reasons.some((reason) => reason.code === 'CODEC_UNAVAILABLE'))
    assert.equal(diagnosis.reasons.some((reason) => reason.code === 'NO_KNOWN_RULE'), false,
      'an unchecked log must not be accused of matching no rule')

    // The store-wide path and its summary have to agree with the single diagnosis.
    const report = await diagnoseStore({ root, probe: false })
    assert.equal(report.codecAvailable, false)
    assert.equal(report.summary.unknown, 1)
    assert.equal(report.summary.unrepairable, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('the same log is checked, not unknown, once the codec is reachable', async () => {
  const modules = await resolveDshFormatModules()
  if (modules === undefined) return skip('DSH format catalog unavailable')

  const root = makeStore({ '--C-test--/session-checked/session.jsonl.zstd': log(olderLogRows('session-checked')) })
  try {
    const entry = listSessions({ root }).sessions[0]
    const diagnosis = diagnoseEntry(entry, { modules })

    assert.equal(diagnosis.codecAvailable, true)
    assert.notEqual(diagnosis.status, 'unknown')
    assert.equal(diagnosis.reasons.some((reason) => reason.code === 'CODEC_UNAVAILABLE'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('a repair targets the version the installed codec reads, not the tool\'s own', () => {
  const root = makeStore({ '--C-test--/session-target/session.jsonl.zstd': log(olderLogRows('session-target')) })
  try {
    const entry = listSessions({ root }).sessions[0]

    // An older DSH reads v2: the successor must be named for the version its own
    // chain produces, or DSH gets a filename/header disagreement it refuses.
    const installed = planRepair(entry, { modules: { currentVersion: 2 } })
    assert.equal(installed.viable, true, installed.blockedBy)
    assert.match(installed.targetPath, /session\.v2\.jsonl\.zstd$/)

    // With nothing resolved at all, the tool's own constant is still the fallback.
    const fallback = planRepair(entry, {})
    assert.match(fallback.targetPath, /session\.v3\.jsonl\.zstd$/)

    // A log already at the installed version has nothing to publish.
    const current = planRepair(entry, { modules: { currentVersion: 0 } })
    assert.equal(current.viable, false)
    assert.match(current.blockedBy, /already at the current format v0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// synthetic demo sessions, end to end
// ────────────────────────────────────────────────────────────────────────────

await test('the mention demo reproduces the real failure and repairs cleanly', async () => {
  const modules = await resolveDshFormatModules()
  if (modules === undefined) return skip('DSH format catalog unavailable')

  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    const created = createDemoSession({ root, scenario: 'mention' })

    // It must be a genuine v0 log that DSH refuses for the real reason.
    const rows = decodeSessionLog(readFileSync(created.path)).rows
    assert.equal(rows[0].version, 0)
    const before = probeMigration(modules, rows)
    assert.equal(before.ok, false, 'the demo must actually be broken')
    assert.match(before.errorMessage, /unclassified message source/)

    // And the ordinary repair path must fix it, with content preserved.
    const report = await diagnoseStore({ root })
    assert.equal(report.sessions[0].status, 'repairable', JSON.stringify(report.sessions[0].reasons))

    const result = await repairSession(listSessions({ root }).sessions[0], { modules })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.preservation.ok, true)
    assert.ok(result.preservation.sourceCount > 0)

    const after = await diagnoseStore({ root })
    assert.equal(after.sessions[0].status, 'ok', JSON.stringify(after.sessions[0].reasons))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('the descriptor demo repairs by default, and says that it edits metadata', async () => {
  const modules = await resolveDshFormatModules()
  if (modules === undefined) return skip('DSH format catalog unavailable')

  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    const created = createDemoSession({ root, scenario: 'descriptor' })
    const rows = decodeSessionLog(readFileSync(created.path)).rows
    const before = probeMigration(modules, rows)
    assert.equal(before.ok, false)
    assert.match(before.errorMessage, /unsupported descriptor version 2/)

    const entry = listSessions({ root }).sessions[0]

    // A diagnosis that reports "repairable" must be actionable: the repair has to
    // run the rule the diagnosis validated, not refuse it as "not enabled".
    const automatic = await repairSession(entry, { modules, dryRun: true })
    assert.equal(automatic.ok, true, automatic.error)
    assert.deepEqual(automatic.risks, ['medium'])
    assert.match((automatic.warnings ?? []).join(' '), /recorded metadata/)

    // Restricting to the conservative subset must name what is missing rather
    // than claim that nothing matches.
    const restricted = await repairSession(entry, { modules, dryRun: true, rules: LOW_RISK_RULE_IDS })
    assert.equal(restricted.ok, false)
    assert.match(restricted.error, /excludes the rule this session needs: subagent-descriptor-version/)
    assert.doesNotMatch(restricted.error, /no known repair rule matches/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('a demo session lands in the directory DSH itself would choose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
  try {
    // A recorded cwd must produce the same project directory DSH encodes, so a
    // demo appears under the right project rather than in a stray one.
    const created = createDemoSession({ root, scenario: 'mention', cwd: 'D:\\work' })
    assert.equal(created.dir, join(root, '--D-work--', created.id))
    assert.equal(existsSync(created.path), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// plugin halves
// ────────────────────────────────────────────────────────────────────────────

await test('host half exports the cordis plugin contract', async () => {
  const host = await import('../lib/index.js')
  assert.equal(host.name, 'dsh-sessions-diagnosis')
  assert.deepEqual(host.inject, ['tools'])
  assert.equal(typeof host.apply, 'function')
})

await test('host half registers three tools with valid schemas', async () => {
  const host = await import('../lib/index.js')
  const registered = []
  const effects = []
  const ctx = {
    effect: (fn, label) => { effects.push(label); return fn() },
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    // A headless profile has no web server: apply() must tolerate that.
    inject: (names, cb) => { assert.deepEqual(names, ['webServer']); assert.equal(typeof cb, 'function') }
  }
  host.apply(ctx, {})

  assert.deepEqual(registered.map((t) => t.name).sort(),
    ['session_diagnose', 'session_repair', 'session_store_overview'])
  assert.equal(effects.length, 3, 'each tool must be registered inside ctx.effect')

  for (const tool of registered) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema.type, 'string')
    assert.equal(typeof tool.execute, 'function')
    // render() must be a pure projection returning ContentBlock[].
    const blocks = tool.output.render({}, { report: 'hello' })
    assert.ok(Array.isArray(blocks) && blocks[0].type === 'text')
  }

  // Repair must default to a dry run: an agent must not be able to write on a
  // bare call with no explicit confirmation flag.
  const repair = registered.find((t) => t.name === 'session_repair')
  assert.deepEqual(repair.parameters.required, ['id'])
  assert.equal(repair.parameters.properties.apply.type, 'boolean')
})

await test('host half overview tool works against a real store tree', async () => {
  const host = await import('../lib/index.js')
  // The plugin resolves the store as $DSH_HOME/sessions, so the fixture is laid
  // out as a DSH home with a sessions/ child.
  const home = makeStore({
    'sessions/--C-test--/session-a/session.jsonl.zstd': log([sessionHeader(0, 'session-a')]),
    'sessions/--C-test--/session-b/session.v3.jsonl.zstd': log([sessionHeader(3, 'session-b')])
  })
  try {
    const registered = []
    host.apply({
      effect: (fn) => fn(),
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      inject: () => {}
    }, {})

    const overview = registered.find((t) => t.name === 'session_store_overview')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const value = await overview.execute({}, { signal: new AbortController().signal })
      assert.equal(value.total, 2)
      assert.match(value.report, /2 session\(s\)/)
      assert.match(value.report, /1 older/)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('client half is a classic script that registers one settings panel', async () => {
  const source = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, /id: 'dsh-sessions-diagnosis'/)

  // Materialize the factory against a stubbed loader and React, exactly as the
  // web shell would, and assert what it contributes.
  const registrations = []
  const injections = []
  let captured
  const windowStub = {
    __ModuleLoader__: {
      load: (registration) => { captured = registration }
    }
  }
  const React = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    Fragment: 'fragment'
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'navigator', 'fetch', source)
  run(windowStub, { language: 'en-US' }, () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }))

  assert.equal(captured.id, 'dsh-sessions-diagnosis')
  const exports = captured.factory((spec) => {
    assert.equal(spec, 'react', 'the client bundle may only require seed specifiers')
    return React
  })
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')

  exports.apply({
    slots: {
      inject: (key, cb) => { injections.push(key); cb() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} }
    }
  })

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'sessions-diagnosis')
  assert.equal(registrations[0].options.order, 320)
  assert.equal(typeof registrations[0].component, 'function')
})

/**
 * A minimal React for the panel tests below.
 *
 * The bundle is a classic script whose only shell dependency is React, so the
 * smallest faithful stand-in is a `createElement` producing an inspectable node
 * plus the four hooks the panel uses, backed by a per-component slot store.
 * That is enough to mount the real component, run its effects, dispatch a click
 * and read the resulting tree —which lets a test pin layout behaviour (a
 * verdict that must not wrap, a detail panel that must open in place) instead
 * of matching source text.
 *
 * @returns {object} the React stand-in, plus `render`, `flush`, `nodes` and `text`.
 */
function createMiniReact () {
  const stores = new Map()
  let active

  const sameDeps = (left, right) =>
    left.length === right.length && left.every((dep, index) => dep === right[index])

  /** The hook store of one component type, created on first render. */
  const storeFor = (key) => {
    let store = stores.get(key)
    if (store === undefined) {
      store = { slots: [], cursor: 0 }
      stores.set(key, store)
    }
    return store
  }

  /** Claim (or create) the slot belonging to one hook call. */
  const slot = (kind, initial) => {
    const store = active
    const index = store.cursor++
    let entry = store.slots[index]
    if (entry === undefined || entry.kind !== kind) {
      entry = { kind, value: kind === 'ref' ? { current: initial } : initial, deps: undefined, run: undefined }
      store.slots[index] = entry
    }
    return entry
  }

  /** Run this component's pending effects, in hook order. */
  const runEffects = (store) => {
    for (const entry of store.slots) {
      if (entry?.kind !== 'effect' || entry.run === undefined) continue
      const run = entry.run
      entry.run = undefined
      run()
    }
  }

  /** Render one component with its own hook store, then walk what it returned. */
  const renderComponent = (type, props) => {
    const store = storeFor(type)
    active = store
    store.cursor = 0
    const rendered = settle(type(props))
    runEffects(store)
    return rendered
  }

  /** Replace function components with what they render, keeping elements as data. */
  const settle = (node) => {
    if (Array.isArray(node)) return node.map(settle)
    if (node === null || typeof node !== 'object') return node
    // A fragment is not an element: it contributes its children and nothing else.
    if (node.type === React.Fragment) return node.children.map(settle)
    if (typeof node.type === 'function') return renderComponent(node.type, node.props)
    return { type: node.type, props: node.props, children: node.children.map(settle) }
  }

  const React = {
    Fragment: Symbol('react.fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const entry = slot('state', initial)
      return [entry.value, (next) => { entry.value = typeof next === 'function' ? next(entry.value) : next }]
    },
    useRef: (initial) => slot('ref', initial).value,
    useCallback: (fn, deps) => {
      const entry = slot('callback', fn)
      if (deps !== undefined && entry.deps !== undefined && sameDeps(entry.deps, deps)) return entry.value
      entry.value = fn
      entry.deps = deps === undefined ? undefined : [...deps]
      return entry.value
    },
    useEffect: (fn, deps) => {
      const entry = slot('effect', undefined)
      if (deps !== undefined && entry.deps !== undefined && sameDeps(entry.deps, deps)) return
      entry.deps = deps === undefined ? undefined : [...deps]
      entry.run = fn
    }
  }

  return {
    React,
    /** Mount (or re-render) a root component and commit what it returns. */
    render (Component) {
      active = storeFor(Component)
      active.cursor = 0
      const tree = settle(Component())
      runEffects(active)
      return tree
    },
    /** Let resolved promises land, so a fetch continuation can update state. */
    async flush () {
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    },
    /** Every element node in a tree, depth first. */
    nodes (tree, found = []) {
      if (Array.isArray(tree)) {
        for (const child of tree) this.nodes(child, found)
        return found
      }
      if (tree === null || typeof tree !== 'object') return found
      found.push(tree)
      for (const child of tree.children) this.nodes(child, found)
      return found
    },
    /** A node's element children, with render arrays (`map` results) flattened. */
    children (node) {
      const found = []
      const push = (child) => {
        if (Array.isArray(child)) {
          for (const item of child) push(item)
          return
        }
        if (child !== null && typeof child === 'object') found.push(child)
      }
      for (const child of node.children) push(child)
      return found
    },
    /** All text inside a node, for identifying a row or a button by its label. */
    text (node) {
      if (typeof node === 'string') return node
      if (Array.isArray(node)) return node.map((child) => this.text(child)).join('')
      if (node === null || typeof node !== 'object') return ''
      return node.children.map((child) => this.text(child)).join('')
    }
  }
}

/**
 * A two-session scan report and the detail one of them diagnoses to.
 *
 * The shape is what `/scan` really answers with: a `Diagnosis` *names* the
 * generation it selected. It carries no `highestVersion`, which is exactly the
 * field the Version column used to read — and printed as "vundefined" for every
 * row. The regression test below drives the real route so the two halves cannot
 * agree with each other and with nothing else.
 */
const PANEL_SESSIONS = [
  {
    id: 'session-ok-one',
    projectDir: '--D-one--',
    status: 'ok',
    selected: { name: 'session.jsonl.zstd', version: 3, compression: 'zstd', sizeBytes: 8192 },
    reasons: [],
    repairable: false
  },
  {
    id: 'session-broken-two',
    projectDir: '--D-two--',
    status: 'repairable',
    selected: { name: 'session.jsonl.zstd', version: 0, compression: 'zstd', sizeBytes: 1316 },
    repairable: true,
    reasons: [{ code: 'unclassified-message-source', summary: 'a source kind DSH no longer admits' }]
  }
]
const PANEL_REPORT = {
  root: 'D:\\store',
  codecAvailable: true,
  summary: { total: 2, ok: 1, unmigrated: 0, repairable: 1, unrepairable: 0, corrupt: 0, tooNew: 0, empty: 0 },
  sessions: PANEL_SESSIONS
}
const PANEL_DETAIL = {
  id: 'session-broken-two',
  status: 'repairable',
  headline: 'A known rule can fix this session.',
  openable: false,
  repairable: true,
  generations: [],
  foreign: [],
  reasons: [{
    code: 'unclassified-message-source',
    summary: 'a source kind DSH no longer admits',
    severity: 'error'
  }],
  findings: []
}

/**
 * Mount the real settings panel over a stubbed dashboard API.
 *
 * @param {object} [report] - the `/scan` payload to answer with. A test that must
 *   not be able to disagree with the API passes the payload the real route
 *   produced, rather than a hand-written one.
 * @returns {Promise<object>} the mini-React harness, the mounted panel, the tree
 *   it last rendered, and the endpoint list it requested.
 */
async function mountPanel (report = PANEL_REPORT) {
  const source = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
  const mini = createMiniReact()

  let captured
  const requested = []
  const windowStub = { __ModuleLoader__: { load: (registration) => { captured = registration } } }
  const fetchStub = (url) => {
    const target = String(url)
    requested.push(target)
    return Promise.resolve({
      ok: true,
      // A diagnosis answers for the session that was asked about, as the real
      // API does: the panel matches a detail to its row by id.
      json: () => Promise.resolve(target.includes('/diagnose')
        ? { ...PANEL_DETAIL, id: decodeURIComponent(target.slice(target.indexOf('id=') + 3)) }
        : report)
    })
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'navigator', 'fetch', source)
  run(windowStub, { language: 'en-US' }, fetchStub)
  assert.equal(captured.id, 'dsh-sessions-diagnosis')

  let Panel
  captured.factory((spec) => {
    assert.equal(spec, 'react', 'the client bundle may only require seed specifiers')
    return mini.React
  }).apply({
    slots: {
      inject: (key, cb) => cb(),
      register: (options, component) => { Panel = component; return () => {} }
    }
  })

  const harness = { mini, requested, tree: null }
  /** Re-render and return the committed tree, remembered for the helpers below. */
  harness.draw = () => {
    harness.tree = mini.render(Panel)
    return harness.tree
  }
  /** Every clickable button inside the row that names `id`. */
  harness.buttons = (id) => {
    const row = mini.nodes(harness.tree).find((node) =>
      node.type === 'tr' && mini.text(node).includes(id))
    assert.ok(row !== undefined, `no row for ${id}`)
    return mini.nodes(row).filter((node) => node.type === 'button')
  }
  /** Click one labelled button in that row. */
  harness.click = (id, label) => {
    const target = harness.buttons(id).find((node) => mini.text(node) === label)
    assert.ok(target !== undefined, `${id}: no "${label}" button among ${harness.buttons(id).map((n) => mini.text(n)).join(', ')}`)
    target.props.onClick()
  }
  /** The expanded detail row, or undefined when nothing is open. */
  harness.detailRow = () =>
    mini.nodes(harness.tree).find((node) => node.type === 'td' && node.props.colSpan === 4)

  harness.draw()
  await mini.flush()
  harness.draw()
  return harness
}

/**
 * The dashboard route handler, mounted the way `dsh web` mounts it.
 *
 * @param {any} config - the plugin config, e.g. `{ dshHome }`, so the API reads
 *   the store the test named instead of whichever one it happens to be pointed at.
 * @returns {Promise<(req: any, res: any) => void>} the route handler.
 */
async function mountApi (config) {
  const host = await import('../lib/index.js')
  let handler
  host.apply({
    effect: (fn) => fn(),
    tools: { register: () => () => {} },
    inject: (names, cb) => cb({ effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; return () => {} } } })
  }, config)
  assert.equal(typeof handler, 'function', 'the plugin must register its dashboard route')
  return handler
}

/**
 * GET a dashboard route through that handler.
 *
 * @param {(req: any, res: any) => void} handler - the route handler.
 * @param {string} route - the path after the API prefix, e.g. `/scan`.
 * @returns {Promise<any>} the parsed JSON body.
 */
async function apiGet (handler, route) {
  return await new Promise((resolve, reject) => {
    const res = {
      writeHead: () => {},
      end: (body) => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`${route} did not answer with JSON: ${error.message}`))
        }
      }
    }
    handler({ method: 'GET', url: `/sessions-diagnosis/api${route}`, headers: { host: '127.0.0.1:3080' } }, res)
  })
}

await test('a verdict label is never wrapped, and the session column keeps the width', async () => {
  const { mini, tree, requested } = await mountPanel()
  assert.ok(requested.some((url) => url.endsWith('/scan')), 'mounting the panel must scan the store')

  // Four columns, not five: at the panel's real ~528px a separate "reason"
  // column left the 44-character session id about 200px and split it three ways.
  const headerCells = mini.nodes(tree).filter((node) => node.type === 'th')
  assert.equal(headerCells.length, 4)
  assert.equal(headerCells[0].props.style.width, '100%', 'the session column must absorb the leftover width')
  for (const index of [1, 2, 3]) {
    assert.equal(headerCells[index].props.style.whiteSpace, 'nowrap', `header cell ${index} must not wrap`)
    assert.equal(headerCells[index].props.style.width, '1%', `header cell ${index} must size to its content`)
  }

  for (const session of PANEL_SESSIONS) {
    const row = mini.nodes(tree).find((node) => node.type === 'tr' && mini.text(node).includes(session.id))
    const cells = mini.children(row).filter((child) => child.type === 'td')
    assert.equal(cells.length, 4)
    // "正常" is two characters: a column that can break anywhere renders it as
    // one character per line, which is what made the list unreadable.
    assert.equal(cells[1].props.style.whiteSpace, 'nowrap', `${session.id}: the verdict cell must not wrap`)
    const badge = mini.nodes(cells[1]).find((node) => node.type === 'span' && node.props.style.borderRadius === 999)
    assert.equal(badge.props.style.whiteSpace, 'nowrap', `${session.id}: the badge itself must not wrap`)
    assert.equal(badge.props.style.display, 'inline-block', `${session.id}: the badge must size to its label`)
    assert.equal(cells[2].props.style.whiteSpace, 'nowrap', `${session.id}: the version cell must not wrap`)

    // The id shares its cell with the reason it is broken, and may only break
    // inside a token as a last resort —`anywhere` split long ids per character.
    const cell = mini.nodes(cells[0]).find((node) => node.props.style?.overflowWrap !== undefined)
    assert.equal(cell.props.style.overflowWrap, 'break-word', `${session.id}: a long id must break at its hyphens`)
    assert.equal(cell.props.style.maxWidth, undefined, `${session.id}: the id must not be capped in width`)
    for (const reason of session.reasons.slice(0, 2)) {
      assert.ok(mini.text(cells[0]).includes(reason.code), `${session.id}: ${reason.code} must sit with the id`)
    }
  }
})

await test('the version column names the generation /scan reports, never "vundefined"', async () => {
  // The column used to read `session.highestVersion`, a field `/scan` has never
  // sent, so every row rendered "vundefined". Driving the real route over a real
  // store and rendering the payload it really produced is the only version of
  // this test that cannot drift: a hand-written fixture can agree with the panel
  // and with nothing else.
  await withTempDshHome(async (home) => {
    const created = createDemoSession({ root: join(home, 'sessions'), scenario: 'mention' })
    const report = await apiGet(await mountApi({ dshHome: home }), '/scan')
    const session = report.sessions.find((entry) => entry.id === created.id)
    assert.ok(session !== undefined, 'the store scan must list the session it holds')

    const { mini, tree } = await mountPanel(report)
    const row = mini.nodes(tree).find((node) => node.type === 'tr' && mini.text(node).includes(session.id))
    assert.ok(row !== undefined, `no row for ${session.id}`)
    const cells = mini.children(row).filter((child) => child.type === 'td')
    assert.equal(mini.text(cells[2]), `v${session.selected.version}`)
    assert.equal(mini.text(cells[2]), 'v0', 'the demo log is a v0 generation')

    // A session directory with no canonical file has no artifact at all, so the
    // column says so rather than naming a version that does not exist.
    const { mini: bare, tree: bareTree } = await mountPanel({
      ...report,
      sessions: [{
        id: 'session-no-artifact',
        projectDir: '--D-none--',
        status: 'empty',
        reasons: [{ code: 'NO_ARTIFACT', summary: 'the session directory holds no readable session log' }],
        repairable: false
      }]
    })
    const bareRow = bare.nodes(bareTree).find((node) => node.type === 'tr' && bare.text(node).includes('session-no-artifact'))
    assert.ok(bareRow !== undefined, 'no row for the session with no artifact')
    const bareCells = bare.children(bareRow).filter((child) => child.type === 'td')
    assert.equal(bare.text(bareCells[2]), '—')
    assert.ok(!bare.text(bareTree).includes('undefined'), 'an absent field must never be rendered')
  })
})

await test('a session detail opens in its own table row, not above the table', async () => {
  const { mini, requested, draw, click, detailRow } = await mountPanel()

  assert.equal(detailRow(), undefined, 'nothing is expanded before a session is inspected')

  click('session-broken-two', 'Inspect')
  await mini.flush()
  let tree = draw()

  assert.ok(requested.some((url) => url.includes('/diagnose?id=session-broken-two')))
  const tbody = mini.nodes(tree).find((node) => node.type === 'tbody')
  const bodyRows = mini.children(tbody).filter((child) => child.type === 'tr')
  assert.equal(bodyRows.length, PANEL_SESSIONS.length + 1, 'the detail is one extra row in the same table body')

  // It is the LAST row, directly under the session it belongs to: the user
  // never has to scroll somewhere else to read it.
  const expanded = bodyRows.at(-1)
  assert.ok(mini.text(bodyRows.at(-2)).includes('session-broken-two'))
  assert.ok(mini.text(expanded).includes('A known rule can fix this session.'))
  assert.equal(detailRow().props.colSpan, 4)

  // It renders inside the table, i.e. below the list, not between the summary
  // card and the table (where it used to appear, at the top of the page).
  const table = mini.nodes(tree).find((node) => node.type === 'table')
  assert.ok(mini.nodes(table).some((node) => mini.text(node).includes('A known rule can fix this session.')))
  const cards = mini.nodes(tree).filter((node) => node.props.style?.borderLeft === '3px solid #0891b2')
  assert.equal(cards.length, 1, 'exactly one detail panel is rendered')
  assert.ok(mini.nodes(table).includes(cards[0]), 'the detail panel must live inside the table')
  assert.ok(mini.text(table).includes('Repair this session'), 'the detail keeps its own repair action')

  // The open row stays marked, and its button now reads as a toggle.
  const openRow = mini.nodes(tree).find((node) => node.type === 'tr' && mini.text(node).includes('session-broken-two'))
  assert.equal(openRow.props.style.background, 'rgba(127,127,127,.10)')
  assert.deepEqual(mini.nodes(openRow).filter((node) => node.type === 'button').map((node) => mini.text(node)),
    ['Hide', 'Repair'])

  // Clicking it again collapses the detail.
  click('session-broken-two', 'Hide')
  tree = draw()
  assert.equal(detailRow(), undefined, 'the toggle must close the detail again')
  assert.equal(mini.nodes(tree).filter((node) => node.type === 'tr').length, PANEL_SESSIONS.length + 1)
})

await test('opening a detail scrolls only the few pixels it needs, never back to the top', async () => {
  const { mini, draw, click } = await mountPanel()

  click('session-broken-two', 'Inspect')
  await mini.flush()
  let tree = draw()

  // The ref the panel put on its detail card, wired to a stand-in element.
  const card = mini.nodes(tree).find((node) => node.props.ref !== undefined && typeof node.props.ref === 'object')
  assert.ok(card !== undefined, 'the detail card must expose a ref so it can be brought into view')
  const scrolled = []
  card.props.ref.current = { scrollIntoView: (options) => scrolled.push(options) }

  // Switching to another session re-runs the effect against the live element.
  click('session-ok-one', 'Inspect')
  await mini.flush()
  tree = draw()

  // `nearest` scrolls the minimum: the panel is in the row the user just
  // clicked, so nothing should jump the list back to the top.
  assert.deepEqual(scrolled, [{ block: 'nearest' }])

  const tbody = mini.nodes(tree).find((node) => node.type === 'tbody')
  const bodyRows = mini.children(tbody).filter((child) => child.type === 'tr')
  assert.ok(mini.text(bodyRows.at(-2)).includes('session-ok-one'), 'the detail moved to the newly opened row')
  assert.equal(bodyRows.length, PANEL_SESSIONS.length + 1, 'only one detail row is ever open')
})

await test('the panel explains every verdict the diagnosis can emit', async () => {
  // Both the guide and the badges have to cover the engine's whole vocabulary,
  // not a list somebody retyped: `empty` is the verdict every hand-maintained
  // list in this repo had lost. Driving the panel with one session per status
  // also proves each verdict renders a badge, so a new status cannot arrive
  // unexplained.
  const summary = { total: DIAGNOSIS_STATUSES.length }
  for (const status of DIAGNOSIS_STATUSES) {
    // `/scan` spells this one `tooNew`; the verdict itself is `too-new`.
    summary[status === 'too-new' ? 'tooNew' : status] = 1
  }
  const report = {
    root: 'D:\\store',
    codecAvailable: true,
    summary,
    sessions: DIAGNOSIS_STATUSES.map((status) => ({
      id: `session-${status}`,
      projectDir: '--D-guide--',
      status,
      reasons: [],
      repairable: false
    }))
  }

  const { mini, draw, tree } = await mountPanel(report)

  for (const status of DIAGNOSIS_STATUSES) {
    const row = mini.nodes(tree).find((node) => node.type === 'tr' && mini.text(node).includes(`session-${status}`))
    assert.ok(row !== undefined, `no row for a ${status} session`)
    const cells = mini.children(row).filter((child) => child.type === 'td')
    const badgeNode = mini.nodes(cells[1]).find((node) => node.type === 'span' && node.props.style.borderRadius === 999)
    assert.ok(badgeNode !== undefined, `${status}: the verdict must render a badge`)
    assert.equal(typeof badgeNode.props.title, 'string', `${status}: a badge must explain itself on hover`)
  }

  // The guide is on demand, so the session list stays the first thing on the page.
  const open = mini.nodes(tree).find((node) => node.type === 'button' && mini.text(node) === 'What the verdicts mean')
  assert.ok(open !== undefined, 'the panel must offer a verdict guide')
  open.props.onClick()
  const guided = draw()

  const entries = mini.nodes(guided).filter((node) =>
    node.type === 'div' &&
    mini.children(node).some((child) => child.props.style?.borderRadius === 999) &&
    mini.children(node).some((child) => child.props.style?.minWidth === 96))
  assert.equal(entries.length, DIAGNOSIS_STATUSES.length, 'the guide must hold one entry per verdict')

  const listed = []
  for (const entry of entries) {
    const spans = mini.children(entry).filter((child) => child.type === 'span')
    const badgeNode = spans.find((child) => child.props.style.borderRadius === 999)
    const keyNode = spans.find((child) => child !== badgeNode && child.props.style.minWidth === 96)
    const helpNode = spans.find((child) => child !== badgeNode && child !== keyNode && child.props.style.flex === 1)
    assert.ok(keyNode !== undefined && helpNode !== undefined, 'a guide entry must name a verdict and explain it')
    listed.push(mini.text(keyNode))
    assert.ok(mini.text(helpNode).length > 10, `${mini.text(keyNode)}: the guide must explain the verdict, not only name it`)
    // One sentence, two places: a tooltip that disagreed with the guide would be
    // worse than no tooltip.
    assert.equal(mini.text(helpNode), badgeNode.props.title, `${mini.text(keyNode)}: the tooltip and the guide must agree`)
  }
  assert.deepEqual([...listed].sort(), [...DIAGNOSIS_STATUSES].sort(),
    "the guide must cover the engine's whole vocabulary")

  const close = mini.nodes(guided).find((node) => node.type === 'button' && mini.text(node) === 'Hide verdict guide')
  assert.ok(close !== undefined, 'the guide button must toggle')
  close.props.onClick()
  const closed = draw()
  assert.equal(mini.nodes(closed).filter((node) =>
    node.type === 'button' && mini.text(node) === 'What the verdicts mean').length, 1, 'the guide must close again')
})

await test('both READMEs and both root-cause write-ups cover every verdict', () => {
  // A documentation test, so it pins text — but the text is the artifact here,
  // and the regression is real: every hand-maintained verdict list in this repo
  // had lost `empty`, so a reader counted six verdicts where the dashboard shows
  // seven, and no file said what to do about any of them.
  const repo = (name) => readFileSync(join(HERE, '..', name), 'utf8')
  const files = {
    'README.md': repo('README.md'),
    'README.zh.md': repo('README.zh.md'),
    'docs/ROOT-CAUSE.md': repo('docs/ROOT-CAUSE.md'),
    'docs/ROOT-CAUSE.zh-CN.md': repo('docs/ROOT-CAUSE.zh-CN.md')
  }

  for (const status of DIAGNOSIS_STATUSES) {
    for (const [name, text] of Object.entries(files)) {
      assert.ok(text.includes('`' + status + '`'), `${name} must name the ${status} verdict`)
    }
    // The taxonomy table is the one place a verdict gets a definition, so a
    // verdict without a row is a verdict a user cannot look up.
    for (const name of ['docs/ROOT-CAUSE.md', 'docs/ROOT-CAUSE.zh-CN.md']) {
      assert.match(files[name], new RegExp('^\\| `' + status + '` \\|', 'm'),
        `${name} must define the ${status} verdict in its table`)
    }
  }

  // …and each table says what the reader can actually do about the verdict.
  assert.match(files['docs/ROOT-CAUSE.md'], /^\| Verdict \| Meaning \| What to do \|$/m,
    'the English taxonomy must say what to do per verdict')
  assert.match(files['docs/ROOT-CAUSE.zh-CN.md'], /^\| 结论 \| 含义 \| 该怎么办 \|$/m,
    'the Chinese taxonomy must say what to do per verdict')

  // A README that names the verdicts without pointing at their definitions still
  // leaves the reader guessing, so each one links the taxonomy in its own language.
  assert.ok(files['README.md'].includes('docs/ROOT-CAUSE.md#failure-taxonomy'),
    'README.md must link the verdict definitions')
  assert.ok(files['README.zh.md'].includes('docs/ROOT-CAUSE.zh-CN.md#失败分类'),
    'README.zh.md must link the verdict definitions')
})

await test('the dashboard API refuses cross-origin requests', async () => {
  const handler = await mountApi({})

  /** Minimal request/response doubles. */
  const call = (headers) => new Promise((resolve) => {
    const res = {
      writeHead: (status) => resolve({ status }),
      end: () => {}
    }
    handler({ method: 'GET', url: '/sessions-diagnosis/api/rules', headers }, res)
  })

  assert.equal((await call({ host: '127.0.0.1:3080' })).status, 200, 'same-origin with no Origin must pass')
  assert.equal((await call({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })).status, 200)
  assert.equal((await call({ host: '127.0.0.1:3080', origin: 'http://evil.example' })).status, 403)
  assert.equal((await call({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })).status, 403)
})

// DSH's own tool-registry validation.
//
// A tool definition whose schema falls outside DSH's enforced JSON Schema subset
// does not fail at call time: `ctx.tools.register()` throws while the profile is
// booting, which takes the whole harness down. So these assertions run DSH's real
// validator over every definition and over every value the tools actually return,
// instead of trusting a hand-written expectation.

/** Resolve DSH's tool package beside the session-format packages it sits with. */
async function loadDshToolSchema () {
  const modules = await resolveDshFormatModules()
  if (modules === undefined) return undefined
  for (const root of [modules.source, join(modules.source, '..')]) {
    const candidate = join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.assertSupportedJsonSchema === 'function') return { ...mod, nodeModulesRoot: root }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Load DSH's real cordis Context and ToolRuntime, so the plugin can be mounted
 * against the genuine registry rather than a stub. This is the code path that
 * runs —and that failed —during `dsh web`.
 */
async function loadDshRegistry () {
  if (TOOL_SCHEMA === undefined) return undefined
  const root = TOOL_SCHEMA.nodeModulesRoot
  const cordisPath = join(root, '@deepseek-ai', 'cordis', 'lib', 'index.js')
  if (!existsSync(cordisPath)) return undefined
  try {
    const cordis = await import(pathToFileURL(cordisPath).href)
    const ToolRuntime = TOOL_SCHEMA.default ?? TOOL_SCHEMA.ToolRuntime
    if (typeof cordis.Context !== 'function' || typeof ToolRuntime !== 'function') return undefined
    return { cordis, ToolRuntime }
  } catch {
    return undefined
  }
}

const TOOL_SCHEMA = await loadDshToolSchema()
const DSH_REGISTRY = await loadDshRegistry()

/** Two synthetic sessions: one that refuses migration, one already current. */
const makeSchemaStore = () => makeStore({
  'sessions/--C-test--/session-broken/session.jsonl.zstd': log([
    sessionHeader(0, 'session-broken'),
    offendingRow(0)
  ]),
  'sessions/--C-test--/session-fine/session.v3.jsonl.zstd': log([
    sessionHeader(3, 'session-fine'),
    { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } }
  ])
})

/** Run `body` with DSH_HOME pointed at a fresh synthetic store. */
async function withSchemaStore (body) {
  const home = makeSchemaStore()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

if (TOOL_SCHEMA === undefined) {
  await test('tool schemas satisfy DSH\'s enforced subset', () =>
    skip('DSH\'s dsh-tools package could not be located'))
} else {
  const registered = []
  const host = await import('../lib/index.js')

  await test('every tool schema passes DSH\'s real assertSupportedJsonSchema', () => {
    host.apply({
      effect: (fn) => fn(),
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      inject: () => {}
    }, {})
    assert.equal(registered.length, 3)

    for (const tool of registered) {
      // Mirror ToolRuntime.register() exactly: it checks the output declaration,
      // then assertSupportedJsonSchema(output.schema), then the reserved name.
      // A throw from any of these aborts the profile boot.
      assert.ok(tool.output !== undefined && typeof tool.output === 'object', `${tool.name} must declare output`)
      assert.equal(typeof tool.output.render, 'function', `${tool.name} output.render must be a function`)
      assert.notEqual(tool.name, 'run_code', 'run_code is reserved for the PTC transport')
      try {
        TOOL_SCHEMA.assertSupportedJsonSchema(tool.output.schema)
      } catch (error) {
        assert.fail(`${tool.name}.output.schema: ${error.violations?.join('; ') ?? error.message}`)
      }

      // `parameters` is not checked by register(), but it is projected into the
      // model-facing schema later; it must be object-rooted and in-subset too.
      try {
        TOOL_SCHEMA.assertObjectJsonSchema(tool.parameters)
      } catch (error) {
        assert.fail(`${tool.name}.parameters: ${error.violations?.join('; ') ?? error.message}`)
      }
    }
  })

  await test('no schema puts additionalProperties/required/properties on a non-object', () => {
    // The exact defect that broke DSH boot:
    //   { type: 'array', additionalProperties: true }
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${path}[${i}]`))
      if (typeof node.type === 'string') {
        for (const key of ['additionalProperties', 'required', 'properties']) {
          assert.ok(
            !(key in node) || node.type === 'object',
            `${path}.${key} is valid only on type "object" but ${path} is "${node.type}"`
          )
        }
        assert.ok(!('items' in node) || node.type === 'array', `${path}.items is valid only on type "array"`)
      }
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`)
    }
    for (const tool of registered) {
      walk(tool.parameters, `${tool.name}.parameters`)
      walk(tool.output.schema, `${tool.name}.output.schema`)
    }
  })

  await test('tool results are lossless JSON and validate against their output schema', async () => {
    await withSchemaStore(async () => {
      const signal = new AbortController().signal
      for (const tool of registered) {
        const args = tool.name === 'session_repair'
          ? { id: 'session-broken' }                                     // dry run: writes nothing
          : tool.name === 'session_diagnose' ? { id: 'session-broken' } : {}
        const value = await tool.execute(args, { signal })

        // No `undefined` anywhere: an optional field must be absent, not present
        // and undefined, or the registry rejects the value after the body ran.
        assert.equal(
          JSON.stringify(value), JSON.stringify(JSON.parse(JSON.stringify(value))),
          `${tool.name} returned a value that is not lossless JSON`
        )

        const violations = TOOL_SCHEMA.validateJsonSchemaValue(tool.output.schema, value, tool.name)
        assert.deepEqual(violations, [], `${tool.name} returned an invalid value: ${violations.join('; ')}`)
        assert.equal(typeof tool.output.render(args, value)[0].text, 'string')
      }
    })
  })

  await test('a whole-store scan result also validates against the output schema', async () => {
    await withSchemaStore(async () => {
      const signal = new AbortController().signal
      for (const name of ['session_diagnose', 'session_store_overview']) {
        const tool = registered.find((t) => t.name === name)
        const value = await tool.execute({}, { signal })
        const violations = TOOL_SCHEMA.validateJsonSchemaValue(tool.output.schema, value, name)
        assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
        assert.ok(value.sessions.length >= 2, `${name} should report both fixture sessions`)
      }
    })
  })

  // The strongest check available without starting a server: mount the plugin
  // against DSH's genuine cordis Context and ToolRuntime. A schema outside the
  // enforced subset throws from the real register() here, exactly as it did
  // during `dsh web`.
  if (DSH_REGISTRY === undefined) {
    await test('the plugin mounts against DSH\'s real registry', () =>
      skip('DSH\'s cordis package could not be located'))
  } else {
    await test('the plugin mounts against DSH\'s real registry', async () => {
      const ctx = new DSH_REGISTRY.cordis.Context()
      // ToolRuntime injects `systemPrompt` and registers a prompt section when
      // it is constructed, so the service has to exist first.
      ctx.provide('systemPrompt', { tools: () => () => {} })
      const runtime = new DSH_REGISTRY.ToolRuntime(ctx)

      let route
      ctx.provide('webServer', { register: (r) => { route = r; return () => {} } })

      host.apply(ctx, {})   // must not throw

      const names = runtime.schemas().map((s) => s.name)
      for (const name of ['session_diagnose', 'session_repair', 'session_store_overview']) {
        assert.ok(names.includes(name), `${name} did not register against the real registry`)
      }

      // Service injection settles on a microtask, so the optional web-server
      // row may not have run yet.
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(route?.kind, 'prefix')
      assert.equal(route?.path, '/sessions-diagnosis/api')
    })
  }
}

// ────────────────────────────────────────────────────────────────────────────
// the demo's safety boundary: a demo must never reach the real session store
// ────────────────────────────────────────────────────────────────────────────

await test('a bare demo targets a throwaway store, never the real one', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-demo-home-'))
  try {
    // Default: a store under the OS temp directory, with a DSH home of its own
    // so pointing DSH at it is a single environment variable.
    const fallback = resolveDemoStore({ tmp: home, env: undefined })
    assert.equal(fallback.root, join(home, 'dsh-session-doctor-demo', 'sessions'))
    assert.equal(fallback.home, join(home, 'dsh-session-doctor-demo'))
    assert.equal(fallback.scratch, true)

    const overridden = resolveDemoStore({ tmp: home, env: home })
    assert.equal(overridden.home, home)
    assert.equal(overridden.root, join(home, 'sessions'))

    // An explicit --root is honoured but is no longer the default, and it carries
    // no DSH home with it.
    const explicit = resolveDemoStore({ root: join(home, 'elsewhere') })
    assert.equal(explicit.root, join(home, 'elsewhere'))
    assert.equal(explicit.scratch, false)
    assert.equal(explicit.home, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('creating a demo in the real session store is refused', () => {
  const real = join(tmpdir(), 'dsh-real-store')
  // Every spelling of the same directory is refused, not just the exact string.
  for (const target of [real, join(real, '.'), join(real, '..', 'dsh-real-store')]) {
    assert.throws(() => assertDemoStoreIsNotReal(target, real),
      /refusing to create a demo in the real session store/, `${target} must be refused`)
  }
  // On a case-insensitive filesystem an uppercased path names the same store.
  assert.throws(() => assertDemoStoreIsNotReal(real.toUpperCase(), real, 'win32'), /refusing to create/)
  // A store anywhere else is fine —including one that merely shares a prefix.
  assertDemoStoreIsNotReal(join(tmpdir(), 'dsh-real-store-2'), real)
  assertDemoStoreIsNotReal(join(tmpdir(), 'dsh-session-doctor-demo', 'sessions'), real)
  // A case-insensitive platform must not make two genuinely different stores equal.
  assertDemoStoreIsNotReal(join(tmpdir(), 'Other-Store'), real, 'win32')
  // Unknown real store: nothing to refuse.
  assertDemoStoreIsNotReal(real, undefined)
})

await test('the CLI routes a bare demo into the throwaway store and refuses the real one', () => {
  // The CLI is a thin wrapper over the two functions above; this pins the wiring
  // without spawning a process, so it holds even where child-process pipes are
  // unavailable.
  const source = readFileSync(join(HERE, '..', 'bin', 'dsh-session-doctor.mjs'), 'utf8')
  assert.match(source, /const store = demoStoreFor\(options\)/, 'demo resolves its store through the guard')
  assert.match(source, /assertDemoStoreIsNotReal\(/, 'demo consults the refusal')
  assert.match(source, /const store = resolveDemoStore\(options\.root === undefined \? \{\} : \{ root: options\.root \}\)\n  const roots = \[store\.root\]/,
    'demo --remove is not gated, so it can still clean a store an older version wrote into')
})

// ────────────────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
for (const result of results) {
  const mark = result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${result.name}`)
  if (result.error !== undefined && !result.skipped) {
    console.log(`      ${result.error.message.split('\n').join('\n      ')}`)
  }
}
console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
process.exit(failed.length === 0 ? 0 : 1)
