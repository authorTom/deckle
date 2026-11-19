// Briefs, from the app's side: work handed to an agent, and handed back.
//
// A brief is a folder in a project — `Projects/<project>/Briefs/<date> <title>/`
// holding Brief.md (the instructions; its front matter is the state), Context/
// (files attached for the agent), Output/ (what the agent delivers) and Run.md
// (the dated record). Mirrors server/briefs.mjs, which is what an agent's MCP
// tools use: the two must read a brief the same way, and write Run.md lines in
// the same shape.
//
// The app moves a brief between the states a person decides — queued, done,
// changes requested, answered, cancelled — by editing Brief.md's front matter,
// the same as it edits a project's status. The states an agent decides
// (running, blocked, review) the server writes. What only matters while an
// agent is working — who holds it, its last progress line — is in
// `.deckle/runs.json`, which the app reads and never writes.

import * as library from '../fs/library'
import * as history from '../fs/history'
import type { ImportItem, NoteFile, NoteFolder, TreeNode } from '../fs/library'
import { readDataJson } from '../fs/appData'
import { parseFrontmatter, setFrontmatterFields } from '../lib/frontmatter'
import { nextOccurrence, todayStr } from '../tasks/dates'
import { projectsFolder } from '../projects/projects'

export const BRIEFS_DIR = 'Briefs'
export const CONTEXT_DIR = 'Context'
export const OUTPUT_DIR = 'Output'
export const BRIEF = 'Brief.md'
export const RUN = 'Run.md'
export const RUNS_FILE = 'runs.json'

export const BRIEF_STATUSES = [
  'draft',
  'queued',
  'running',
  'blocked',
  'review',
  'changes-requested',
  'done',
  'cancelled',
] as const
export type BriefStatus = (typeof BRIEF_STATUSES)[number]

export const REPEATS = ['daily', 'weekly', 'monthly'] as const
export type BriefRepeat = (typeof REPEATS)[number]

/** How the person reads a status. */
export const STATUS_LABELS: Record<BriefStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  running: 'Running',
  blocked: 'Needs an answer',
  review: 'Ready for review',
  'changes-requested': 'Changes requested',
  done: 'Done',
  cancelled: 'Cancelled',
}

/** The server's default; a claim this old is shown as stale. */
export const DEFAULT_LEASE_MS = 30 * 60_000

export interface BriefFile {
  /** Library path, e.g. "Projects/Acme/Briefs/2026-11-19 X/Output/report.docx". */
  id: string
  name: string
  isNote: boolean
  size: number | null
  updatedAt: number
}

export interface Brief {
  /** The brief's folder, which is also its id for an agent. */
  id: string
  project: string
  title: string
  status: BriefStatus
  agent: string | null
  priority: 1 | 2 | 3 | 4
  due: string | null
  start: string | null
  repeat: BriefRepeat | null
  outputs: string[]
  created: string | null
  createdBy: string | null
  lastRun: string | null
  /** Path of Brief.md. */
  brief: string
  /** Path of Run.md, if there is one. */
  run: string | null
  context: BriefFile[]
  output: BriefFile[]
  updatedAt: number
}

export interface RunClaim {
  agent: string
  claimedAt: number
  heartbeatAt: number
  progress?: string
  runDate?: string
}

export interface AgentSeen {
  lastSeen?: number
  lastPoll?: number
  current?: string
}

export interface RunsState {
  claims: Record<string, RunClaim>
  agents: Record<string, AgentSeen>
  /** The server's DECKLE_BRIEF_LEASE_MINUTES, in milliseconds. */
  leaseMs: number
}

export const EMPTY_RUNS: RunsState = { claims: {}, agents: {}, leaseMs: DEFAULT_LEASE_MS }

function isStatus(value: unknown): value is BriefStatus {
  return typeof value === 'string' && (BRIEF_STATUSES as readonly string[]).includes(value)
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function asList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : []
  return list.map((v) => String(v).trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
}

function filesUnder(nodes: TreeNode[], out: BriefFile[] = []): BriefFile[] {
  for (const node of nodes) {
    if (node.kind === 'folder') filesUnder(node.children, out)
    else
      out.push({
        id: node.id,
        name: node.name,
        isNote: node.kind === 'file',
        size: node.kind === 'asset' ? node.size : null,
        updatedAt: node.updatedAt,
      })
  }
  return out
}

/**
 * Every brief in the library, read from the tree. `readNote` is the app's
 * cached reader, so an unchanged library costs only a walk of the tree.
 */
export async function listBriefs(
  tree: TreeNode[],
  root: string,
  readNote: (id: string, updatedAt: number) => Promise<string>,
): Promise<Brief[]> {
  const folder = projectsFolder(tree, root)
  if (!folder) return []
  const out: Brief[] = []
  for (const project of folder.children) {
    if (project.kind !== 'folder') continue
    const briefs = project.children.find(
      (c): c is NoteFolder => c.kind === 'folder' && c.name === BRIEFS_DIR,
    )
    if (!briefs) continue
    for (const node of briefs.children) {
      if (node.kind !== 'folder') continue
      const briefNode = node.children.find((c): c is NoteFile => c.kind === 'file' && c.name === BRIEF)
      if (!briefNode) continue
      let meta: Record<string, unknown> = {}
      try {
        meta = parseFrontmatter(await readNote(briefNode.id, briefNode.updatedAt))
      } catch {
        // Unreadable: listed as a draft with no settings, so it can be opened and fixed.
      }
      const sub = (name: string) =>
        node.children.find((c): c is NoteFolder => c.kind === 'folder' && c.name === name)
      const priority = Number(meta.priority)
      out.push({
        id: node.id,
        project: project.name,
        title:
          typeof meta.title === 'string' && meta.title.trim()
            ? meta.title.trim()
            : node.name.replace(/^\d{4}-\d{2}-\d{2}\s+/, ''),
        status: isStatus(meta.status) ? meta.status : 'draft',
        agent: typeof meta.agent === 'string' && meta.agent.trim() ? meta.agent.trim() : null,
        priority: ([1, 2, 3, 4].includes(priority) ? priority : 3) as Brief['priority'],
        due: isDate(meta.due) ? meta.due : null,
        start: isDate(meta.start) ? meta.start : null,
        repeat: (REPEATS as readonly string[]).includes(meta.repeat as string) ? (meta.repeat as BriefRepeat) : null,
        outputs: asList(meta.outputs),
        created: meta.created ? String(meta.created) : null,
        createdBy: meta.created_by ? String(meta.created_by) : null,
        lastRun: isDate(meta.last_run) ? meta.last_run : null,
        brief: briefNode.id,
        run: node.children.some((c) => c.kind === 'file' && c.name === RUN) ? `${node.id}/${RUN}` : null,
        context: filesUnder(sub(CONTEXT_DIR)?.children ?? []),
        output: filesUnder(sub(OUTPUT_DIR)?.children ?? []),
        updatedAt: Math.max(0, ...filesUnder(node.children).map((f) => f.updatedAt)),
      })
    }
  }
  return out
}

/** What the server says about running briefs and agents, or nothing yet. */
export async function readRuns(dir: FileSystemDirectoryHandle): Promise<RunsState> {
  const raw = (await readDataJson(dir, RUNS_FILE)) as Partial<RunsState> | null
  if (!raw || typeof raw !== 'object') return EMPTY_RUNS
  return {
    claims: raw.claims && typeof raw.claims === 'object' ? raw.claims : {},
    agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {},
    leaseMs: typeof raw.leaseMs === 'number' && raw.leaseMs > 0 ? raw.leaseMs : DEFAULT_LEASE_MS,
  }
}

/** Where a brief stands for the person: what they need to do, if anything. */
export type BriefGroup = 'needs-you' | 'running' | 'queued' | 'drafts' | 'finished'

export function groupOf(brief: Brief): BriefGroup {
  switch (brief.status) {
    case 'blocked':
    case 'review':
      return 'needs-you'
    case 'running':
      return 'running'
    case 'queued':
    case 'changes-requested':
      return 'queued'
    case 'draft':
      return 'drafts'
    default:
      return 'finished'
  }
}

/** Most pressing first, as the server hands them out. */
export function byUrgency(a: Brief, b: Brief): number {
  const rework = (x: Brief) => (x.status === 'changes-requested' ? 0 : 1)
  return (
    rework(a) - rework(b) ||
    a.priority - b.priority ||
    (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
    (a.created ?? '').localeCompare(b.created ?? '') ||
    a.id.localeCompare(b.id)
  )
}

// ---- Writing ---------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "2026-11-19 14:02", as server/projects.mjs stamps a log line. */
export function timeStamp(date = new Date()): string {
  return `${todayStrOf(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function todayStrOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One Run.md line, in the server's shape (see logLine in server/projects.mjs). */
export function runLine(text: string, actor: string, date = new Date()): string {
  const [first, ...rest] = text.trim().split(/\r?\n/)
  return `- **${timeStamp(date)}** · ${actor} — ${first}${rest.map((l) => `\n  ${l}`).join('')}\n`
}

/** Who the app writes as in a run log. */
export const PERSON = 'you'

async function appendRun(dir: FileSystemDirectoryHandle, brief: Pick<Brief, 'id' | 'title'>, text: string) {
  const path = `${brief.id}/${RUN}`
  let current = ''
  try {
    current = await library.readNote(dir, path)
  } catch {
    current = `# Run log — ${brief.title}\n\n`
  }
  const sep = current && !current.endsWith('\n') ? '\n' : ''
  await library.writeNote(dir, path, `${current}${sep}${runLine(text, PERSON)}`)
}

async function setFields(
  dir: FileSystemDirectoryHandle,
  brief: Pick<Brief, 'brief'>,
  fields: Record<string, string | number | string[] | undefined>,
) {
  const current = await library.readNote(dir, brief.brief)
  const next = setFrontmatterFields(current, fields)
  if (next === current) return
  if (current.trim()) await history.snapshotNote(dir, brief.brief, current, 'edit')
  await library.writeNote(dir, brief.brief, next)
}

export interface NewBrief {
  /** An existing project's folder name. */
  project: string
  title: string
  instructions: string
  agent: string
  priority: 1 | 2 | 3 | 4
  due: string
  start: string
  repeat: BriefRepeat | ''
  outputs: string[]
  /** Attachments, with paths relative to Context/ (folders are kept). */
  files: ImportItem[]
  queue: boolean
}

/** Create a brief's folder and files. Returns the brief's id. */
export async function createBrief(
  dir: FileSystemDirectoryHandle,
  root: string,
  input: NewBrief,
): Promise<string> {
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!title) throw new Error('A brief needs a title')
  const id = await library.createFolder(dir, `${root}/${input.project}/${BRIEFS_DIR}`, `${todayStr()} ${title}`)
  await library.createFolder(dir, id, CONTEXT_DIR)
  await library.createFolder(dir, id, OUTPUT_DIR)
  const outputs = input.outputs.map((o) => o.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
  const content = setFrontmatterFields(`# ${title}\n\n${input.instructions.trim() ? `${input.instructions.trim()}\n` : ''}`, {
    type: 'brief',
    title,
    status: input.queue ? 'queued' : 'draft',
    agent: input.agent.trim() || undefined,
    priority: input.priority,
    due: input.due || undefined,
    start: input.start || undefined,
    repeat: input.repeat || undefined,
    outputs: outputs.length ? outputs : undefined,
    created: todayStr(),
    created_by: PERSON,
  })
  await library.writeNote(dir, `${id}/${BRIEF}`, content)
  if (input.files.length) await library.importNotes(dir, input.files, `${id}/${CONTEXT_DIR}`)
  const attached = input.files.length
    ? ` ${input.files.length} ${input.files.length === 1 ? 'file' : 'files'} attached.`
    : ''
  await appendRun(dir, { id, title }, `${input.queue ? 'Brief created and queued.' : 'Brief drafted.'}${attached}`)
  return id
}

/** Attach more files to a brief's Context/ folder. */
export async function attachContext(dir: FileSystemDirectoryHandle, brief: Brief, files: ImportItem[]) {
  if (!files.length) return
  await library.importNotes(dir, files, `${brief.id}/${CONTEXT_DIR}`)
  await appendRun(dir, brief, `Attached ${files.length} ${files.length === 1 ? 'file' : 'files'} to the context.`)
}

/** The decisions a person makes about a brief. */
export type BriefAction =
  | { kind: 'queue' }
  | { kind: 'approve' }
  | { kind: 'request-changes'; comment: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'cancel' }
  | { kind: 'rerun'; note?: string }
  | { kind: 'to-draft' }

/** Which actions make sense for a brief in its current state. */
export function actionsFor(brief: Brief): BriefAction['kind'][] {
  switch (brief.status) {
    case 'draft':
      return ['queue', 'cancel']
    case 'queued':
      return ['to-draft', 'cancel']
    case 'running':
      return ['cancel']
    case 'blocked':
      return ['answer', 'cancel']
    case 'review':
      return ['approve', 'request-changes']
    case 'changes-requested':
      return ['cancel']
    default:
      return ['rerun']
  }
}

/**
 * Apply a person's decision: Brief.md's status (the old version kept in
 * history), and a line in Run.md saying what they decided — which is how the
 * agent, in a fresh session, learns of an answer or a change request.
 */
export async function applyAction(dir: FileSystemDirectoryHandle, brief: Brief, action: BriefAction): Promise<BriefStatus> {
  switch (action.kind) {
    case 'queue':
      await setFields(dir, brief, { status: 'queued' })
      await appendRun(dir, brief, 'Queued.')
      return 'queued'
    case 'to-draft':
      await setFields(dir, brief, { status: 'draft' })
      await appendRun(dir, brief, 'Taken out of the queue, back to draft.')
      return 'draft'
    case 'approve': {
      // A repeating brief is a work stream: approving one run waits for the next.
      const status: BriefStatus = brief.repeat ? 'queued' : 'done'
      const start =
        brief.repeat && !(brief.start && brief.start > todayStr())
          ? nextOccurrence(todayStr(), { freq: brief.repeat, interval: 1 })
          : undefined
      await setFields(dir, brief, start ? { status, start } : { status })
      await appendRun(dir, brief, brief.repeat ? '**Approved.** Next run as scheduled.' : '**Approved.**')
      return status
    }
    case 'request-changes': {
      const comment = action.comment.trim()
      if (!comment) throw new Error('Say what should change')
      await setFields(dir, brief, { status: 'changes-requested' })
      await appendRun(dir, brief, `**Changes requested:** ${comment}`)
      return 'changes-requested'
    }
    case 'answer': {
      const answer = action.answer.trim()
      if (!answer) throw new Error('Write an answer first')
      await setFields(dir, brief, { status: 'queued' })
      await appendRun(dir, brief, `**Answer:** ${answer}`)
      return 'queued'
    }
    case 'cancel':
      await setFields(dir, brief, { status: 'cancelled' })
      await appendRun(dir, brief, brief.status === 'running' ? 'Cancelled while it was running.' : 'Cancelled.')
      return 'cancelled'
    case 'rerun': {
      await setFields(dir, brief, { status: 'queued', start: undefined })
      const note = action.note?.trim()
      await appendRun(dir, brief, note ? `**Run again:** ${note}` : 'Queued to run again.')
      return 'queued'
    }
  }
}

// ---- Templates -------------------------------------------------------------

export interface BriefTemplate {
  id: string
  label: string
  outputs: string[]
  instructions: string
}

/** Starting points for the instructions; every heading is a prompt to the person. */
export const TEMPLATES: BriefTemplate[] = [
  { id: 'blank', label: 'Blank', outputs: [], instructions: '' },
  {
    id: 'research',
    label: 'Research report',
    outputs: ['docx', 'md'],
    instructions: [
      '## Question',
      'What should this research answer?',
      '',
      '## Scope',
      '- In:',
      '- Out:',
      '',
      '## Sources',
      'Use the files in Context/ first. Bookmark any web source you rely on.',
      '',
      '## Deliverable',
      'A report with a one-paragraph summary at the top, findings with sources, and a recommendation.',
    ].join('\n'),
  },
  {
    id: 'deck',
    label: 'Slide deck',
    outputs: ['pptx'],
    instructions: [
      '## Audience and purpose',
      'Who will see it, and what should they decide or understand afterwards?',
      '',
      '## Content',
      '- Key messages:',
      '- Data to show:',
      '',
      '## Format',
      'About 10 slides. One idea per slide; speaker notes on each. Use any template in Context/.',
    ].join('\n'),
  },
  {
    id: 'spreadsheet',
    label: 'Spreadsheet analysis',
    outputs: ['xlsx', 'md'],
    instructions: [
      '## Data',
      'The data is in Context/. Describe what each file holds and anything known to be wrong with it.',
      '',
      '## Questions',
      '1.',
      '',
      '## Deliverable',
      'A workbook with the cleaned data, the analysis on its own sheet, and a short note of the findings.',
    ].join('\n'),
  },
  {
    id: 'document',
    label: 'Document draft',
    outputs: ['docx'],
    instructions: [
      '## What it is',
      'The kind of document, who it is for, and roughly how long.',
      '',
      '## Must include',
      '-',
      '',
      '## Tone',
      'Plain and direct.',
    ].join('\n'),
  },
]

export const OUTPUT_TYPES = ['docx', 'pptx', 'xlsx', 'pdf', 'md', 'csv', 'png']
