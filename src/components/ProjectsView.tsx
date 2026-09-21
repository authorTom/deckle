import { useMemo, useState } from 'react'
import { FolderKanban, Plus, ScrollText } from 'lucide-react'
import type { Project, ProjectStatus } from '../projects/projects'
import { STATUSES } from '../projects/projects'
import { timeAgo } from '../lib/format'

interface ProjectsViewProps {
  projects: Project[]
  /** Folder projects live in, for the empty state to name. */
  root: string
  /** Activity in each project since the person last looked. */
  unseenByProject: Map<string, number>
  onOpen: (project: Project) => void
  onOpenLog: (project: Project) => void
  onSetStatus: (project: Project, status: ProjectStatus) => void
  onCreate: (name: string, summary: string) => void
}

type Filter = 'current' | ProjectStatus | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
]

/** Active and paused work, plus anything without a status yet — what's live. */
function isCurrent(p: Project): boolean {
  return p.status !== 'done' && p.status !== 'archived'
}

/**
 * The library's projects: each folder in Projects/, with the status, summary
 * and tags its overview gives it, how much is in it, and whether an agent has
 * been at it since you last looked.
 */
export default function ProjectsView({
  projects,
  root,
  unseenByProject,
  onOpen,
  onOpenLog,
  onSetStatus,
  onCreate,
}: ProjectsViewProps) {
  const [filter, setFilter] = useState<Filter>('current')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')

  const shown = useMemo(
    () =>
      projects.filter((p) =>
        filter === 'all' ? true : filter === 'current' ? isCurrent(p) : p.status === filter,
      ),
    [projects, filter],
  )

  const counts = useMemo(() => {
    const out = new Map<Filter, number>([['current', 0], ['all', projects.length]])
    for (const p of projects) {
      if (isCurrent(p)) out.set('current', (out.get('current') ?? 0) + 1)
      if (p.status) out.set(p.status as Filter, (out.get(p.status as Filter) ?? 0) + 1)
    }
    return out
  }, [projects])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed, summary.trim())
    setCreating(false)
    setName('')
    setSummary('')
  }

  return (
    <div className="projects-view">
      <div className="task-nav">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`task-pill${filter === f.id ? ' active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {(counts.get(f.id) ?? 0) > 0 && <span className="task-count">{counts.get(f.id)}</span>}
          </button>
        ))}
        <button
          type="button"
          className="task-pill"
          onClick={() => setCreating((c) => !c)}
          aria-expanded={creating}
        >
          <Plus size={13} /> Project
        </button>
      </div>

      <div className="task-body">
        {creating && (
          <form
            className="project-create"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              aria-label="Project name"
              onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
            />
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What it's for, in a sentence"
              aria-label="Project summary"
              onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
            />
            <div className="project-create-actions">
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!name.trim()}>
                Create in {root}/
              </button>
            </div>
          </form>
        )}

        {projects.length === 0 && !creating ? (
          <div className="task-empty project-empty">
            <FolderKanban size={22} aria-hidden="true" />
            <p>No projects yet.</p>
            <p>
              A project is any folder inside <code>{root}/</code>. An agent connected over MCP starts one for
              each piece of work, keeps its files there and logs what it did — or start one yourself.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <div className="task-empty">Nothing here with that status.</div>
        ) : (
          <ul className="project-list">
            {shown.map((p) => {
              const unseen = unseenByProject.get(p.name) ?? 0
              return (
                <li key={p.path} className="project-card">
                  <div className="project-card-head">
                    <button type="button" className="project-card-name" onClick={() => onOpen(p)}>
                      {p.name}
                    </button>
                    {unseen > 0 && (
                      <span className="project-card-new" title={`${unseen} changes since you last looked`}>
                        {unseen} new
                      </span>
                    )}
                    <select
                      className={`project-status status-${p.status ?? 'none'}`}
                      value={p.status && (STATUSES as readonly string[]).includes(p.status) ? p.status : ''}
                      onChange={(e) => onSetStatus(p, e.target.value as ProjectStatus)}
                      aria-label={`Status of ${p.name}`}
                    >
                      {!p.status && <option value="">No status</option>}
                      {p.status && !(STATUSES as readonly string[]).includes(p.status) && (
                        <option value="">{p.status}</option>
                      )}
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s[0].toUpperCase() + s.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {p.summary && <p className="project-card-summary">{p.summary}</p>}
                  <div className="project-card-meta">
                    <span>
                      {p.notes} {p.notes === 1 ? 'note' : 'notes'} · {p.files} {p.files === 1 ? 'file' : 'files'}
                      {p.updatedAt ? ` · changed ${timeAgo(p.updatedAt)}` : ''}
                    </span>
                    {p.log && (
                      <button type="button" className="project-card-log" onClick={() => onOpenLog(p)}>
                        <ScrollText size={13} /> Log
                      </button>
                    )}
                  </div>
                  {p.tags.length > 0 && (
                    <div className="project-card-tags">
                      {p.tags.map((t) => (
                        <span key={t} className="note-property-chip">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
