#!/usr/bin/env node
/**
 * `dsh-session-doctor` — diagnose and repair a DSH session store without DSH.
 *
 * A standalone CLI over the same core the plugin uses. Useful when the web UI
 * itself is the problem, on a headless machine, or in a script.
 *
 *   dsh-session-doctor scan                       # what is in the store
 *   dsh-session-doctor diagnose                   # full store diagnosis
 *   dsh-session-doctor diagnose <id>              # one session, in detail
 *   dsh-session-doctor repair <id>                # dry run (writes nothing)
 *   dsh-session-doctor repair <id> --apply        # perform the repair
 *   dsh-session-doctor repair --all --apply       # repair every repairable session
 *   dsh-session-doctor rollback <id>              # undo a repair this tool made
 *
 * Add `--json` for machine-readable output.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertDemoStoreIsNotReal, createDemoSession, diagnoseEntry, diagnoseStore, findDemoSessions, listSessions, LOW_RISK_RULE_IDS, planRepair, probeMigration, readRepairManifest, readSessionLog, removeDemoSessions, repairSession, resolveDemoStore, resolveSessionsRoot, rollbackSession, REPAIR_MODES, REPAIR_RULES, resolveDshFormatModules } from '../lib/core/index.js'

/**
 * How to re-invoke this CLI, exactly as the user just invoked it.
 *
 * The tool is a script in this repo, not a command on `PATH`, so a hint reading
 * `dsh-session-doctor …` can name something the reader cannot actually run.
 * Echoing the real invocation keeps every suggestion copy-pasteable — whether it
 * was started via `node bin/…`, through `npm link`, or from somewhere else.
 */
const SELF = process.argv[1]
const SELF_COMMAND = SELF === undefined || SELF.length === 0
  ? 'dsh-session-doctor'
  : `node "${SELF}"`

const USAGE = `dsh-session-doctor — diagnose and repair DSH sessions that will not open

Usage:
  ${SELF_COMMAND} <command> [options]

Commands:
  scan                     Summarise the session store (header frames only)
  diagnose [<id>]          Diagnose one session, or every session
  repair <id> | --all      Repair a session (dry run unless --apply)
  rollback <id>            Undo a repair this tool made, restoring the prior state
  verify                   Restore every session with DSH's codec and report failures
  demo                     Create a synthetic broken session in a throwaway store
  demo --remove            Delete every demo session again (needs --apply)
  rules                    List the known repair rules

Options:
  --apply                  Actually write (default is a dry run; demo --remove needs it)
  --mode <mode>            ${Object.values(REPAIR_MODES).join(' | ')}
  --rules <a,b>            Restrict repair to these rule ids (default: every rule that matches)
  --include-medium-risk    With --all, also run rules that edit recorded metadata
  --scenario <name>        demo: mention (default) | descriptor
  --cwd <path>             demo: working directory to record in the header
  --id <session-id>        demo: exact session id (default: a fresh collision-free one)
  --at <iso8601>           demo: creation timestamp (default: now)
  --force                  demo --remove: also delete demos you have talked in
  --root <path>            Session store root (default: $DSH_HOME/sessions)
                           demo: a store to use instead of the throwaway one. The
                           real session store is refused: a demo is a broken
                           session and must never join your conversations.
  --dsh-home <path>        DSH home directory
  --json                   Emit JSON instead of text
  -h, --help               Show this help

The demo store lives in <tmp>/dsh-session-doctor-demo and can be relocated with
DSH_DEMO_HOME. To watch a demo in the dashboard, point a throwaway harness at it:

  $env:DSH_HOME = "<tmp>/dsh-session-doctor-demo"; dsh web
`

/**
 * Parse argv into a command and options.
 * @param {string[]} argv - process arguments after the script name.
 * @returns {{ command: string, positional: string[], options: Record<string, any> }}
 */
function parseArgs (argv) {
  const options = { apply: false, json: false, all: false }
  const positional = []
  let command = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') { options.help = true; continue }
    if (arg === '--apply') { options.apply = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--all') { options.all = true; continue }
    if (arg === '--include-medium-risk') { options.includeMediumRisk = true; continue }
    if (arg === '--remove') { options.remove = true; continue }
    if (arg === '--force') { options.force = true; continue }
    if (arg === '--mode') { options.mode = argv[++i]; continue }
    if (arg === '--scenario') { options.scenario = argv[++i]; continue }
    if (arg === '--cwd') { options.cwd = argv[++i]; continue }
    if (arg === '--id') { options.id = argv[++i]; continue }
    if (arg === '--at') { options.at = argv[++i]; continue }
    if (arg === '--rules') { options.rules = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean); continue }
    if (arg === '--root') { options.root = argv[++i]; continue }
    if (arg === '--dsh-home') { options.dshHome = argv[++i]; continue }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    if (command === '') command = arg
    else positional.push(arg)
  }
  return { command, positional, options }
}

/**
 * Find one session by exact id or unambiguous fragment.
 * @param {string} needle - id or fragment.
 * @param {any} options - resolved options.
 * @returns {any} the session entry.
 */
function findEntry (needle, options) {
  const { sessions } = listSessions(options)
  const exact = sessions.find((entry) => entry.id === needle)
  if (exact !== undefined) return exact
  const matches = sessions.filter((entry) => entry.id.includes(needle))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error(`no session matches ${JSON.stringify(needle)}`)
  throw new Error(`${matches.length} sessions match ${JSON.stringify(needle)}:\n  ${matches.map((m) => m.id).join('\n  ')}`)
}

/** Print a store census. */
function cmdScan (options) {
  const { root, sessions, errors } = listSessions(options)
  if (options.json) {
    return console.log(JSON.stringify({ root, errors, sessions }, null, 2))
  }
  if (root === undefined) return console.log('No DSH session store found. Set DSH_HOME or pass --root.')
  console.log(`Session store: ${root}`)
  const stale = sessions.filter((s) => s.highestVersion < 3)
  console.log(`${sessions.length} session(s); ${sessions.length - stale.length} on the current format v3, ${stale.length} older.\n`)
  for (const entry of sessions) {
    const versions = entry.generations.map((g) => `v${g.version}`).join('+') || '—'
    const flag = entry.highestVersion < 3 ? '  <-- no v3 generation' : ''
    console.log(`  ${entry.id}  [${entry.projectDir}]  ${versions}${flag}`)
    if (entry.foreign.length > 0) {
      console.log(`      ignored by DSH: ${entry.foreign.map((g) => g.path.split(/[\\/]/).pop()).join(', ')}`)
    }
  }
  if (errors.length > 0) console.log(`\n${errors.length} directory error(s); first: ${errors[0].message}`)
}

/** Diagnose one session or the whole store. */
async function cmdDiagnose (positional, options) {
  const modules = await resolveDshFormatModules(options)

  if (positional.length > 0) {
    const entry = findEntry(positional[0], options)
    const diagnosis = diagnoseEntry(entry, { modules })
    if (options.json) return console.log(JSON.stringify(diagnosis, null, 2))
    printDiagnosis(entry, diagnosis)
    return
  }

  const report = await diagnoseStore(options)
  if (options.json) return console.log(JSON.stringify(report, null, 2))
  printReport(report)
}

/** Repair one session, or every repairable session. */
async function cmdRepair (positional, options) {
  const modules = await resolveDshFormatModules(options)
  if (modules === undefined) {
    console.error('warning: DSH\'s session-format catalog was not found; use --mode patch-source')
  }

  const mode = options.mode ?? (modules === undefined ? REPAIR_MODES.PATCH_SOURCE : REPAIR_MODES.PUBLISH)
  const targets = []

  if (options.all === true) {
    // A bulk sweep has no per-session confirmation step, so it stays on the rules
    // that only rewrite a provenance tag unless the caller opts in. A targeted
    // `repair <id>` runs whatever the session actually needs, because the dry run
    // it prints is the consent step.
    const report = await diagnoseStore(options)
    const skipped = []
    for (const session of report.sessions) {
      if (!session.repairable) continue
      const needsMedium = session.findings.some((finding) => {
        const rule = REPAIR_RULES.find((candidate) => candidate.id === finding.ruleId)
        return rule?.risk === 'medium'
      })
      if (needsMedium && options.includeMediumRisk !== true) {
        skipped.push(session.id)
        continue
      }
      targets.push(session.id)
    }
    if (skipped.length > 0) {
      console.log(`${skipped.length} session(s) need a rule that edits recorded metadata and were left alone:`)
      for (const id of skipped) console.log(`  ${id}`)
      console.log('Re-run with --include-medium-risk, or repair one at a time, to include them.\n')
    }
    if (targets.length === 0) return console.log('No repairable sessions found.')
  } else if (positional.length > 0) {
    for (const needle of positional) targets.push(findEntry(needle, options).id)
  } else {
    throw new Error('repair needs a session id, or --all')
  }

  const results = []
  for (const id of targets) {
    const entry = findEntry(id, options)
    const result = await repairSession(entry, { ...options, modules, mode, dryRun: options.apply !== true })
    results.push({ entry, result })
    if (!options.json) {
      console.log(`${result.ok ? 'OK  ' : 'FAIL'}  ${id}`)
      console.log(`      ${result.summary}`)
      for (const finding of result.findings.slice(0, 5)) {
        console.log(`      ${finding.type} seq ${finding.seq} ${finding.path}: ` +
          `${JSON.stringify(finding.before)} -> ${JSON.stringify(finding.after)}`)
      }
      if (result.findings.length > 5) console.log(`      ... and ${result.findings.length - 5} more edit(s)`)
      if (result.verification?.ok === true) {
        console.log(`      verified: ${result.verification.rows} rows / ${result.verification.events} events, ` +
          `storage admission ${result.verification.admission}`)
      }
      if (result.preservation?.ok === true) {
        console.log(`      content: ${result.preservation.sourceCount} payload(s) checked, ` +
          `0 lost, ${result.preservation.addedCount} added by the migration`)
      }
      for (const warning of result.warnings ?? []) console.log(`      note: ${warning}`)
      if (result.backupPath !== undefined) console.log(`      backup: ${result.backupPath}`)
      if (result.manifestPath !== undefined) console.log(`      undo with: ${SELF_COMMAND} rollback ${id}`)
      console.log('')
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results.map(({ entry, result }) => ({ id: entry.id, ...result })), null, 2))
  } else if (options.apply !== true && results.some((r) => r.result.ok)) {
    console.log('This was a dry run. Re-run with --apply to perform the repair.')
  }
}

/** Print one diagnosis in detail. */
function printDiagnosis (entry, diagnosis) {
  console.log(`Session ${diagnosis.id}  [${diagnosis.projectDir}]`)
  console.log(`Verdict: ${diagnosis.headline}`)
  console.log(`Artifact DSH would open: ${entry.selectedPath ?? '<none>'}`)
  if (diagnosis.physical !== undefined) {
    const p = diagnosis.physical
    console.log(`Frames: ${p.frames}${p.badFrames > 0 ? ` (${p.badFrames} bad)` : ''}   ` +
      `Rows: ${p.rows}${p.tornStart === undefined ? '' : '   Torn tail: yes'}`)
  }
  if (diagnosis.generations.length > 1) {
    console.log(`Generations present: ${diagnosis.generations.map((g) => `v${g.version}`).join(', ')}`)
  }
  if (diagnosis.foreign.length > 0) {
    console.log(`Ignored by DSH: ${diagnosis.foreign.map((g) => g.name).join(', ')}`)
  }
  console.log('\nFindings:')
  for (const reason of diagnosis.reasons) {
    console.log(`  [${reason.severity}] ${reason.code}: ${reason.summary}`)
    if (reason.detail !== undefined) console.log(`      ${String(reason.detail).split('\n')[0].slice(0, 300)}`)
  }
  if (diagnosis.findings.length > 0) {
    console.log(`\nPlanned repair edits (${diagnosis.findings.length}):`)
    for (const finding of diagnosis.findings.slice(0, 10)) {
      console.log(`  ${finding.ruleId}: ${finding.type} seq ${finding.seq} ${finding.path}`)
      console.log(`      ${JSON.stringify(finding.before)}  ->  ${JSON.stringify(finding.after)}`)
    }
    if (diagnosis.findings.length > 10) console.log(`  ... and ${diagnosis.findings.length - 10} more`)
    console.log(diagnosis.repairable
      ? `\nRun: ${SELF_COMMAND} repair ${diagnosis.id} --apply`
      : '\nThese edits are NOT sufficient — the repaired log was verified to still fail. No repair is offered.')
  }
}

/** Print a store-wide report. */
function printReport (report) {
  console.log(`Session store: ${report.root ?? '<not found>'}`)
  console.log(`Released format codec: ${report.codecAvailable ? `available (${report.codecSource})` : 'NOT FOUND — older logs cannot be checked'}`)
  const s = report.summary
  console.log(`${s.total} session(s): ${s.ok} ok, ${s.unmigrated} unmigrated, ${s.repairable} repairable, ` +
    `${s.unrepairable} unrepairable, ${s.corrupt} corrupt, ${s.tooNew} too-new, ${s.empty} empty, ` +
    `${s.unknown ?? 0} unknown\n`)

  // `unknown` is not a failure: it means nothing was checked. Reporting it as
  // "will not open" is the false accusation this list exists to avoid.
  const broken = report.sessions.filter((session) => session.status !== 'unknown' && !session.openable)
  const unchecked = report.sessions.filter((session) => session.status === 'unknown')
  if (unchecked.length > 0) {
    console.log(`${unchecked.length} session(s) could not be checked: this build of DSH ships no format ` +
      'codec, so their verdict is unknown — not a failure. Run the scan from a DSH install that has one.\n')
  }
  if (broken.length === 0) {
    console.log('Every session that could be checked opens.')
    return
  }
  console.log(`${broken.length} session(s) will not open:\n`)
  for (const session of broken) {
    console.log(`  ${session.id}  [${session.projectDir}]   ${session.headline}`)
    for (const reason of session.reasons) {
      console.log(`      ${reason.code}: ${reason.summary}`)
      if (reason.detail !== undefined) console.log(`        ${String(reason.detail).split('\n')[0].slice(0, 240)}`)
    }
    for (const finding of session.findings.slice(0, 3)) {
      console.log(`      fix: ${finding.type} seq ${finding.seq} ${finding.path} ` +
        `${JSON.stringify(finding.before)} -> ${JSON.stringify(finding.after)}`)
    }
    if (session.findings.length > 3) console.log(`      ... and ${session.findings.length - 3} more edit(s)`)
    console.log(`      ${session.repairable ? `-> repairable: ${SELF_COMMAND} repair ${session.id} --apply` : '-> no known repair'}`)
    console.log('')
  }
}

/** List the repair rules. */
function cmdRules (options) {
  if (options.json) return console.log(JSON.stringify(REPAIR_RULES.map(({ id, title, risk, rationale }) => ({ id, title, risk, rationale })), null, 2))
  console.log('Repair rules:\n')
  for (const rule of REPAIR_RULES) {
    console.log(`  ${rule.id}   [risk: ${rule.risk}]`)
    console.log(`      ${rule.title}`)
    console.log(`      ${rule.rationale.replace(/\s+/g, ' ').slice(0, 300)}`)
    console.log('')
  }
  console.log('Low-risk rules run by default; medium-risk rules must be named with --rules.')
}

/** Prove every selected generation in the store restores cleanly. */
async function cmdVerify (options) {
  const modules = await resolveDshFormatModules(options)
  if (modules === undefined) {
    console.error('error: DSH\'s session-format catalog was not found, so nothing can be restored')
    process.exit(1)
  }
  const { sessions } = listSessions(options)
  const rows = []
  for (const entry of sessions) {
    if (entry.selectedPath === undefined) {
      rows.push({ id: entry.id, ok: false, error: 'no readable artifact' })
      continue
    }
    try {
      const decoded = readSessionLog(entry.selectedPath)
      const results = {}
      for (const validation of ['transformed', 'current']) {
        const probe = probeMigration(modules, decoded.rows, { validation })
        results[validation] = probe.ok ? { ok: true, events: probe.events } : { ok: false, error: `${probe.errorName}: ${probe.errorMessage}` }
      }
      const ok = results.transformed.ok && results.current.ok
      rows.push({
        id: entry.id,
        ok,
        generation: `v${entry.highestVersion}`,
        frames: decoded.frames.length,
        badFrames: decoded.badFrames,
        rows: decoded.rows.length,
        events: results.transformed.events,
        error: ok ? undefined : (results.transformed.error ?? results.current.error)
      })
    } catch (error) {
      rows.push({ id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const bad = rows.filter((row) => !row.ok)
  if (options.json) {
    console.log(JSON.stringify({ total: rows.length, failed: bad.length, sessions: rows }, null, 2))
  } else {
    console.log(`Restored ${rows.length - bad.length}/${rows.length} session(s) with DSH's own codec.`)
    for (const row of rows) {
      if (row.ok) continue
      console.log(`  FAIL ${row.id}: ${row.error}`)
    }
    if (bad.length === 0) console.log('Every session restores cleanly under both validation policies.')
  }
  if (bad.length > 0) process.exit(1)
}

/** Undo a repair this tool made, restoring the session's pre-repair state. */
function cmdRollback (positional, options) {
  if (positional.length === 0) throw new Error('rollback needs a session id')
  const results = []
  for (const needle of positional) {
    const entry = findEntry(needle, options)
    const manifest = readRepairManifest(entry)
    const outcome = rollbackSession(entry)
    results.push({ id: entry.id, manifest, ...outcome })
    if (!options.json) {
      console.log(`${outcome.ok ? 'OK  ' : 'FAIL'}  ${entry.id}`)
      console.log(`      ${outcome.summary}`)
      if (manifest !== undefined && !outcome.ok) {
        console.log(`      repaired at ${manifest.repairedAt} via ${manifest.strategy}`)
      }
      console.log('')
    }
  }
  if (options.json) console.log(JSON.stringify(results, null, 2))
}

/**
 * The store a `demo` run uses, and the refusal that keeps it out of yours.
 *
 * The decision itself lives in the core ({@link module:dsh-sessions-diagnosis/core/demo})
 * so it can be tested directly; this only supplies the process's DSH home and
 * reports which store was chosen.
 *
 * @param {any} options - parsed CLI options.
 * @returns {{ root: string, home: string|undefined, scratch: boolean, source: string }} the demo store.
 */
function demoStoreFor (options) {
  const store = resolveDemoStore(options.root === undefined ? {} : { root: options.root })
  assertDemoStoreIsNotReal(store.root, resolveSessionsRoot(options.dshHome))
  return store
}

/** Create a synthetic broken session so a repair can be practised safely. */
function cmdDemo (options) {
  if (options.remove === true) return cmdDemoRemove(options)

  const store = demoStoreFor(options)

  const scenario = options.scenario ?? 'mention'
  if (scenario !== 'mention' && scenario !== 'descriptor') {
    throw new Error(`unknown scenario ${JSON.stringify(scenario)}; expected "mention" or "descriptor"`)
  }

  const createdAt = options.at === undefined ? undefined : Date.parse(options.at)
  if (options.at !== undefined && !Number.isFinite(createdAt)) {
    throw new Error(`--at must be an ISO-8601 timestamp, got ${JSON.stringify(options.at)}`)
  }

  // A demo store has no sidebar, so it has no archive set to honour. Consulting
  // the real one would also let an unrelated DSH home steer the id choice here.
  const created = createDemoSession({
    root: store.root,
    scenario,
    cwd: options.cwd,
    createdAt,
    id: options.id,
    archived: new Set()
  })
  const entry = listSessions({ root: store.root }).sessions.find((session) => session.id === created.id)

  if (options.json) {
    console.log(JSON.stringify({ ...created, store, entry: entry ?? null }, null, 2))
    return
  }

  console.log('Created a synthetic broken session.\n')
  console.log(`  id        : ${created.id}`)
  console.log(`  file      : ${created.path}`)
  console.log(`  defect    : ${created.defect}`)
  console.log(`  bytes     : ${created.bytes}`)
  console.log('')
  console.log(`  store     : ${store.root}`)
  if (store.scratch) {
    console.log(`              a throwaway demo store (${store.source === 'default' ? 'default' : 'DSH_DEMO_HOME'}),`)
    console.log('              never your session store. DSH does not read it, so this demo')
    console.log('              cannot appear in your sidebar or affect your conversations.')
  } else {
    console.log('              an explicit --root store, not your session store.')
  }
  if (!created.idRedeemed) {
    console.log('')
    console.log(`  note      : ${created.requestedId} was already taken by an existing session`)
    console.log(`              in this store, so ${created.id} was used instead.`)
  }
  console.log('')
  console.log('It is a genuine released-v0 log, so DSH refuses it for exactly the reason')
  console.log('it refuses a real one. Run the whole flow against this demo store:')
  console.log('')
  console.log(`  ${SELF_COMMAND} diagnose ${created.id} --root "${store.root}"`)
  console.log(`  ${SELF_COMMAND} repair ${created.id} --root "${store.root}" --apply`)
  console.log(`  ${SELF_COMMAND} rollback ${created.id} --root "${store.root}"`)
  console.log('')
  console.log('It contains no data of yours and no real conversation. Remove it with:')
  console.log('')
  console.log(`  ${SELF_COMMAND} demo --remove --apply`)
  if (store.home !== undefined) {
    console.log('')
    console.log('To watch the same flow in the dashboard, point DSH at the demo store\'s home')
    console.log('in a throwaway process — never at the harness you are using now:')
    console.log('')
    console.log(`  $env:DSH_HOME = "${store.home}"; dsh web`)
  }
}

/** List or delete the demo sessions in a store. */
function cmdDemoRemove (options) {
  // Cleanup is deliberately NOT gated on the safety refusal: deleting demos from
  // the real store is exactly how a store gets clean again, including stores that
  // older versions of this tool wrote into.
  const store = resolveDemoStore(options.root === undefined ? {} : { root: options.root })
  const roots = [store.root]
  const real = resolveSessionsRoot(options.dshHome)
  if (real !== undefined && roots.every((root) => resolve(root) !== resolve(real))) roots.push(real)

  const found = []
  for (const root of roots) {
    if (root !== store.root && !existsSync(root)) continue
    for (const demo of findDemoSessions({ root, scenario: options.scenario })) found.push({ ...demo, root })
  }

  if (found.length === 0) {
    console.log('No demo sessions found.')
    if (store.scratch) console.log(`Looked in the demo store (${store.root}) and in your real session store.`)
    return
  }

  if (options.json) {
    const results = roots.map((root) => ({
      root,
      ...removeDemoSessions({
        root,
        scenario: options.scenario,
        apply: options.apply === true,
        force: options.force === true
      })
    }))
    console.log(JSON.stringify(options.apply === true ? { results } : { dryRun: true, found }, null, 2))
    return
  }

  if (options.apply !== true) {
    console.log(`${found.length} demo session(s) found:`)
    for (const demo of found) {
      console.log(`  ${demo.id}   [${demo.state}]`)
      console.log(`     ${demo.dir}`)
      console.log(`     ${demo.files.length} file(s), ${demo.bytes} bytes — ${demo.detail}`)
    }
    const blocked = found.filter((demo) => !demo.removable)
    console.log('')
    console.log('Nothing was deleted. Re-run with --apply to remove them.')
    if (blocked.length > 0) {
      console.log(`${blocked.length} of them will NOT be removed without --force, because they hold`)
      console.log('content this tool did not write. A demo is a live session: once you talk in it,')
      console.log('deleting it destroys a real conversation.')
    }
    console.log('Ownership is proved by a "session.diag-demo.json" marker this tool wrote, not by')
    console.log('the session id, so a real session can never be selected.')
    return
  }

  const removed = []
  const kept = []
  for (const root of roots) {
    if (root !== store.root && !existsSync(root)) continue
    const outcome = removeDemoSessions({
      root,
      scenario: options.scenario,
      apply: true,
      force: options.force === true
    })
    for (const demo of outcome.removed) removed.push({ ...demo, root })
    for (const demo of outcome.kept) kept.push({ ...demo, root })
  }

  console.log(`Removed ${removed.length} demo session(s):`)
  for (const demo of removed) console.log(`  ${demo.id}`)

  if (kept.length > 0) {
    console.log('')
    console.log(`Kept ${kept.length} demo session(s), because they hold content this tool did not write:`)
    for (const demo of kept) console.log(`  ${demo.id} — ${demo.detail}`)
    console.log('')
    console.log('If you really want them gone, pass --force. Otherwise just archive them in the')
    console.log('sidebar, or leave them; they are ordinary sessions.')
  }

  console.log('')
  console.log('Demos are created only in the throwaway demo store, so nothing was taken out of')
  console.log('your conversations by this cleanup. If a demo was archived in the sidebar before')
  console.log('that changed, its id may still sit in the workspace registry: a stale archived id')
  console.log('matches nothing and is harmless, and this tool does not edit that file.')
}
const { command, positional, options } = parseArgs(process.argv.slice(2))

try {
  if (options.help === true || command === '' || command === 'help') {
    console.log(USAGE)
    process.exit(command === '' && options.help !== true ? 1 : 0)
  }
  switch (command) {
    case 'scan': cmdScan(options); break
    case 'diagnose': await cmdDiagnose(positional, options); break
    case 'repair': await cmdRepair(positional, options); break
    case 'rollback': cmdRollback(positional, options); break
    case 'verify': await cmdVerify(options); break
    case 'demo': cmdDemo(options); break
    case 'rules': cmdRules(options); break
    default:
      console.error(`unknown command ${JSON.stringify(command)}\n`)
      console.log(USAGE)
      process.exit(1)
  }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
