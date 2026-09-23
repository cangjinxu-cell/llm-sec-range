# Root cause: why sessions stop opening after a DSH upgrade

This document explains the failure this plugin diagnoses and repairs. It is
written from the installed DSH 0.1.5-rc.2 packages, by reading the shipped code
and by running it against real session logs.

## Symptom

After upgrading DSH, some conversations vanish from the sidebar's reach: they are
still listed, and clicking one shows a load error instead of history. Nothing
else about the install looks wrong, and the affected sessions are not the newest
ones.

In the web UI the message is:

```
Failed to load history: failed to observe session "<id>":
cannot safely transform unclassified message source; source v0 artifact remains
unchanged (raw log: <...>\session.jsonl.zstd)   (gateway/internal)
```

## The storage model

DSH stores a session as a directory containing **one file per immutable format
generation**:

```
$DSH_HOME/sessions/<project>/<session-id>/
    session.jsonl.zstd          # generation 0  (no .vN suffix for v0)
    session.v3.jsonl.zstd       # generation 3  (current)
```

- The current format version is **3**.
- Runtime operations always select the **numerically highest** canonical
  generation, and a directory that mixes compressed and uncompressed generations
  is rejected outright.
- A physical file is a **concatenation of independent, checksummed Zstandard
  frames**: the first frame holds exactly the JSON header line, and each later
  frame holds one durable append batch of JSONL rows.

Because generations are immutable, a format upgrade does not rewrite old files.
It migrates them **lazily, at open time**, and publishes a successor *beside* the
original. The original file is never renamed, rewritten, or deleted.

Crucially, the successor is published only on a **write** open:

| Open kind | What happens |
|---|---|
| read | decodes and migrates **in memory**, returns history, writes nothing |
| write | performs the same migration, then publishes `session.vN.jsonl.zstd` |

So the presence of a `.v3` sibling means "this session has been opened for
writing since the upgrade". Its absence is normal for a session you have only
looked at — *unless* the migration itself fails.

## The failure

Migration walks the adjacent chain `v0 → v1 → v2 → v3`. The final edge, V2→V3, is
not a reformatting pass: it is a **closed-vocabulary audit**. Every message slot
must carry a `source.kind` drawn from a fixed set of fifteen values:

```
user, plugin, model, tool, agent-instructions, session-reference, team-message,
goal, skill-invocation, skill-catalog, coordinator, subagent-report,
subagent-settled, webhook, agent-message
```

Anything else aborts the **entire** migration:

```
SessionFormatUnsupportedMigrationError: cannot safely transform unclassified message source
```

One retired value is enough to make a whole conversation unopenable. The value
seen in the wild is `at-file-mention`:

```json
{
  "type": "user/message",
  "seq": 10,
  "data": {
    "content": [{ "type": "text", "text": "<workspace-reference path=\"docs/notes.md\" kind=\"file\" />" }],
    "source": { "kind": "at-file-mention", "relative": "docs/notes.md" },
    "role": "user",
    "id": "..."
  },
  "surfaceOp": "append"
}
```

That record is the synthetic user message an older build emitted when someone
typed `@path` in the composer. The string `at-file-mention` does not appear
anywhere in the 0.1.5-rc.2 packages — the vocabulary entry was simply removed, and
the audit has no rule that maps it.

This is why the breakage looks arbitrary: it affects exactly the sessions where
somebody once used an `@` mention. Sessions that never did still migrate cleanly
and older conversations may keep working.

### A second, unrelated refusal

A different stale value produces a different message from the earlier `v0 → v1`
edge:

```
SessionFormatUnsupportedMigrationError: subagent/descriptor <seq> uses unsupported descriptor version 2
```

The released v0 payload codec requires `subagent/descriptor.data.version` to be
exactly `3`, and the descriptor's shape is keyed by its `mode` member — not by
`version` — so a stale version number is a metadata defect rather than a
structural one.

### What a failed migration leaves behind

Nothing. The source generation stays byte-identical, no successor is written, and
the staging file is removed. That is good for safety and bad for diagnosis: the
only evidence is the exception, which is swallowed several layers up and finally
rendered as a generic gateway error.

## The user-visible error chain

```
session-persistence-jsonl  throws SessionFormatUnsupportedError
                           "<reason>; source v<N> artifact remains unchanged (raw log: <path>)"
        ↓
session-query              wraps it as SessionQueryError
                           code SESSION_QUERY_PERSISTENCE_FAILED
        ↓
api-session-controller     has no mapping for that code
        ↓
api-gateway                folds it to RemoteError('gateway/internal', message)
        ↓
client-ui-chat             renders "Failed to load history: <message> (gateway/internal)"
```

Note that the raw log path *is* carried all the way to the UI — that is usually
how you find the file this tool then diagnoses.

## The repair principle

Because generations are immutable and publication is additive, the correct repair
is **not** to edit history. It is to do what DSH itself would do: produce a valid
successor generation and let DSH select it.

```
decode the old generation
  → apply the minimal rule edit to an in-memory copy
  → re-run DSH's real migration over the patched rows
  → encode the result with DSH's own current-format encoder
  → re-read the encoded bytes and prove they pass the storage layer's
    structural admission and a full restore
  → publish session.v<N>.jsonl.zstd beside the original, without overwriting
```

Properties this gives you:

- **The source is never modified.** The repair is reversible by deleting the
  published successor, and the original stays available as a rollback source.
- **Nothing is written unless it has been proven to work.** If a rule guesses
  wrong, the verification fails and no file appears.
- **The edit is minimal.** No event is added, removed, or reordered, so sequence
  coordinates, timestamps, and cross-references are untouched. The `@`-mention's
  path is not lost either — it is already recorded verbatim in the message's own
  content, so only the redundant provenance tag is dropped.

## Two traps worth knowing

Both were found the hard way while building this, and both are easy to fall into
when writing your own tooling.

### 1. DSH's restore mutates the rows you hand it

The format library documents that a restore "transfers caller-owned parsed values
through stateful stages **without intermediate artifact copies or freezing**".
It therefore modifies the row objects it is given — *including when it fails
part-way through*.

Feeding the same array to a second restore therefore produces a **wrong answer**,
typically a phantom error like:

```
SessionFormatError: released Session row 16 has seq gap (expected 170, got 37)
```

The events are not damaged at all; the second restore is simply looking at
half-transformed data. A naive tool that probes, patches, and probes again on the
same array will confidently report a repairable session as corrupt.

This plugin probes a defensive copy and never mutates the caller's rows. There is
a regression test pinning that behaviour.

### 2. Never promise a repair you have not proven

A log can carry two independent defects, where the second only becomes reachable
once the first is fixed. Reporting "repairable" on the strength of a matching
rule alone is a lie the user discovers only after authorising a write.

So the diagnosis **simulates the repair in memory first** and only reports
`repairable` when the repaired log has actually been shown to migrate. When it has
not, the verdict is `unrepairable` and the residual error is reported instead.

## Failure taxonomy

| Verdict | Meaning | What to do |
|---|---|---|
| `ok` | the selected generation is current and restores cleanly | nothing — just open it |
| `unmigrated` | still an older generation, but it migrates fine and opens normally | nothing — opening it for writing makes DSH publish the current-format successor itself |
| `repairable` | migration refuses, a known rule matches, **and** the repaired log was verified to migrate | `dsh-session-doctor repair <id>` (dry run first), or **Repair** in the dashboard — the same two-step flow |
| `unrepairable` | refuses, and either no rule matches or the repaired log still fails | keep the log and report it with the reason code the diagnosis names; no automatic fix will be invented for it |
| `corrupt` | the physical bytes are damaged: bad frame magic, failed checksum, unparseable rows | restore from your own backup if you have one — this tool repairs *format*, not damaged bytes, and it will not guess |
| `too-new` | written by a newer harness than this one | upgrade DSH, rather than downgrading the log |
| `empty` | no canonical generation present | check that the harness is pointed at the store you think it is (`DSH_HOME`), and that a backup or a cleanup did not leave an empty directory behind |
| `unknown` | **nothing was checked**: the running build of DSH ships no `@deepseek-ai/dsh-session-format-catalog`, so its migration chain could not be borrowed to test the log | not a failure and not a verdict about the log — run the scan from a DSH install that has the codec (0.1.3-alpha.2 or newer). `openable: false` here means "not proven", which is why every report renders `unknown` separately from the sessions that will not open |

## Is the repair safe?

The honest answer has two parts: what is guaranteed by construction, and what is
only guaranteed because it is checked.

### Guaranteed by construction

The repair never edits the source generation. It publishes a new one beside it —
the same additive publication DSH performs — so the pre-repair bytes remain on
disk untouched and DSH's own retention story is preserved. Nothing in this tool
deletes a session log.

### Guaranteed because it is checked

A repair is refused unless all of the following hold:

| Check | Why it is needed |
|---|---|
| The patched log migrates under DSH's real chain | the whole point of the repair |
| The result encodes with DSH's own current-format encoder | a hand-rolled encoder could be subtly wrong |
| The bytes re-read and pass structural admission | the storage layer's own pre-recovery gate |
| A full restore succeeds under **both** validation policies | catches what the admission gate alone would let through |
| **Every source message payload appears in the result** | structural validity does not imply the conversation survived |

The last one deserves emphasis. A migration can produce a perfectly readable log
that has quietly dropped messages, and a check that only asks "does it load?" would
call that a success. Comparing message payloads is what turns "your conversation is
preserved" from an assumption into a measurement.

Measured on real sessions: 248 source payloads and 643 source payloads respectively,
**zero lost**, with exactly the two `system/message` additions the v2→v3
specification requires (an empty head, and the prompt promoted out of the request
header).

### Undoing a repair

Repair is reversible, and the reverse operation is deliberately narrow. Each repair
writes a sidecar recording both files' SHA-256, and `rollback`:

1. refuses if the selected generation is not the one the record describes, or if its
   bytes have changed since;
2. otherwise moves it **aside** under a non-canonical name, so DSH stops selecting it
   and the session returns to its pre-repair state.

Step 1 is the important one. DSH appends to the current generation whenever you
resume a session, so a successor that was written to after the repair now holds
history that exists nowhere else. Deleting it would destroy that history. Refusing
is the only correct behaviour, and it is what the tool does.

Step 2 keeps the rollback itself reversible: the file is moved, never removed.

### Atomicity

Publication stages a complete file, flushes it, and hard-links it into place, so a
concurrent reader sees either a whole generation or none. On filesystems without
hard links the exclusive-copy fallback is verified against the staged bytes and
removed again on mismatch, because a half-written generation is worse than no
generation at all: DSH selects the highest one, so a corrupt successor would hide a
still-readable predecessor.

## Method

Every claim above was verified against the installed packages, not inferred from
behaviour:

- `@deepseek-ai/dsh-session-format` — canonical filename rules and generation parsing
- `@deepseek-ai/dsh-session-format-catalog` — `currentVersion: 3` and the composed v0→v3 chain
- `@deepseek-ai/dsh-session-format-v2-to-v3` — `SOURCE_KINDS`, `assertSource`, the payload audit
- `@deepseek-ai/dsh-session-format-v0-to-v1` — the `subagent/descriptor` version rule
- `@deepseek-ai/dsh-session-persistence-jsonl` — generation selection, frame container, publication path

The diagnosis runs that same catalog. Its verdicts are not a reimplementation of
DSH's rules; they *are* DSH's rules, executed.
