/**
 * Repairing a session that DSH 0.1.5 refuses to open.
 *
 * ## Why publishing a successor is the right repair
 *
 * DSH stores one immutable file per format generation and always selects the
 * numerically highest one. The old generation is a *released* artifact: DSH
 * itself never rewrites it, and its migration is purely additive. So the repair
 * mirrors DSH's own publication rather than editing history:
 *
 * 1. decode the old generation,
 * 2. apply the minimal rule edits to an **in-memory copy**,
 * 3. re-run DSH's real migration over the patched rows,
 * 4. encode the result with **DSH's own current-format encoder**,
 * 5. re-read the encoded bytes and prove they pass both the storage layer's
 *    structural admission and a full restore,
 * 6. publish `session.v<N>.jsonl.zstd` beside the original, without overwriting.
 *
 * The source file is never modified, so the repair is reversible by deleting the
 * published successor. Nothing is written unless step 5 succeeds, so a rule that
 * guesses wrong cannot corrupt a session.
 *
 * ## The `patch-source` fallback
 *
 * When DSH's codec cannot be reached (a standalone checkout, a stripped
 * install), the repair can instead rewrite the *source* generation in place
 * after backing it up. DSH then migrates it itself on the next open. This
 * mutates a released generation, so it is opt-in and always leaves a backup.
 *
 * @module dsh-sessions-diagnosis/core/repair
 */

import { closeSync, copyFileSync, constants as fsConstants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { decodeSessionLog, encodeSessionLog, readSessionLog } from './frames.js'
import { CURRENT_FORMAT_VERSION } from './store.js'
import { probeMigration, resolveDshFormatModules } from './format.js'
import { REPAIR_RULES, applyIssues, detectIssues, getRule } from './rules.js'

/** Repair strategies. */
export const REPAIR_MODES = Object.freeze({
  /** Publish a verified current-format successor; the source is left untouched. */
  PUBLISH: 'publish-successor',
  /** Rewrite the source generation in place, after backing it up. */
  PATCH_SOURCE: 'patch-source'
})

/**
 * Filename of the sidecar recording a completed repair.
 *
 * Non-canonical, so DSH ignores it as a generation. Exported because everything
 * that reasons about a repaired session — rollback, demo cleanup — has to find it.
 */
export const REPAIR_MANIFEST_NAME = 'session.diag-repair.json'

/**
 * A repair plan: what would happen, computed without writing anything.
 * @typedef {object} RepairPlan
 * @property {string} id - session id.
 * @property {string} dir - session directory.
 * @property {string} mode - one of {@link REPAIR_MODES}.
 * @property {string} sourcePath - the artifact that would be read.
 * @property {number} sourceVersion - its format version.
 * @property {string|undefined} targetPath - the file that would be written.
 * @property {string[]} ruleIds - rules that would run.
 * @property {object[]} findings - the edits that would be applied.
 * @property {boolean} viable - whether the plan can proceed.
 * @property {string|undefined} blockedBy - why not, when not viable.
 */

/**
 * Build a repair plan without touching the filesystem.
 *
 * @param {import('./store.js').SessionEntry} entry - the session to plan for.
 * @param {object} [options]
 * @param {any} [options.modules] - pre-resolved DSH modules.
 * @param {string} [options.mode] - {@link REPAIR_MODES}; defaults to publishing a successor.
 * @param {ReadonlyArray<string>} [options.rules] - rule ids to run.
 * @returns {RepairPlan} the plan.
 */
export function planRepair (entry, options = {}) {
  const mode = options.mode ?? REPAIR_MODES.PUBLISH
  const ruleIds = resolveRuleIds(options.rules)

  /** @type {RepairPlan} */
  const plan = {
    id: entry.id,
    dir: entry.dir,
    mode,
    sourcePath: entry.selectedPath ?? '',
    sourceVersion: entry.highestVersion,
    targetPath: undefined,
    ruleIds,
    findings: [],
    viable: false,
    blockedBy: undefined
  }

  if (entry.selectedPath === undefined) {
    plan.blockedBy = 'the session directory holds no readable session artifact'
    return plan
  }
  const targetVersion = installedVersion(options.modules)
  if (entry.highestVersion === targetVersion) {
    plan.blockedBy = `the session is already at the current format v${targetVersion}`
    return plan
  }
  if (entry.highestVersion > targetVersion) {
    plan.blockedBy = `the session is format v${entry.highestVersion}, newer than this harness reads`
    return plan
  }

  if (mode === REPAIR_MODES.PUBLISH) {
    plan.targetPath = join(entry.dir, successorFilename(entry, targetVersion))
    if (existsSync(plan.targetPath)) {
      plan.blockedBy = `a v${targetVersion} generation already exists at ${plan.targetPath}`
      return plan
    }
  } else if (mode === REPAIR_MODES.PATCH_SOURCE) {
    plan.targetPath = entry.selectedPath
  } else {
    plan.blockedBy = `unknown repair mode ${JSON.stringify(mode)}`
    return plan
  }

  let rows
  try {
    rows = readSessionLog(entry.selectedPath).rows
  } catch (error) {
    plan.blockedBy = `the session log could not be decoded: ${message(error)}`
    return plan
  }

  plan.findings = detectIssues(rows, { rules: ruleIds })
  if (plan.findings.length === 0) {
    plan.blockedBy = 'no known repair rule matches this session'
    return plan
  }
  plan.viable = true
  return plan
}

/**
 * The outcome of a repair.
 * @typedef {object} RepairResult
 * @property {string} id - session id.
 * @property {boolean} ok - whether the repair completed and verified.
 * @property {string} mode - the mode that ran.
 * @property {boolean} dryRun - whether anything was actually written.
 * @property {string[]} ruleIds - rules that ran.
 * @property {string[]|undefined} risks - the risk tiers of those rules.
 * @property {number} edits - edits applied to the in-memory rows.
 * @property {object[]} findings - what was changed.
 * @property {string|undefined} wrote - the path written, when one was.
 * @property {string|undefined} backupPath - the verified backup made, for `patch-source`.
 * @property {string|undefined} manifestPath - the repair record, for rollback.
 * @property {object|undefined} verification - the post-write re-read result.
 * @property {object|undefined} preservation - the content-preservation result.
 * @property {string[]|undefined} warnings - non-fatal problems worth reporting.
 * @property {string|undefined} error - why it failed, when it did.
 * @property {string} summary - one-line human outcome.
 */

/**
 * Repair one session.
 *
 * @param {import('./store.js').SessionEntry} entry - the session to repair.
 * @param {object} [options]
 * @param {any} [options.modules] - pre-resolved DSH modules (required for `publish-successor`).
 * @param {string} [options.dshHome] - explicit DSH home, used to resolve the codec.
 * @param {string} [options.catalogPath] - explicit path to DSH's format catalog.
 * @param {string} [options.mode] - {@link REPAIR_MODES}.
 * @param {ReadonlyArray<string>} [options.rules] - rule ids to run.
 * @param {boolean} [options.dryRun] - plan and verify, but write nothing.
 * @param {boolean} [options.backup=true] - back up before `patch-source`.
 * @returns {Promise<RepairResult>} the outcome.
 */
export async function repairSession (entry, options = {}) {
  const mode = options.mode ?? REPAIR_MODES.PUBLISH
  const dryRun = options.dryRun === true
  const ruleIds = resolveRuleIds(options.rules)

  /** @type {RepairResult} */
  const result = {
    id: entry.id,
    ok: false,
    mode,
    dryRun,
    ruleIds,
    risks: undefined,
    edits: 0,
    findings: [],
    wrote: undefined,
    backupPath: undefined,
    manifestPath: undefined,
    verification: undefined,
    preservation: undefined,
    warnings: undefined,
    error: undefined,
    summary: ''
  }

  if (entry.selectedPath === undefined) {
    return fail(result, 'the session directory holds no readable session artifact')
  }
  const targetVersion = installedVersion(options.modules)
  if (entry.highestVersion === targetVersion) {
    return fail(result, `the session is already at the current format v${targetVersion}`)
  }
  if (entry.highestVersion > targetVersion) {
    return fail(result, `the session is format v${entry.highestVersion}, newer than this harness reads`)
  }

  // ── decode ────────────────────────────────────────────────────────────────
  let decoded
  try {
    decoded = readSessionLog(entry.selectedPath)
  } catch (error) {
    return fail(result, `the session log could not be decoded: ${message(error)}`)
  }

  const rows = decoded.rows
  const findings = detectIssues(rows, { rules: ruleIds })
  result.findings = findings
  if (findings.length === 0) {
    // Distinguish "nothing is wrong that we can fix" from "the rule you need was
    // not enabled" — the second is a user error with an exact remedy, and saying
    // "no known rule matches" for it is simply false.
    if (options.rules !== undefined) {
      const wouldMatch = detectIssues(rows)
      if (wouldMatch.length > 0) {
        const needed = [...new Set(wouldMatch.map((finding) => finding.ruleId))]
        return fail(
          result,
          `the enabled rule set excludes the rule this session needs: ${needed.join(', ')}. ` +
          `Re-run with rules: [${needed.map((id) => JSON.stringify(id)).join(', ')}]`
        )
      }
    }
    return fail(result, 'no known repair rule matches this session')
  }

  // Report the risk tier of what actually ran. A medium-risk rule edits recorded
  // metadata rather than a provenance tag, so the caller is told explicitly
  // instead of having to infer it from the rule ids.
  const risks = [...new Set(findings.map((finding) => getRule(finding.ruleId)?.risk ?? 'unknown'))]
  result.risks = risks
  if (risks.includes('medium')) {
    result.warnings = [
      ...(result.warnings ?? []),
      `this repair edits recorded metadata (${findings.filter((f) => getRule(f.ruleId)?.risk === 'medium').map((f) => f.ruleId).join(', ')}), not only a provenance tag`
    ]
  }

  // ── patch an in-memory copy ───────────────────────────────────────────────
  const patched = deepClone(rows)
  const { edits, byRule } = applyIssues(patched, deepClone(findings))
  result.edits = edits
  if (edits !== findings.length) {
    return fail(result, `only ${edits} of ${findings.length} planned edits could be applied; the log changed underneath the plan`)
  }
  result.ruleIds = Object.keys(byRule)

  if (mode === REPAIR_MODES.PATCH_SOURCE) {
    return repairByPatchingSource(entry, result, decoded, patched, options, dryRun)
  }
  return repairByPublishingSuccessor(entry, result, decoded, patched, options, dryRun)
}

/**
 * Publish a verified current-format successor beside the source generation.
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @param {RepairResult} result - mutable result record.
 * @param {any} decoded - the decoded source log.
 * @param {unknown[]} patched - the patched rows.
 * @param {any} options - caller options.
 * @param {boolean} dryRun - whether to stop before writing.
 * @returns {Promise<RepairResult>} the result.
 */
async function repairByPublishingSuccessor (entry, result, decoded, patched, options, dryRun) {
  const modules = options.modules ?? await resolveDshFormatModules({ dshHome: options.dshHome, catalogPath: options.catalogPath })
  if (modules === undefined) {
    return fail(result, 'DSH\'s session-format catalog could not be located; use mode "patch-source" instead')
  }

  // The successor's name has to match the header DSH's *installed* chain produces,
  // not the generation this tool was written for. Labelling a v2 payload `v3`
  // would hand DSH exactly the filename/header disagreement it refuses.
  const targetVersion = installedVersion(modules)
  const targetPath = join(entry.dir, successorFilename(entry, targetVersion))
  if (existsSync(targetPath)) {
    return fail(result, `a v${targetVersion} generation already exists at ${targetPath}`)
  }

  // ── migrate the patched rows with DSH's own chain ─────────────────────────
  const migrated = probeMigration(modules, patched, { recovery: 'strict', validation: 'transformed' })
  if (!migrated.ok || migrated.artifact === undefined) {
    return fail(result, `the patched log still fails DSH's migration: ${migrated.errorName}: ${migrated.errorMessage}`)
  }
  if (migrated.artifact.header?.version !== targetVersion) {
    return fail(result, `DSH's chain produced a v${migrated.artifact.header?.version} artifact, but the successor ` +
      `would be named v${targetVersion}; refusing to publish a mislabelled generation`)
  }

  // ── prove the conversation itself survives the migration ──────────────────
  // Structural validity is not the same as content preservation: a migration
  // could produce a perfectly readable log that has quietly dropped messages.
  // Every message payload in the source must appear in the target. Additions are
  // allowed and expected — v2-to-v3 inserts a system head and promotes the
  // recorded prompt out of the request header — but a loss is refused outright.
  const preservation = checkContentPreserved(patched, migrated.artifact.events)
  result.preservation = preservation
  if (!preservation.ok) {
    return fail(
      result,
      `the migration would drop ${preservation.missing.length} message payload(s) ` +
      `(e.g. ${preservation.missing[0]?.label} ${String(preservation.missing[0]?.preview).slice(0, 80)}); refusing to publish`
    )
  }

  // ── encode with DSH's own current-format encoder ──────────────────────────
  const artifact = migrated.artifact
  let encoded
  let successorRows
  try {
    const headerRow = modules.catalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount)
    const eventRows = artifact.events.map((event) => modules.catalog.encodeCurrentEvent(event))
    successorRows = [headerRow, ...eventRows]
    encoded = encodeSessionLog(successorRows)
  } catch (error) {
    return fail(result, `the migrated artifact could not be encoded: ${message(error)}`)
  }

  // ── prove the bytes we are about to publish are acceptable ────────────────
  const verification = verifySuccessor(modules, encoded, successorRows, artifact)
  result.verification = verification
  if (!verification.ok) {
    return fail(result, `the encoded successor failed verification: ${verification.error}`)
  }

  if (dryRun) {
    result.ok = true
    result.summary = `dry run: would publish ${basename(targetPath)} (${artifact.events.length} events, ${encoded.length} bytes)`
    return result
  }

  // ── publish without overwriting ───────────────────────────────────────────
  try {
    publishNoOverwrite(targetPath, encoded)
  } catch (error) {
    return fail(result, `publishing ${basename(targetPath)} failed: ${message(error)}`)
  }

  // ── record what we published, so the repair can be undone exactly ─────────
  // A sidecar rather than a database: DSH ignores any filename that is not a
  // canonical generation, and the record has to survive alongside the files it
  // describes. Failure to write it is not fatal — the repair already succeeded —
  // but it is reported, because rollback then falls back to a weaker check.
  let manifestPath
  try {
    manifestPath = writeRepairManifest(entry, {
      strategy: REPAIR_MODES.PUBLISH,
      rules: result.ruleIds,
      source: { name: basename(entry.selectedPath), sha256: sha256(decoded.bytes), sizeBytes: decoded.bytes.length },
      published: { name: basename(targetPath), sha256: sha256(encoded), sizeBytes: encoded.length }
    })
  } catch (error) {
    result.warnings = [...(result.warnings ?? []), `could not record the repair manifest: ${message(error)}`]
  }

  result.ok = true
  result.wrote = targetPath
  result.manifestPath = manifestPath
  result.summary = `published ${basename(targetPath)} (${artifact.events.length} events, ${encoded.length} bytes); the source generation is unchanged`
  return result
}

/**
 * Rewrite the source generation in place, leaving a timestamped backup.
 *
 * This is the fallback for environments where DSH's codec cannot be imported.
 * It cannot self-verify with DSH's own chain, so it verifies structurally
 * instead: the patched rows must re-decode and re-parse cleanly.
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @param {RepairResult} result - mutable result record.
 * @param {any} decoded - the decoded source log.
 * @param {unknown[]} patched - the patched rows.
 * @param {any} options - caller options.
 * @param {boolean} dryRun - whether to stop before writing.
 * @returns {RepairResult} the result.
 */
function repairByPatchingSource (entry, result, decoded, patched, options, dryRun) {
  const sourcePath = entry.selectedPath
  let encoded
  try {
    encoded = encodeSessionLog(patched)
  } catch (error) {
    return fail(result, `the patched log could not be encoded: ${message(error)}`)
  }

  // Structural self-check: the bytes we are about to write must decode back to
  // exactly the patched rows.
  const verification = verifyBytes(encoded, patched.length)
  result.verification = verification
  if (!verification.ok) {
    return fail(result, `the re-encoded log failed its structural check: ${verification.error}`)
  }

  if (dryRun) {
    result.ok = true
    result.summary = `dry run: would rewrite ${basename(sourcePath)} in place (${patched.length} rows)`
    return result
  }

  const backupPath = options.backup === false
    ? undefined
    : `${sourcePath}.diag-backup-${stamp()}`
  try {
    if (backupPath !== undefined) {
      // Copy first, then verify the copy is byte-identical BEFORE the original is
      // touched. A backup nobody checked is not a backup.
      copyFileSync(sourcePath, backupPath, fsConstants.COPYFILE_EXCL)
      const original = readFileSync(sourcePath)
      const copy = readFileSync(backupPath)
      if (!original.equals(copy)) {
        rmSync(backupPath, { force: true })
        return fail(result, `the backup copy of ${basename(sourcePath)} did not verify; the original was left untouched`)
      }
      if (!original.equals(decoded.bytes)) {
        return fail(result, `${basename(sourcePath)} changed on disk since it was read; refusing to rewrite it`)
      }
    }

    // Replace atomically: stage a complete file, flush it, then rename over the
    // original. Truncating the original and writing into it would leave a
    // half-written log behind if the process died mid-write.
    const staged = join(dirname(sourcePath), `.session.diagnosis-${randomBytes(8).toString('hex')}.tmp`)
    writeFileDurable(staged, encoded)
    try {
      renameSync(staged, sourcePath)
    } catch (error) {
      rmSync(staged, { force: true })
      throw error
    }
  } catch (error) {
    return fail(result, `rewriting ${basename(sourcePath)} failed: ${message(error)}`)
  }

  result.ok = true
  result.wrote = sourcePath
  result.backupPath = backupPath
  result.summary = `rewrote ${basename(sourcePath)} in place; DSH will migrate it on the next open` +
    (backupPath === undefined ? '' : ` (verified backup: ${basename(backupPath)})`)
  return result
}

/**
 * Verify an encoded successor the way DSH will read it.
 *
 * Three independent gates, all of which must pass:
 * 1. the storage layer's per-row structural admission (`assertV3RowAdmission`);
 * 2. a full restore with `validation: 'transformed'` — the policy DSH's
 *    persistence layer applies to a current generation; and
 * 3. a full restore with `validation: 'current'`, the strictest installed
 *    validation, which catches anything the first two would let through.
 *
 * @param {any} modules - resolved DSH modules.
 * @param {Buffer} encoded - the encoded artifact bytes.
 * @param {unknown[]} rows - the rows that were encoded.
 * @param {any} artifact - the artifact they were encoded from.
 * @returns {{ ok: boolean, error?: string, frames?: number, rows?: number, events?: number, admission?: string }}
 */
function verifySuccessor (modules, encoded, rows, artifact) {
  try {
    const admission = modules.v2to3?.assertV3RowAdmission
    if (typeof admission === 'function') {
      for (let i = 0; i < rows.length; i++) {
        try {
          admission(rows[i])
        } catch (error) {
          return { ok: false, error: `row ${i} fails the storage layer's structural admission: ${message(error)}` }
        }
      }
    }

    const decoded = decodeSessionLog(encoded, '<successor>')
    if (decoded.frames.length === 0) return { ok: false, error: 'the successor contains no frames' }
    if (decoded.badFrames > 0) return { ok: false, error: `the successor has ${decoded.badFrames} undecodable frame(s)` }

    // The first frame must contain exactly one header line: DSH asserts this on
    // every read (`assertZstdHeaderFrame`).
    const firstFrame = decodeSessionLog(
      encoded.subarray(decoded.frames[0].start, decoded.frames[0].end), '<header frame>'
    )
    if (firstFrame.rows.length !== 1) {
      return { ok: false, error: 'the first frame must contain exactly one header line' }
    }
    if (decoded.tornStart !== undefined) {
      return { ok: false, error: 'the successor ends with a torn frame' }
    }

    const expected = rows.length
    if (decoded.rows.length !== expected) {
      return { ok: false, error: `the successor round-trips to ${decoded.rows.length} rows, expected ${expected}` }
    }

    for (const validation of ['transformed', 'current']) {
      const probe = probeMigration(modules, decoded.rows, { recovery: 'strict', validation })
      if (!probe.ok) {
        return { ok: false, error: `re-read with validation=${validation} failed: ${probe.errorName}: ${probe.errorMessage}` }
      }
      if (probe.events !== artifact.events.length) {
        return {
          ok: false,
          error: `re-read with validation=${validation} produced ${probe.events} events, expected ${artifact.events.length}`
        }
      }
    }

    return {
      ok: true,
      frames: decoded.frames.length,
      rows: decoded.rows.length,
      events: artifact.events.length,
      admission: typeof admission === 'function' ? 'passed' : 'not available'
    }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/**
 * Structural verification for the `patch-source` path.
 * @param {Buffer} encoded - the encoded bytes.
 * @param {number} expectedRows - how many rows they should contain.
 * @returns {{ ok: boolean, error?: string, frames?: number, rows?: number }}
 */
function verifyBytes (encoded, expectedRows) {
  try {
    const decoded = decodeSessionLog(encoded, '<patched>')
    if (decoded.badFrames > 0) return { ok: false, error: `${decoded.badFrames} undecodable frame(s)` }
    if (decoded.tornStart !== undefined) return { ok: false, error: 'the log ends with a torn frame' }
    if (decoded.rows.length !== expectedRows) {
      return { ok: false, error: `round-trip produced ${decoded.rows.length} rows, expected ${expectedRows}` }
    }
    return { ok: true, frames: decoded.frames.length, rows: decoded.rows.length }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/**
 * Write bytes to a path only if nothing is there, durably.
 *
 * Staging into a non-canonical temp name and then hard-linking mirrors what DSH
 * itself does: the link is the atomic, no-overwrite publication step, and a
 * reader either sees the complete file or nothing at all.
 *
 * The fallback for filesystems without hard links is a non-atomic exclusive
 * copy, so it is verified afterwards and removed again on any mismatch — a
 * partially written generation would be worse than no generation, because DSH
 * selects it in preference to the readable older one.
 *
 * @param {string} targetPath - the canonical destination.
 * @param {Buffer} bytes - the complete artifact bytes.
 */
function publishNoOverwrite (targetPath, bytes) {
  const staged = join(dirname(targetPath), `.session.diagnosis-${randomBytes(8).toString('hex')}.tmp`)
  writeFileDurable(staged, bytes)
  try {
    try {
      linkSync(staged, targetPath)
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`refusing to overwrite ${targetPath}`)
      copyFileSync(staged, targetPath, fsConstants.COPYFILE_EXCL)
      // Verify the fallback copy; delete it rather than leave a partial file.
      if (!readFileSync(targetPath).equals(bytes)) {
        rmSync(targetPath, { force: true })
        throw new Error(`the published copy of ${basename(targetPath)} did not verify and was removed`)
      }
    }
  } finally {
    try {
      rmSync(staged, { force: true })
    } catch {
      // A leftover staged file is non-canonical and ignored by DSH.
    }
  }
}

/**
 * Extract every durable message payload from rows or migrated events.
 *
 * Only the payload and role are captured — not ids or coordinates — because the
 * migration is allowed to renumber and to re-identify synthetic events. What
 * must not change is what the conversation actually says.
 *
 * @param {unknown[]} rows - raw rows or migrated events.
 * @returns {string[]} one fingerprint per message payload.
 */
function messagePayloads (rows) {
  const out = []
  const push = (label, message) => {
    if (message === null || typeof message !== 'object' || !('content' in message)) return
    out.push(`${label}\u0000${JSON.stringify(message.content)}\u0000${message.role ?? ''}`)
  }
  for (const row of rows) {
    const data = row?.data
    switch (row?.type) {
      case 'user/message': push('user', data); break
      case 'assistant/message': push('assistant', data?.message); break
      case 'tool/result': push('tool', data?.message); break
      case 'system/message': push('system', data?.message); break
      case 'agent/inbox/spliced': for (const m of data?.inserted ?? []) push('inbox', m); break
      case 'session/title-llm-request': for (const m of data?.messages ?? []) push('title', m); break
      default: break
    }
  }
  return out
}

/**
 * Decide whether every source message payload survives into the target.
 *
 * Additions are permitted: v2-to-v3 inserts an empty system head and promotes
 * each recorded prompt from `request/header.data.header.system` into a
 * `system/message`. Losses are not.
 *
 * @param {unknown[]} sourceRows - the patched source rows.
 * @param {unknown[]} targetEvents - the migrated current-format events.
 * @returns {{ ok: boolean, sourceCount: number, targetCount: number, addedCount: number,
 *   missing: Array<{ label: string, preview: string }> }}
 */
export function checkContentPreserved (sourceRows, targetEvents) {
  const count = (list) => {
    const m = new Map()
    for (const item of list) m.set(item, (m.get(item) ?? 0) + 1)
    return m
  }
  const source = count(messagePayloads(sourceRows))
  const target = count(messagePayloads(targetEvents))

  const missing = []
  for (const [fingerprint, want] of source) {
    const have = target.get(fingerprint) ?? 0
    if (have >= want) continue
    const [label, content] = fingerprint.split('\u0000')
    missing.push({ label, preview: content })
  }
  let addedCount = 0
  for (const [fingerprint, have] of target) addedCount += Math.max(0, have - (source.get(fingerprint) ?? 0))

  return { ok: missing.length === 0, sourceCount: source.size, targetCount: target.size, addedCount, missing }
}

/**
 * The sidecar that records what a repair did.
 *
 * DSH ignores any file in a session directory that is not a canonical
 * generation, so this is inert as far as the harness is concerned, and it makes
 * a rollback exact rather than best-effort.
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @returns {string} the manifest path.
 */
function manifestPathFor (entry) {
  return join(entry.dir, REPAIR_MANIFEST_NAME)
}

/**
 * Record a completed repair beside the session it changed.
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @param {object} record - strategy, rules, and source/published descriptors.
 * @returns {string} the manifest path.
 */
function writeRepairManifest (entry, record) {
  const path = manifestPathFor(entry)
  const body = JSON.stringify({
    tool: 'dsh-sessions-diagnosis',
    schemaVersion: 1,
    sessionId: entry.id,
    repairedAt: new Date().toISOString(),
    ...record
  }, null, 2)
  writeFileDurable(path, Buffer.from(body, 'utf8'))
  return path
}

/**
 * Read a session's repair manifest, if one is present.
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @returns {any|undefined} the parsed record, or undefined.
 */
export function readRepairManifest (entry) {
  const path = manifestPathFor(entry)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Undo a repair, restoring the session to its pre-repair state.
 *
 * The successor is **renamed aside**, never deleted, so even a rollback is
 * reversible. The operation refuses whenever it cannot prove the successor is
 * still exactly what the repair published, because DSH appends to the current
 * generation once the session is used again — removing it then would discard
 * everything written since.
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @param {object} [options]
 * @param {string} [options.root] - explicit sessions root (unused; kept for symmetry).
 * @param {string} [options.dshHome] - explicit DSH home (unused; kept for symmetry).
 * @returns {{ ok: boolean, id: string, rolledBack?: string, restoredTo?: string, error?: string, summary: string }}
 *   the outcome.
 */
export function rollbackSession (entry, options = {}) {
  const outcome = { ok: false, id: entry.id, summary: '' }
  const manifest = readRepairManifest(entry)

  // Which generation would disappear, and which one becomes selected again?
  const current = entry.generations[entry.generations.length - 1]
  if (current === undefined) {
    outcome.error = 'the session directory holds no canonical generation'
    outcome.summary = `not rolled back: ${outcome.error}`
    return outcome
  }
  const older = entry.generations.slice(0, -1)
  if (older.length === 0) {
    outcome.error = 'there is no older generation to fall back to'
    outcome.summary = `not rolled back: ${outcome.error}`
    return outcome
  }

  const expectedName = manifest?.published?.name
  if (expectedName !== undefined && expectedName !== basename(current.path)) {
    outcome.error = `the repair published ${expectedName}, but the selected generation is ${basename(current.path)}; ` +
      'a newer generation exists, so rolling back could discard later history'
    outcome.summary = `not rolled back: ${outcome.error}`
    return outcome
  }
  if (manifest?.published?.sha256 !== undefined) {
    const actual = sha256(readFileSync(current.path))
    if (actual !== manifest.published.sha256) {
      outcome.error = `${basename(current.path)} has changed since the repair (expected ${manifest.published.sha256.slice(0, 12)}…, ` +
        `found ${actual.slice(0, 12)}…); the session was used after being repaired, so rolling back could discard new messages`
      outcome.summary = `not rolled back: ${outcome.error}`
      return outcome
    }
  } else if (manifest === undefined) {
    outcome.error = 'no repair manifest was found, so the successor cannot be proven to be this tool\'s output'
    outcome.summary = `not rolled back: ${outcome.error}`
    return outcome
  }

  const aside = `${current.path}.diag-rolled-back-${stamp()}`
  try {
    renameSync(current.path, aside)
    rmSync(manifestPathFor(entry), { force: true })
  } catch (error) {
    outcome.error = `renaming ${basename(current.path)} failed: ${message(error)}`
    outcome.summary = `not rolled back: ${outcome.error}`
    return outcome
  }

  outcome.ok = true
  outcome.rolledBack = aside
  outcome.restoredTo = older[older.length - 1].path
  outcome.summary =
    `rolled back: ${basename(current.path)} moved aside to ${basename(aside)}; ` +
    `DSH now selects ${basename(outcome.restoredTo)} again. ` +
    'The session will not open until it is repaired again, which is exactly its pre-repair state.'
  return outcome
}

/** SHA-256 of a buffer, as lowercase hex. */
function sha256 (buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Write a file and flush it to stable storage.
 * @param {string} path - destination path.
 * @param {Buffer} bytes - bytes to write.
 */
function writeFileDurable (path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * The format version the *installed* DSH reads.
 *
 * The tool's own constant is only a fallback for when DSH's catalog could not be
 * reached at all. A repair has to target the generation the running harness
 * actually reads: under an older DSH that is a lower version, and publishing a
 * successor named for a newer one would produce a file DSH refuses to select.
 *
 * @param {any} modules - resolved DSH modules, when they were resolved.
 * @returns {number} the target format version.
 */
function installedVersion (modules) {
  return typeof modules?.currentVersion === 'number' ? modules.currentVersion : CURRENT_FORMAT_VERSION
}

/**
 * The canonical filename of a successor generation.
 *
 * DSH requires the filename's version to match the header's version, and
 * rejects a directory that mixes compressed and uncompressed generations — so
 * the successor must inherit the source's compression suffix.
 *
 * @param {import('./store.js').SessionEntry} entry - the session.
 * @param {number} version - the target format version.
 * @returns {string} the basename.
 */
function successorFilename (entry, version) {
  const selected = entry.generations[entry.generations.length - 1]
  const suffix = selected?.compression === 'none' ? '' : '.zstd'
  return `session.v${version}.jsonl${suffix}`
}

/**
 * Resolve the rule ids a call should run.
 *
 * With no explicit list, **every known rule is offered** and detection decides
 * which apply. That keeps a repair coherent with the diagnosis: if the diagnosis
 * says "repairable" and names the rule, the repair must be able to run it. The
 * risk tier is not a silent capability gate — the dry run and the explicit
 * `apply` are the consent step, and each result reports which tiers ran.
 *
 * Callers that genuinely want a narrower set (a bulk operation, say) pass
 * `rules` explicitly.
 *
 * @param {ReadonlyArray<string>|undefined} rules - explicit rule ids, or undefined.
 * @returns {string[]} the rule ids to consider.
 */
function resolveRuleIds (rules) {
  if (rules === undefined) return REPAIR_RULES.map((rule) => rule.id)
  const ids = []
  for (const id of rules) {
    if (getRule(id) === undefined) throw new Error(`unknown repair rule ${JSON.stringify(id)}`)
    ids.push(id)
  }
  return ids
}

/** @param {RepairResult} result @param {string} reason @returns {RepairResult} */
function fail (result, reason) {
  result.ok = false
  result.error = reason
  result.summary = `not repaired: ${reason}`
  return result
}

/** @param {string} path @returns {string} */
function dirname (path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? '.' : path.slice(0, index)
}

/** @param {string} path @returns {string} */
function basename (path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}

/** A filesystem-safe UTC timestamp. */
function stamp () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** @param {unknown} value @returns {any} */
function deepClone (value) {
  return JSON.parse(JSON.stringify(value))
}

/** @param {unknown} error @returns {string} */
function message (error) {
  return error instanceof Error ? error.message : String(error)
}
