// Briefs: work a person hands to an agent, and the agent hands back.
//
// Deckle calls no model, so it never runs a brief itself. It holds a queue, and
// an agent pulls from it: a scheduled job calls next_brief every few minutes,
// does the work it gets, files the output and says it is done. Everything the
// agent needs to start — or, in a fresh session, to pick the work up again — is
// in the brief's folder, because a scheduled run remembers nothing of the last.
//
// A brief is a folder inside a project, nothing more:
//
//   Projects/<project>/Briefs/<date> <title>/
//     Brief.md    the instructions; its front matter is the brief's state
//     Context/    files the person attached for this piece of work
//     Output/     what the agent hands back (Output/<date>/ for a repeating brief)
//     Run.md      the dated record: progress, questions, answers, change requests
//
// and Projects/<project>/Context/ holds context every brief in the project shares.
//
// Brief.md's front matter is the one source of truth for where a brief stands,
// and the app edits it as freely as the agent does. What only matters while an
// agent is working — who holds the brief, when it last reported, the line it
// last said — lives in .deckle/runs.json, so a progress report every few
// minutes doesn't put a new version of Brief.md into history each time. That
// file is derived state: lose it and the worst outcome is that a running brief
// waits out its lease before it can be claimed again.

import { ApiError, normalizeFolderPath } from './library-store.mjs'
import { parseFrontmatter, setFrontmatterFields, splitFrontmatter } from './frontmatter.mjs'
import { isValidDateStr, nextOccurrence, toDateStr } from './dates.mjs'
import { isExtractable } from './extract.mjs'
import { dateStamp, logLine } from './projects.mjs'

export const BRIEFS_DIR = 'Briefs'
export const CONTEXT_DIR = 'Context'
export const OUTPUT_DIR = 'Output'
export const BRIEF = 'Brief.md'
export const RUN = 'Run.md'
export const RUNS_FILE = '.deckle/runs.json'

export const BRIEF_STATUSES = [
  'draft',
  'queued',
  'running',
  'blocked',
  'review',
  'changes-requested',
  'done',
  'cancelled',
]
export const REPEATS = ['daily', 'weekly', 'monthly']

/** A claim not renewed by report_progress for this long goes back to the queue. */
export const DEFAULT_LEASE_MS = 30 * 60_000

const MAX_TITLE = 120
const MAX_INSTRUCTIONS = 200_000
const MAX_ENTRY = 20_000

function oneLine(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function asList(value) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  return list.map((v) => String(v).trim().replace(/^\./, '').toLowerCase()).filter(Boolean).slice(0, 20)
}

function validPriority(value, fallback = 3) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (![1, 2, 3, 4].includes(n)) throw new ApiError(400, 'invalid_body', '"priority" must be 1, 2, 3 or 4')
  return n
}

function validDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (!isValidDateStr(value)) {
    throw new ApiError(400, 'invalid_body', `"${field}" must be a real date as "YYYY-MM-DD"`)
  }
  return value
}

function validRepeat(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (!REPEATS.includes(value)) {
    throw new ApiError(400, 'invalid_body', `"repeat" must be one of ${REPEATS.join(', ')}`)
  }
  return value
}

function sameAgent(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
}

/** The title a brief is shown by: its front matter's, or its folder's, less the date. */
function titleOf(meta, folderName) {
  if (typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim()
  return folderName.replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
}

/**
 * Every file under some tree nodes, listed with library paths. Built from
 * names, not node ids: a tree's ids are relative to whichever folder was
 * walked, and briefs are read from walks of different folders.
 */
function filesUnder(nodes, base, out = []) {
  for (const node of nodes) {
    const path = `${base}/${node.name}`
    if (node.kind === 'folder') filesUnder(node.children, path, out)
    else
      out.push({
        path,
        name: node.name,
        kind: node.kind === 'file' ? 'note' : 'file',
        size: node.size ?? null,
        updatedAt: node.updatedAt ?? null,
        // Whether `read` gives its text back; anything else is downloaded.
        readable: node.kind === 'file' || isExtractable(node.name),
      })
  }
  return out
}

/**
 * Which briefs an agent may take, most pressing first: change requests before
 * new work (finish what's in flight), then priority, then the nearest due
 * date, then the oldest.
 */
function byUrgency(a, b) {
  const rework = (x) => (x.status === 'changes-requested' ? 0 : 1)
  return (
    rework(a) - rework(b) ||
    a.priority - b.priority ||
    (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
    (a.created ?? '').localeCompare(b.created ?? '') ||
    a.id.localeCompare(b.id)
  )
}

export function createBriefs({
  library,
  store,
  projects,
  now = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
}) {
  const root = projects.root

  // Every change of state goes through one queue, so two agents polling at
  // the same moment can't both claim the same brief.
  let chain = Promise.resolve()
  function serial(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ---- runs.json --------------------------------------------------------

  async function loadRuns() {
    try {
      const parsed = JSON.parse(await library.readText(RUNS_FILE))
      if (parsed?.version === 1 && parsed.claims && parsed.agents) return parsed
    } catch {
      // Missing or torn: it is derived state, so start again.
    }
    return { version: 1, claims: {}, agents: {} }
  }

  async function saveRuns(runs) {
    // The lease goes with it, so the app judges a claim stale by this server's
    // setting rather than the default.
    await library.writeText(RUNS_FILE, JSON.stringify({ ...runs, leaseMs }, null, 2))
  }

  // An agent's "last seen", kept in memory — every authenticated request
  // touches it, and most are reads, so it is never a write of its own. It is
  // written down whenever runs.json is saved anyway: on every poll for work and
  // every progress report, which is when the app wants to know.
  const seen = new Map()

  function touch(agent) {
    if (agent) seen.set(agent, now().getTime())
  }

  function mergeSeen(runs) {
    for (const [agent, at] of seen) {
      runs.agents[agent] = { ...runs.agents[agent], lastSeen: Math.max(at, runs.agents[agent]?.lastSeen ?? 0) }
    }
    seen.clear()
  }

  // ---- Reading -----------------------------------------------------------

  /** "Projects/Acme/Briefs/2026-11-19 X" (or …/Brief.md) → its parts, or a 400. */
  function parseId(raw) {
    let path = normalizeFolderPath(String(raw ?? '').trim())
    if (path.endsWith(`/${BRIEF}`)) path = path.slice(0, -(BRIEF.length + 1))
    const prefix = `${root}/`
    const parts = path.startsWith(prefix) ? path.slice(prefix.length).split('/') : []
    if (parts.length !== 3 || parts[1] !== BRIEFS_DIR || !parts[0] || !parts[2]) {
      throw new ApiError(
        400,
        'invalid_params',
        `"${raw}" is not a brief: a brief's id is its folder, "${root}/<project>/${BRIEFS_DIR}/<brief>"`,
      )
    }
    return { id: path, project: parts[0], folder: parts[2] }
  }

  async function describe(id, project, folderName, children, runs) {
    const briefNode = children.find((c) => c.kind === 'file' && c.name === BRIEF)
    if (!briefNode) return null
    const text = await library.readText(`${id}/${BRIEF}`)
    const meta = parseFrontmatter(text)
    const contextNode = children.find((c) => c.kind === 'folder' && c.name === CONTEXT_DIR)
    const outputNode = children.find((c) => c.kind === 'folder' && c.name === OUTPUT_DIR)
    const status = BRIEF_STATUSES.includes(meta.status) ? meta.status : 'draft'
    const claim = runs?.claims[id] && status === 'running' ? runs.claims[id] : null
    const at = now().getTime()
    return {
      id,
      project,
      title: titleOf(meta, folderName),
      status,
      agent: typeof meta.agent === 'string' && meta.agent.trim() ? meta.agent.trim() : null,
      priority: [1, 2, 3, 4].includes(meta.priority) ? meta.priority : 3,
      due: isValidDateStr(meta.due) ? meta.due : null,
      start: isValidDateStr(meta.start) ? meta.start : null,
      repeat: REPEATS.includes(meta.repeat) ? meta.repeat : null,
      outputs: asList(meta.outputs),
      created: meta.created ? String(meta.created) : null,
      createdBy: meta.created_by ? String(meta.created_by) : null,
      lastRun: isValidDateStr(meta.last_run) ? meta.last_run : null,
      brief: `${id}/${BRIEF}`,
      run: children.some((c) => c.kind === 'file' && c.name === RUN) ? `${id}/${RUN}` : null,
      contextDir: `${id}/${CONTEXT_DIR}`,
      outputDir: `${id}/${OUTPUT_DIR}`,
      context: contextNode ? filesUnder(contextNode.children, `${id}/${CONTEXT_DIR}`) : [],
      output: outputNode ? filesUnder(outputNode.children, `${id}/${OUTPUT_DIR}`) : [],
      updatedAt: Math.max(0, ...filesUnder(children, id).map((f) => f.updatedAt ?? 0)),
      claim: claim
        ? {
            agent: claim.agent,
            claimedAt: claim.claimedAt,
            heartbeatAt: claim.heartbeatAt,
            progress: claim.progress ?? null,
            stale: claim.heartbeatAt + leaseMs < at,
          }
        : null,
    }
  }

  async function list({ status, agent, project } = {}) {
    if ((await library.exists(root)) !== 'directory') return []
    const runs = await loadRuns()
    const tree = await library.tree(root)
    const out = []
    for (const projectNode of tree) {
      if (projectNode.kind !== 'folder') continue
      if (project && projectNode.name.toLowerCase() !== String(project).toLowerCase()) continue
      const briefsNode = projectNode.children.find((c) => c.kind === 'folder' && c.name === BRIEFS_DIR)
      if (!briefsNode) continue
      for (const node of briefsNode.children) {
        if (node.kind !== 'folder') continue
        const id = `${root}/${projectNode.name}/${BRIEFS_DIR}/${node.name}`
        try {
          const brief = await describe(id, projectNode.name, node.name, node.children, runs)
          if (brief) out.push(brief)
        } catch {
          // An unreadable brief is skipped rather than failing the whole list.
        }
      }
    }
    return out
      .filter((b) => !status || b.status === status)
      .filter((b) => !agent || !b.agent || sameAgent(b.agent, agent))
      .sort(byUrgency)
  }

  async function get(raw, runs) {
    const { id, project, folder } = parseId(raw)
    if ((await library.exists(id)) !== 'directory') {
      throw new ApiError(404, 'not_found', `no brief at "${id}"`)
    }
    const brief = await describe(id, project, folder, await library.tree(id), runs ?? (await loadRuns()))
    if (!brief) throw new ApiError(404, 'not_found', `"${id}" has no ${BRIEF}`)
    return brief
  }

  /** A brief with everything an agent reads before starting: instructions, log, shared context. */
  async function detail(raw) {
    const brief = await get(raw)
    const { body } = splitFrontmatter(await library.readText(brief.brief))
    const runLog = brief.run ? await library.readText(brief.run) : ''
    const projectContextDir = `${root}/${brief.project}/${CONTEXT_DIR}`
    const projectContext =
      (await library.exists(projectContextDir)) === 'directory'
        ? filesUnder(await library.tree(projectContextDir), projectContextDir)
        : []
    return { ...brief, instructions: body.trim(), runLog, projectContext }
  }

  // ---- Writing -----------------------------------------------------------

  async function setFields(brief, fields) {
    const current = await library.readText(brief.brief)
    const next = setFrontmatterFields(current, fields)
    if (next !== current) await store.writeNote(brief.brief, next, 'agent')
  }

  async function appendRun(brief, actor, entry) {
    const path = `${brief.id}/${RUN}`
    const line = logLine(entry, actor, now())
    if ((await library.exists(path)) !== 'file') {
      await library.writeText(path, `# Run log — ${brief.title}\n\n${line}`)
    } else {
      const current = await library.readText(path)
      await library.appendText(path, current.endsWith('\n') ? line : `\n${line}`)
    }
    return path
  }

  /** Start a brief in an existing project. */
  function create({ project, title, instructions, agent, priority, due, start, repeat, outputs, status, createdBy }) {
    return serial(async () => {
      const owner = await projects.get(project)
      const cleanTitle = oneLine(title, MAX_TITLE)
      if (!cleanTitle) throw new ApiError(400, 'invalid_body', '"title" is required')
      const initial = status ?? 'queued'
      if (!['draft', 'queued'].includes(initial)) {
        throw new ApiError(400, 'invalid_body', '"status" for a new brief must be draft or queued')
      }
      const text = String(instructions ?? '').trim()
      if (text.length > MAX_INSTRUCTIONS) throw new ApiError(400, 'invalid_body', '"instructions" is too long')

      const briefsDir = `${owner.path}/${BRIEFS_DIR}`
      const desired = store.sanitizeName(`${dateStamp(now())} ${cleanTitle}`, '')
      if (!desired || desired.startsWith('.')) throw new ApiError(400, 'invalid_body', '"title" must make a usable folder name')
      let folderName = desired
      for (let i = 1; await library.exists(`${briefsDir}/${folderName}`); i++) folderName = `${desired} ${i}`
      const id = `${briefsDir}/${folderName}`

      const fields = {
        type: 'brief',
        title: cleanTitle,
        status: initial,
        agent: agent ? oneLine(agent, 60) : undefined,
        priority: validPriority(priority),
        due: validDate(due, 'due'),
        start: validDate(start, 'start'),
        repeat: validRepeat(repeat),
        outputs: asList(outputs).length ? asList(outputs) : undefined,
        created: dateStamp(now()),
        created_by: createdBy ? oneLine(createdBy, 60) : undefined,
      }
      const content = setFrontmatterFields(`# ${cleanTitle}\n\n${text ? `${text}\n` : ''}`, fields)
      await library.mkdir(`${id}/${CONTEXT_DIR}`)
      await library.mkdir(`${id}/${OUTPUT_DIR}`)
      await store.writeNote(`${id}/${BRIEF}`, content, 'agent')
      const brief = await get(id)
      await appendRun(brief, createdBy, initial === 'queued' ? 'Brief created and queued.' : 'Brief drafted.')
      return await get(id)
    })
  }

  /** Put stale claims back in the queue. Runs inside serial(). */
  async function expireClaims(runs) {
    const at = now().getTime()
    const expired = []
    for (const [id, claim] of Object.entries(runs.claims)) {
      let brief = null
      try {
        brief = await get(id, runs)
      } catch {
        // The brief is gone: so is the claim.
      }
      if (!brief || brief.status !== 'running') {
        delete runs.claims[id]
        continue
      }
      if (claim.heartbeatAt + leaseMs >= at) continue
      delete runs.claims[id]
      await setFields(brief, { status: claim.from === 'changes-requested' ? 'changes-requested' : 'queued' })
      await appendRun(
        brief,
        null,
        `${claim.agent} stopped reporting progress ${Math.round(leaseMs / 60_000)} minutes ago, so the brief is back in the queue.`,
      )
      expired.push({ ...brief, agent: claim.agent })
    }
    return expired
  }

  /** Is this brief one the agent may take now? */
  function isAvailable(brief, agent, today) {
    if (brief.agent && !sameAgent(brief.agent, agent)) return false
    if (brief.status === 'changes-requested') return true
    const due = !brief.start || brief.start <= today
    if (brief.status === 'queued') return due
    // A repeating brief whose last run nobody has reviewed yet still runs on time.
    if (brief.repeat && (brief.status === 'review' || brief.status === 'done')) return !!brief.start && due
    return false
  }

  /**
   * Claim the most pressing brief this agent may take, or null. Also expires
   * stale claims, and notes that the agent polled.
   */
  function claim(agent) {
    return serial(async () => {
      const runs = await loadRuns()
      mergeSeen(runs)
      runs.agents[agent] = { ...runs.agents[agent], lastSeen: now().getTime(), lastPoll: now().getTime() }
      const expired = await expireClaims(runs)
      const today = toDateStr(now())
      const candidate = (await list()).find((b) => isAvailable(b, agent, today))
      if (!candidate) {
        await saveRuns(runs)
        return { brief: null, expired }
      }
      const at = now().getTime()
      runs.claims[candidate.id] = {
        agent,
        claimedAt: at,
        heartbeatAt: at,
        from: candidate.status,
        runDate: today,
        progress: 'Started',
      }
      runs.agents[agent].current = candidate.id
      await saveRuns(runs)
      await setFields(candidate, { status: 'running' })
      await appendRun(
        candidate,
        agent,
        candidate.status === 'changes-requested' ? 'Picked the brief up again to make the changes asked for.' : 'Started.',
      )
      return { brief: await detail(candidate.id), expired, runDate: today }
    })
  }

  /** The brief, and this agent's claim on it — or a 409 telling it why not. */
  async function claimed(raw, agent, runs) {
    const brief = await get(raw, runs)
    const held = runs.claims[brief.id]
    if (brief.status !== 'running' || !held) {
      throw new ApiError(
        409,
        'not_claimed',
        `"${brief.title}" is ${brief.status}, not running for you — the user may have changed or cancelled it. Call next_brief for work.`,
      )
    }
    if (!sameAgent(held.agent, agent)) {
      throw new ApiError(409, 'not_claimed', `"${brief.title}" is being worked by ${held.agent}, not ${agent}.`)
    }
    return { brief, held }
  }

  /** Where this run's output goes: Output/, or Output/<date>/ for a repeating brief. */
  function runOutputDir(brief, held) {
    return brief.repeat ? `${brief.outputDir}/${held.runDate}` : brief.outputDir
  }

  function progress(raw, agent, entry) {
    return serial(async () => {
      const text = String(entry ?? '').trim()
      if (!text) throw new ApiError(400, 'invalid_body', '"entry" cannot be empty')
      if (text.length > MAX_ENTRY) throw new ApiError(400, 'invalid_body', '"entry" is too long')
      const runs = await loadRuns()
      const { brief, held } = await claimed(raw, agent, runs)
      held.heartbeatAt = now().getTime()
      held.progress = oneLine(text.split('\n')[0], 200)
      mergeSeen(runs)
      await saveRuns(runs)
      await appendRun(brief, agent, text)
      return brief
    })
  }

  function ask(raw, agent, question) {
    return serial(async () => {
      const text = String(question ?? '').trim()
      if (!text) throw new ApiError(400, 'invalid_body', '"question" cannot be empty')
      if (text.length > MAX_ENTRY) throw new ApiError(400, 'invalid_body', '"question" is too long')
      const runs = await loadRuns()
      const { brief } = await claimed(raw, agent, runs)
      delete runs.claims[brief.id]
      if (sameAgent(runs.agents[agent]?.current, brief.id)) delete runs.agents[agent].current
      await saveRuns(runs)
      await setFields(brief, { status: 'blocked' })
      await appendRun(brief, agent, `**Question:** ${text}`)
      return await get(brief.id)
    })
  }

  /** The path a delivered file lands at, checked: inside this run's output folder. */
  async function outputPath(raw, agent, name) {
    const runs = await loadRuns()
    const { brief, held } = await claimed(raw, agent, runs)
    const relative = normalizeFolderPath(String(name ?? '').replace(/^\/+/, ''))
    if (!relative || relative.split('/').some((s) => !s || s.startsWith('.'))) {
      throw new ApiError(400, 'invalid_params', `"${name}" is not a usable file name`)
    }
    return { brief, path: `${runOutputDir(brief, held)}/${relative}` }
  }

  function complete(raw, agent, summary) {
    return serial(async () => {
      const text = String(summary ?? '').trim()
      if (!text) throw new ApiError(400, 'invalid_body', '"summary" cannot be empty')
      if (text.length > MAX_ENTRY) throw new ApiError(400, 'invalid_body', '"summary" is too long')
      const runs = await loadRuns()
      const { brief, held } = await claimed(raw, agent, runs)
      const dir = runOutputDir(brief, held)
      const delivered = brief.output.filter((f) => f.path.startsWith(`${dir}/`) && (f.updatedAt ?? 0) >= held.claimedAt - 1000)
      delete runs.claims[brief.id]
      if (sameAgent(runs.agents[agent]?.current, brief.id)) delete runs.agents[agent].current
      await saveRuns(runs)

      const today = toDateStr(now())
      const fields = { status: 'review', last_run: today }
      if (brief.repeat) fields.start = nextOccurrence(today, { freq: brief.repeat, interval: 1 }, today)
      await setFields(brief, fields)
      const outputs = delivered.length
        ? `\nOutputs: ${delivered.map((f) => `[[${f.path.slice(brief.id.length + 1)}]]`).join(', ')}`
        : '\nNo output files.'
      await appendRun(brief, agent, `**Done:** ${text}${outputs}`)
      return { brief: await get(brief.id), delivered, next: fields.start ?? null }
    })
  }

  /** Who has been here: every agent's last request, poll and current brief. */
  async function agents() {
    const runs = await loadRuns()
    const out = { ...runs.agents }
    for (const [agent, at] of seen) out[agent] = { ...out[agent], lastSeen: Math.max(at, out[agent]?.lastSeen ?? 0) }
    return out
  }

  /** One call's worth of project context: overview, recent log, open briefs, latest files. */
  async function projectContext(name, { files = 15, logLines = 20 } = {}) {
    const project = await projects.get(name)
    const overview = project.overview ? await library.readText(project.overview) : ''
    let log = ''
    if (project.log) {
      const lines = (await library.readText(project.log)).split('\n').filter((l) => l.startsWith('- '))
      log = lines.slice(-logLines).join('\n')
    }
    const briefs = (await list({ project: project.name })).filter((b) => !['done', 'cancelled'].includes(b.status))
    const tree = filesUnder(await library.tree(project.path), project.path)
      .filter((f) => f.path !== project.overview && f.path !== project.log)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, files)
    return { project, overview, log, briefs, recent: tree }
  }

  return {
    list,
    get,
    detail,
    create,
    claim,
    progress,
    ask,
    outputPath,
    complete,
    agents,
    touch,
    projectContext,
    parseId,
    leaseMs,
  }
}
