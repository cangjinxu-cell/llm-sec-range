/**
 * `dsh-sessions-diagnosis` — host (Node) half.
 *
 * Gives DSH two capabilities:
 *
 * - three model-facing tools (`session_diagnose`, `session_repair`,
 *   `session_store_overview`) so an agent can investigate and fix a session
 *   store conversationally; and
 * - a small JSON API under `/sessions-diagnosis/api`, which the browser half
 *   uses to render the dashboard.
 *
 * The heavy lifting lives in `./core`, which is plain Node.js and has no DSH
 * imports, so the identical code backs the standalone CLI and the test suite.
 *
 * @module dsh-sessions-diagnosis
 */

import { diagnoseEntry, diagnoseStore, listSessions, planRepair, readRepairManifest, repairSession, rollbackSession, REPAIR_MODES, REPAIR_RULES, resolveDshFormatModules } from './core/index.js'

/** Plugin identity for the `cordis.patch.yml` row. */
export const name = 'dsh-sessions-diagnosis'

/** Services required before mount: the tool registry. */
export const inject = ['tools']

/** HTTP prefix owned by this plugin's dashboard API. */
const API_PREFIX = '/sessions-diagnosis/api'

/** Largest JSON request body the dashboard API accepts. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Tool-registry schemas.
 *
 * DSH enforces a documented JSON Schema **subset**, and it is strict about it:
 * `additionalProperties` and `required` are keywords for `type: "object"` only,
 * `items` only for `type: "array"`, and an unsupported keyword is a hard
 * `register()` failure — which takes the whole profile down at boot. So every
 * array here declares `items`, and nothing declares `additionalProperties` on an
 * array. `test/run.mjs` pins this by running DSH's own validator over every
 * definition rather than trusting a hand-written expectation.
 */

/** One row of a store census (`session_store_overview`). */
const STORE_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    project: { type: 'string' },
    highestVersion: { type: 'integer' },
    generations: { type: 'array', items: { type: 'integer' } },
    sizeBytes: { type: 'integer' },
    migrated: { type: 'boolean' }
  },
  required: ['id', 'project', 'highestVersion', 'generations', 'sizeBytes', 'migrated']
}

/** One session's summary inside a `session_diagnose` result. */
const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    project: { type: 'string' },
    status: { type: 'string' },
    headline: { type: 'string' },
    openable: { type: 'boolean' },
    repairable: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
    findings: { type: 'integer' }
  },
  required: ['id', 'project', 'status', 'headline', 'openable', 'repairable', 'reasons', 'findings']
}

/**
 * One planned edit inside a `session_repair` result.
 *
 * `additionalProperties` is left open because `before` and `after` hold
 * arbitrary JSON — a source object, a number, a string — and an empty `{}`
 * schema is not part of DSH's supported subset.
 */
const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ruleId: { type: 'string' },
    seq: { type: 'integer' },
    type: { type: 'string' },
    path: { type: 'string' },
    detail: { type: 'string' }
  },
  required: ['ruleId', 'type', 'path']
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx - the cordis context.
 * @param {any} [config] - plugin config from the patch row.
 */
export function apply (ctx, config) {
  const dshHome = typeof config?.dshHome === 'string' ? config.dshHome : undefined
  const catalogPath = typeof config?.catalogPath === 'string' ? config.catalogPath : undefined
  const base = { dshHome, catalogPath }

  ctx.effect(() => ctx.tools.register(defineDiagnoseTool(base)), 'dsh-sessions-diagnosis: session_diagnose')
  ctx.effect(() => ctx.tools.register(defineRepairTool(base)), 'dsh-sessions-diagnosis: session_repair')
  ctx.effect(() => ctx.tools.register(defineOverviewTool(base)), 'dsh-sessions-diagnosis: session_store_overview')

  // The dashboard API is optional: a headless profile has no web server, and the
  // tools above must still work there.
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => handleApi(req, res, base)
    }), 'dsh-sessions-diagnosis: dashboard api')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `session_diagnose` — explain why sessions will or will not open.
 * @param {any} base - resolved config.
 * @returns {any} the tool definition.
 */
function defineDiagnoseTool (base) {
  return {
    name: 'session_diagnose',
    description:
      'Diagnose why DSH sessions fail to open. Runs the harness\'s own released format-migration ' +
      'chain over the stored logs, so the reported reason is exactly what the harness hit. Each ' +
      'session is classified as ok, unmigrated (opens, migrated on open), repairable (a known rule ' +
      'fixes it), unrepairable, corrupt, too-new, or unknown — the last meaning this build of DSH ' +
      'ships no format codec, so nothing was verified and the verdict is not a failure. Call with no ' +
      'arguments to scan the whole store, or pass `id` (or a unique id fragment) to inspect one ' +
      'session in detail.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'Session id or unique fragment. Omit to scan the whole store.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum sessions to inspect in a store scan (default 200).'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          codecAvailable: { type: 'boolean' },
          summary: { type: 'object', additionalProperties: true },
          sessions: { type: 'array', items: SESSION_SUMMARY_SCHEMA },
          report: { type: 'string' }
        },
        required: ['codecAvailable', 'report']
      },
      render: (_args, value) => [{ type: 'text', text: value.report }]
    },
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      throwIfAborted(exec)
      const modules = await resolveDshFormatModules(base)
      if (args?.id !== undefined && typeof args.id === 'string' && args.id.length > 0) {
        return diagnoseOne(String(args.id), base, modules)
      }
      const report = await diagnoseStore({ ...base, limit: Number.isSafeInteger(args?.limit) ? args.limit : 200 })
      return compact({
        root: report.root,
        codecAvailable: report.codecAvailable,
        summary: report.summary,
        sessions: report.sessions.map(briefSession),
        report: renderStoreReport(report)
      })
    }
  }
}

/**
 * `session_repair` — make a session openable again.
 *
 * Defaults to a dry run: the tool reports exactly what it would change and
 * writes nothing until the caller passes `apply: true`.
 *
 * @param {any} base - resolved config.
 * @returns {any} the tool definition.
 */
function defineRepairTool (base) {
  return {
    name: 'session_repair',
    description:
      'Repair a DSH session that will not open because the released format migration refuses its ' +
      'stored log, or undo a repair this tool already made. By default a repair is a DRY RUN: it ' +
      'reports the exact edits it would make and writes nothing; pass `apply: true` to publish it. ' +
      'The default strategy publishes a verified current-format successor beside the original and ' +
      'never modifies the original file, so nothing is destroyed and the repair is reversible; ' +
      '"patch-source" instead rewrites the original after keeping a verified backup. Pass ' +
      '`action: "rollback"` to undo a repair, which moves the published successor aside and returns ' +
      'the session to its pre-repair state — it refuses if the session has been used since, because ' +
      'that would discard newer messages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'Session id or unique fragment.'
        },
        action: {
          type: 'string',
          enum: ['repair', 'rollback'],
          description: 'What to do. Defaults to "repair"; "rollback" undoes a previous repair.'
        },
        apply: {
          type: 'boolean',
          description: 'Actually write the repair. Omit or set false for a dry run.'
        },
        mode: {
          type: 'string',
          enum: [REPAIR_MODES.PUBLISH, REPAIR_MODES.PATCH_SOURCE],
          description: 'Repair strategy. Defaults to publishing a verified successor.'
        },
        rules: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Restrict the repair to these rule ids. By default every rule that matches is used, so a ' +
            'session the diagnosis called repairable can always be repaired; the result reports the ' +
            'risk tier of whatever ran. Narrow the set with this; there is no need to widen it. ' +
            `Known rules: ${REPAIR_RULES.map((rule) => `${rule.id} (${rule.risk} risk)`).join(', ')}.`
        }
      },
      required: ['id']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          dryRun: { type: 'boolean' },
          wrote: { type: 'string' },
          backupPath: { type: 'string' },
          manifestPath: { type: 'string' },
          rolledBack: { type: 'string' },
          restoredTo: { type: 'string' },
          edits: { type: 'integer' },
          findings: { type: 'array', items: FINDING_SCHEMA },
          preservation: { type: 'object', additionalProperties: true },
          verification: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
          report: { type: 'string' }
        },
        required: ['ok', 'report']
      },
      render: (_args, value) => [{ type: 'text', text: value.report }]
    },
    async execute (args, exec) {
      throwIfAborted(exec)
      const modules = await resolveDshFormatModules(base)
      const entry = await findEntry(String(args?.id ?? ''), base)

      if (args?.action === 'rollback') {
        const outcome = rollbackSession(entry)
        return compact({ ...outcome, report: renderRollbackReport(entry, outcome) })
      }

      const apply = args?.apply === true
      const mode = typeof args?.mode === 'string' ? args.mode : REPAIR_MODES.PUBLISH
      const rules = Array.isArray(args?.rules) && args.rules.length > 0 ? args.rules.map(String) : undefined

      const result = await repairSession(entry, { ...base, modules, mode, rules, dryRun: !apply })
      return compact({ ...result, report: renderRepairReport(entry, result, apply) })
    }
  }
}

/**
 * `session_store_overview` — a cheap census that reads only header frames.
 * @param {any} base - resolved config.
 * @returns {any} the tool definition.
 */
function defineOverviewTool (base) {
  return {
    name: 'session_store_overview',
    description:
      'Summarise the local DSH session store: where it lives, how many sessions exist, and which ' +
      'format generation each one is on. Reads only the header frame of each log, so it is fast even ' +
      'on a large store. Use this to find sessions that never gained a current-format generation.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          total: { type: 'integer' },
          sessions: { type: 'array', items: STORE_ROW_SCHEMA },
          report: { type: 'string' }
        },
        required: ['total', 'report']
      },
      render: (_args, value) => [{ type: 'text', text: value.report }]
    },
    isConcurrencySafe: () => true,
    execute (args, exec) {
      throwIfAborted(exec)
      const scan = listSessions(base)
      const sessions = scan.sessions.map((entry) => ({
        id: entry.id,
        project: entry.projectDir,
        highestVersion: entry.highestVersion,
        generations: entry.generations.map((g) => g.version),
        sizeBytes: entry.totalBytes,
        migrated: entry.highestVersion >= 3
      }))
      const stale = sessions.filter((s) => !s.migrated)
      const lines = [
        `Session store: ${scan.root ?? '<not found>'}`,
        `${sessions.length} session(s); ${sessions.length - stale.length} on the current format, ${stale.length} older.`,
        ''
      ]
      if (stale.length > 0) {
        lines.push('Sessions without a current-format generation (run session_diagnose to classify):')
        for (const s of stale) lines.push(`  ${s.id}  [${s.project}]  v${s.highestVersion}`)
      }
      return compact({ root: scan.root, total: sessions.length, sessions, report: lines.join('\n') })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// dashboard API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serve one dashboard API request.
 *
 * @param {any} req - the Node request.
 * @param {any} res - the Node response.
 * @param {any} base - resolved plugin config.
 */
async function handleApi (req, res, base) {
  if (!isTrustedRequest(req)) return send(res, 403, { error: 'cross-origin request refused' })
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const route = url.pathname.slice(API_PREFIX.length)

  try {
    if (req.method === 'GET' && (route === '/overview' || route === '/scan')) {
      const report = await diagnoseStore({ ...base, limit: 500 })
      return send(res, 200, report)
    }
    if (req.method === 'GET' && route === '/diagnose') {
      const id = url.searchParams.get('id') ?? ''
      const modules = await resolveDshFormatModules(base)
      return send(res, 200, await diagnoseOneRaw(id, base, modules))
    }
    if (req.method === 'POST' && route === '/repair') {
      const body = await readJsonBody(req)
      const entry = await findEntry(String(body?.id ?? ''), base)
      const modules = await resolveDshFormatModules(base)
      const result = await repairSession(entry, {
        ...base,
        modules,
        mode: typeof body?.mode === 'string' ? body.mode : REPAIR_MODES.PUBLISH,
        rules: Array.isArray(body?.rules) && body.rules.length > 0 ? body.rules.map(String) : undefined,
        dryRun: body?.apply !== true
      })
      return send(res, result.ok ? 200 : 422, compact(result))
    }
    if (req.method === 'POST' && route === '/rollback') {
      const body = await readJsonBody(req)
      const entry = await findEntry(String(body?.id ?? ''), base)
      const outcome = rollbackSession(entry)
      return send(res, outcome.ok ? 200 : 422, outcome)
    }
    if (req.method === 'GET' && route === '/rules') {
      return send(res, 200, { rules: REPAIR_RULES.map(({ id, title, risk, rationale }) => ({ id, title, risk, rationale })) })
    }
    return send(res, 404, { error: `unknown route ${route}` })
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Look up one session by exact id or unambiguous fragment. */
async function findEntry (needle, base) {
  if (needle.length === 0) throw new Error('a session id is required')
  const { sessions } = listSessions(base)
  const exact = sessions.find((entry) => entry.id === needle)
  if (exact !== undefined) return exact
  const matches = sessions.filter((entry) => entry.id.includes(needle))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error(`no session matches ${JSON.stringify(needle)}`)
  throw new Error(`${matches.length} sessions match ${JSON.stringify(needle)}: ${matches.map((m) => m.id).join(', ')}`)
}

/** Diagnose one session and render it as text. */
async function diagnoseOne (id, base, modules) {
  const entry = await findEntry(id, base)
  const diagnosis = diagnoseEntry(entry, { modules })
  return compact({
    codecAvailable: diagnosis.codecAvailable,
    summary: { total: 1, [diagnosis.status]: 1 },
    sessions: [briefSession(diagnosis)],
    report: renderDiagnosis(entry, diagnosis)
  })
}

/** Diagnose one session, returning the full structured record (dashboard use). */
async function diagnoseOneRaw (id, base, modules) {
  const entry = await findEntry(id, base)
  // The dashboard needs to know whether this tool repaired the session, so it
  // can offer an undo that is guaranteed to be safe.
  const manifest = readRepairManifest(entry)
  return compact({ ...diagnoseEntry(entry, { modules }), manifest })
}

/** Trim a diagnosis down to what a tool result needs. */
function briefSession (diagnosis) {
  return {
    id: diagnosis.id,
    project: diagnosis.projectDir,
    status: diagnosis.status,
    headline: diagnosis.headline,
    openable: diagnosis.openable,
    repairable: diagnosis.repairable,
    reasons: diagnosis.reasons.map((reason) => `${reason.code}: ${reason.summary}`),
    findings: diagnosis.findings.length
  }
}

/** Render a rollback outcome as readable text. */
function renderRollbackReport (entry, outcome) {
  const lines = [`Session ${entry.id}`, '']
  lines.push(outcome.summary)
  if (outcome.restoredTo !== undefined) lines.push(`DSH will select: ${outcome.restoredTo}`)
  if (outcome.rolledBack !== undefined) lines.push(`Preserved at:    ${outcome.rolledBack}`)
  if (!outcome.ok) {
    lines.push('', 'Nothing was changed.')
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Render a store-wide diagnosis as readable text. */
function renderStoreReport (report) {
  const lines = [
    `DSH session store: ${report.root ?? '<not found>'}`,
    `Released format codec: ${report.codecAvailable ? `available (${report.codecSource})` : 'NOT FOUND — older logs cannot be checked'}`,
    ''
  ]
  const s = report.summary
  lines.push(`${s.total} session(s): ${s.ok} ok, ${s.unmigrated} unmigrated, ${s.repairable} repairable, ` +
    `${s.unrepairable} unrepairable, ${s.corrupt} corrupt, ${s.tooNew} too-new, ${s.empty} empty, ` +
    `${s.unknown ?? 0} unknown`)
  lines.push('')

  // `unknown` means nothing was checked, which is not the same as a failure:
  // listing those sessions as "will not open" is exactly the false accusation
  // that a codec-less environment used to produce for a whole store.
  const broken = report.sessions.filter((session) => session.status !== 'unknown' && !session.openable)
  const unchecked = report.sessions.filter((session) => session.status === 'unknown')
  if (unchecked.length > 0) {
    lines.push(`${unchecked.length} session(s) could not be checked: this build of DSH ships no format ` +
      'codec, so their verdict is unknown rather than a failure.')
    lines.push('')
  }
  if (broken.length === 0) {
    lines.push('Every session that could be checked opens.')
  } else {
    lines.push(`${broken.length} session(s) will not open:`)
    for (const session of broken) {
      lines.push('')
      lines.push(`  ${session.id}  [${session.projectDir}]`)
      lines.push(`    ${session.headline}`)
      for (const reason of session.reasons) {
        lines.push(`    - ${reason.code}: ${reason.summary}`)
        if (reason.detail !== undefined) lines.push(`      ${firstLine(reason.detail)}`)
      }
      for (const finding of session.findings.slice(0, 3)) {
        lines.push(`    fix: ${finding.type} seq ${finding.seq} ${finding.path} ` +
          `${JSON.stringify(finding.before)} -> ${JSON.stringify(finding.after)}`)
      }
      if (session.findings.length > 3) lines.push(`    ... and ${session.findings.length - 3} more edit(s)`)
      if (session.repairable) lines.push(`    -> repairable: call session_repair with id "${session.id}"`)
    }
  }
  if (report.errors.length > 0) {
    lines.push('', `${report.errors.length} directory error(s); first: ${report.errors[0].message}`)
  }
  return lines.join('\n')
}

/** Render one session's diagnosis as readable text. */
function renderDiagnosis (entry, diagnosis) {
  const lines = [
    `Session ${diagnosis.id}  [${diagnosis.projectDir}]`,
    `Verdict: ${diagnosis.headline}`,
    `Artifact DSH would open: ${entry.selectedPath ?? '<none>'}`
  ]
  if (diagnosis.selected !== undefined) {
    lines.push(`  format v${diagnosis.selected.version}, ${diagnosis.selected.compression}, ` +
      `${diagnosis.selected.sizeBytes} bytes`)
  }
  if (diagnosis.generations.length > 1) {
    lines.push(`  also present: ${diagnosis.generations.map((g) => `v${g.version}`).join(', ')}`)
  }
  if (diagnosis.foreign.length > 0) {
    lines.push(`  ignored by DSH: ${diagnosis.foreign.map((g) => g.name).join(', ')}`)
  }
  if (diagnosis.physical !== undefined) {
    const p = diagnosis.physical
    lines.push(`  frames: ${p.frames}${p.badFrames > 0 ? ` (${p.badFrames} bad)` : ''}, rows: ${p.rows}` +
      `${p.tornStart !== undefined ? ', torn tail present' : ''}`)
  }
  lines.push('', 'Findings:')
  for (const reason of diagnosis.reasons) {
    lines.push(`  [${reason.severity}] ${reason.code}: ${reason.summary}`)
    if (reason.detail !== undefined) lines.push(`      ${firstLine(reason.detail)}`)
  }
  if (diagnosis.findings.length > 0) {
    lines.push('', `Repair edits (${diagnosis.findings.length}):`)
    for (const finding of diagnosis.findings.slice(0, 10)) {
      lines.push(`  ${finding.ruleId}: ${finding.type} seq ${finding.seq} ${finding.path}`)
      lines.push(`      ${JSON.stringify(finding.before)}  ->  ${JSON.stringify(finding.after)}`)
    }
    if (diagnosis.findings.length > 10) lines.push(`  ... and ${diagnosis.findings.length - 10} more`)
  }
  return lines.join('\n')
}

/** Render a repair outcome as readable text. */
function renderRepairReport (entry, result, apply) {
  const lines = [`Session ${entry.id}`, `Strategy: ${result.mode}${apply ? '' : ' (dry run)'}`, '']
  if (result.findings.length > 0) {
    lines.push(`Edits (${result.findings.length}):`)
    for (const finding of result.findings.slice(0, 10)) {
      lines.push(`  ${finding.ruleId}: ${finding.type} seq ${finding.seq} ${finding.path}`)
      lines.push(`      ${JSON.stringify(finding.before)}  ->  ${JSON.stringify(finding.after)}`)
      if (finding.detail !== undefined) lines.push(`      ${firstLine(finding.detail)}`)
    }
    if (result.findings.length > 10) lines.push(`  ... and ${result.findings.length - 10} more`)
    lines.push('')
  }
  lines.push(result.summary)
  if (result.verification?.ok === true) {
    lines.push(`Verified: ${result.verification.rows} rows / ${result.verification.events} events, ` +
      `${result.verification.frames} frame(s), storage admission ${result.verification.admission}.`)
  }
  // The safety evidence, stated explicitly rather than implied.
  if (result.preservation?.ok === true) {
    lines.push(`Content preserved: ${result.preservation.sourceCount} source message payload(s) all present ` +
      `in the repaired log (${result.preservation.addedCount} added by the migration itself).`)
  }
  if (result.backupPath !== undefined) lines.push(`Verified backup: ${result.backupPath}`)
  for (const warning of result.warnings ?? []) lines.push(`Warning: ${warning}`)
  if (!apply && result.ok) {
    lines.push('', 'Nothing was written. Re-run with apply: true to perform the repair.')
  }
  if (apply && result.ok) {
    if (result.manifestPath !== undefined) {
      lines.push('', `The original file was not modified. To undo this repair, call this tool again with ` +
        `action: "rollback" (or run: dsh-session-doctor rollback ${entry.id}).`)
    }
    lines.push('Reopen the session (or refresh the browser) for DSH to pick it up.')
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// http helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse cross-origin requests.
 *
 * The DSH web server has no authentication of its own, so the dashboard API
 * applies a same-origin fence: a request carrying a mismatched `Origin`, or one
 * a browser marks as cross-site, is rejected. This is what stops another page in
 * the user's browser from driving a repair.
 *
 * @param {any} req - the Node request.
 * @returns {boolean} whether the request may proceed.
 */
function isTrustedRequest (req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a size-capped JSON request body. */
function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
  })
}

/** Send a JSON response. */
function send (res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** Coarse cancellation check before doing expensive work. */
function throwIfAborted (exec) {
  if (exec?.signal?.aborted === true) throw new Error('session diagnosis cancelled')
}

/**
 * Drop `undefined` members from a tool's canonical value.
 *
 * A tool's result must be a lossless JSON value, and `undefined` is not JSON —
 * an optional field that was not populated has to be absent rather than present
 * and undefined, or the registry rejects the value after the body has already
 * done its work. Stripping happens at every depth, because the same rule applies
 * to nested findings and verification records.
 *
 * @param {any} value - the value to compact.
 * @returns {any} the value with `undefined` members removed.
 */
function compact (value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : compact(item)))
  }
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = compact(item)
  }
  return out
}

/** @param {string} value @returns {string} */
function firstLine (value) {
  return String(value).split('\n', 1)[0].slice(0, 300)
}
