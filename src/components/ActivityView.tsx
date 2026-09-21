import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  Bookmark,
  FileText,
  Folder,
  FolderKanban,
  ListTodo,
  type LucideIcon,
} from 'lucide-react'
import type { ActivityEvent } from '../activity/activity'
import { iconFor } from '../lib/fileTypes'
import { dayHeading, toDateStr } from '../tasks/dates'

interface ActivityViewProps {
  events: ActivityEvent[]
  /** False for a library no agent can reach — a local folder or in-browser one. */
  supported: boolean
  /** When the person last caught up; newer events are marked. */
  seenAt: number
  onMarkSeen: () => void
  /** What is at a path now, so a deleted file isn't offered as a link. */
  kindAt: (path: string) => 'file' | 'folder' | null
  onOpen: (path: string) => void
  onOpenProject: (project: string) => void
}

const MAX_SHOWN = 300

function iconForEvent(event: ActivityEvent): LucideIcon {
  switch (event.kind) {
    case 'folder':
      return Folder
    case 'project':
      return FolderKanban
    case 'task':
      return ListTodo
    case 'bookmark':
      return Bookmark
    case 'note':
      return FileText
    case 'file': {
      const path = event.to ?? event.path ?? ''
      return iconFor({ kind: 'asset', name: path.slice(path.lastIndexOf('/') + 1) })
    }
    default:
      return Activity
  }
}

function nameOf(path: string): string {
  const leaf = path.slice(path.lastIndexOf('/') + 1)
  return leaf.replace(/\.md$/i, '')
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * What agents have done to the library, newest first, grouped by day: every
 * note and file they saved, changed, moved or deleted, under the name of the
 * token they used, with whatever they said about it.
 */
export default function ActivityView({
  events,
  supported,
  seenAt,
  onMarkSeen,
  kindAt,
  onOpen,
  onOpenProject,
}: ActivityViewProps) {
  const [project, setProject] = useState('')
  const [actor, setActor] = useState('')

  // Opening the feed is catching up: the badge clears straight away, but what
  // was new when it opened stays marked for as long as it is being read.
  const newSince = useRef(seenAt)
  useEffect(() => {
    onMarkSeen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const projects = useMemo(
    () => [...new Set(events.map((e) => e.project).filter(Boolean) as string[])].sort(),
    [events],
  )
  const actors = useMemo(() => [...new Set(events.map((e) => e.actor))].sort(), [events])

  const groups = useMemo(() => {
    const shown = events
      .filter((e) => (!project || e.project === project) && (!actor || e.actor === actor))
      .slice(0, MAX_SHOWN)
    const out: { day: string; events: ActivityEvent[] }[] = []
    for (const event of shown) {
      const day = toDateStr(new Date(event.at))
      const last = out[out.length - 1]
      if (last && last.day === day) last.events.push(event)
      else out.push({ day, events: [event] })
    }
    return out
  }, [events, project, actor])

  if (!supported) {
    return (
      <div className="task-body">
        <div className="task-empty project-empty">
          <Activity size={22} aria-hidden="true" />
          <p>No activity log for this library.</p>
          <p>
            Agents reach Deckle through its API and MCP server, which need the server library. What they do there
            is recorded here. A local folder an agent writes into directly still shows its files, but nothing
            records who made them.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="activity-view">
      {(projects.length > 1 || actors.length > 1) && (
        <div className="activity-filters">
          {projects.length > 1 && (
            <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project">
              <option value="">Every project</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {actors.length > 1 && (
            <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Filter by agent">
              <option value="">Every agent</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="task-body">
        {events.length === 0 ? (
          <div className="task-empty project-empty">
            <Activity size={22} aria-hidden="true" />
            <p>Nothing recorded yet.</p>
            <p>
              When an agent saves, changes or deletes something through the API or MCP, it is listed here under
              the name of the token it used.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.day} className="activity-day">
              <h3 className="task-section">{dayHeading(group.day)}</h3>
              <ul className="activity-list">
                {group.events.map((event, i) => {
                  const Icon = iconForEvent(event)
                  const target = event.to ?? event.path
                  const now = target ? kindAt(target) : null
                  const fresh = event.at > newSince.current
                  // A project opens on its overview; a file opens in a tab; a
                  // folder is named but has nowhere to open; anything no
                  // longer there is struck through.
                  let targetEl: ReactNode = null
                  if (target && event.kind === 'project' && now === 'folder' && event.project) {
                    targetEl = (
                      <button type="button" className="activity-target" onClick={() => onOpenProject(event.project!)}>
                        {nameOf(target)}
                      </button>
                    )
                  } else if (target && now === 'file') {
                    targetEl = (
                      <button type="button" className="activity-target" onClick={() => onOpen(target)}>
                        {nameOf(target)}
                      </button>
                    )
                  } else if (target && now === 'folder') {
                    targetEl = <span className="activity-target plain">{nameOf(target)}</span>
                  } else if (target) {
                    targetEl = (
                      <span className="activity-target gone" title="No longer in the library">
                        {nameOf(target)}
                      </span>
                    )
                  }
                  return (
                    <li key={`${event.at}-${i}`} className={`activity-item${fresh ? ' fresh' : ''}`}>
                      <span className="activity-icon" aria-hidden="true">
                        <Icon size={15} />
                      </span>
                      <div className="activity-body">
                        <p className="activity-line">
                          <span className="activity-actor">{event.actor}</span> {event.action}
                          {event.count && event.count > 1 ? ` ${event.count} items` : ''}
                          {event.kind === 'folder' || event.kind === 'project' ? ` ${event.kind}` : ''}{' '}
                          {targetEl}
                          {event.to && event.path && (
                            <span className="activity-from"> from {event.path}</span>
                          )}
                        </p>
                        {event.message && <p className="activity-message">{event.message}</p>}
                        <p className="activity-meta">
                          {clock(event.at)}
                          {event.project && (
                            <>
                              {' · '}
                              <button
                                type="button"
                                className="activity-project"
                                onClick={() => onOpenProject(event.project!)}
                              >
                                {event.project}
                              </button>
                            </>
                          )}
                          {event.via === 'mcp' ? ' · via MCP' : ''}
                        </p>
                      </div>
                      {fresh && <span className="activity-fresh" aria-label="New since you last looked" />}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
        {events.length > MAX_SHOWN && (
          <p className="file-preview-note">
            Showing the latest {MAX_SHOWN}. The full log is <code>.deckle/activity.jsonl</code> in the library.
          </p>
        )}
      </div>
    </div>
  )
}
