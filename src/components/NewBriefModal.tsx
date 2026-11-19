import { useEffect, useRef, useState } from 'react'
import { Paperclip, Send, X } from 'lucide-react'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'
import { dragHasFiles, selectionFromDataTransfer, selectionFromFiles } from '../lib/importMarkdown'
import type { ImportItem } from '../fs/library'
import { OUTPUT_TYPES, REPEATS, TEMPLATES, type BriefRepeat, type NewBrief } from '../briefs/briefs'

interface NewBriefModalProps {
  open: boolean
  /** Existing project folder names. */
  projects: string[]
  /** The project to start on, if the brief was started from one. */
  initialProject?: string
  /** Agent names to suggest. */
  agentNames: string[]
  onClose: () => void
  /** `newProject` is set when the brief needs a project made for it first. */
  onCreate: (brief: NewBrief, newProject: { name: string; summary: string } | null) => Promise<boolean>
}

const NEW_PROJECT = '\u0000new'

function itemSize(item: ImportItem): number {
  return item.blob?.size ?? new Blob([item.content ?? '']).size
}

/**
 * Writing a brief: which project it belongs to, what to do, the files to work
 * from, and what should come back. Everything here becomes plain files —
 * Brief.md's text and front matter, and the attachments in Context/ — so the
 * same brief can be written by hand in any editor.
 */
export default function NewBriefModal({ open, projects, initialProject, agentNames, onClose, onCreate }: NewBriefModalProps) {
  const anim = useEnterExit(open, OVERLAY_EXIT_MS)
  const [project, setProject] = useState('')
  const [newName, setNewName] = useState('')
  const [newSummary, setNewSummary] = useState('')
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState('blank')
  const [instructions, setInstructions] = useState('')
  const [files, setFiles] = useState<ImportItem[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [agent, setAgent] = useState('')
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(3)
  const [due, setDue] = useState('')
  const [start, setStart] = useState('')
  const [repeat, setRepeat] = useState<BriefRepeat | ''>('')
  const [outputs, setOutputs] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Each opening starts clean, on the project it was opened from.
  useEffect(() => {
    if (!open) return
    setProject(initialProject && projects.includes(initialProject) ? initialProject : projects[0] ?? NEW_PROJECT)
    setNewName('')
    setNewSummary('')
    setTitle('')
    setTemplate('blank')
    setInstructions('')
    setFiles([])
    setSkipped([])
    setAgent(agentNames.length === 1 ? agentNames[0] : '')
    setPriority(3)
    setDue('')
    setStart('')
    setRepeat('')
    setOutputs([])
    setError(null)
    setBusy(false)
    // Only on opening: the lists can change underneath an open form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!anim.render) return null

  const chooseTemplate = (id: string) => {
    const next = TEMPLATES.find((t) => t.id === id)
    if (!next) return
    const current = TEMPLATES.find((t) => t.id === template)
    // Replace the text only if it is still the old template's (or empty), so
    // switching never throws away what someone wrote.
    if (!instructions.trim() || instructions === current?.instructions) setInstructions(next.instructions)
    if (!outputs.length || outputs.join() === current?.outputs.join()) setOutputs(next.outputs)
    setTemplate(id)
  }

  const addSelection = (items: ImportItem[], skips: { name: string; reason: string }[]) => {
    setFiles((prev) => [...prev, ...items.filter((i) => !prev.some((p) => p.path === i.path))])
    if (skips.length) setSkipped((prev) => [...prev, ...skips.map((s) => `${s.name} (${s.reason})`)])
  }

  const isNew = project === NEW_PROJECT
  const ready = !!title.trim() && (!isNew || !!newName.trim()) && !busy

  const submit = async (queue: boolean) => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const ok = await onCreate(
      {
        project: isNew ? newName.trim() : project,
        title,
        instructions,
        agent,
        priority,
        due,
        start,
        repeat,
        outputs,
        files,
        queue,
      },
      isNew ? { name: newName.trim(), summary: newSummary.trim() } : null,
    )
    setBusy(false)
    if (ok) onClose()
    else setError('The brief could not be saved. Nothing was queued.')
  }

  return (
    <div className={`modal-overlay${anim.entered ? ' entered' : ''}`} onMouseDown={onClose}>
      <div
        className={`modal brief-modal${anim.entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="New brief"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">New brief</span>
          <button type="button" className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form
          className="modal-body brief-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit(true)
          }}
        >
          <div className="brief-form-row">
            <label className="brief-field">
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value={NEW_PROJECT}>New project…</option>
              </select>
            </label>
            <label className="brief-field">
              <span>Starting point</span>
              <select value={template} onChange={(e) => chooseTemplate(e.target.value)}>
                {TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {isNew && (
            <div className="brief-form-row">
              <label className="brief-field">
                <span>Project name</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme research" />
              </label>
              <label className="brief-field">
                <span>What it's for</span>
                <input value={newSummary} onChange={(e) => setNewSummary(e.target.value)} placeholder="In a sentence" />
              </label>
            </div>
          )}

          <label className="brief-field">
            <span>Title</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Compare three ELT vendors"
              maxLength={120}
            />
          </label>

          <label className="brief-field">
            <span>Instructions</span>
            <textarea
              rows={9}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="What to do, what to work from, and what done looks like. Markdown and [[wikilinks]] work."
            />
          </label>

          <div
            className={`brief-drop${dragging ? ' dragging' : ''}`}
            onDragOver={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return
              e.preventDefault()
              setDragging(false)
              void selectionFromDataTransfer(e.dataTransfer).then((s) => addSelection(s.items, s.skipped))
            }}
          >
            <div className="brief-drop-head">
              <span>Context files</span>
              <button type="button" className="brief-link" onClick={() => fileInput.current?.click()}>
                <Paperclip size={13} /> Choose files
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = e.target.files
                  if (list?.length) void selectionFromFiles(list).then((s) => addSelection(s.items, s.skipped))
                  e.target.value = ''
                }}
              />
            </div>
            {files.length === 0 ? (
              <p className="brief-empty">Drop files or folders here. A ZIP is unpacked. They go in the brief's Context folder.</p>
            ) : (
              <ul className="brief-attachments">
                {files.map((f) => (
                  <li key={f.path}>
                    <span className="brief-file-name">{f.path}</span>
                    <span className="brief-file-size">{Math.max(1, Math.round(itemSize(f) / 1024))} KB</span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${f.path}`}
                      onClick={() => setFiles((prev) => prev.filter((p) => p.path !== f.path))}
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {skipped.length > 0 && <p className="brief-empty">Left out: {skipped.join(', ')}</p>}
          </div>

          <fieldset className="brief-outputs">
            <legend>What should come back</legend>
            {OUTPUT_TYPES.map((type) => (
              <label key={type} className={`brief-chip${outputs.includes(type) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={outputs.includes(type)}
                  onChange={(e) =>
                    setOutputs((prev) => (e.target.checked ? [...prev, type] : prev.filter((o) => o !== type)))
                  }
                />
                .{type}
              </label>
            ))}
          </fieldset>

          <div className="brief-form-row brief-form-row-4">
            <label className="brief-field">
              <span>Agent</span>
              <input
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="Any agent"
                list="brief-agent-names"
              />
              <datalist id="brief-agent-names">
                {agentNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
            <label className="brief-field">
              <span>Priority</span>
              <select value={priority} onChange={(e) => setPriority(Number(e.target.value) as 1 | 2 | 3 | 4)}>
                <option value={1}>P1 urgent</option>
                <option value={2}>P2 high</option>
                <option value={3}>P3 normal</option>
                <option value={4}>P4 low</option>
              </select>
            </label>
            <label className="brief-field">
              <span>Due</span>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="brief-field">
              <span>Repeat</span>
              <select value={repeat} onChange={(e) => setRepeat(e.target.value as BriefRepeat | '')}>
                <option value="">Once</option>
                {REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {r[0].toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="brief-field brief-field-inline">
            <span>Not before</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <span className="brief-hint">Leave empty to start as soon as an agent checks in.</span>
          </label>

          {error && <p className="brief-error" role="alert">{error}</p>}
        </form>

        <div className="modal-footer brief-footer">
          <button type="button" className="btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" disabled={!ready} onClick={() => void submit(false)}>
            Save as draft
          </button>
          <button type="button" className="btn-primary" disabled={!ready} onClick={() => void submit(true)}>
            <Send size={15} /> Queue
          </button>
        </div>
      </div>
    </div>
  )
}
