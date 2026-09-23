# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

`dsh-sessions-diagnosis` finds and repairs **DSH (DeepSeek Harness) session logs
that stopped opening after a harness upgrade**. It ships as three front ends over
one plain-Node.js core: a DSH plugin (agent tools + web dashboard), a standalone
CLI, and a test suite.

Read `README.md` for the user-facing story and `docs/ROOT-CAUSE.md` for why the
breakage exists. This file is about **working on the code**.

---

## 1. Ground rules

These are the rules that, if broken, produce silent damage or a broken checkout.
Everything else in this file is detail.

1. **Never write to a user's session store during development or testing.** No
   test may point at a real `DSH_HOME`. Every test builds its own store under
   `mkdtempSync(join(tmpdir(), …))` and removes it in a `finally`.
2. **A repair never modifies the original file.** The default `publish-successor`
   strategy writes a *new generation beside* the original. `patch-source` is the
   guarded fallback and keeps a verified backup. Do not add a code path that
   truncates or overwrites a session log in place.
3. **Nothing is written until it has been proven.** Any new write path must
   verify (migrate with DSH's real chain → encode with DSH's real encoder →
   re-read and restore under both validation policies → confirm every source
   message payload survived) *before* publishing. On failure, **no file appears**.
4. **`lib/core/` must not import DSH packages statically.** DSH's format codec is
   located and imported at runtime (`lib/core/format.js`) and may be absent —
   the static audit must still work when it is. `lib/core/index.js` is a pure
   re-export barrel.
5. **Tool output schemas must stay inside DSH's JSON Schema subset.** See §5.1.
   Getting this wrong takes the whole profile down at boot.
6. **Every safety guarantee must be asserted by a test**, not merely intended.
   If you add a guarantee to the README, add the test that pins it.
7. **Never commit `.scratch/`, `notes/`, or `profile-backup/`.** See §8.

---

## 2. Layout

```
bin/dsh-session-doctor.mjs   standalone CLI (no install step needed)
lib/index.js                 host half: agent tools + dashboard JSON API
lib/client.js                browser half: the dashboard panel (classic script)
lib/core/                    the shared engine — plain Node.js, no DSH imports
  frames.js                  concatenated-Zstandard-frame container (scan/decode/encode)
  store.js                   locate DSH_HOME, enumerate generations, source-kind vocabulary
  format.js                  find DSH's format catalog at runtime; run its real migration
  rules.js                   the repair-rule catalogue (data, not code paths)
  diagnose.js                static audit + live migration probe + repair simulation
  repair.js                  plan, verify, publish, rollback
  demo.js                    synthetic broken sessions for safe experimentation
  index.js                   public surface (re-export barrel)
test/run.mjs                 the whole test suite
test/fetch-fixtures.mjs      copy one broken generation out of a real store (optional)
docs/ROOT-CAUSE.md           root-cause write-up
```

The identical `lib/core/` code backs the plugin, the CLI, and the tests. Keep it
that way: if logic is needed by two front ends, it belongs in `lib/core/`.

---

## 3. Commands

```bash
node test/run.mjs              # the whole suite; the only required check
node bin/dsh-session-doctor.mjs scan
node bin/dsh-session-doctor.mjs diagnose
node bin/dsh-session-doctor.mjs repair <id>            # dry run, writes nothing
node bin/dsh-session-doctor.mjs demo                   # synthetic broken session
node test/fetch-fixtures.mjs   # optional: enable the real-session tests
```

- **Node ≥ 22.15** is required (built-in `node:zlib` Zstandard support).
- There is **no build step and no dependency install.** Do not add a bundler, a
  transpiler, a TypeScript step, or runtime dependencies. `lib/client.js` is
  deliberately a classic script loaded through `window.__ModuleLoader__`.
- `npm test` is `node test/run.mjs`. There is no lint step.
- The suite must pass **with and without** `.scratch/fixtures` present. Real-session
  tests skip when the fixture is absent. §7.

---

## 4. Making common changes

### 4.1 Add a repair rule

A rule is **data, not a code path**: one entry in `lib/core/rules.js`.

```js
{
  id: 'my-rule',
  title: 'One line describing the fix',
  risk: 'low',                       // 'low' runs by default; 'medium' is opt-in
  rationale: 'Why this edit is correct, in prose.',
  detect (rows) {                    // -> Finding[]
    return rows.filter(/* … */).map((row) => ({
      ruleId: 'my-rule', seq: row.seq, type: row.type,
      path: 'data.someField', before: /* … */, after: /* … */,
      detail: 'shown to the user'
    }))
  },
  apply (rows, findings) {           // mutate rows in place, return an edit count
    /* … */
  }
}
```

The framework does the rest (before/after display, simulation, verification).
Then add a test to `test/run.mjs`. `repair --all` stays on low-risk rules unless
`--include-medium-risk` is passed.

### 4.2 Add a CLI subcommand

Edit `bin/dsh-session-doctor.mjs`: extend the hand-rolled argument parser, add the
command to the help text, and **honour the dry-run/`--apply` convention** — a
command that writes must do nothing without an explicit `--apply`. Keep `--json`
working for the new command.

### 4.3 Add an agent tool or HTTP route

Both live in `lib/index.js`.

- Tools are built by a factory taking the shared `base` config
  (`{ dshHome, catalogPath }`) and registered inside `ctx.effect(...)` so unmount
  removes them. Read-only tools set `isConcurrencySafe: () => true`; a tool that
  writes must not.
- A tool that writes is **dry-run by default** and writes only on an explicit
  `apply: true`.
- Routes live under `API_PREFIX` (`/sessions-diagnosis/api`) and are matched by
  **exact string equality** on the pathname after the prefix — so `/scan/` is a
  404. Every route is behind the same-origin guard; do not add one that bypasses it.
- See §5.1 before writing any schema.

### 4.4 Change the dashboard

`lib/client.js`, a classic script using `React.createElement` (no JSX) that
registers one `settings.section` (id `sessions-diagnosis`, order `320`).

- The layout is **load-bearing and test-pinned**: four columns, `width:'100%'` on
  the session column, `width:'1%'` + `nowrap` on the short columns,
  `overflowWrap:'break-word'` (not `anywhere`) on the session cell, and the
  detail row rendered as an extra `<tr>` with `colSpan: 4`. Read the comments at
  the top of `lib/client.js` before touching styles — they record which bug each
  choice fixed, and `test/run.mjs` asserts them.
- User-visible strings go through `t('English', '中文')`. Add both.
- All dynamic values are passed as `createElement` children — never
  `dangerouslySetInnerHTML`.

---

## 5. Invariants and gotchas

### 5.1 DSH's JSON Schema subset is enforced at boot

`ctx.tools.register()` validates `output.schema` **immediately, while the profile
is booting**. An unsupported keyword does not degrade gracefully — it throws, the
loader entry fails, and `dsh web` refuses to start:

```
Error: dsh: plugin tree failed to load: failed to apply loader entry <id> ...
unsupported JSON schema: schema.properties.<x>.additionalProperties is not supported on type "array"
```

The supported subset is: one scalar `type`; `properties` / `required` / boolean
`additionalProperties` **on objects only**; `items` **on arrays only**; scalar
`enum` / `const`; and exact-one `oneOf`. Misplaced keywords **reject** rather than
being ignored. Output schemas must stay object-rooted.

`test/run.mjs` guards this by running DSH's own `assertSupportedJsonSchema` and
`validateJsonSchemaValue` over every definition and every value the tools return.

Also: tool results must be **lossless JSON** — no `undefined` members, no
functions. `lib/index.js` compacts results for exactly this reason.

### 5.2 Two layers, two error channels

- A tool that fails returns `{ ok: false, error }` rather than throwing where it can.
- Over HTTP, a failed repair/rollback is **422** with `{ ok: false, … }`, but a
  bad request (unknown id, unparseable body) surfaces as **500** `{ error }`.
  Clients must consult `payload.error` / `.ok`, never the status code alone.

### 5.3 Session-store facts

- A session is a directory holding **one immutable file per format generation**;
  DSH migrates lazily on open and selects the highest generation.
- Current format version is **3**. Since 0.1.5 the final migration step is a
  **closed-vocabulary audit** over `source.kind` (fifteen admitted values);
  anything else aborts the whole migration. `at-file-mention` is the usual culprit.
- A failed migration writes **nothing**, so there is no on-disk evidence — which
  is why diagnosis re-runs DSH's *own* released migration chain rather than
  reimplementing it.
- Nested frames are decoded by walking frame/block headers structurally rather
  than by decompressing: `zstdDecompressSync()` stops after the first frame of a
  concatenated container.

### 5.4 Plugin loading

`cordis.patch.yml` inserts one host row. Adding a second mount line *and*
installing via the CLI loads **two copies** of the plugin. Don't.

---

## 6. Verification expectations

Before you call a change done:

1. `node test/run.mjs` → **0 failed**.
2. Run it in a **bare checkout** (no `.scratch/`) as well — real-session tests
   must skip, not fail. `45 passed, 0 failed, 2 skipped` is the fixture-less shape.
3. If you touched `lib/client.js` or `lib/index.js`, exercise the real boot path:
   the suite mounts the plugin against DSH's real `cordis` `Context` and
   `ToolRuntime`, which is the same call that fails at boot.
4. If you touched a write path, confirm the "no file appears on failure" property
   still holds, and that a dry run writes nothing.

---

## 7. Test-suite conventions

- Hand-rolled runner: `await test('name', async () => { … })`. No framework.
- Fail with `node:assert/strict`; skip with `return skip('reason')` (it throws a
  marked error).
- Real-session tests read a fixture from `.scratch/fixtures/` and **must skip**
  when it is absent. Guard *before* you read the file:
  `if (!existsSync(BROKEN)) return skip(...)`.
- Use `withTempDshHome(fn)` when a test must not be able to reach the developer's
  real store. It is `async` and awaits your body, so pass a sync or async function
  and let the caller `await` it. Demo *id minting* does not read any registry —
  `createDemoSession` takes the archived-id set as an explicit `archived` option,
  so tests pass it directly.
- Restore anything you mutate — especially `process.env.DSH_HOME` — in a
  `finally`. Never leak environment state between tests.
- The suite asserts *behaviour*, not source text, where it can: UI tests mount the
  real component against a minimal React stand-in and inspect the returned tree.
- Two exceptions pin **source text** by regex: the CLI-wiring test (it deliberately
  avoids spawning a child process, because piped stdio may be unavailable) and the
  client's loader-contract test. Reformatting `cmdDemo`/`cmdDemoRemove` or the
  `__ModuleLoader__` block can fail those tests without any behaviour change —
  update the regex when you legitimately restructure them.

---

## 8. Never commit local state

`.gitignore` keeps these out. Do not force-add them, and do not paste their
contents into an issue, a commit message, or documentation.

| Path | Why |
|---|---|
| `.scratch/` | Fixtures copied from a real session store, ad-hoc probes. **A session log contains the full text of a conversation.** |
| `notes/` | Reverse-engineering notes that quote real session content and real filesystem paths. |
| `profile-backup/` | A copy of a live DSH profile; its `pnpm-lock.yaml` records `link:` dependencies as **absolute paths on one machine**. |

When writing docs, examples, tests, or comments, use obviously synthetic paths
(`C:\Users\you\.dsh\sessions`, `D:\work\projects\my-app`). Do not paste a path
from the machine you are working on: it will name a real user, drive layout, or
session store.

---

## 9. Docs and commit style

- Documentation is **bilingual**: `README.md` + `README.zh.md`,
  `docs/ROOT-CAUSE.md` + `docs/ROOT-CAUSE.zh-CN.md`. Update both when you change
  user-facing behaviour.
- Commit messages are single-line, conventional-prefix, lowercase after the
  colon, no trailing period, and state **what changed and why**:

  ```
  fix: create demos in a throwaway store, never the real one
  feat: demo --remove, and be honest about where a demo lands
  docs: give a command that actually runs
  ```

- Keep comments at the level of *why*. The existing code explains the bug a
  decision fixed; match that tone.

---

## 10. Known issues

Verified, unfixed. Fixing one? Add the regression test in the same commit.

1. **`patch-source` repair reports print `undefined`.** The repair report reads
   `verification.events` / `verification.admission`, which only `verifySuccessor`
   sets; the `patch-source` path sets a different `verification` shape.
2. **`session_repair` with `action: 'rollback'` writes without a dry run**, while
   the tool description presents `apply: true` as the only write switch. The
   asymmetry is deliberate but under-documented; do not assume symmetry.
3. **An unknown CLI option prints a raw stack trace.** `parseArgs` is called
   outside the `try` that renders `error: <message>`, so
   `dsh-session-doctor scan --bogus` throws an unhandled `Error: unknown option
   --bogus` from `parseArgs` instead of the friendly one-line error + exit 1.
4. **`repair` and `rollback` exit 0 even when a session fails.** They print
   `FAIL  <id>` per session but never set a failing exit code; only `verify`
   maps per-item failure to exit 1. Scripts cannot rely on the exit code to
   detect a partial failure.

---

## 11. Scope discipline

This tool's whole value is that it is **trustworthy about other people's
irreplaceable conversation history**. Prefer a smaller change that keeps every
guarantee provable over a broader one that weakens a guarantee. If a change would
make any statement in README §"Safety model" less true, it is the wrong change —
or the README must change with it, in the same commit.
