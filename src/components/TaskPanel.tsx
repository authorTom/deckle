import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  Bookmark,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Inbox,
  ListTodo,
  Pencil,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import BookmarkList from './BookmarkList'

/** The things the left panel can be showing. */
export type PanelTab = 'projects' | 'activity' | 'tasks' | 'bookmarks'
import MiniCalendar from './MiniCalendar'
import TaskItem from './TaskItem'
import { timeAgo } from '../lib/format'
import { dayHeading, todayStr } from '../tasks/dates'
import type { Task } from '../tasks/types'
import type { TasksApi } from '../tasks/useTasks'
import type { BookmarksApi } from '../bookmarks/useBookmarks'

interface TaskPanelProps {
  open: boolean
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  onClose: () => void
  tasks: TasksApi
  bookmarks: BookmarksApi
  onOpenNote: (noteId: string) => void
  /** The Projects tab's content, built by the app, which owns the projects. */
  projects: ReactNode
  /** The Activity tab's content, likewise. */
  activity: ReactNode
  /** Agent changes since the person last looked, counted on the Activity tab. */
  activityUnseen: number
}

const TABS: { id: PanelTab; label: string; Icon: typeof Activity }[] = [
  { id: 'projects', label: 'Projects', Icon: FolderKanban },
  { id: 'activity', label: 'Activity', Icon: Activity },
  { id: 'tasks', label: 'Tasks', Icon: ListTodo },
  { id: 'bookmarks', label: 'Bookmarks', Icon: Bookmark },
]

/** Priority first, then due date (undated last), then creation order. */
function sortTasks(list: Task[]): Task[] {
  return [...list].sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
      a.createdAt - b.createdAt,
  )
}

export default function TaskPanel({
  open,
  tab,
  onTabChange,
  onClose,
  tasks,
  bookmarks,
  onOpenNote,
  projects,
  activity,
  activityUnseen,
}: TaskPanelProps) {
  const [view, setView] = useState('inbox')
  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [calOpen, setCalOpen] = useState(true)
  const [quickTitle, setQuickTitle] = useState('')

  const { store } = tasks
  const today = todayStr()

  const openTasks = useMemo(
    () => store.tasks.filter((t) => !t.completedAt && !t.deletedAt),
    [store.tasks],
  )
  const markedDates = useMemo(
    () => new Set(openTasks.filter((t) => t.due).map((t) => t.due!)),
    [openTasks],
  )

  if (!open) return null

  const project = view.startsWith('project:')
    ? store.projects.find((p) => p.id === view.slice('project:'.length))
    : undefined
  // Fall back to the inbox if the viewed project was deleted.
  const activeView = view.startsWith('project:') && !project ? 'inbox' : view

  // Counts what the Inbox now shows: everything outstanding, filed or not.
  const inboxCount = openTasks.length
  const todayCount = openTasks.filter((t) => t.due && t.due <= today).length

  const renderList = (list: Task[], showProject = true): ReactNode =>
    list.map((t) => (
      <TaskItem
        key={t.id}
        task={t}
        projects={store.projects}
        showProject={showProject}
        onToggle={() => tasks.toggleComplete(t.id)}
        onUpdate={(patch) => tasks.updateTask(t.id, patch)}
        onDelete={() => tasks.deleteTask(t.id)}
        onOpenNote={onOpenNote}
        onAddComment={(body) => tasks.addComment(t.id, body)}
        onDeleteComment={(commentId) => tasks.deleteComment(t.id, commentId)}
      />
    ))

  const quickAdd = () => {
    const title = quickTitle.trim()
    if (!title) return
    tasks.addTask({
      title,
      due:
        activeView === 'today'
          ? today
          : activeView === 'upcoming'
            ? selectedDate
            : null,
      projectId: project?.id ?? null,
    })
    setQuickTitle('')
  }

  const quickAddPlaceholder =
    activeView === 'today'
      ? 'Add a task for today…'
      : activeView === 'upcoming'
        ? `Add a task for ${dayHeading(selectedDate)}…`
        : project
          ? `Add a task to ${project.name}…`
          : 'Add a task to the Inbox…'

  let content: ReactNode
  if (activeView === 'inbox') {
    // Everything still to do, wherever it was filed. A task assigned to a
    // project used to disappear from the Inbox entirely, which meant the one
    // view called "everything outstanding" was the only view that couldn't
    // show you everything outstanding. Filing now groups a task rather than
    // hiding it, and the per-project views are still there for working inside
    // one of them.
    const unfiled = sortTasks(openTasks.filter((t) => !t.projectId))
    const grouped = store.projects
      .map((p) => ({
        project: p,
        list: sortTasks(openTasks.filter((t) => t.projectId === p.id)),
      }))
      .filter((g) => g.list.length > 0)

    content = openTasks.length ? (
      <>
        {unfiled.length > 0 && (
          <>
            <div className="task-section">Unfiled</div>
            {renderList(unfiled, false)}
          </>
        )}
        {grouped.map(({ project: p, list }) => (
          <div key={p.id}>
            <div className="task-section">
              <span className="task-project-dot" style={{ background: p.color }} />
              {p.name}
            </div>
            {renderList(list, false)}
          </div>
        ))}
      </>
    ) : (
      <div className="task-empty">
        Inbox zero 🎉 — capture tasks here with Ctrl/Cmd+Shift+A.
      </div>
    )
  } else if (activeView === 'today') {
    const overdue = sortTasks(openTasks.filter((t) => t.due && t.due < today))
    const dueToday = sortTasks(openTasks.filter((t) => t.due === today))
    content = (
      <>
        {overdue.length > 0 && (
          <>
            <div className="task-section overdue">Overdue</div>
            {renderList(overdue)}
          </>
        )}
        {dueToday.length > 0 && (
          <>
            <div className="task-section">Today</div>
            {renderList(dueToday)}
          </>
        )}
        {overdue.length === 0 && dueToday.length === 0 && (
          <div className="task-empty">Nothing due today. That is allowed.</div>
        )}
      </>
    )
  } else if (activeView === 'upcoming') {
    const overdue =
      selectedDate === today
        ? sortTasks(openTasks.filter((t) => t.due && t.due < today))
        : []
    const dated = sortTasks(
      openTasks.filter((t) => t.due && t.due >= selectedDate),
    )
    const byDate = new Map<string, Task[]>()
    for (const t of dated) {
      const list = byDate.get(t.due!) ?? []
      list.push(t)
      byDate.set(t.due!, list)
    }
    const dates = [...byDate.keys()].sort()
    content = (
      <>
        <button
          type="button"
          className="task-cal-toggle"
          onClick={() => setCalOpen((o) => !o)}
          aria-expanded={calOpen}
        >
          {calOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Calendar
        </button>
        {calOpen && (
          <MiniCalendar
            selected={selectedDate}
            onSelect={setSelectedDate}
            markedDates={markedDates}
          />
        )}
        {overdue.length > 0 && (
          <>
            <div className="task-section overdue">Overdue</div>
            {renderList(overdue)}
          </>
        )}
        {dates.map((date) => (
          <div key={date}>
            <div className="task-section">{dayHeading(date)}</div>
            {renderList(byDate.get(date)!)}
          </div>
        ))}
        {overdue.length === 0 && dates.length === 0 && (
          <div className="task-empty">
            No upcoming tasks from {dayHeading(selectedDate)}.
          </div>
        )}
      </>
    )
  } else if (activeView === 'completed') {
    const done = store.tasks
      .filter((t) => t.completedAt && !t.deletedAt)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 100)
    content = done.length ? (
      <>
        {renderList(done)}
        <button
          type="button"
          className="btn-secondary task-clear"
          onClick={() => {
            if (window.confirm('Move all completed tasks to the bin?')) {
              tasks.clearCompleted()
            }
          }}
        >
          <Trash2 size={14} /> Clear completed
        </button>
      </>
    ) : (
      <div className="task-empty">
        Nothing finished yet. Ticked tasks collect here rather than vanishing.
      </div>
    )
  } else if (activeView === 'bin') {
    const binned = store.tasks
      .filter((t) => t.deletedAt)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
    content = binned.length ? (
      <>
        {binned.map((t) => (
          <div key={t.id} className="task-row">
            <div className="task-main-static">
              <span className="task-title">{t.title}</span>
              <span className="task-meta">deleted {timeAgo(t.deletedAt!)}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              title="Restore"
              aria-label="Restore task"
              onClick={() => tasks.restoreTask(t.id)}
            >
              <RotateCcw size={15} />
            </button>
            <button
              type="button"
              className="icon-btn trash-danger"
              title="Delete permanently"
              aria-label="Delete task permanently"
              onClick={() => {
                if (
                  window.confirm(
                    `Permanently delete "${t.title}"? This cannot be undone.`,
                  )
                ) {
                  tasks.deleteForever(t.id)
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary task-clear"
          onClick={() => {
            if (
              window.confirm(
                'Permanently delete everything in the bin? This cannot be undone.',
              )
            ) {
              tasks.emptyTaskBin()
            }
          }}
        >
          <Trash2 size={14} /> Empty bin
        </button>
        <div className="task-empty">
          Items in the bin are removed automatically after 30 days.
        </div>
      </>
    ) : (
      <div className="task-empty">
            Empty. Binned tasks wait here for 30 days, then go for good.
          </div>
    )
  } else if (project) {
    const list = sortTasks(openTasks.filter((t) => t.projectId === project.id))
    content = (
      <>
        <div className="task-projhead">
          <span
            className="task-project-dot"
            style={{ background: project.color }}
          />
          <strong>{project.name}</strong>
          <button
            type="button"
            className="icon-btn"
            title="Rename project"
            aria-label="Rename project"
            onClick={() => {
              const name = window.prompt('Rename project', project.name)
              if (name) tasks.renameProject(project.id, name)
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="icon-btn trash-danger"
            title="Delete project"
            aria-label="Delete project"
            onClick={() => {
              if (
                window.confirm(
                  `Delete "${project.name}"? Its tasks move to the Inbox.`,
                )
              ) {
                tasks.deleteProject(project.id)
                setView('inbox')
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {list.length ? (
          renderList(list, false)
        ) : (
          <div className="task-empty">Nothing filed under this one yet.</div>
        )}
      </>
    )
  }

  return (
    <aside className="task-panel">
      <div className="task-header">
        {/* Four tabs don't fit a narrow panel with every label showing, so an
            inactive tab keeps its icon and gives its name as a tooltip — until
            the panel is widened enough to hold them all (see global.css). */}
        <div className="panel-tabs" role="tablist" aria-label="Panel">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`panel-tab${tab === id ? ' active' : ''}`}
              onClick={() => onTabChange(id)}
              title={label}
              aria-label={
                id === 'activity' && activityUnseen
                  ? `${label}, ${activityUnseen} new`
                  : label
              }
            >
              <Icon size={15} />
              <span className="panel-tab-label">{label}</span>
              {id === 'activity' && activityUnseen > 0 && (
                <span className="panel-tab-count" aria-hidden="true">
                  {activityUnseen > 99 ? '99+' : activityUnseen}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          title="Close"
          aria-label="Close panel"
        >
          <X size={18} />
        </button>
      </div>

      {tab === 'projects' && projects}

      {tab === 'activity' && activity}

      {tab === 'bookmarks' && (
        <BookmarkList bookmarks={bookmarks} onOpenNote={onOpenNote} />
      )}

      {tab === 'tasks' && (
        <>
      <div className="task-nav">
        <button
          type="button"
          className={`task-pill${activeView === 'inbox' ? ' active' : ''}`}
          onClick={() => setView('inbox')}
        >
          <Inbox size={13} /> Inbox
          {inboxCount > 0 && <span className="task-count">{inboxCount}</span>}
        </button>
        <button
          type="button"
          className={`task-pill${activeView === 'today' ? ' active' : ''}`}
          onClick={() => setView('today')}
        >
          <Sun size={13} /> Today
          {todayCount > 0 && <span className="task-count">{todayCount}</span>}
        </button>
        <button
          type="button"
          className={`task-pill${activeView === 'upcoming' ? ' active' : ''}`}
          onClick={() => setView('upcoming')}
        >
          <CalendarDays size={13} /> Upcoming
        </button>
        <button
          type="button"
          className={`task-pill${activeView === 'completed' ? ' active' : ''}`}
          onClick={() => setView('completed')}
        >
          <CheckCircle2 size={13} /> Done
        </button>
        <button
          type="button"
          className={`task-pill${activeView === 'bin' ? ' active' : ''}`}
          onClick={() => setView('bin')}
        >
          <Trash2 size={13} /> Bin
        </button>
      </div>

      <div className="task-projects">
        {store.projects.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`task-pill${view === `project:${p.id}` ? ' active' : ''}`}
            onClick={() => setView(`project:${p.id}`)}
          >
            <span className="task-project-dot" style={{ background: p.color }} />
            {p.name}
            {(() => {
              const n = openTasks.filter((t) => t.projectId === p.id).length
              return n > 0 ? <span className="task-count">{n}</span> : null
            })()}
          </button>
        ))}
        <button
          type="button"
          className="task-pill"
          title="New project"
          onClick={() => {
            const name = window.prompt('Project name')
            if (name?.trim()) setView(`project:${tasks.addProject(name)}`)
          }}
        >
          <Plus size={13} /> Project
        </button>
      </div>

      <div className="task-body">
        {activeView !== 'completed' && activeView !== 'bin' && (
          <div className="task-quickadd">
            <Plus size={15} />
            <input
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  quickAdd()
                }
              }}
              placeholder={quickAddPlaceholder}
              aria-label="Add a task"
            />
          </div>
        )}
        {content}
      </div>
        </>
      )}
    </aside>
  )
}
