import { Bot, FileText, FolderKanban, FolderTree, ListTodo, type LucideIcon } from 'lucide-react'

/** The five places a phone can be. `note` is the editor with nothing over it. */
export type MobileSection = 'note' | 'files' | 'projects' | 'agents' | 'tasks'

interface MobileNavProps {
  current: MobileSection | null
  onGo: (section: MobileSection) => void
  /** Briefs waiting on the person — the same count the Agents tab carries. */
  agentsCount: number
  /** Open tasks due today or overdue. */
  tasksDue: number
}

const ITEMS: { id: MobileSection; label: string; Icon: LucideIcon }[] = [
  { id: 'note', label: 'Note', Icon: FileText },
  { id: 'files', label: 'Files', Icon: FolderTree },
  { id: 'projects', label: 'Projects', Icon: FolderKanban },
  { id: 'agents', label: 'Agents', Icon: Bot },
  { id: 'tasks', label: 'Tasks', Icon: ListTodo },
]

/**
 * The phone's tab bar.
 *
 * On a desk the sections are docked panels reached from icons in the sidebar's
 * header — fine with a pointer, invisible under a thumb. Here every section is
 * one labelled tap from the bottom edge, where the thumb already is, and the
 * bar says which one you're in with the same accent line the editor tabs use.
 *
 * Only rendered on a phone; the CSS hides it everywhere else as a backstop.
 */
export default function MobileNav({ current, onGo, agentsCount, tasksDue }: MobileNavProps) {
  return (
    <nav className="mobile-nav" aria-label="Sections">
      {ITEMS.map(({ id, label, Icon }) => {
        const count = id === 'agents' ? agentsCount : id === 'tasks' ? tasksDue : 0
        const here = current === id
        const said = id === 'agents' ? 'waiting on you' : 'due'
        return (
          <button
            key={id}
            type="button"
            className={`mobile-nav-item${here ? ' active' : ''}`}
            aria-current={here ? 'page' : undefined}
            // Named label-first ("Tasks, 4 due"). The badge sits inside the
            // icon, before the label in the DOM, so left to itself the name
            // would come out as "4 dueTasks".
            aria-label={count > 0 ? `${label}, ${count} ${said}` : label}
            onClick={() => onGo(id)}
          >
            <span className="mobile-nav-icon">
              <Icon size={22} aria-hidden="true" />
              {count > 0 && (
                <span className="mobile-nav-count" aria-hidden="true">
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span className="mobile-nav-label" aria-hidden="true">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
