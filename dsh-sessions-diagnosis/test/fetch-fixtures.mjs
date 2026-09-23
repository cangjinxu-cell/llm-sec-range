#!/usr/bin/env node
/**
 * Populate the local test fixture from your own session store.
 *
 * The most convincing test data for a repair tool is a real session log that a
 * real DSH upgrade actually broke — and that is also data you must never
 * publish. So the suite does not ship a fixture: it reads one out of your store
 * at test time and writes it to `.scratch/`, which `.gitignore` excludes.
 *
 * The script looks for a **generation** that DSH's migration refuses, not for a
 * broken *session*. That distinction matters after you have run a repair: repair
 * is additive, so a session reads fine while its older source generation still
 * refuses. Those retained sources are exactly the input the suite needs.
 *
 *   node test/fetch-fixtures.mjs                 # pick any refusing generation
 *   node test/fetch-fixtures.mjs <session-id>    # or name a session
 *   node test/fetch-fixtures.mjs --dsh-home <p>  # non-default DSH home
 *
 * Nothing under DSH_HOME is modified: the selected generation is only read.
 * Without a fixture the suite still runs and skips the real-session tests.
 */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { applyIssues, detectIssues, listSessions, probeMigration, readSessionLog, resolveDshFormatModules } from '../lib/core/index.js'

const FIXTURE_DIR = join(import.meta.dirname, '..', '.scratch', 'fixtures', 'broken')
const FIXTURE = join(FIXTURE_DIR, 'session.jsonl.zstd')

const argv = process.argv.slice(2)
let dshHome
let wanted
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dsh-home') dshHome = argv[++i]
  else if (!argv[i].startsWith('-')) wanted = argv[i]
}

const modules = await resolveDshFormatModules({ dshHome })
if (modules === undefined) {
  console.error('DSH\'s session-format catalog could not be located, so candidates cannot be tested.')
  console.error('Install DSH, or pass --dsh-home pointing at one.')
  process.exit(1)
}

const { root, sessions } = listSessions({ dshHome })
if (root === undefined) {
  console.error('No DSH session store found. Set DSH_HOME or pass --dsh-home.')
  process.exit(1)
}

console.log(`Scanning ${root} for an older generation that DSH refuses...\n`)

/** Candidates: an older generation whose migration refuses but a rule can fix. */
const candidates = []
for (const entry of sessions) {
  if (wanted !== undefined && !entry.id.includes(wanted)) continue
  for (const generation of entry.generations) {
    if (generation.version >= modules.currentVersion) continue
    let rows
    try {
      rows = readSessionLog(generation.path).rows
    } catch {
      continue
    }
    const probe = probeMigration(modules, rows)
    if (probe.ok) continue
    const findings = detectIssues(rows)
    if (findings.length === 0) continue
    const patched = JSON.parse(JSON.stringify(rows))
    applyIssues(patched, JSON.parse(JSON.stringify(findings)))
    const after = probeMigration(modules, patched)
    if (!after.ok) continue
    candidates.push({ entry, generation, findings, events: after.events, reason: probe.errorMessage })
  }
}

if (candidates.length === 0) {
  console.error('No refusing-but-repairable generation was found in this store.')
  console.error(`Store: ${root} (${sessions.length} session(s))`)
  console.error('This is expected once every session has been repaired and its old sources removed.')
  process.exit(1)
}

const chosen = candidates[0]
rmSync(FIXTURE_DIR, { recursive: true, force: true })
mkdirSync(FIXTURE_DIR, { recursive: true })
copyFileSync(chosen.generation.path, FIXTURE)

console.log(`Fixture written: ${FIXTURE}`)
console.log(`  session     : ${chosen.entry.id}  [${chosen.entry.projectDir}]`)
console.log(`  generation  : v${chosen.generation.version}  (${chosen.generation.sizeBytes} bytes)`)
console.log(`  DSH refuses : ${chosen.reason}`)
console.log(`  repair      : ${chosen.findings.length} edit(s) -> ${chosen.events} events`)
console.log(`  other candidates: ${candidates.length - 1}`)
console.log('')
console.log('PRIVACY: this file is a verbatim copy of one of your conversations.')
console.log('It lives under .scratch/ (git-ignored). Do not commit it or attach it to an issue.')
console.log('\nRun the suite with: node test/run.mjs')
