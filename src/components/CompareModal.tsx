import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'
import { diffLines, diffStats, foldDiff } from '../lib/diff'

export interface CompareRequest {
  /** What the dialog is about: "Plan — hermes edited it 2 hours ago". */
  title: string
  /** Labels for the two sides. */
  beforeLabel: string
  afterLabel: string
  loadBefore: () => Promise<string>
  loadAfter: () => Promise<string>
  /** Offered as a button, when there is a note to go to. */
  onOpen?: () => void
}

interface CompareModalProps {
  request: CompareRequest | null
  onClose: () => void
}

type Loaded = { before: string; after: string } | { error: string } | null

/**
 * A note before an agent changed it, against the note now: removed lines,
 * added lines, and a few unchanged ones either side, with long unchanged runs
 * folded away.
 */
export default function CompareModal({ request, onClose }: CompareModalProps) {
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [shown, setShown] = useState<CompareRequest | null>(request)

  // Keep the last request on screen while the dialog animates out.
  useEffect(() => {
    if (request) setShown(request)
  }, [request])

  useEffect(() => {
    if (!request) return
    let cancelled = false
    setLoaded(null)
    Promise.all([request.loadBefore(), request.loadAfter()]).then(
      ([before, after]) => !cancelled && setLoaded({ before, after }),
      () =>
        !cancelled &&
        setLoaded({
          error: 'The earlier version is no longer in the history. Deckle keeps the last 20 versions of each note.',
        }),
    )
    return () => {
      cancelled = true
    }
  }, [request])

  const lines = useMemo(
    () => (loaded && 'before' in loaded ? diffLines(loaded.before, loaded.after) : []),
    [loaded],
  )
  const hunks = useMemo(() => foldDiff(lines), [lines])
  const stats = useMemo(() => diffStats(lines), [lines])

  const anim = useEnterExit(!!request, OVERLAY_EXIT_MS)
  if (!anim.render || !shown) return null

  return (
    <div className={`modal-overlay${anim.entered ? ' entered' : ''}`} onMouseDown={onClose}>
      <div
        className={`modal compare-modal${anim.entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Changes — ${shown.title}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">Changes — {shown.title}</span>
          <button type="button" className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="compare-legend">
          <span className="compare-key removed">{shown.beforeLabel}</span>
          <span className="compare-key added">{shown.afterLabel}</span>
          {loaded && 'before' in loaded && (
            <span className="compare-stats" aria-label={`${stats.added} lines added, ${stats.removed} removed`}>
              +{stats.added} −{stats.removed}
            </span>
          )}
          {shown.onOpen && (
            <button
              type="button"
              className="btn-secondary compare-open"
              onClick={() => {
                shown.onOpen?.()
                onClose()
              }}
            >
              Open note
            </button>
          )}
        </div>

        <div className="modal-body compare-body">
          {!loaded ? (
            <div className="modal-empty">Loading…</div>
          ) : 'error' in loaded ? (
            <div className="modal-empty">{loaded.error}</div>
          ) : stats.added + stats.removed === 0 ? (
            <div className="modal-empty">No difference: the note reads the same as it did before.</div>
          ) : (
            <pre className="compare-diff">
              {hunks.map((hunk, h) =>
                hunk.kind === 'skipped' ? (
                  <span key={h} className="compare-line skipped">
                    ⋯ {hunk.count} unchanged {hunk.count === 1 ? 'line' : 'lines'}
                    {'\n'}
                  </span>
                ) : (
                  hunk.lines.map((line, i) => (
                    <span key={`${h}-${i}`} className={`compare-line ${line.kind}`}>
                      <span className="compare-sign" aria-hidden="true">
                        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                      </span>
                      <span className="visually-hidden">
                        {line.kind === 'added' ? 'Added: ' : line.kind === 'removed' ? 'Removed: ' : ''}
                      </span>
                      {line.text || ' '}
                      {'\n'}
                    </span>
                  ))
                ),
              )}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
