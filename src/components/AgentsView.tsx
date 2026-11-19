import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Paperclip,
  Plus,
  RotateCcw,
  ScrollText,
  Send,
  X,
} from 'lucide-react'
import {
  STATUS_LABELS,
  actionsFor,
  groupOf,
  type Brief,
  type BriefAction,
  type BriefFile,
  type BriefGroup,
  type RunsState,
} from '../briefs/briefs'
import { iconFor, formatBytes } from '../lib/fileTypes'
import { timeAgo } from '../lib/format'

interface AgentsViewProps {
  briefs: Brief[]
  runs: RunsState
  /** False for a library no agent can reach — a local folder or in-browser one. */
  supported: boolean
  /** Agents the library has heard of: every token in runs.json or the activity log. */
  agentNames: string[]
  onOpen: (path: string) => void
  onNewBrief: () => void
  onAction: (brief: Brief, action: BriefAction) => Promise<boolean>
  onAttach: (brief: Brief, files: FileList) => void
  /** Read a note's text — the run log, when a card is opened. */
  readText: (path: string) => Promise<string>
}

const GROUPS: { id: BriefGroup; label: string; empty?: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'queued', label: 'Queued' },
  { id: 'drafts', label: 'Drafts' },
]

type Filter = 'active' | 'finished'

/** The last few entries of a Run.md, newest last, as plain lines. */
function lastEntries(log: string, count: number): string[] {
  const entries: string[] = []
  for (const line of log.split('\n')) {
    if (line.startsWith('- ')) entries.push(line.slice(2))
    else if (line.startsWith('  ') && entries.length) entries[entries.length - 1] += `\n${line.trim()}`
  }
  return entries.slice(-count)
}

/** The newest "**Question:**" the agent asked, if it is still the latest word. */
function openQuestion(log: string): string | null {
  const entries = lastEntries(log, 50)
  for (let i = entries.length - 1; i >= 0; i--) {
    const at = entries[i].indexOf('**Question:**')
    if (at !== -1) return entries[i].slice(at + '**Question:**'.length).trim()
    if (entries[i].includes('**Answer:**')) return null
  }
  return null
}

/** "**2026-11-19 14:02** · hermes — text" → its parts. */
function splitEntry(entry: string): { when: string; who: string; text: string } {
  const m = /^\*\*(.+?)\*\*(?: · (.+?))? — ([\s\S]*)$/.exec(entry)
  if (!m) return { when: '', who: '', text: entry }
  return { when: m[1], who: m[2] ?? '', text: m[3] }
}

/** Markdown emphasis and wikilinks, flattened for a one-line summary. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_, target) => target.slice(target.lastIndexOf('/') + 1))
}

function FileList({ files, onOpen, empty }: { files: BriefFile[]; onOpen: (path: string) => void; empty: string }) {
  if (!files.length) return <p className="brief-empty">{empty}</p>
  return (
    <ul className="brief-files">
      {files.map((f) => {
        const Icon = f.isNote ? FileText : iconFor({ kind: 'asset', name: f.name })
        return (
          <li key={f.id}>
            <button type="button" className="brief-file" onClick={() => onOpen(f.id)} title={f.id}>
              <Icon size={14} aria-hidden="true" />
              <span className="brief-file-name">{f.name}</span>
              {f.size !== null && <span className="brief-file-size">{formatBytes(f.size)}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function BriefCard({
  brief,
  runs,
  defaultOpen,
  onOpen,
  onAction,
  onAttach,
  readText,
}: {
  brief: Brief
  runs: RunsState
  defaultOpen: boolean
  onOpen: (path: string) => void
  onAction: (brief: Brief, action: BriefAction) => Promise<boolean>
  onAttach: (brief: Brief, files: FileList) => void
  readText: (path: string) => Promise<string>
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [log, setLog] = useState<string | null>(null)
  const [composing, setComposing] = useState<'request-changes' | 'answer' | 'rerun' | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const attachInput = useRef<HTMLInputElement>(null)

  const claim = brief.status === 'running' ? runs.claims[brief.id] : undefined
  const stale = !!claim && claim.heartbeatAt + runs.leaseMs < Date.now()

  // The run log is read when the card opens, and again whenever the brief
  // changes on disk — which is how a new question or progress line shows up.
  useEffect(() => {
    if (!open || !brief.run) return
    let cancelled = false
    void readText(brief.run)
      .then((text) => !cancelled && setLog(text))
      .catch(() => !cancelled && setLog(''))
    return () => {
      cancelled = true
    }
  }, [open, brief.run, brief.updatedAt, readText])

  const question = brief.status === 'blocked' && log ? openQuestion(log) : null
  const actions = actionsFor(brief)

  const act = async (action: BriefAction) => {
    setBusy(true)
    const ok = await onAction(brief, action)
    setBusy(false)
    if (ok) {
      setComposing(null)
      setDraft('')
    }
  }

  const meta = [
    brief.project,
    brief.agent ?? 'any agent',
    `P${brief.priority}`,
    brief.due ? `due ${brief.due}` : null,
    brief.repeat ? `${brief.repeat}${brief.start ? ` · next ${brief.start}` : ''}` : brief.start ? `from ${brief.start}` : null,
  ].filter(Boolean)

  return (
    <li className={`brief-card status-${brief.status}`}>
      <div className="brief-card-head">
        <button
          type="button"
          className="brief-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${brief.title}`}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button type="button" className="brief-card-title" onClick={() => onOpen(brief.brief)} title="Open the brief">
          {brief.title}
        </button>
        <span className={`brief-status status-${brief.status}`}>{STATUS_LABELS[brief.status]}</span>
      </div>
      <div className="brief-card-meta">{meta.join(' · ')}</div>

      {claim && (
        <p className={`brief-progress${stale ? ' stale' : ''}`}>
          <Bot size={13} aria-hidden="true" />
          <span>
            <strong>{claim.agent}</strong> — {claim.progress ?? 'working'}
            <span className="brief-progress-when">
              {' '}
              · {stale ? `no word for ${timeAgo(claim.heartbeatAt).replace(/ ago$/, '')}; it goes back to the queue on the next poll` : timeAgo(claim.heartbeatAt)}
            </span>
          </span>
        </p>
      )}
      {!open && (brief.output.length > 0 || brief.context.length > 0) && (
        <div className="brief-card-counts">
          {brief.context.length > 0 && <span>{brief.context.length} context</span>}
          {brief.output.length > 0 && <span>{brief.output.length} delivered</span>}
        </div>
      )}

      {open && (
        <div className="brief-detail">
          {question && (
            <div className="brief-question">
              <CircleHelp size={15} aria-hidden="true" />
              <p>{plain(question)}</p>
            </div>
          )}

          <div className="brief-section">
            <div className="brief-section-head">
              <span>Delivered</span>
              {brief.outputs.length > 0 && <span className="brief-section-note">expects {brief.outputs.join(', ')}</span>}
            </div>
            <FileList files={brief.output} onOpen={onOpen} empty="Nothing yet." />
          </div>

          <div className="brief-section">
            <div className="brief-section-head">
              <span>Context</span>
              <button type="button" className="brief-link" onClick={() => attachInput.current?.click()}>
                <Paperclip size={13} /> Attach
              </button>
              <input
                ref={attachInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) onAttach(brief, e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            <FileList files={brief.context} onOpen={onOpen} empty="No files attached." />
          </div>

          {log !== null && (
            <div className="brief-section">
              <div className="brief-section-head">
                <span>Latest</span>
                {brief.run && (
                  <button type="button" className="brief-link" onClick={() => onOpen(brief.run!)}>
                    <ScrollText size={13} /> Run log
                  </button>
                )}
              </div>
              <ol className="brief-log">
                {lastEntries(log, 4).map((entry, i) => {
                  const { when, who, text } = splitEntry(entry)
                  return (
                    <li key={i}>
                      <span className="brief-log-who">{who || 'note'}</span>
                      <span className="brief-log-text">{plain(text)}</span>
                      {when && <span className="brief-log-when">{when.slice(5)}</span>}
                    </li>
                  )
                })}
              </ol>
            </div>
          )}

          {composing && (
            <form
              className="brief-compose"
              onSubmit={(e) => {
                e.preventDefault()
                if (composing === 'rerun') void act({ kind: 'rerun', note: draft })
                else if (composing === 'answer') void act({ kind: 'answer', answer: draft })
                else void act({ kind: 'request-changes', comment: draft })
              }}
            >
              <textarea
                autoFocus
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={composing === 'answer' ? 'Your answer' : composing === 'rerun' ? 'Anything different this time' : 'What should change'}
                placeholder={
                  composing === 'answer'
                    ? 'Your answer. The brief goes back in the queue with it.'
                    : composing === 'rerun'
                      ? 'Anything different this time? (optional)'
                      : 'What should change? The agent gets this with the brief.'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setComposing(null)
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
                }}
              />
              <div className="brief-compose-actions">
                <button type="button" className="btn-quiet" onClick={() => setComposing(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={busy || (composing !== 'rerun' && !draft.trim())}>
                  <Send size={14} />
                  {composing === 'answer' ? 'Answer and requeue' : composing === 'rerun' ? 'Queue again' : 'Send back'}
                </button>
              </div>
            </form>
          )}

          {!composing && (
            <div className="brief-actions">
              {actions.includes('approve') && (
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void act({ kind: 'approve' })}>
                  <Check size={14} /> Approve
                </button>
              )}
              {actions.includes('request-changes') && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setComposing('request-changes')}>
                  Request changes
                </button>
              )}
              {actions.includes('answer') && (
                <button type="button" className="btn-primary" disabled={busy} onClick={() => setComposing('answer')}>
                  Answer
                </button>
              )}
              {actions.includes('queue') && (
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void act({ kind: 'queue' })}>
                  <Send size={14} /> Queue
                </button>
              )}
              {actions.includes('rerun') && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setComposing('rerun')}>
                  <RotateCcw size={14} /> Run again
                </button>
              )}
              {actions.includes('to-draft') && (
                <button type="button" className="btn-quiet" disabled={busy} onClick={() => void act({ kind: 'to-draft' })}>
                  Back to draft
                </button>
              )}
              {actions.includes('cancel') && (
                <button type="button" className="btn-quiet brief-cancel" disabled={busy} onClick={() => void act({ kind: 'cancel' })}>
                  <X size={14} /> {brief.status === 'running' ? 'Stop' : 'Cancel'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Work handed to agents: every brief in every project, grouped by what it
 * needs — your answer or review first, then what is running, then the queue —
 * with the agents that have been in touch, and when.
 */
export default function AgentsView({
  briefs,
  runs,
  supported,
  agentNames,
  onOpen,
  onNewBrief,
  onAction,
  onAttach,
  readText,
}: AgentsViewProps) {
  const [filter, setFilter] = useState<Filter>('active')

  const grouped = useMemo(() => {
    const out = new Map<BriefGroup, Brief[]>()
    for (const brief of briefs) {
      const group = groupOf(brief)
      out.set(group, [...(out.get(group) ?? []), brief])
    }
    return out
  }, [briefs])

  const finished = useMemo(
    () => (grouped.get('finished') ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [grouped],
  )
  const activeCount = briefs.length - finished.length

  const titleOf = (id: string | undefined) => briefs.find((b) => b.id === id)?.title

  const renderCards = (list: Brief[], defaultOpen: boolean) => (
    <ul className="brief-list">
      {list.map((b) => (
        <BriefCard
          key={b.id}
          brief={b}
          runs={runs}
          defaultOpen={defaultOpen}
          onOpen={onOpen}
          onAction={onAction}
          onAttach={onAttach}
          readText={readText}
        />
      ))}
    </ul>
  )

  return (
    <div className="agents-view">
      {agentNames.length > 0 && (
        <ul className="agent-strip" aria-label="Agents">
          {agentNames.map((name) => {
            const seen = runs.agents[name]
            const current = seen?.current && runs.claims[seen.current] ? titleOf(seen.current) : undefined
            return (
              <li key={name} className="agent-row">
                <Bot size={14} aria-hidden="true" />
                <span className="agent-name">{name}</span>
                <span className="agent-state">
                  {current ? `on ${current}` : seen?.lastPoll ? `checked for work ${timeAgo(seen.lastPoll)}` : 'has not checked for work'}
                  {seen?.lastSeen ? ` · seen ${timeAgo(seen.lastSeen)}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <div className="task-nav">
        <button type="button" className={`task-pill${filter === 'active' ? ' active' : ''}`} onClick={() => setFilter('active')}>
          Active
          {activeCount > 0 && <span className="task-count">{activeCount}</span>}
        </button>
        <button type="button" className={`task-pill${filter === 'finished' ? ' active' : ''}`} onClick={() => setFilter('finished')}>
          Finished
          {finished.length > 0 && <span className="task-count">{finished.length}</span>}
        </button>
        <button type="button" className="task-pill" onClick={onNewBrief}>
          <Plus size={13} /> Brief
        </button>
      </div>

      <div className="task-body">
        {!supported && (
          <p className="brief-notice">
            This library is on this device, where no agent can reach it. Briefs you write here are kept as files, but
            an agent picks them up only from a server library.
          </p>
        )}
        {briefs.length === 0 ? (
          <div className="task-empty project-empty">
            <Bot size={22} aria-hidden="true" />
            <p>No briefs yet.</p>
            <p>
              A brief is a piece of work for an agent: instructions, files to work from, and what you want back. An
              agent connected over MCP takes the next one with <code>next_brief</code>, and delivers its work into the
              brief's Output folder for you to review.
            </p>
            <button type="button" className="btn-primary" onClick={onNewBrief}>
              <Plus size={15} /> Write a brief
            </button>
          </div>
        ) : filter === 'finished' ? (
          finished.length ? (
            renderCards(finished, false)
          ) : (
            <div className="task-empty">Nothing finished yet.</div>
          )
        ) : activeCount === 0 ? (
          <div className="task-empty">Nothing in hand. Finished briefs are under Finished.</div>
        ) : (
          GROUPS.map(({ id, label }) => {
            const list = grouped.get(id) ?? []
            if (!list.length) return null
            return (
              <section key={id} className="brief-group">
                <div className={`task-section${id === 'needs-you' ? ' brief-needs-you' : ''}`}>
                  {label}
                  <span className="task-count">{list.length}</span>
                </div>
                {renderCards(list, id === 'needs-you')}
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}
