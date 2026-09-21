import { useEffect, useRef, useState } from 'react'
import { Check, SlidersHorizontal, X } from 'lucide-react'
import { parseFrontmatter } from '../lib/frontmatter'

interface NotePropertiesProps {
  /** The note's front-matter block, fences included ('' for none). */
  frontmatter: string
  /** Replace the block ('' removes it). */
  onChange: (frontmatter: string) => void
}

/** The YAML between the fences, for editing. */
function innerOf(frontmatter: string): string {
  return frontmatter
    .replace(/^---[ \t]*\r?\n/, '')
    .replace(/\r?\n?---[ \t]*(?:\r?\n)?$/, '')
}

function display(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * A note's front matter, shown above the text as a strip of properties.
 *
 * Agents describe their notes this way — a project's status and summary, a
 * source, tags — and it has to stay out of the editor, which would render the
 * fence as a rule and a heading and write that back. So it is shown here, read
 * at a glance, and edited as the YAML it is when someone asks to.
 */
export default function NoteProperties({ frontmatter, onChange }: NotePropertiesProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // Caret at the end: adding a property is the usual reason to open this.
  useEffect(() => {
    const area = areaRef.current
    if (!editing || !area) return
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, [editing])

  const data = parseFrontmatter(frontmatter)
  const entries = Object.entries(data).filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length))

  const start = () => {
    setDraft(innerOf(frontmatter))
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    // A line of three dashes would end the block early and spill the rest of
    // it into the note, so it can't be typed in here.
    const yaml = draft
      .split(/\r?\n/)
      .filter((line) => !/^---\s*$/.test(line))
      .join('\n')
      .trim()
    const next = yaml ? `---\n${yaml}\n---\n` : ''
    if (next !== frontmatter) onChange(next)
  }

  if (editing) {
    return (
      <div className="note-properties editing">
        <textarea
          ref={areaRef}
          className="note-properties-source"
          value={draft}
          spellCheck={false}
          aria-label="Properties (YAML front matter)"
          rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setEditing(false)
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              commit()
            }
          }}
        />
        <div className="note-properties-actions">
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>
            <X size={14} /> Cancel
          </button>
          <button type="button" className="btn-primary" onClick={commit}>
            <Check size={14} /> Save properties
          </button>
        </div>
      </div>
    )
  }

  if (!entries.length && !frontmatter) return null

  return (
    <div className="note-properties" aria-label="Properties">
      <dl className="note-properties-list">
        {entries.map(([key, value]) => (
          <div key={key} className="note-property">
            <dt>{key}</dt>
            <dd>
              {Array.isArray(value)
                ? value.map((item) => (
                    <span key={item} className="note-property-chip">
                      {item}
                    </span>
                  ))
                : display(value)}
            </dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className="icon-btn note-properties-edit"
        onClick={start}
        title="Edit properties"
        aria-label="Edit properties"
      >
        <SlidersHorizontal size={14} />
      </button>
    </div>
  )
}
