import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Upload, X } from 'lucide-react'
import FolderPicker from './FolderPicker'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'
import type { TreeNode } from '../fs/library'
import type { ImportSkip } from '../lib/importMarkdown'

/**
 * Where an import has got to.
 *
 * Two phases, because they fail for different reasons and take different
 * amounts of time: reading is disk (or an archive being inflated) and can
 * surface a corrupt file; writing is the library, and can surface a revoked
 * permission or a full disk. Reporting them as one bar would put "it stalled"
 * and "it broke" behind the same picture.
 */
export interface ImportProgress {
  phase: 'reading' | 'writing'
  done: number
  total: number
  /** The file currently being read, when there is a meaningful one to name. */
  label?: string
}

export interface ImportOutcome {
  imported: number
  /** Landed under a different name because something was already there. */
  renamed: number
  skipped: ImportSkip[]
  /** Where they landed ("" = the library root); absent if nothing was written. */
  folder?: string
}

/**
 * Files that have been read and are waiting to be told where to go.
 *
 * The destination is asked *after* the read rather than before it, because
 * only then is there anything worth saying: how many files were found, and
 * whether the selection carried folders of its own.
 */
export interface ImportPending {
  notes: number
  skipped: number
  /** True when the files bring folder structure with them. */
  nested: boolean
}

interface ImportModalProps {
  open: boolean
  progress: ImportProgress | null
  /** Set while the destination is being chosen; nothing has been written yet. */
  pending: ImportPending | null
  outcome: ImportOutcome | null
  error: string | null
  /** The library's folders, to choose a destination from. */
  tree: TreeNode[]
  libraryName: string | null
  /** Go ahead and write the read files into this folder ("" = library root). */
  onImportInto: (targetFolder: string) => void
  onClose: () => void
}

/** Enough to see the shape of what went wrong without scrolling all afternoon. */
const MAX_LISTED_SKIPS = 40

export default function ImportModal({
  open,
  progress,
  pending,
  outcome,
  error,
  tree,
  libraryName,
  onImportInto,
  onClose,
}: ImportModalProps) {
  const anim = useEnterExit(open, OVERLAY_EXIT_MS)
  /** Where this import will land. Every import starts at the root: it is the
   *  one destination that is never a surprise. */
  const [target, setTarget] = useState('')

  useEffect(() => {
    if (pending) setTarget('')
  }, [pending])

  if (!anim.render) return null

  const running = progress !== null
  const close = () => {
    if (running) return // don't walk away from a half-written import
    onClose()
  }
  const start = () => {
    if (!pending) return
    onImportInto(target)
  }

  // Reading a drop has no total until the walk finishes, so the bar runs
  // indeterminate rather than claiming a percentage it doesn't know.
  const known = !!progress && progress.total > 0
  const percent =
    progress && known ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0

  const listed = outcome?.skipped.slice(0, MAX_LISTED_SKIPS) ?? []
  const overflow = (outcome?.skipped.length ?? 0) - listed.length

  return (
    <div
      className={`modal-overlay${anim.entered ? ' entered' : ''}`}
      onMouseDown={close}
    >
      <div
        className={`modal${anim.entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Import files"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">Import</span>
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            disabled={running}
            title="Close"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {pending && (
            <>
              <p className="modal-note">
                <strong>
                  {pending.notes} file{pending.notes === 1 ? '' : 's'} ready to
                  import
                </strong>
                {pending.skipped > 0 && (
                  <>
                    {' '}
                    ({pending.skipped} file{pending.skipped === 1 ? '' : 's'} will
                    be skipped)
                  </>
                )}
                . Choose where {pending.notes === 1 ? 'it goes' : 'they go'} —{' '}
                {pending.nested
                  ? 'the folders they came in are kept inside it, and nothing is overwritten.'
                  : 'nothing is ever overwritten.'}
              </p>
              <FolderPicker
                tree={tree}
                rootLabel={libraryName ?? 'Library root'}
                value={target}
                onChange={setTarget}
                onSubmit={start}
              />
            </>
          )}

          {running && (
            <div className="import-progress">
              <div className="import-progress-head">
                <span>
                  {progress.phase === 'reading'
                    ? 'Reading files…'
                    : 'Writing into your library…'}
                </span>
                {known && (
                  <span className="import-progress-count">
                    {progress.done} / {progress.total}
                  </span>
                )}
              </div>

              <div
                className={`progress-track${known ? '' : ' indeterminate'}`}
                role="progressbar"
                aria-label={
                  progress.phase === 'reading' ? 'Reading files' : 'Writing files'
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={known ? percent : undefined}
              >
                <div
                  className="progress-fill"
                  style={known ? { transform: `scaleX(${percent / 100})` } : undefined}
                />
              </div>

              {progress.label && (
                <div className="import-progress-file" title={progress.label}>
                  {progress.label}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="import-result import-result-error" role="alert">
              <AlertTriangle size={16} />
              <div>
                <strong>The import stopped.</strong>
                <div className="import-result-detail">{error}</div>
                <div className="import-result-detail">
                  Anything already written is in your library and was not undone.
                </div>
              </div>
            </div>
          )}

          {outcome && !error && (
            <>
              <div
                className={`import-result${
                  outcome.imported ? ' import-result-done' : ''
                }`}
                role="status"
              >
                {outcome.imported ? <Check size={16} /> : <AlertTriangle size={16} />}
                <div>
                  <strong>
                    {outcome.imported
                      ? `Imported ${outcome.imported} file${
                          outcome.imported === 1 ? '' : 's'
                        } into ${outcome.folder || libraryName || 'the library root'}`
                      : 'Nothing was imported'}
                  </strong>
                  {outcome.renamed > 0 && (
                    <div className="import-result-detail">
                      {outcome.renamed} landed under a new name — something of
                      that name was already there, and nothing is ever overwritten.
                    </div>
                  )}
                  {!outcome.imported && !outcome.skipped.length && (
                    <div className="import-result-detail">
                      There was nothing to import in that selection.
                    </div>
                  )}
                </div>
              </div>

              {outcome.skipped.length > 0 && (
                <div className="import-skips">
                  <div className="import-skips-title">
                    {outcome.skipped.length} file
                    {outcome.skipped.length === 1 ? '' : 's'} skipped
                  </div>
                  <ul className="import-skip-list">
                    {listed.map((skip) => (
                      <li key={`${skip.name}:${skip.reason}`} className="import-skip">
                        <span className="import-skip-name" title={skip.name}>
                          {skip.name}
                        </span>
                        <span className="import-skip-reason">{skip.reason}</span>
                      </li>
                    ))}
                  </ul>
                  {overflow > 0 && (
                    <div className="import-skips-more">
                      …and {overflow} more.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          {pending ? (
            <>
              <button type="button" className="btn-quiet" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={start}>
                <Upload size={15} />
                Import {pending.notes} file{pending.notes === 1 ? '' : 's'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={close}
              disabled={running}
            >
              {running ? 'Importing…' : 'Done'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
