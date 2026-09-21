import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { extensionOf, type LibraryFile } from '../fs/library'

/**
 * What kind of thing a file is, as far as showing it goes. One table, so the
 * tree, the tabs, the palette and the viewer all agree on what a `.xlsx` is.
 */
export type FileFamily =
  | 'note'
  | 'image'
  | 'pdf'
  | 'sheet'
  | 'doc'
  | 'slides'
  | 'csv'
  | 'json'
  | 'text'
  | 'code'
  | 'audio'
  | 'video'
  | 'archive'
  | 'other'

const FAMILIES: Record<string, FileFamily> = {
  md: 'note',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
  svg: 'image', bmp: 'image', ico: 'image',
  pdf: 'pdf',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', numbers: 'sheet',
  docx: 'doc', doc: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  pptx: 'slides', ppt: 'slides', odp: 'slides', key: 'slides',
  csv: 'csv', tsv: 'csv',
  json: 'json', jsonl: 'json', ndjson: 'json', ipynb: 'json',
  txt: 'text', text: 'text', log: 'text', markdown: 'text', rst: 'text', org: 'text',
  yaml: 'text', yml: 'text', toml: 'text', ini: 'text', cfg: 'text', conf: 'text',
  srt: 'text', vtt: 'text', tex: 'text', bib: 'text', env: 'text',
  xml: 'code', html: 'code', htm: 'code', css: 'code', scss: 'code', less: 'code',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', vue: 'code',
  svelte: 'code', py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', kt: 'code',
  swift: 'code', c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', cs: 'code',
  php: 'code', sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code', sql: 'code',
  r: 'code', lua: 'code', pl: 'code', scala: 'code', dart: 'code', graphql: 'code',
  proto: 'code', dockerfile: 'code', makefile: 'code', gradle: 'code',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', '7z': 'archive', rar: 'archive',
}

export function familyOf(name: string): FileFamily {
  const ext = extensionOf(name)
  // "Dockerfile" and "Makefile" have no extension; their name is their type.
  return FAMILIES[ext || name.toLowerCase()] ?? 'other'
}

const ICONS: Record<FileFamily, LucideIcon> = {
  note: FileText,
  image: FileImage,
  pdf: FileType,
  sheet: FileSpreadsheet,
  doc: FileText,
  slides: Presentation,
  csv: FileSpreadsheet,
  json: FileJson,
  text: FileText,
  code: FileCode,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  other: File,
}

/** The icon for a note or file. */
export function iconFor(item: Pick<LibraryFile, 'kind' | 'name'>): LucideIcon {
  return item.kind === 'file' ? FileText : ICONS[familyOf(item.name)]
}

/** A plain-words name for a file's type, for the viewer's header. */
export function describeType(name: string): string {
  const ext = extensionOf(name)
  switch (familyOf(name)) {
    case 'image':
      return `${ext.toUpperCase()} image`
    case 'pdf':
      return 'PDF document'
    case 'sheet':
      return 'Spreadsheet'
    case 'doc':
      return 'Document'
    case 'slides':
      return 'Presentation'
    case 'csv':
      return ext === 'tsv' ? 'Tab-separated data' : 'CSV data'
    case 'json':
      return 'JSON'
    case 'audio':
      return 'Audio'
    case 'video':
      return 'Video'
    case 'archive':
      return 'Archive'
    default:
      return ext ? `.${ext} file` : 'File'
  }
}

/**
 * The MIME type a preview needs for a blob, by extension. Only for the types
 * the viewer hands to the browser to render — images, audio, video and PDF.
 * Never HTML: a blob URL shares the app's origin, so a stored web page is only
 * ever shown as source text.
 */
export function previewMime(name: string): string | null {
  const ext = extensionOf(name)
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
    ico: 'image/x-icon', pdf: 'application/pdf',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    flac: 'audio/flac', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  }
  return types[ext] ?? null
}

export { formatBytes } from './exportLibrary'
