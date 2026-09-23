/**
 * The repair-rule catalogue.
 *
 * Each rule describes one *known, reproducible* reason why DSH 0.1.5 refuses to
 * open a session that an older build wrote, plus the minimal edit that makes the
 * released migration accept it. Rules are data, not policy: they detect and
 * apply, and the caller decides which ones to run and whether to publish.
 *
 * Two invariants hold for every rule here:
 *
 * 1. **Minimal** — only the offending field is rewritten. No event is added,
 *    removed, or reordered, so sequence coordinates, timestamps, and references
 *    are untouched.
 * 2. **Verified elsewhere** — applying a rule never publishes anything by
 *    itself. {@link module:dsh-sessions-diagnosis/core/repair} re-runs DSH's real
 *    migration over the patched rows and only publishes if it succeeds.
 *
 * @module dsh-sessions-diagnosis/core/rules
 */

import { ADMITTED_MESSAGE_SOURCE_KINDS, visitMessageSources } from './store.js'

/** The descriptor version the frozen v0 codec requires. */
const REQUIRED_DESCRIPTOR_VERSION = 3

/**
 * One detected instance of a rule's problem.
 * @typedef {object} Finding
 * @property {string} ruleId - the rule that produced it.
 * @property {number|undefined} seq - the event's sequence number, when it has one.
 * @property {string} type - the event type.
 * @property {string} path - JSON path of the offending value within the row.
 * @property {any} before - the offending value.
 * @property {any} after - the value the rule would write.
 * @property {string} [detail] - human-readable context.
 */

/**
 * A repair rule.
 * @typedef {object} RepairRule
 * @property {string} id - stable identifier used by callers and config.
 * @property {string} title - one-line summary.
 * @property {string} risk - `low` when the edit is provably semantics-preserving,
 *   `medium` when it rewrites recorded metadata.
 * @property {string} rationale - why the edit is correct.
 * @property {(rows: unknown[]) => Finding[]} detect - find instances in decoded rows.
 * @property {(rows: unknown[], findings: Finding[]) => number} apply - rewrite rows in place; returns edits made.
 */

/**
 * Rule 1 — a message carries a `source.kind` the released migration does not admit.
 *
 * Older DSH builds tagged the synthetic user message produced by an `@path`
 * mention with `{"kind":"at-file-mention","relative":"<path>"}`. That kind was
 * retired: it appears nowhere in DSH 0.1.5, and the V2-to-V3 source audit
 * refuses any kind outside its closed 15-entry vocabulary, aborting the whole
 * migration. The session then lists in the sidebar but cannot be opened.
 *
 * Rewriting the source to the generic `{"kind":"user"}` is the minimal accepted
 * form, and it is lossless in practice: the mention's path is already recorded
 * verbatim in the message's own content as `<workspace-reference path="..." />`,
 * so only the redundant provenance tag is dropped.
 *
 * @type {RepairRule}
 */
const unclassifiedMessageSource = {
  id: 'unclassified-message-source',
  title: 'Rewrite a message source.kind the migration refuses',
  risk: 'low',
  rationale:
    'The V2-to-V3 audit admits a closed set of source kinds. A retired kind such as ' +
    '`at-file-mention` aborts the entire migration, so the session cannot be opened. ' +
    'The reference path survives in the message content, so mapping the source to `user` ' +
    'loses no information the model or the UI reads.',
  detect (rows) {
    /** @type {Finding[]} */
    const findings = []
    for (const row of rows) {
      visitMessageSources(row, (message, where) => {
        const source = message?.source
        if (source === null || typeof source !== 'object' || Array.isArray(source)) return
        const kind = source.kind
        if (typeof kind === 'string' && ADMITTED_MESSAGE_SOURCE_KINDS.has(kind)) return
        findings.push({
          ruleId: unclassifiedMessageSource.id,
          seq: where.seq,
          type: where.type,
          path: `${where.path}.source`,
          before: clone(source),
          after: { kind: 'user' },
          detail: typeof kind === 'string'
            ? `source.kind ${JSON.stringify(kind)} is not in the released migration vocabulary`
            : `source.kind is ${kind === undefined ? 'absent' : typeof kind}, not a string`
        })
      })
    }
    return findings
  },
  apply (rows, findings) {
    return rewriteMessageSources(rows, findings, () => ({ kind: 'user' }))
  }
}

/**
 * Rule 2 — a `subagent/descriptor` row records a descriptor version this build cannot read.
 *
 * The frozen v0 codec requires `data.version === 3` on `subagent/descriptor`
 * and refuses the whole payload when it is anything else. Some logs written by
 * older builds carry `2`. The descriptor's shape is keyed by `mode`, not by
 * `version`, and every other member is validated independently, so correcting the
 * stale version number does not change how any other field is interpreted.
 *
 * This is a `medium`-risk rule: it edits recorded metadata rather than a
 * provenance tag, so it is opt-in where rule 1 is on by default.
 *
 * @type {RepairRule}
 */
const subagentDescriptorVersion = {
  id: 'subagent-descriptor-version',
  title: 'Correct a stale subagent/descriptor version',
  risk: 'medium',
  rationale:
    'The released v0 payload codec requires subagent/descriptor.data.version to be exactly 3 ' +
    'and rejects the log otherwise. The member is a schema revision number, not a coordinate: ' +
    'the descriptor payload is keyed by `mode`, so no other field is re-interpreted.',
  detect (rows) {
    /** @type {Finding[]} */
    const findings = []
    for (const row of rows) {
      if (row?.type !== 'subagent/descriptor') continue
      const version = row?.data?.version
      if (version === REQUIRED_DESCRIPTOR_VERSION) continue
      findings.push({
        ruleId: subagentDescriptorVersion.id,
        seq: typeof row.seq === 'number' ? row.seq : undefined,
        type: row.type,
        path: 'data.version',
        before: version,
        after: REQUIRED_DESCRIPTOR_VERSION,
        detail: `subagent/descriptor records version ${JSON.stringify(version)}; this build reads only ${REQUIRED_DESCRIPTOR_VERSION}`
      })
    }
    return findings
  },
  apply (rows, findings) {
    const targets = new Set(findings.map((finding) => seqKey(finding.seq)))
    let edits = 0
    for (const row of rows) {
      if (row?.type !== 'subagent/descriptor') continue
      if (!targets.has(seqKey(row.seq))) continue
      if (row.data?.version === REQUIRED_DESCRIPTOR_VERSION) continue
      row.data.version = REQUIRED_DESCRIPTOR_VERSION
      edits++
    }
    return edits
  }
}

/**
 * Every rule this build knows, in the order a report should present them.
 * @type {ReadonlyArray<RepairRule>}
 */
export const REPAIR_RULES = Object.freeze([unclassifiedMessageSource, subagentDescriptorVersion])

/**
 * Rule ids whose edits only rewrite a provenance tag, never recorded metadata.
 *
 * A repair runs **every** matching rule by default — a diagnosis that reports
 * "repairable" has to be actionable, or the two disagree. This list exists for
 * callers that want the conservative subset, such as a bulk sweep across a whole
 * store, where the per-session dry run that normally supplies consent has not
 * happened.
 *
 * @type {ReadonlyArray<string>}
 */
export const LOW_RISK_RULE_IDS = Object.freeze(
  REPAIR_RULES.filter((rule) => rule.risk === 'low').map((rule) => rule.id)
)

/**
 * Look up a rule by id.
 * @param {string} id - the rule id.
 * @returns {RepairRule|undefined} the rule, when known.
 */
export function getRule (id) {
  return REPAIR_RULES.find((rule) => rule.id === id)
}

/**
 * Detect every problem the known rules can see.
 *
 * @param {unknown[]} rows - decoded session rows, header first.
 * @param {object} [options]
 * @param {ReadonlyArray<string>} [options.rules] - rule ids to run (default: all).
 * @returns {Finding[]} findings, grouped by rule in catalogue order.
 */
export function detectIssues (rows, options = {}) {
  const wanted = new Set(options.rules ?? REPAIR_RULES.map((rule) => rule.id))
  /** @type {Finding[]} */
  const findings = []
  for (const rule of REPAIR_RULES) {
    if (!wanted.has(rule.id)) continue
    findings.push(...rule.detect(rows))
  }
  return findings
}

/**
 * Apply the given findings to a row array, in place.
 *
 * @param {unknown[]} rows - decoded session rows to mutate.
 * @param {Finding[]} findings - findings to apply.
 * @returns {{ edits: number, byRule: Record<string, number> }} what was changed.
 */
export function applyIssues (rows, findings) {
  /** @type {Record<string, number>} */
  const byRule = {}
  let edits = 0
  for (const rule of REPAIR_RULES) {
    const mine = findings.filter((finding) => finding.ruleId === rule.id)
    if (mine.length === 0) continue
    const changed = rule.apply(rows, mine)
    byRule[rule.id] = changed
    edits += changed
  }
  return { edits, byRule }
}

/**
 * Rewrite the `source` of each targeted message slot.
 *
 * Targets are addressed by event type + sequence + JSON path, so a finding that
 * no longer matches (because the log changed underneath us) is skipped rather
 * than applied to the wrong row.
 *
 * @param {unknown[]} rows - rows to mutate.
 * @param {Finding[]} findings - findings produced by the same rule.
 * @param {(before: any) => any} replacement - computes the new source value.
 * @returns {number} the number of sources rewritten.
 */
function rewriteMessageSources (rows, findings, replacement) {
  const targets = indexFindings(findings, findings[0]?.ruleId)
  let edits = 0
  for (const row of rows) {
    visitMessageSources(row, (message, where) => {
      const key = `${seqKey(where.seq)}|${where.type}|${where.path}`
      if (!targets.has(key)) return
      if (message === null || typeof message !== 'object') return
      message.source = replacement(message.source)
      edits++
    })
  }
  return edits
}

/**
 * Index findings by `seq|type|path` so `apply` can address exact positions.
 * @param {Finding[]} findings - findings for one rule.
 * @param {string|undefined} ruleId - the rule id to keep.
 * @returns {Set<string>} addressable keys.
 */
function indexFindings (findings, ruleId) {
  const keys = new Set()
  for (const finding of findings) {
    if (ruleId !== undefined && finding.ruleId !== ruleId) continue
    keys.add(`${seqKey(finding.seq)}|${finding.type}|${finding.path.replace(/\.source$/, '')}`)
  }
  return keys
}

/** @param {unknown} seq @returns {string} */
function seqKey (seq) {
  return typeof seq === 'number' ? String(seq) : '<none>'
}

/** @param {any} value @returns {any} */
function clone (value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}
