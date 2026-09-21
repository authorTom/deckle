import { useState } from 'react'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'
import { Archive, Check, Download, X } from 'lucide-react'
import {
  exportLibraryZip,
  formatBytes,
  type ExportProgress,
} from '../lib/exportLibrary'

interface ExportModalProps {
  open: boolean
  dir: FileSystemDirectoryHandle | null
  libraryName: string | null
  noteCount: number
  /** Files that aren't notes: PDFs, spreadsheets, images… */
  fileCount: number
  onClose: () => void
}

export default function ExportModal({
  open,
  dir,
  libraryName,
  noteCount,
  fileCount,
  onClose,
}: ExportModalProps) {
  const [includeHidden, setIncludeHidden] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Stays mounted for the length of its exit, so the surface leaves the
  // way it arrived instead of blinking out.
  const anim = useEnterExit(open, OVERLAY_EXIT_MS)
  if (!anim.render) return null

  const running = progress !== null && done === null && error === null

  const close = () => {
    if (running) return // don't leave a half-built archive behind
    setProgress(null)
    setDone(null)
    setError(null)
    onClose()
  }

  const run = async () => {
    if (!dir) return
    setDone(null)
    setError(null)
    setProgress({ phase: 'reading', done: 0, total: 0 })
    try {
      const result = await exportLibraryZip(
        dir,
        libraryName ?? 'library',
        { includeHidden },
        setProgress,
      )
      setDone(
        `${result.fileName} — ${result.fileCount} file${
          result.fileCount === 1 ? '' : 's'
        }, ${formatBytes(result.bytes)}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export failed.')
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className={`modal-overlay${anim.entered ? ' entered' : ''}`} onMouseDown={close}>
      <div
        className={`modal${anim.entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Export knowledge base"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">Export knowledge base</span>
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
          <p className="modal-note">
            Downloads everything in <strong>{libraryName ?? 'this library'}</strong> as a
            single ZIP — {noteCount} note{noteCount === 1 ? '' : 's'}
            {fileCount > 0 && (
              <>
                {' '}and {fileCount} other file{fileCount === 1 ? '' : 's'}
              </>
            )}{' '}
            with their folder structure intact, plus your tasks, bookmarks and the
            activity log. Unzip it anywhere; it's just files.
          </p>

          <label className="export-option">
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(e) => setIncludeHidden(e.target.checked)}
              disabled={running}
            />
            <span>
              Include the recycle bin and version history
              <span className="export-option-hint">
                Makes it a full backup rather than a clean copy. Much larger.
              </span>
            </span>
          </label>

          {running && (
            <div className="export-status" role="status">
              {progress.phase === 'reading'
                ? `Reading files… (${progress.done})`
                : `Compressing… (${progress.done} of ${progress.total})`}
            </div>
          )}

          {done && (
            <div className="export-status export-status-done" role="status">
              <Check size={15} />
              Saved {done}
            </div>
          )}

          {error && (
            <div className="export-status export-status-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={close} disabled={running}>
            {done ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void run()}
            disabled={running || !dir}
          >
            {running ? <Archive size={15} /> : <Download size={15} />}
            {running ? 'Exporting…' : 'Export ZIP'}
          </button>
        </div>
      </div>
    </div>
  )
}
