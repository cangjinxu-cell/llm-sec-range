/**
 * `dsh-sessions-diagnosis` — browser half.
 *
 * Contributes one settings page: a dashboard that lists every session in the
 * local store with its verdict, explains exactly why the broken ones will not
 * open, and can repair them from the UI.
 *
 * This file is a **classic script**, not an ES module, because that is the
 * contract the web shell's client module loader expects: it only registers a
 * factory, and every side effect happens when the factory is materialized.
 *
 * It is also deliberately **not built**: the data layer is plain `fetch` and the
 * view is `React.createElement`, so the plugin ships without esbuild, TypeScript,
 * or any `node_modules`. The only runtime imports are the shell's seed words.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sessions-diagnosis',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Client services required before mount. */
    const inject = ['slots']

    /** Dashboard API prefix, owned by the host half. */
    const API = '/sessions-diagnosis/api'

    /** Pick a string by the browser's language. */
    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
    const t = (en, cn) => (zh ? cn : en)

    // ── data layer ───────────────────────────────────────────────────────────

    /** GET a JSON endpoint, surfacing the server's error message. */
    async function getJson (path) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`)
      return payload
    }

    /** POST a JSON body, surfacing the server's error message. */
    async function postJson (path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok && payload.error === undefined) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return payload
    }

    // ── presentation ─────────────────────────────────────────────────────────

    /** Colour + short label per verdict. */
    const STATUS_STYLE = {
      ok: { colour: '#17a34a', label: t('ok', '正常') },
      unmigrated: { colour: '#0891b2', label: t('unmigrated', '待迁移') },
      repairable: { colour: '#d97706', label: t('repairable', '可修复') },
      unrepairable: { colour: '#dc2626', label: t('unrepairable', '无法修复') },
      corrupt: { colour: '#dc2626', label: t('corrupt', '已损坏') },
      'too-new': { colour: '#7c3aed', label: t('too new', '版本过新') },
      empty: { colour: '#6b7280', label: t('empty', '空') },
      unknown: { colour: '#64748b', label: t('unknown', '未检查') }
    }

    /**
     * One line per verdict: the in-panel guide, and every badge's tooltip.
     *
     * The short label is what raises the question in the first place — a user who
     * has just been told a session is "unmigrated" has no way to find out what
     * that means without leaving the harness. Every status the engine can emit
     * needs an entry here, which is why the list is exactly the engine's own
     * `DIAGNOSIS_STATUSES` and a test pins the two together.
     */
    const STATUS_HELP = {
      ok: t('Current format, opens cleanly.', '已是当前格式，能正常打开。'),
      unmigrated: t('An older generation that still opens; DSH migrates it when the session is next written to.',
        '仍是较旧的一代，但能正常打开；下次写入该会话时 DSH 会自行迁移。'),
      repairable: t('Will not open, but a known rule was verified to fix it.',
        '无法打开，但已验证有已知规则可以修复。'),
      unrepairable: t('Will not open, and no known rule applies.',
        '无法打开，且没有已知规则适用。'),
      corrupt: t('The stored bytes are damaged: bad frames, or rows that are not valid JSON.',
        '存储字节已损坏：帧错误，或存在不是合法 JSON 的行。'),
      'too-new': t('Written by a newer harness. Upgrade DSH to open it.',
        '由更新的 harness 写入；需升级 DSH 才能打开。'),
      empty: t('The directory holds no session log DSH can open.',
        '该目录里没有 DSH 能打开的会话日志。'),
      unknown: t('Not checked: this build of DSH ships no format codec, so the log was never tested. Not a failure.',
        '未检查：这份 DSH 没有可用的格式编解码器，日志从未被检验过；这不是失败。')
    }

    /**
     * The order the guide lists verdicts in.
     *
     * The raw status is shown beside each explanation, because it is the same
     * word the JSON output, the CLI and the documentation use — a user who reads
     * it here can grep for it there.
     */
    const STATUS_ORDER = ['ok', 'unmigrated', 'repairable', 'unrepairable', 'corrupt', 'too-new', 'empty', 'unknown']

    const styles = {
      page: { padding: '16px 18px', display: 'grid', gap: 14, fontSize: 13, lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      card: { border: '1px solid var(--dsh-border, rgba(127,127,127,.28))', borderRadius: 8, padding: '10px 12px' },
      muted: { opacity: 0.68 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.28))', fontWeight: 600, whiteSpace: 'nowrap' },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.14))', verticalAlign: 'top' },
      // A short column: exactly as wide as its own content, and never broken
      // mid-label. Without this the verdict column is squeezed by its
      // neighbours and a two-character label like "正常" wraps onto two lines.
      narrow: { width: '1%', whiteSpace: 'nowrap' },
      // The session column is the only flexible one, so it absorbs every pixel
      // the short columns leave. That matters: the settings panel is 800px wide,
      // the nav takes 188px and the panel plus page padding another 84px, so the
      // table has roughly 528px to share — and a session id is ~290px of it.
      wide: { width: '100%' },
      // Breaking inside a long token is the last resort, never the first: the id
      // and the project path both have hyphens to break at. `anywhere` would let
      // the column shrink past the id and split it every few characters, which
      // is what made a long id unreadable.
      sessionCell: { overflowWrap: 'break-word' },
      reason: { fontSize: 11.5, marginTop: 2 },
      selectedRow: { background: 'rgba(127,127,127,.10)' },
      detailRow: { padding: '0 8px 10px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.14))' },
      detailCard: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,.28))',
        borderLeft: '3px solid #0891b2',
        borderRadius: 8, padding: '10px 12px', background: 'rgba(127,127,127,.06)'
      },
      button: {
        padding: '5px 11px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.4))',
        background: 'var(--dsh-surface, transparent)', color: 'inherit', fontSize: 12
      },
      buttonPrimary: {
        padding: '5px 11px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
        border: '1px solid transparent', background: '#d97706', color: '#fff', fontWeight: 600
      },
      badge: { padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', display: 'inline-block' },
      pre: {
        margin: 0, padding: 8, borderRadius: 6, overflowX: 'auto', fontSize: 11.5,
        background: 'rgba(127,127,127,.12)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      }
    }

    const badge = (status) => {
      const style = STATUS_STYLE[status] ?? { colour: '#6b7280', label: status }
      // The tooltip is the guide entry: hovering any verdict in the table answers
      // the question without opening anything.
      return h('span', {
        style: { ...styles.badge, background: style.colour },
        title: STATUS_HELP[status]
      }, style.label)
    }

    const button = (label, onClick, options = {}) =>
      h('button', {
        type: 'button',
        style: options.primary === true ? styles.buttonPrimary : styles.button,
        disabled: options.disabled === true,
        onClick
      }, label)

    const knobs = (label, value) =>
      h('div', { style: styles.row },
        h('span', { style: { ...styles.muted, minWidth: 132 } }, label),
        h('span', { style: styles.mono }, String(value)))

    /**
     * The format version of the artifact DSH would open, for the Version column.
     *
     * `/scan` answers with `Diagnosis` objects, which *name* the generation they
     * selected instead of carrying a `highestVersion` field — reading the latter
     * printed "vundefined" in every row. A directory holding no canonical file
     * has no artifact, so there is no version to name; the dash is punctuation,
     * not a label, and reads the same in every language.
     */
    const versionLabel = (session) =>
      typeof session.selected?.version === 'number' ? `v${session.selected.version}` : '—'

    // ── components ───────────────────────────────────────────────────────────

    /**
     * One session's row, plus its detail panel directly underneath when open.
     *
     * The detail is rendered as an extra row in place — not above the table —
     * so clicking "查看" far down a long list shows the answer where the user
     * is looking instead of at the top of a page they then have to scroll back
     * to. `detail` is null while that session is still being read.
     *
     * Identity and the reason it is broken share one column on purpose: with a
     * separate "原因" column the table's ~528px left a 44-character session id
     * about 200px, which wrapped it across three unreadable lines.
     */
    function SessionRow ({ session, selected, detail, busy, onInspect, onRepair, onRollback }) {
      const reasons = session.reasons.slice(0, 2)
      return h(React.Fragment, null,
        h('tr', { style: selected ? styles.selectedRow : undefined },
          h('td', { style: styles.td },
            h('div', { style: styles.sessionCell },
              h('div', { style: styles.mono }, session.id),
              h('div', { style: { ...styles.muted, fontSize: 11 } }, session.projectDir),
              reasons.length === 0
                ? null
                : h('div', { style: styles.reason }, reasons.map((reason) =>
                  h('div', { key: reason.code },
                    h('span', {
                      style: {
                        fontWeight: 600,
                        color: reason.severity === 'error' ? '#dc2626' : '#d97706'
                      }
                    }, reason.code),
                    `: ${reason.summary}`))),
              session.reasons.length > reasons.length
                ? h('div', { style: { ...styles.muted, fontSize: 11.5 } },
                  `… +${session.reasons.length - reasons.length}`)
                : null)),
          h('td', { style: { ...styles.td, ...styles.narrow } }, badge(session.status)),
          h('td', { style: { ...styles.td, ...styles.narrow } },
            h('span', { style: styles.mono }, versionLabel(session))),
          h('td', { style: { ...styles.td, ...styles.narrow } },
            h('div', { style: styles.row },
              button(selected ? t('Hide', '收起') : t('Inspect', '查看'), () => onInspect(session.id)),
              session.repairable ? button(t('Repair', '修复'), () => onRepair(session.id), { primary: true }) : null))),

        selected
          ? h('tr', null,
            h('td', { colSpan: 4, style: styles.detailRow },
              detail === null
                ? h('div', { style: { ...styles.muted, padding: '6px 0' } },
                  t('Reading this session…', '正在读取该会话…'))
                : h(Detail, {
                  detail,
                  busy,
                  onClose: () => onInspect(session.id),
                  onRepair,
                  onRollback
                })))
          : null)
    }

    /** The expanded detail view for one session. */
    function Detail ({ detail, onClose, onRepair, onRollback, busy }) {
      const card = React.useRef(null)
      // The panel sits inside the row that was clicked, so only the last few
      // pixels below the fold ever need bringing into view.
      React.useEffect(() => {
        const node = card.current
        if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
      }, [detail.id])

      const reasons = detail.reasons ?? []
      const findings = detail.findings ?? []
      return h('div', { ref: card, style: styles.detailCard },
        h('div', { style: styles.row },
          h('strong', null, detail.id),
          badge(detail.status),
          h('span', { style: { flex: 1 } }),
          button(t('Close', '关闭'), onClose)),
        h('div', { style: { ...styles.muted, marginTop: 6 } }, detail.headline),

        detail.selected === undefined ? null : h('div', { style: { marginTop: 8 } },
          knobs(t('Artifact DSH opens', 'DSH 打开的文件'), detail.selected.name),
          knobs(t('Format version', '格式版本'), `v${detail.selected.version} (${detail.selected.compression})`),
          knobs(t('Size', '大小'), `${detail.selected.sizeBytes} bytes`)),
        detail.physical === undefined ? null : h('div', { style: { marginTop: 4 } },
          knobs(t('Frames / rows', '帧 / 行'), `${detail.physical.frames} / ${detail.physical.rows}`),
          detail.physical.tornStart === undefined ? null : knobs(t('Torn tail', '截断尾部'), `byte ${detail.physical.tornStart}`)),
        detail.generations.length > 1 ? knobs(t('All generations', '全部代际'),
          detail.generations.map((g) => `v${g.version}`).join(', ')) : null,
        detail.foreign.length > 0 ? knobs(t('Ignored by DSH', 'DSH 忽略的文件'),
          detail.foreign.map((g) => g.name).join(', ')) : null,

        h('div', { style: { marginTop: 10, fontWeight: 600 } }, t('Findings', '诊断结论')),
        reasons.length === 0
          ? h('div', { style: styles.muted }, t('None.', '无。'))
          : h('ul', { style: { margin: '4px 0 0 18px', padding: 0 } }, reasons.map((reason, i) =>
            h('li', { key: i, style: { marginBottom: 4 } },
              h('span', { style: { fontWeight: 600, color: reason.severity === 'error' ? '#dc2626' : '#d97706' } },
                reason.code),
              ' — ', reason.summary,
              reason.detail === undefined ? null : h('div', { style: { ...styles.mono, ...styles.muted } },
                String(reason.detail).slice(0, 400))))),

        findings.length === 0 ? null : h('div', { style: { marginTop: 10 } },
          h('div', { style: { fontWeight: 600 } },
            `${t('Planned edits', '计划修改')} (${findings.length})`),
          h('div', { style: { marginTop: 4 } }, findings.slice(0, 12).map((finding, i) =>
            h('div', { key: i, style: styles.mono },
              `${finding.type} seq ${finding.seq} ${finding.path}: `,
              h('span', { style: { color: '#dc2626' } }, JSON.stringify(finding.before)),
              ' → ',
              h('span', { style: { color: '#17a34a' } }, JSON.stringify(finding.after))))),
          findings.length > 12
            ? h('div', { style: styles.muted }, `… +${findings.length - 12}`)
            : null),

        h('div', { style: { ...styles.muted, marginTop: 10, fontSize: 12 } },
          t('A repair publishes a new generation beside the original file and never modifies it, ' +
            'so the original conversation is always preserved and the repair can be undone.',
            '修复会在原文件旁边发布一个新代际，绝不修改原文件，因此原始对话始终保留，且修复可以撤销。')),

        // A repair this tool made: show its record and offer a proven-safe undo.
        detail.manifest === undefined ? null : h('div', { style: { marginTop: 10 } },
          h('div', { style: { fontWeight: 600 } }, t('Repaired by this plugin', '本插件已修复')),
          h('div', { style: { ...styles.muted, fontSize: 12 } },
            `${detail.manifest.strategy} · ${detail.manifest.repairedAt}`),
          h('div', { style: { ...styles.muted, fontSize: 12 } },
            `${t('rules', '规则')}: ${(detail.manifest.rules ?? []).join(', ')}`),
          h('div', { style: { marginTop: 6 } },
            button(t('Undo this repair', '撤销本次修复'), () => onRollback(detail.id), { disabled: busy }))),

        detail.repairable
          ? h('div', { style: { marginTop: 12 } },
            button(t('Repair this session', '修复此会话'), () => onRepair(detail.id), { primary: true, disabled: busy }))
          : null)
    }

    /** The settings page. */
    function DiagnosisPanel () {
      const [report, setReport] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [guide, setGuide] = React.useState(false)

      const refresh = React.useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          setReport(await getJson('/scan'))
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      /** Read one session's diagnosis into the row that is already open. */
      const inspect = React.useCallback(async (id) => {
        setSelected(id)
        setDetail(null)
        setBusy(true)
        setNotice(null)
        try {
          setDetail(await getJson(`/diagnose?id=${encodeURIComponent(id)}`))
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
          setSelected(null)
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * The row button toggles: clicking an open row closes it again. The
       * current selection is read from this render's scope rather than from a
       * stale closure, so the handler is deliberately not memoized.
       */
      const toggle = (id) => {
        if (selected === id) {
          setSelected(null)
          setDetail(null)
          return
        }
        void inspect(id)
      }

      /** Close whatever detail row is open. */
      const close = () => {
        setSelected(null)
        setDetail(null)
      }

      /** Repair one session: dry run first, then apply on confirmation. */
      const repair = React.useCallback(async (id) => {
        setBusy(true)
        setNotice(null)
        try {
          const plan = await postJson('/repair', { id, apply: false })
          if (!plan.ok) {
            setNotice({ kind: 'error', text: plan.summary ?? plan.error })
            return
          }
          // Show exactly which rules would run and how invasive they are: a
          // medium-risk rule edits recorded metadata rather than a provenance tag.
          const rules = [...new Set((plan.findings ?? []).map((finding) => finding.ruleId))]
          const invasive = (plan.risks ?? []).includes('medium')
          const summary = [
            `${t('Session', '会话')}: ${id}`,
            `${t('Rules', '规则')}: ${rules.join(', ') || t('none', '无')}`,
            invasive
              ? t('NOTE: this edits recorded metadata, not only a provenance tag.',
                  '注意：这会修改已记录的元数据，而不只是来源标记。')
              : t('This only rewrites a provenance tag.', '这只会重写来源标记。'),
            '',
            `${t('Edits', '修改条目')}: ${plan.findings?.length ?? 0}`,
            t('The original file is not modified and this can be undone.',
              '原文件不会被修改，且此操作可以撤销。')
          ].join('\n')
          if (!window.confirm(`${t('Apply this repair?', '确认执行修复？')}\n\n${summary}`)) {
            setNotice({ kind: 'info', text: plan.summary })
            return
          }
          const applied = await postJson('/repair', { id, apply: true })
          setNotice({ kind: applied.ok ? 'ok' : 'error', text: applied.summary ?? applied.error })
          close()
          await refresh()
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [refresh])

      /**
       * Undo a repair. The server refuses when the published generation has
       * changed since the repair, so a rollback can never discard new messages.
       */
      const rollback = React.useCallback(async (id) => {
        setBusy(true)
        setNotice(null)
        try {
          const confirmed = window.confirm(
            `${t('Undo this repair?', '确认撤销本次修复？')}\n\n${id}\n\n` +
            t('The published generation is moved aside (not deleted) and the session returns to its pre-repair state.',
              '已发布的代际会被移到一旁（不会删除），会话回到修复前的状态。')
          )
          if (!confirmed) return
          const outcome = await postJson('/rollback', { id })
          setNotice({ kind: outcome.ok ? 'ok' : 'error', text: outcome.summary ?? outcome.error })
          close()
          await refresh()
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const noticeColour = notice?.kind === 'error' ? '#dc2626' : notice?.kind === 'ok' ? '#17a34a' : '#0891b2'

      return h('div', { style: styles.page },
        h('div', { style: styles.row },
          h('strong', { style: { fontSize: 15 } }, t('Session diagnosis', '会话诊断')),
          h('span', { style: { flex: 1 } }),
          button(guide ? t('Hide verdict guide', '收起结论说明') : t('What the verdicts mean', '结论说明'),
            () => setGuide(!guide)),
          button(busy ? t('Working…', '处理中…') : t('Rescan', '重新扫描'), () => void refresh(), { disabled: busy })),

        h('div', { style: { ...styles.muted, fontSize: 12 } },
          t('Explains why stored sessions fail to open, and repairs the ones a known rule can fix.',
            '诊断本地会话为何无法打开，并修复已知规则可修复的会话。')),

        // The verdicts are the panel's whole vocabulary, and the labels alone do
        // not define themselves. This is on demand rather than always visible so
        // the list stays the first thing on the page.
        guide
          ? h('div', { style: styles.card },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('What the verdicts mean', '结论说明')),
            STATUS_ORDER.map((status) => h('div', {
              key: status,
              style: { ...styles.row, alignItems: 'baseline', marginBottom: 4 }
            },
            badge(status),
            h('span', { style: { ...styles.mono, ...styles.muted, minWidth: 96 } }, status),
            h('span', { style: { flex: 1, fontSize: 12 } }, STATUS_HELP[status]))))
          : null,

        notice === null ? null : h('div', { style: { ...styles.card, color: noticeColour } }, notice.text),

        report === null
          ? h('div', { style: styles.muted }, busy ? t('Scanning…', '扫描中…') : t('No data.', '暂无数据。'))
          : h(React.Fragment, null,
            h('div', { style: styles.card },
              knobs(t('Session store', '会话目录'), report.root ?? t('<not found>', '<未找到>')),
              knobs(t('Format codec', '格式编解码器'),
                report.codecAvailable
                  ? t('available', '可用')
                  : t('NOT FOUND — older logs cannot be checked', '未找到 — 旧日志无法检查')),
              knobs(t('Sessions', '会话数'),
                // Every verdict gets a count here, including the two that used to
                // be missing: a verdict that is never counted reads as a verdict
                // that cannot happen, and `too-new`/`empty` were exactly that.
                // `?? 0` keeps an older or hand-written report from rendering the
                // word "undefined" where a number belongs.
                `${report.summary.total}  (` +
                `${report.summary.ok} ok, ${report.summary.unmigrated} ${t('unmigrated', '待迁移')}, ` +
                `${report.summary.repairable} ${t('repairable', '可修复')}, ` +
                `${report.summary.unrepairable} ${t('unrepairable', '无法修复')}, ` +
                `${report.summary.corrupt} ${t('corrupt', '已损坏')}, ` +
                `${report.summary.tooNew ?? 0} ${t('too new', '版本过新')}, ` +
                `${report.summary.empty ?? 0} ${t('empty', '空')}, ` +
                `${report.summary.unknown ?? 0} ${t('unknown', '未检查')})`)),

            // No separate detail block here: each session's detail renders
            // inside the table, directly under the row it belongs to.
            h('table', { style: styles.table },
              h('thead', null, h('tr', null,
                h('th', { style: { ...styles.th, ...styles.wide } }, t('Session', '会话')),
                h('th', { style: { ...styles.th, ...styles.narrow } }, t('Verdict', '结论')),
                h('th', { style: { ...styles.th, ...styles.narrow } }, t('Version', '版本')),
                h('th', { style: { ...styles.th, ...styles.narrow } }, ''))),
              h('tbody', null, report.sessions.map((session) =>
                h(SessionRow, {
                  key: session.id,
                  session,
                  selected: session.id === selected,
                  detail: detail !== null && detail.id === session.id ? detail : null,
                  busy,
                  onInspect: toggle,
                  onRepair: (id) => void repair(id),
                  onRollback: (id) => void rollback(id)
                }))))))
    }

    /** Mount the dashboard into the settings shell. */
    function apply (ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'sessions-diagnosis',
          order: 320,
          label: t('Session diagnosis', '会话诊断')
        },
        DiagnosisPanel
      ))
    }

    return { apply, inject }
  }
})
