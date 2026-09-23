/**
 * Diagnosing why a session will or will not open.
 *
 * The diagnosis combines two independent layers, so a useful answer survives
 * even when DSH's own codec cannot be reached:
 *
 * - a **static audit** of the decoded log (frame integrity, header, sequence
 *   density, and the released migration's message-source vocabulary); and
 * - a **live probe** that runs DSH's real v0→v3 migration chain over the rows,
 *   which is the exact code path that decides whether the session opens.
 *
 * @module dsh-sessions-diagnosis/core/diagnose
 */

import { decodeSessionLog, readSessionLog } from './frames.js'
import { ADMITTED_MESSAGE_SOURCE_KINDS, CURRENT_FORMAT_VERSION, listSessions, visitMessageSources } from './store.js'
import { classifyMigrationFailure, probeMigration, resolveDshFormatModules } from './format.js'
import { detectIssues, applyIssues } from './rules.js'

/**
 * A single reason a session is not openable.
 * @typedef {object} DiagnosisReason
 * @property {string} code - stable machine-readable code.
 * @property {string} summary - one-line explanation.
 * @property {string} [detail] - the underlying message or measurement.
 * @property {string} [severity] - `error` (blocks opening) or `warning`.
 */

/**
 * The full diagnosis of one session.
 * @typedef {object} Diagnosis
 * @property {string} id - session id.
 * @property {string} dir - absolute session directory.
 * @property {string} projectDir - the enclosing project directory name.
 * @property {'ok'|'unmigrated'|'repairable'|'unrepairable'|'corrupt'|'too-new'|'empty'|'unknown'} status
 *   the overall verdict.
 * @property {string} headline - one-line human summary.
 * @property {boolean} openable - whether DSH was **proven** able to open the
 *   session. `false` also covers "never checked" — read `status` (`unknown`) to
 *   tell the two apart, because this tool never reports a failure it did not
 *   observe.
 * @property {boolean} repairable - whether a known rule can make it openable.
 * @property {object} selected - the artifact DSH would select.
 * @property {Array<object>} generations - every canonical generation present.
 * @property {Array<object>} foreign - files DSH ignores (backups, staged temps).
 * @property {object|undefined} physical - frame/row statistics, when the log was decoded.
 * @property {object|undefined} header - the selected artifact's header.
 * @property {object|undefined} probe - the live migration outcome.
 * @property {Array<DiagnosisReason>} reasons - everything found, worst first.
 * @property {Array<object>} findings - repairable issues, with before/after values.
 * @property {boolean} codecAvailable - whether DSH's migration chain could be reached.
 */

/**
 * Diagnose one session directory.
 *
 * @param {import('./store.js').SessionEntry} entry - the session to diagnose.
 * @param {object} [options]
 * @param {any} [options.modules] - pre-resolved DSH modules (see
 *   {@link module:dsh-sessions-diagnosis/core/format.resolveDshFormatModules}).
 * @param {boolean} [options.probe=true] - run the live migration probe.
 * @param {ReadonlyArray<string>} [options.rules] - rule ids to consider.
 * @returns {Diagnosis} the verdict.
 */
export function diagnoseEntry (entry, options = {}) {
  const modules = options.modules
  const codecAvailable = modules !== undefined && modules !== null

  /** @type {DiagnosisReason[]} */
  const reasons = []

  const base = {
    id: entry.id,
    dir: entry.dir,
    projectDir: entry.projectDir,
    selected: entry.selectedPath === undefined
      ? undefined
      : describeGeneration(entry.generations[entry.generations.length - 1]),
    generations: entry.generations.map(describeGeneration),
    foreign: entry.foreign.map(describeGeneration),
    codecAvailable
  }

  if (entry.selectedPath === undefined) {
    reasons.push({
      code: 'NO_ARTIFACT',
      summary: 'the session directory holds no readable session log',
      detail: entry.foreign.length > 0
        ? `only non-canonical files present: ${entry.foreign.map((f) => f.path.split(/[\\/]/).pop()).join(', ')}`
        : 'the directory is empty',
      severity: 'error'
    })
    return finalize({ ...base, status: 'empty', reasons, findings: [] })
  }

  // Read the header frame only. This is cheap and is what DSH's own listing does.
  /** @type {any} */
  let rows
  /** @type {any} */
  let log
  try {
    log = readSessionLog(entry.selectedPath)
    rows = log.rows
  } catch (error) {
    reasons.push({
      code: 'UNREADABLE',
      summary: 'the session log could not be decoded',
      detail: text(error),
      severity: 'error'
    })
    return finalize({ ...base, status: 'corrupt', reasons, findings: [] })
  }

  const header = rows[0]
  const storedVersion = typeof header?.version === 'number' ? header.version : -1
  const physical = {
    bytes: log.bytes.length,
    frames: log.frames.length,
    tornStart: log.tornStart,
    badFrames: log.badFrames,
    frameErrors: log.frameErrors.slice(0, 5),
    rows: rows.length,
    rowErrors: log.rowErrors.length,
    rowErrorSamples: log.rowErrors.slice(0, 5)
  }

  if (log.tornStart !== undefined) {
    reasons.push({
      code: 'TORN_TAIL',
      summary: 'the final Zstandard frame is incomplete, as after a crash mid-append',
      detail: `incomplete frame starts at byte ${log.tornStart}; DSH recovers the committed prefix`,
      severity: 'warning'
    })
  }
  if (log.badFrames > 0) {
    reasons.push({
      code: 'BAD_FRAMES',
      summary: `${log.badFrames} frame(s) failed to decompress or failed their checksum`,
      detail: log.frameErrors[0]?.message,
      severity: 'error'
    })
  }
  if (log.rowErrors.length > 0) {
    reasons.push({
      code: 'BAD_ROWS',
      summary: `${log.rowErrors.length} line(s) are not valid JSON`,
      detail: log.rowErrors[0]?.message,
      severity: 'error'
    })
  }

  // The version the *installed* DSH reads — not necessarily the one this tool was
  // written against. Borrowing the running harness's own codec is the point of the
  // live probe, and running under an older build is a normal, supported situation;
  // judging its logs against a newer generation would invent a "too new" that the
  // user's own DSH does not see.
  const currentVersion = codecAvailable && typeof modules.currentVersion === 'number'
    ? modules.currentVersion
    : CURRENT_FORMAT_VERSION
  const alreadyCurrent = storedVersion === currentVersion

  // A newer format than this build understands is an upgrade problem, not damage.
  if (storedVersion > currentVersion) {
    reasons.push({
      code: 'FORMAT_TOO_NEW',
      summary: `the log is format v${storedVersion}, but this harness reads only v${currentVersion}`,
      detail: 'the log was written by a newer harness; upgrade DSH to open it',
      severity: 'error'
    })
    return finalize({ ...base, status: 'too-new', header, physical, reasons, findings: [] })
  }

  if (storedVersion !== entry.highestVersion) {
    reasons.push({
      code: 'NAME_HEADER_MISMATCH',
      summary: `the filename says v${entry.highestVersion} but the header says v${storedVersion}`,
      detail: 'DSH refuses a generation whose filename and header disagree',
      severity: 'error'
    })
  }

  // The static audit: what the released vocabulary says about this log.
  const findings = detectIssues(rows, options.rules === undefined ? {} : { rules: options.rules })
  const sourceIssues = countSourceIssues(rows)

  // The live probe: what DSH itself says about this log.
  /** @type {any} */
  let probe
  if (options.probe !== false && codecAvailable) {
    probe = probeMigration(modules, rows)
    if (!probe.ok) {
      const classified = classifyMigrationFailure(probe)
      reasons.push({
        code: classified.code,
        summary: classified.summary,
        detail: describeProbeFailure(probe),
        severity: 'error'
      })
      if (probe.errorName === 'SessionFormatError' && /seq gap/.test(probe.errorMessage ?? '')) {
        reasons.push({
          code: 'STRUCTURAL_DAMAGE',
          summary: 'the stored log is missing event rows, so its sequence numbers are not dense',
          detail: 'no source-mapping rule can reconstruct absent events; this log needs an expert repair',
          severity: 'error'
        })
      }
    }
  }

  const checked = probe !== undefined
  const migrated = checked && probe.ok
  const openable = alreadyCurrent ? (probe === undefined || probe.ok) : migrated

  // Not at the version this build writes, and nothing was ever verified. That is a
  // missing tool, not a defect in the log: an older DSH that ships no format
  // catalog opens its own logs perfectly well — it simply cannot be asked to prove
  // it. Reporting "will not open" here is how a whole store of healthy sessions
  // gets declared unrepairable.
  if (!checked && !alreadyCurrent) {
    reasons.push({
      code: 'CODEC_UNAVAILABLE',
      summary: `this build of DSH was not found, so the v${storedVersion} log was never tested against v${currentVersion}`,
      detail: 'the log was not proven to fail; run this tool from a DSH install that ships ' +
        '@deepseek-ai/dsh-session-format-catalog' +
        (findings.length === 0
          ? ''
          : ` (the static audit did find ${findings.length} issue(s) a known rule would rewrite)`),
      severity: 'warning'
    })
  }

  // Never promise a repair that has not been proven. Apply the findings to an
  // in-memory copy and re-run DSH's migration: a log can carry a second,
  // independent defect that only surfaces once the first one is fixed, and
  // reporting it as "repairable" would be a lie the user only discovers after
  // authorising a write.
  /** @type {any} */
  let repairSimulation
  let repairable = false
  if (!openable && findings.length > 0 && codecAvailable) {
    repairSimulation = simulateRepair(modules, rows, findings)
    repairable = repairSimulation.ok
    if (repairable) {
      reasons.push({
        code: 'REPAIR_AVAILABLE',
        summary: `${findings.length} known-repairable issue(s) found; the repaired log was verified to migrate`,
        detail: `${[...new Set(findings.map((f) => f.ruleId))].join(', ')} -> ${repairSimulation.events} events`,
        severity: 'warning'
      })
    } else {
      reasons.push({
        code: 'REPAIR_INSUFFICIENT',
        summary: 'a known rule matches, but the repaired log still fails to migrate',
        detail: `after applying ${findings.length} edit(s): ${repairSimulation.errorName}: ${repairSimulation.errorMessage}`,
        severity: 'error'
      })
      if (/seq gap/.test(repairSimulation.errorMessage ?? '')) {
        reasons.push({
          code: 'STRUCTURAL_DAMAGE',
          summary: 'the stored log is missing event rows, so its sequence numbers are not dense',
          detail: 'no source-mapping rule can reconstruct absent events; this log needs an expert repair',
          severity: 'error'
        })
      }
    }
  }

  let status
  if (openable) status = alreadyCurrent ? 'ok' : 'unmigrated'
  else if (repairable) status = 'repairable'
  else if (hasCorruption(reasons)) status = 'corrupt'
  else if (!checked && !alreadyCurrent) status = 'unknown'
  else status = 'unrepairable'

  if (openable && !alreadyCurrent) {
    reasons.push({
      code: 'MIGRATION_REQUIRED',
      summary: `the session is still format v${storedVersion}; DSH migrates it in memory when it opens`,
      detail: 'a v3 successor is published the first time the session is opened for writing',
      severity: 'warning'
    })
  }
  if (status === 'unrepairable' && sourceIssues === 0 && findings.length === 0) {
    reasons.push({
      code: 'NO_KNOWN_RULE',
      summary: 'this failure does not match any known repair rule',
      detail: probe?.errorMessage,
      severity: 'error'
    })
  }

  return finalize({
    ...base,
    status,
    header,
    physical,
    probe: sanitizeProbe(probe),
    repairSimulation,
    reasons,
    findings
  })
}

/**
 * Apply the findings to a copy of the rows and re-run DSH's migration.
 *
 * @param {any} modules - resolved DSH modules.
 * @param {unknown[]} rows - the decoded rows (not mutated).
 * @param {object[]} findings - the findings to apply.
 * @returns {{ ok: boolean, events?: number, errorName?: string, errorMessage?: string }}
 *   whether the repair would actually make the session openable.
 */
function simulateRepair (modules, rows, findings) {
  try {
    const patched = JSON.parse(JSON.stringify(rows))
    const { edits } = applyIssues(patched, JSON.parse(JSON.stringify(findings)))
    if (edits !== findings.length) {
      return { ok: false, errorName: 'RepairSimulationError', errorMessage: `only ${edits} of ${findings.length} edits applied` }
    }
    const probe = probeMigration(modules, patched, { recovery: 'strict', validation: 'transformed' })
    return probe.ok
      ? { ok: true, events: probe.events }
      : { ok: false, errorName: probe.errorName, errorMessage: probe.errorMessage }
  } catch (error) {
    return { ok: false, errorName: 'RepairSimulationError', errorMessage: text(error) }
  }
}

/**
 * Diagnose every session in the store.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - explicit DSH home.
 * @param {string} [options.root] - explicit sessions root.
 * @param {boolean} [options.probe=true] - run the live migration probe per session.
 * @param {number} [options.limit] - maximum sessions to inspect.
 * @param {ReadonlyArray<string>} [options.rules] - rule ids to consider.
 * @returns {Promise<{ root: string|undefined, codecAvailable: boolean, codecSource: string|undefined,
 *   sessions: Diagnosis[], errors: Array<{path: string, message: string}>, summary: object }>}
 *   the store-wide report.
 */
export async function diagnoseStore (options = {}) {
  const scan = listSessions(options)
  const modules = options.probe === false
    ? undefined
    : await resolveDshFormatModules({ dshHome: options.dshHome, catalogPath: options.catalogPath })

  const chosen = options.limit === undefined ? scan.sessions : scan.sessions.slice(0, options.limit)
  const sessions = chosen.map((entry) => diagnoseEntry(entry, { modules, probe: options.probe, rules: options.rules }))

  const summary = {
    total: sessions.length,
    ok: sessions.filter((s) => s.status === 'ok').length,
    unmigrated: sessions.filter((s) => s.status === 'unmigrated').length,
    repairable: sessions.filter((s) => s.status === 'repairable').length,
    unrepairable: sessions.filter((s) => s.status === 'unrepairable').length,
    corrupt: sessions.filter((s) => s.status === 'corrupt').length,
    tooNew: sessions.filter((s) => s.status === 'too-new').length,
    empty: sessions.filter((s) => s.status === 'empty').length,
    unknown: sessions.filter((s) => s.status === 'unknown').length,
    findings: sessions.reduce((sum, s) => sum + s.findings.length, 0)
  }

  return {
    root: scan.root,
    codecAvailable: modules !== undefined,
    codecSource: modules?.source,
    sessions,
    errors: scan.errors,
    summary
  }
}

/**
 * Decode one session's log, header first, for callers that need the raw rows
 * (the repair path and the detail view).
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @returns {{ rows: unknown[], log: any, header: any }} the decoded log.
 */
export function loadSessionRows (entry) {
  if (entry.selectedPath === undefined) throw new Error(`${entry.id}: no readable session artifact`)
  const log = readSessionLog(entry.selectedPath)
  return { rows: log.rows, log, header: log.rows[0] }
}

/** Turn a generation record into a plain, serializable description. */
function describeGeneration (generation) {
  return {
    version: generation.version,
    compression: generation.compression,
    canonical: generation.canonical,
    path: generation.path,
    name: generation.path.split(/[\\/]/).pop(),
    sizeBytes: generation.sizeBytes,
    mtimeMs: generation.mtimeMs
  }
}

/** Count message-source vocabulary violations without building full findings. */
function countSourceIssues (rows) {
  let count = 0
  for (const row of rows) {
    visitMessageSources(row, (message) => {
      const kind = message?.source?.kind
      if (typeof kind !== 'string' || !ADMITTED_MESSAGE_SOURCE_KINDS.has(kind)) count++
    })
  }
  return count
}

/** Strip the (huge) migrated artifact out of a probe before returning it. */
function sanitizeProbe (probe) {
  if (probe === undefined) return undefined
  const { artifact, ...rest } = probe
  return rest
}

/** Describe where a live probe failed, in operator terms. */
function describeProbeFailure (probe) {
  const parts = []
  if (probe.failedAtRow !== undefined) {
    parts.push(`while decoding row ${probe.failedAtRow}`)
  }
  if (probe.failedAtType !== undefined) {
    parts.push(`event ${probe.failedAtType}${probe.failedAtSeq === undefined ? '' : ` seq ${probe.failedAtSeq}`}`)
  }
  parts.push(`${probe.errorName}: ${probe.errorMessage}`)
  return parts.join(' — ')
}

/** @param {DiagnosisReason[]} reasons */
function hasCorruption (reasons) {
  return reasons.some((reason) => reason.code === 'BAD_FRAMES' || reason.code === 'BAD_ROWS' || reason.code === 'CORRUPTION')
}

/**
 * Attach the verdict fields every diagnosis shares.
 *
 * `openable` is "proven openable", so `unknown` reports `false`: the field says
 * what was established, and `status` says whether anything was established at
 * all. Callers that act on a failure must therefore test the status, not this
 * boolean alone — see the store report renderers.
 *
 * @param {any} partial - the assembled diagnosis.
 * @returns {Diagnosis} the completed diagnosis.
 */
function finalize (partial) {
  const status = partial.status
  const headline = HEADLINES[status] ?? status
  return {
    ...partial,
    headline,
    openable: status === 'ok' || status === 'unmigrated',
    repairable: status === 'repairable',
    reasons: orderReasons(partial.reasons ?? []),
    findings: partial.findings ?? [],
    physical: partial.physical,
    header: partial.header,
    probe: partial.probe,
    repairSimulation: partial.repairSimulation
  }
}

/** Human headline per status. */
const HEADLINES = Object.freeze({
  ok: 'Opens normally',
  unmigrated: 'Opens normally (migrated on open)',
  repairable: 'Will not open — a known repair applies',
  unrepairable: 'Will not open — no known repair applies',
  corrupt: 'Stored log is damaged',
  'too-new': 'Written by a newer harness',
  empty: 'No session log present',
  unknown: 'Not checked — this build of DSH has no format codec'
})

/**
 * Every verdict this engine can return, in report order.
 *
 * Exported so the things that have to *describe* verdicts — the dashboard's
 * guide, the CLI summaries, the documentation tests — can be checked against
 * the engine instead of against a list somebody retyped. They are not
 * equivalent: `empty` was silently absent from both READMEs and from both
 * summary lines for as long as the list was maintained by hand.
 *
 * @type {ReadonlyArray<string>}
 */
export const DIAGNOSIS_STATUSES = Object.freeze(Object.keys(HEADLINES))

/** Errors first, then warnings, stable within each severity. */
function orderReasons (reasons) {
  const rank = (reason) => (reason.severity === 'error' ? 0 : 1)
  return [...reasons].sort((a, b) => rank(a) - rank(b))
}

/** @param {unknown} error @returns {string} */
function text (error) {
  return error instanceof Error ? error.message : String(error)
}
