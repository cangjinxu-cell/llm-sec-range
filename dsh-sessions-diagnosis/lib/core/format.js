/**
 * Reaching DSH's own released Session-format codec at runtime.
 *
 * The authoritative answer to "can this build open that session?" comes from
 * running DSH's real migration chain (v0 -> v1 -> v2 -> v3) over the log. That
 * chain lives in `@deepseek-ai/dsh-session-format-catalog`, which ships inside
 * the DSH installation.
 *
 * A plugin installed with `dsh plugin --profile web add link:<path>` resolves
 * from its **real** directory, not from the profile's `node_modules`, so a bare
 * `import '@deepseek-ai/dsh-session-format-catalog'` fails with
 * `ERR_MODULE_NOT_FOUND`. This module therefore locates the package by probing
 * the well-known locations a DSH install creates, and imports it by absolute
 * file URL. That keeps the plugin free of runtime dependencies and independent
 * of the DSH version installed.
 *
 * @module dsh-sessions-diagnosis/core/format
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshHome } from './store.js'

/** Packages we want from the DSH installation, in load order. */
const WANTED = Object.freeze({
  catalog: '@deepseek-ai/dsh-session-format-catalog',
  format: '@deepseek-ai/dsh-session-format',
  v2to3: '@deepseek-ai/dsh-session-format-v2-to-v3'
})

/**
 * The resolved DSH format modules.
 * @typedef {object} DshFormatModules
 * @property {any} catalog - `sessionFormatCatalog` from the format catalog.
 * @property {any|undefined} format - the pure format helpers, when resolvable.
 * @property {any|undefined} v2to3 - the V2-to-V3 edge (used for row admission checks).
 * @property {number} currentVersion - the catalog's current format version.
 * @property {string} source - the `node_modules` root the packages came from.
 */

/** Cached resolution, so a store scan resolves the installation once. */
let cached

/** Absolute path of the entry file of one package under a `node_modules` root. */
function packageEntry (nodeModulesRoot, packageName) {
  return join(nodeModulesRoot, ...packageName.split('/'), 'lib', 'index.js')
}

/**
 * Candidate `node_modules` roots that may hold the DSH packages, best first.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - explicit DSH home.
 * @param {string} [options.catalogPath] - explicit path to the catalog package directory.
 * @returns {string[]} candidate roots.
 */
function candidateRoots (options = {}) {
  const roots = []

  if (typeof options.catalogPath === 'string' && options.catalogPath.length > 0) {
    const dir = options.catalogPath
    roots.push(dir.endsWith('dsh-session-format-catalog') ? join(dir, '..') : dir)
  }

  const home = resolveDshHome(options.dshHome)
  if (home !== undefined) {
    // The profile root mirrors the whole install through junctions.
    roots.push(join(home, 'profiles', 'node_modules'))
    const profilesDir = join(home, 'profiles')
    if (existsSync(profilesDir)) {
      try {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            roots.push(join(profilesDir, entry.name, 'node_modules'))
          }
        }
      } catch {
        // An unreadable profiles directory is not fatal: other roots may still hit.
      }
    }
  }

  // The DSH CLI install itself, reached from the running entry point when the
  // plugin is loaded by DSH (`.../@deepseek-ai/dsh/lib/bin.js`).
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    const normalized = entry.replace(/\\/g, '/')
    const marker = '/@deepseek-ai/dsh/'
    const at = normalized.lastIndexOf(marker)
    if (at !== -1) {
      const dshDir = normalized.slice(0, at + '/@deepseek-ai/dsh'.length)
      roots.push(join(dshDir, 'node_modules'))
      roots.push(join(dshDir, '..'))
    }
  }

  // Walk up from this module looking for a co-located install (dev checkouts).
  let dir = import.meta.dirname ?? ''
  for (let depth = 0; depth < 6 && dir.length > 3; depth++) {
    roots.push(join(dir, 'node_modules'))
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }

  return [...new Set(roots)]
}

/**
 * Locate and import the DSH session-format packages.
 *
 * Resolution is cached; pass `{ refresh: true }` to re-probe after an upgrade.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - explicit DSH home.
 * @param {string} [options.catalogPath] - explicit catalog package directory.
 * @param {boolean} [options.refresh] - ignore the cache.
 * @returns {Promise<DshFormatModules|undefined>} the modules, or undefined when DSH's
 *   codec cannot be reached (the static audit still works without it).
 */
export async function resolveDshFormatModules (options = {}) {
  if (cached !== undefined && options.refresh !== true && options.catalogPath === undefined) return cached

  for (const root of candidateRoots(options)) {
    const catalogEntry = packageEntry(root, WANTED.catalog)
    if (!existsSync(catalogEntry)) continue
    try {
      const catalogMod = await import(pathToFileURL(catalogEntry).href)
      const catalog = catalogMod.sessionFormatCatalog
      if (catalog === undefined || typeof catalog.createRestore !== 'function') continue

      const formatMod = await tryImport(packageEntry(root, WANTED.format))
      const v2to3Mod = await tryImport(packageEntry(root, WANTED.v2to3))

      const resolved = {
        catalog,
        format: formatMod,
        v2to3: v2to3Mod,
        currentVersion: catalog.currentVersion,
        source: root
      }
      if (options.catalogPath === undefined) cached = resolved
      return resolved
    } catch {
      // Try the next root: a half-materialized install must not be fatal.
    }
  }

  if (options.catalogPath === undefined) cached = undefined
  return undefined
}

/** Import an absolute file URL, returning undefined instead of throwing. */
async function tryImport (path) {
  if (!existsSync(path)) return undefined
  try {
    return await import(pathToFileURL(path).href)
  } catch {
    return undefined
  }
}

/**
 * A migration probe outcome.
 * @typedef {object} MigrationProbe
 * @property {boolean} ok - whether the migration completed.
 * @property {number} [events] - current-format event count, when ok.
 * @property {number} [inheritedEventCount] - the inherited cut, when ok.
 * @property {any} [artifact] - the migrated artifact, when ok.
 * @property {string} [errorName] - the thrown error's class name.
 * @property {string} [errorMessage] - the thrown error's message.
 * @property {number} [failedAtRow] - index into `rows` of the row being decoded when it threw.
 * @property {string} [failedAtType] - that row's `type`.
 * @property {number} [failedAtSeq] - that row's `seq`.
 * @property {number} [reportedSeq] - a `seq N` mentioned by the error message, when present.
 */

/**
 * Run DSH's real migration over decoded rows and report the exact outcome.
 *
 * ## Ground truth, and one sharp edge
 *
 * This is the ground-truth diagnosis: it is the same code path DSH's
 * persistence layer uses when it opens a historical session, so a failure here
 * is precisely the failure the user sees.
 *
 * **The sharp edge:** DSH's restore *transfers caller-owned parsed values
 * through its stages without copying or freezing them*, so it mutates the row
 * objects it is given — including when it fails part-way. Feeding the same
 * array to a second restore therefore produces a **bogus** result (typically a
 * phantom "seq gap"), because the stages are now looking at half-transformed
 * events. {@link probeMigration} defends against this by working on its own
 * copy, so a probe never mutates the caller's rows and can be run repeatedly on
 * the same array. That defence is why the tool's verdicts are trustworthy; do
 * not "optimise" it away.
 *
 * @param {DshFormatModules} modules - resolved DSH modules.
 * @param {unknown[]} rows - decoded rows, header first. Never modified.
 * @param {object} [options]
 * @param {'strict'|'recoverable'} [options.recovery] - physical-row failure policy
 *   (DSH's migration path uses `strict`).
 * @param {'transformed'|'current'} [options.validation] - validation policy (DSH's
 *   migration path uses `transformed`).
 * @param {boolean} [options.consume] - pass `true` only when the caller is
 *   finished with `rows` and wants to skip the defensive copy.
 * @returns {MigrationProbe} the outcome; never throws for a format refusal.
 */
export function probeMigration (modules, rows, options = {}) {
  const recovery = options.recovery ?? 'strict'
  const validation = options.validation ?? 'transformed'
  // DSH's restore takes ownership of the values it is handed. Probe a copy so a
  // failed attempt cannot poison every later attempt (see the note above).
  const input = options.consume === true ? rows : rows.map((row) => (row === null || typeof row !== 'object' ? row : structuredClone(row)))

  let restore
  try {
    restore = modules.catalog.createRestore(input[0], { recovery, validation })
  } catch (error) {
    return { ok: false, errorName: name(error), errorMessage: message(error) }
  }

  for (let i = 1; i < input.length; i++) {
    try {
      restore.decodeRow(input[i])
    } catch (error) {
      const text = message(error)
      const reported = /\bseq (\d+)\b/.exec(text)
      return {
        ok: false,
        errorName: name(error),
        errorMessage: text,
        failedAtRow: i,
        failedAtType: typeof input[i]?.type === 'string' ? input[i].type : undefined,
        failedAtSeq: typeof input[i]?.seq === 'number' ? input[i].seq : undefined,
        reportedSeq: reported === null ? undefined : Number(reported[1])
      }
    }
  }

  try {
    const artifact = restore.finish()
    return {
      ok: true,
      events: artifact.events.length,
      inheritedEventCount: artifact.inheritedEventCount,
      artifact
    }
  } catch (error) {
    const text = message(error)
    const reported = /\bseq (\d+)\b/.exec(text)
    return {
      ok: false,
      errorName: name(error),
      errorMessage: text,
      reportedSeq: reported === null ? undefined : Number(reported[1])
    }
  }
}

/**
 * Classify a DSH migration refusal into a stable machine-readable code.
 *
 * @param {MigrationProbe} probe - a failed probe.
 * @returns {{ code: string, summary: string }} the classification.
 */
export function classifyMigrationFailure (probe) {
  const text = `${probe.errorName ?? ''}: ${probe.errorMessage ?? ''}`
  if (/unclassified message source/.test(text)) {
    return {
      code: 'UNCLASSIFIED_MESSAGE_SOURCE',
      summary: 'a message carries a source.kind the released migration does not admit'
    }
  }
  if (/unsupported descriptor version/.test(text)) {
    return {
      code: 'UNSUPPORTED_DESCRIPTOR_VERSION',
      summary: 'a subagent/descriptor row carries a version this build cannot read'
    }
  }
  if (/unknown historical event type/.test(text)) {
    return {
      code: 'UNKNOWN_EVENT_TYPE',
      summary: 'the log contains an event type absent from the frozen released inventory'
    }
  }
  if (/seq gap/.test(text)) {
    return { code: 'SEQUENCE_GAP', summary: 'the log is missing rows: sequence numbers are not dense' }
  }
  if (/retired header\.system|rejects retired/.test(text)) {
    return { code: 'RETIRED_FIELD', summary: 'the log uses a field a later format generation retired' }
  }
  if (/SessionFormatUnsupported/.test(text)) {
    return { code: 'UNSUPPORTED_MIGRATION', summary: 'the released migration declined this log' }
  }
  if (/corrupt|checksum|magic/.test(text)) {
    return { code: 'CORRUPTION', summary: 'the physical log is damaged' }
  }
  return { code: 'UNKNOWN', summary: 'the migration failed for an unclassified reason' }
}

/** @param {unknown} error @returns {string} */
function name (error) {
  return error instanceof Error ? error.name : 'Error'
}

/** @param {unknown} error @returns {string} */
function message (error) {
  return error instanceof Error ? error.message : String(error)
}
