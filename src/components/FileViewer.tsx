import { useEffect, useState, type ReactNode } from 'react'
import { Download, ExternalLink, FolderInput, Trash2, X } from 'lucide-react'
import Backlinks from './Backlinks'
import type { AssetFile } from '../fs/library'
import type { Backlink } from '../lib/wikilinks'
import type { ActivityEvent } from '../activity/activity'
import { describeType, familyOf, formatBytes, iconFor, previewMime } from '../lib/fileTypes'
import {
  parseDelimited,
  readDocx,
  readPptx,
  readXlsx,
  type DocBlock,
  type Sheet,
  type Slide,
} from '../lib/officePreview'
import { timeAgo } from '../lib/format'
import { downloadBlob } from '../lib/zip'

interface FileViewerProps {
  file: AssetFile
  /** Read the file's bytes from the library. */
  load: (id: string) => Promise<Blob>
  focused: boolean
  /** Rendered as a pane header when the workspace is split. */
  paneLabel?: string
  onClosePane?: () => void
  onFocusPane: () => void
  backlinks: Backlink[]
  onOpenNote: (id: string) => void
  /** The newest thing an agent did to this file, if the activity log knows. */
  provenance: ActivityEvent | null
  onMove: () => void
  onDelete: () => void
}

/** Text-like files bigger than this are offered as a download, not rendered. */
const MAX_TEXT_PREVIEW_BYTES = 8 * 1024 * 1024
/** And no more than this much of one is put on screen. */
const MAX_TEXT_CHARS = 400_000

type Preview =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'none'; reason: string }
  | { kind: 'url'; url: string; as: 'image' | 'pdf' | 'audio' | 'video' }
  | { kind: 'doc'; blocks: DocBlock[] }
  | { kind: 'sheets'; sheets: Sheet[] }
  | { kind: 'slides'; slides: Slide[] }
  | { kind: 'table'; rows: string[][]; truncated: boolean }
  | { kind: 'text'; text: string; truncated: boolean; language: 'json' | 'text' }

async function buildPreview(file: AssetFile, blob: Blob): Promise<Preview> {
  const family = familyOf(file.name)
  const mime = previewMime(file.name)

  if (mime && (family === 'image' || family === 'pdf' || family === 'audio' || family === 'video')) {
    // Typed by extension, never sniffed, so only these four kinds of thing are
    // ever handed to the browser to render.
    const url = URL.createObjectURL(new Blob([blob], { type: mime }))
    return { kind: 'url', url, as: family }
  }

  const textual = ['csv', 'json', 'text', 'code'].includes(family)
  if (textual && blob.size > MAX_TEXT_PREVIEW_BYTES) {
    return { kind: 'none', reason: `At ${formatBytes(blob.size)} this is too big to show here.` }
  }

  switch (family) {
    case 'doc':
      if (file.ext !== 'docx') break
      return { kind: 'doc', blocks: await readDocx(await blob.arrayBuffer()) }
    case 'sheet':
      if (file.ext !== 'xlsx' && file.ext !== 'xlsm') break
      return { kind: 'sheets', sheets: await readXlsx(await blob.arrayBuffer()) }
    case 'slides':
      if (file.ext !== 'pptx') break
      return { kind: 'slides', slides: await readPptx(await blob.arrayBuffer()) }
    case 'csv': {
      const { rows, truncated } = parseDelimited(await blob.text(), file.ext === 'tsv' ? '\t' : ',')
      return { kind: 'table', rows, truncated }
    }
    case 'json': {
      const raw = await blob.text()
      let text = raw
      if (file.ext === 'json') {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2)
        } catch {
          // Not valid JSON after all — show it as written.
        }
      }
      return { kind: 'text', text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS, language: 'json' }
    }
    case 'text':
    case 'code': {
      const text = await blob.text()
      return { kind: 'text', text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS, language: 'text' }
    }
  }
  return {
    kind: 'none',
    reason:
      family === 'archive'
        ? 'Archives are kept as they are. Download it to open it.'
        : `Deckle can't show ${describeType(file.name).toLowerCase()}s. Download it to open it in the app that made it.`,
  }
}

function Table({ rows, numbered = false }: { rows: string[][]; numbered?: boolean }) {
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0)
  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {numbered && <th scope="row">{r + 1}</th>}
              {Array.from({ length: width }, (_, c) => (
                <td key={c}>{row[c] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A file that isn't a note, open in a pane: a preview where the browser can
 * give one safely, and what it is, who put it there and what links to it.
 */
export default function FileViewer({
  file,
  load,
  focused,
  paneLabel,
  onClosePane,
  onFocusPane,
  backlinks,
  onOpenNote,
  provenance,
  onMove,
  onDelete,
}: FileViewerProps) {
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' })
  const [sheet, setSheet] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)

  // Reload whenever the file changes on disk — an agent replacing a report
  // shows the new one without anyone reopening it.
  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setPreview({ kind: 'loading' })
    setSheet(0)
    void (async () => {
      try {
        const data = await load(file.id)
        if (cancelled) return
        setBlob(data)
        const next = await buildPreview(file, data)
        if (next.kind === 'url') url = next.url
        if (cancelled) {
          if (url) URL.revokeObjectURL(url)
          return
        }
        setPreview(next)
      } catch (err) {
        if (!cancelled) {
          setPreview({
            kind: 'error',
            message: err instanceof Error ? err.message : 'This file could not be read.',
          })
        }
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.updatedAt, load])

  const Icon = iconFor(file)
  const download = () => {
    if (blob) downloadBlob(blob, file.name)
  }

  let body: ReactNode
  switch (preview.kind) {
    case 'loading':
      body = <div className="file-preview-empty">Opening {file.name}…</div>
      break
    case 'error':
      body = (
        <div className="file-preview-empty" role="alert">
          {preview.message}
        </div>
      )
      break
    case 'none':
      body = (
        <div className="file-preview-empty">
          <Icon size={28} aria-hidden="true" />
          <p>{preview.reason}</p>
          <button type="button" className="btn-primary" onClick={download} disabled={!blob}>
            <Download size={15} /> Download {file.name}
          </button>
        </div>
      )
      break
    case 'url':
      if (preview.as === 'image') {
        body = <img className="file-preview-image" src={preview.url} alt={file.name} />
      } else if (preview.as === 'pdf') {
        body = (
          <>
            <iframe className="file-preview-frame" src={preview.url} title={file.name} />
            <p className="file-preview-note">
              Blank? Some browsers — most phones among them — won't show a PDF inside a page.{' '}
              <a href={preview.url} target="_blank" rel="noopener noreferrer">
                Open it in its own tab
              </a>{' '}
              or download it.
            </p>
          </>
        )
      } else if (preview.as === 'audio') {
        body = <audio className="file-preview-audio" src={preview.url} controls />
      } else {
        body = <video className="file-preview-video" src={preview.url} controls />
      }
      break
    case 'doc':
      body = (
        <article className="file-preview-doc">
          {preview.blocks.length === 0 && <p className="file-preview-note">This document has no text.</p>}
          {preview.blocks.map((block, i) => {
            if (block.type === 'heading') {
              const Tag = (['h1', 'h2', 'h3'] as const)[block.level - 1] ?? 'h3'
              return <Tag key={i}>{block.text}</Tag>
            }
            if (block.type === 'bullet') return <p key={i} className="file-doc-bullet">{block.text}</p>
            if (block.type === 'table') return <Table key={i} rows={block.rows} />
            return <p key={i}>{block.text}</p>
          })}
        </article>
      )
      break
    case 'sheets': {
      const current = preview.sheets[Math.min(sheet, preview.sheets.length - 1)]
      body = (
        <div className="file-preview-sheets">
          {preview.sheets.length > 1 && (
            <div className="file-sheet-tabs" role="tablist" aria-label="Sheets">
              {preview.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  aria-selected={i === sheet}
                  className={`file-sheet-tab${i === sheet ? ' active' : ''}`}
                  onClick={() => setSheet(i)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {current && current.rows.length ? (
            <Table rows={current.rows} numbered />
          ) : (
            <p className="file-preview-note">This sheet is empty.</p>
          )}
          {current && current.truncated > 0 && (
            <p className="file-preview-note">
              Showing the first rows; {current.truncated.toLocaleString()} more are in the file.
            </p>
          )}
          <p className="file-preview-note">Values as last calculated. Formulas, formatting and charts stay in the file.</p>
        </div>
      )
      break
    }
    case 'slides':
      body = (
        <div className="file-preview-slides">
          {preview.slides.map((slide) => (
            <section key={slide.number} className="file-slide" aria-label={`Slide ${slide.number}`}>
              <span className="file-slide-number">{slide.number}</span>
              {slide.paragraphs.length ? (
                slide.paragraphs.map((p, i) => (i === 0 ? <h3 key={i}>{p}</h3> : <p key={i}>{p}</p>))
              ) : (
                <p className="file-preview-note">No text on this slide.</p>
              )}
            </section>
          ))}
        </div>
      )
      break
    case 'table':
      body = (
        <>
          <Table rows={preview.rows} numbered />
          {preview.truncated && <p className="file-preview-note">Showing the first rows only.</p>}
        </>
      )
      break
    case 'text':
      body = (
        <>
          <pre className="file-preview-text">{preview.text}</pre>
          {preview.truncated && <p className="file-preview-note">Showing the beginning of the file only.</p>}
        </>
      )
      break
  }

  return (
    <div className={`pane file-pane${focused ? ' focused' : ''}`} onMouseDown={onFocusPane}>
      {paneLabel && (
        <div className="pane-header">
          <span className="pane-title">{paneLabel}</span>
          {onClosePane && (
            <button
              type="button"
              className="icon-btn pane-close"
              onClick={onClosePane}
              title="Close this pane"
              aria-label="Close this pane"
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}

      <div className="file-viewer">
        <header className="file-viewer-header">
          <span className="file-viewer-icon" aria-hidden="true">
            <Icon size={20} />
          </span>
          <div className="file-viewer-meta">
            <span className="file-viewer-type">
              {describeType(file.name)} · {formatBytes(file.size)} · changed {timeAgo(file.updatedAt)}
            </span>
            {provenance && (
              <span className="file-viewer-provenance">
                {provenance.actor} {provenance.action} it {timeAgo(provenance.at)}
                {provenance.message ? ` — “${provenance.message}”` : ''}
              </span>
            )}
          </div>
          <div className="file-viewer-actions">
            {preview.kind === 'url' && (
              <a
                className="icon-btn"
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in a new tab"
                aria-label="Open in a new tab"
              >
                <ExternalLink size={17} />
              </a>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={download}
              disabled={!blob}
              title="Download"
              aria-label={`Download ${file.name}`}
            >
              <Download size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onMove}
              title="Move to another folder"
              aria-label="Move to another folder"
            >
              <FolderInput size={17} />
            </button>
            <button
              type="button"
              className="icon-btn trash-danger"
              onClick={onDelete}
              title="Move to Recycle Bin"
              aria-label={`Move ${file.name} to the Recycle Bin`}
            >
              <Trash2 size={17} />
            </button>
          </div>
        </header>

        <div className={`file-viewer-body file-viewer-${preview.kind === 'url' ? preview.as : preview.kind}`}>
          {body}
        </div>

        <div className="file-viewer-links">
          <Backlinks backlinks={backlinks} onOpenNote={onOpenNote} />
        </div>
      </div>
    </div>
  )
}
