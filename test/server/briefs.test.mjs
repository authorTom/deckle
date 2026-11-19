// Briefs: the pull queue an agent works from, through the real HTTP handler —
// MCP for the agent's side, REST for scripts, and the files on disk the app
// reads, since Brief.md's front matter is the brief's state.

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../helpers/server.mjs'

const HERMES = 'hermes-secret-0123456789abcdef'
const CLAUDE = 'claude-secret-0123456789abcdef'
const RO = 'reader-secret-0123456789abcdef'

describe('briefs', () => {
  let s
  beforeAll(async () => {
    s = await startServer({
      DECKLE_API_TOKENS: `hermes:rw:${HERMES},claude-code:rw:${CLAUDE},reader:r:${RO}`,
      DECKLE_BRIEF_LEASE_MINUTES: '1',
    })
  })
  afterAll(() => s.close())

  const auth = (token = HERMES) => ({ Authorization: `Bearer ${token}` })
  const disk = (p) => fs.readFile(path.join(s.libraryDir, p), 'utf8')
  const json = async (res) => ({ status: res.status, body: await res.json() })
  const rest = (method, p, body, token = HERMES) =>
    s
      .fetch(`/api/v1${p}`, {
        method,
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      .then(json)

  let nextId = 1
  const call = async (name, args = {}, token = HERMES) => {
    const res = await s.fetch('/api/v1/mcp', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    })
    const body = await res.json()
    if (body.error) throw new Error(body.error.message)
    return { text: body.result.content[0].text, isError: body.result.isError === true }
  }

  /** Write a brief's Brief.md front matter by hand, as the app does. */
  async function setStatus(id, status) {
    const file = path.join(s.libraryDir, id, 'Brief.md')
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace(/^status: .*$/m, `status: ${status}`))
  }
  async function appendRun(id, line) {
    await fs.appendFile(path.join(s.libraryDir, id, 'Run.md'), `${line}\n`)
  }

  let reportId
  it('creates a brief as a folder with Brief.md, Context/, Output/ and Run.md', async () => {
    expect((await call('create_project', { name: 'Acme', summary: 'Vendor work' })).isError).toBe(false)
    const created = await rest('POST', '/briefs', {
      project: 'Acme',
      title: 'Vendor comparison',
      instructions: 'Compare three ELT vendors.\n\n- Use [[pricing.csv]]',
      agent: 'hermes',
      priority: 2,
      due: '2030-01-10',
      outputs: ['docx', '.PPTX'],
    })
    expect(created.status).toBe(201)
    reportId = created.body.id
    expect(reportId).toMatch(/^Projects\/Acme\/Briefs\/\d{4}-\d{2}-\d{2} Vendor comparison$/)
    expect(created.body).toMatchObject({ status: 'queued', agent: 'hermes', priority: 2, outputs: ['docx', 'pptx'], createdBy: 'hermes' })

    const brief = await disk(`${reportId}/Brief.md`)
    expect(brief).toMatch(/^---\ntype: brief\ntitle: Vendor comparison\nstatus: queued\n/)
    expect(brief).toContain('# Vendor comparison\n\nCompare three ELT vendors.')
    expect(await disk(`${reportId}/Run.md`)).toContain('Brief created and queued.')
    for (const dir of ['Context', 'Output']) {
      expect((await fs.stat(path.join(s.libraryDir, reportId, dir))).isDirectory()).toBe(true)
    }

    await fs.writeFile(path.join(s.libraryDir, reportId, 'Context', 'pricing.csv'), 'vendor,price\nA,1')
    await fs.writeFile(path.join(s.libraryDir, reportId, 'Context', 'scan.pdf'), Buffer.from('%PDF-1.4'))
    await fs.mkdir(path.join(s.libraryDir, 'Projects/Acme/Context'), { recursive: true })
    await fs.writeFile(path.join(s.libraryDir, 'Projects/Acme/Context/style guide.md'), '# House style')
  })

  it('refuses a brief for a missing project, a bad date or status', async () => {
    expect((await rest('POST', '/briefs', { project: 'Nope', title: 'x' })).status).toBe(404)
    expect((await rest('POST', '/briefs', { project: 'Acme', title: 'x', due: '2030-02-31' })).status).toBe(400)
    expect((await rest('POST', '/briefs', { project: 'Acme', title: 'x', repeat: 'hourly' })).status).toBe(400)
    expect((await rest('POST', '/briefs', { project: 'Acme', title: 'x' }, RO)).status).toBe(403)
  })

  it('hands an agent only briefs addressed to it or to anyone', async () => {
    const none = await call('next_brief', {}, CLAUDE)
    expect(none.text).toContain('No briefs are waiting')
    const list = await call('list_briefs', { mine: true }, CLAUDE)
    expect(list.text).toBe('No briefs.')
  })

  it('claims the brief with its instructions, context and how to work it', async () => {
    const claimed = await call('next_brief')
    expect(claimed.isError).toBe(false)
    expect(claimed.text).toContain('You have taken the brief "Vendor comparison" in project Acme.')
    expect(claimed.text).toContain(`id: ${reportId}`)
    expect(claimed.text).toContain('Compare three ELT vendors.')
    expect(claimed.text).toContain(`${reportId}/Context/pricing.csv`)
    expect(claimed.text).toMatch(/Context\/pricing\.csv \(\d+ B\) — read it with `read`/)
    expect(claimed.text).toMatch(/scan\.pdf .*binary — download GET \/api\/v1\/files\/Projects\/Acme\/Briefs\/.*%20Vendor%20comparison\/Context\/scan\.pdf/)
    expect(claimed.text).toContain('Projects/Acme/Context/style guide.md')
    expect(claimed.text).toContain('expected outputs: docx, pptx')
    expect(claimed.text).toContain(`it lands in ${reportId}/Output/.`)
    expect(await disk(`${reportId}/Brief.md`)).toContain('status: running')

    const runs = JSON.parse(await disk('.deckle/runs.json'))
    expect(runs.claims[reportId]).toMatchObject({ agent: 'hermes', from: 'queued', progress: 'Started' })
    expect(runs.agents.hermes.lastPoll).toBeGreaterThan(0)
    expect(runs.agents.hermes.current).toBe(reportId)
    expect(runs.leaseMs).toBe(60_000)

    // Nothing more for hermes: the one brief is running.
    expect((await call('next_brief')).text).toContain('No briefs are waiting')
  })

  it('takes progress, deliveries and refuses anyone not holding the claim', async () => {
    expect((await call('report_progress', { brief: reportId, entry: 'Read the context; drafting.' })).text).toBe(
      'Noted on "Vendor comparison".',
    )
    const docx = Buffer.from('PK\u0003\u0004 pretend docx').toString('base64')
    const delivered = await call('deliver_file', {
      brief: reportId,
      name: 'Vendor comparison.docx',
      content: docx,
      encoding: 'base64',
      message: 'the report',
    })
    expect(delivered).toMatchObject({ isError: false })
    expect(delivered.text).toContain(`Saved ${reportId}/Output/Vendor comparison.docx`)
    const nested = await call('deliver_file', { brief: reportId, name: 'charts/notes.md', content: '# Notes' })
    expect(nested.isError).toBe(false)

    // Over REST, as deckle_push.py --brief does.
    const put = await s.fetch(
      `/api/v1/briefs/output?brief=${encodeURIComponent(reportId)}&name=${encodeURIComponent('deck.pptx')}`,
      { method: 'PUT', headers: auth(), body: Buffer.from('pretend pptx') },
    )
    expect(put.status).toBe(201)

    const escape = await call('deliver_file', { brief: reportId, name: '../Brief.md', content: 'x' })
    expect(escape.isError).toBe(true)
    const hidden = await call('deliver_file', { brief: reportId, name: '.secret', content: 'x' })
    expect(hidden.isError).toBe(true)
    const thief = await call('report_progress', { brief: reportId, entry: 'mine now' }, CLAUDE)
    expect(thief).toMatchObject({ isError: true })
    expect(thief.text).toContain('being worked by hermes')

    const runLog = await disk(`${reportId}/Run.md`)
    expect(runLog).toContain('· hermes — Read the context; drafting.')
    expect(runLog).toContain('Delivered [[Output/Vendor comparison.docx]].')

    const events = (await rest('GET', '/activity?limit=20')).body.events
    const saved = events.find((e) => e.path === `${reportId}/Output/Vendor comparison.docx`)
    expect(saved).toMatchObject({ actor: 'hermes', action: 'saved', kind: 'file', brief: reportId, project: 'Acme' })
  })

  it('completes the brief for review, listing what was delivered', async () => {
    const done = await call('complete_brief', { brief: reportId, summary: 'Vendor B wins on price.' })
    expect(done.text).toContain('is with the user for review, with 3 files delivered')
    const brief = await disk(`${reportId}/Brief.md`)
    expect(brief).toContain('status: review')
    expect(brief).toMatch(/last_run: \d{4}-\d{2}-\d{2}/)
    const runLog = await disk(`${reportId}/Run.md`)
    expect(runLog).toContain('**Done:** Vendor B wins on price.')
    expect(runLog).toContain('[[Output/Vendor comparison.docx]]')
    expect(JSON.parse(await disk('.deckle/runs.json')).claims[reportId]).toBeUndefined()
    // A finished brief takes no more progress.
    expect((await call('report_progress', { brief: reportId, entry: 'late' })).isError).toBe(true)
  })

  it('hands a brief back with the change request when the user asks for changes', async () => {
    await setStatus(reportId, 'changes-requested')
    await appendRun(reportId, '- **2030-01-01 09:00** · you — **Changes requested:** Add a cost table.')
    const again = await call('next_brief')
    expect(again.text).toContain('Add a cost table.')
    expect(again.text).toContain('act on the newest ones')
    const runs = JSON.parse(await disk('.deckle/runs.json'))
    expect(runs.claims[reportId].from).toBe('changes-requested')
  })

  it('stops a brief when the agent asks a question, and resumes after the answer', async () => {
    const asked = await call('ask_user', { brief: reportId, question: 'Which currency?' })
    expect(asked.text).toContain('blocked until the user answers')
    expect(await disk(`${reportId}/Brief.md`)).toContain('status: blocked')
    expect(await disk(`${reportId}/Run.md`)).toContain('**Question:** Which currency?')
    expect((await call('next_brief')).text).toContain('No briefs are waiting')

    await setStatus(reportId, 'queued')
    await appendRun(reportId, '- **2030-01-01 10:00** · you — **Answer:** GBP.')
    const resumed = await call('next_brief')
    expect(resumed.text).toContain('**Answer:** GBP.')
  })

  it('refuses progress on a brief the user cancelled mid-run', async () => {
    await setStatus(reportId, 'cancelled')
    const refused = await call('report_progress', { brief: reportId, entry: 'still going' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('is cancelled')
  })

  it('puts a brief whose agent went quiet back in the queue', async () => {
    const created = await rest('POST', '/briefs', { project: 'Acme', title: 'Quiet one' }, CLAUDE)
    const id = created.body.id
    const claimed = await rest('POST', '/briefs/claim', undefined, CLAUDE)
    expect(claimed.body.brief.id).toBe(id)
    // Age the claim past the one-minute lease.
    const runsPath = path.join(s.libraryDir, '.deckle/runs.json')
    const runs = JSON.parse(await fs.readFile(runsPath, 'utf8'))
    runs.claims[id].heartbeatAt -= 2 * 60_000
    await fs.writeFile(runsPath, JSON.stringify(runs))

    const listed = await rest('GET', `/briefs?project=Acme&status=running`)
    expect(listed.body.briefs.find((b) => b.id === id).claim).toMatchObject({ agent: 'claude-code', stale: true })

    const retaken = await rest('POST', '/briefs/claim')
    expect(retaken.body.brief.id).toBe(id)
    expect(await disk(`${id}/Run.md`)).toContain('claude-code stopped reporting progress 1 minutes ago')
    const lapsed = (await rest('GET', '/activity?limit=10')).body.events.find((e) => e.action === 'released')
    expect(lapsed).toMatchObject({ kind: 'brief', path: id })
    await rest('POST', '/briefs/complete', { brief: id, summary: 'Nothing to it.' })
  })

  it('runs a repeating brief into dated output folders, on schedule', async () => {
    const created = await call('create_brief', {
      project: 'Acme',
      title: 'Weekly scan',
      instructions: 'Scan competitors.',
      repeat: 'weekly',
    })
    const id = created.text.match(/id (Projects\/[^)]+)\)/)[1]
    const claimed = await call('next_brief')
    expect(claimed.text).toContain('Weekly scan')
    expect(claimed.text).toMatch(/lands in .*\/Output\/\d{4}-\d{2}-\d{2}\//)
    await call('deliver_file', { brief: id, name: 'scan.md', content: '# Scan' })
    const done = await call('complete_brief', { brief: id, summary: 'Quiet week.' })
    expect(done.text).toMatch(/repeats weekly: the next run is due \d{4}-\d{2}-\d{2}/)
    const brief = await disk(`${id}/Brief.md`)
    const start = brief.match(/^start: (.*)$/m)[1]
    expect(start > new Date().toISOString().slice(0, 10)).toBe(true)
    // Not before its date.
    expect((await call('next_brief')).text).toContain('No briefs are waiting')
    // Once the date comes, it runs again even though nobody reviewed the last run.
    await fs.writeFile(path.join(s.libraryDir, id, 'Brief.md'), brief.replace(/^start: .*$/m, 'start: 2020-01-01'))
    expect((await call('next_brief')).text).toContain('Weekly scan')
  })

  it('lists briefs and agents for the app and scripts', async () => {
    const { body } = await rest('GET', '/briefs?project=Acme', undefined, RO)
    expect(body.count).toBeGreaterThanOrEqual(3)
    const detail = await rest('GET', `/briefs/detail?id=${encodeURIComponent(reportId)}`, undefined, RO)
    expect(detail.body).toMatchObject({ id: reportId, title: 'Vendor comparison', status: 'cancelled' })
    expect(detail.body.instructions).toContain('Compare three ELT vendors.')
    expect(detail.body.output.map((f) => f.name).sort()).toEqual(['Vendor comparison.docx', 'deck.pptx', 'notes.md'])
    expect(detail.body.projectContext.map((f) => f.path)).toEqual(['Projects/Acme/Context/style guide.md'])
    expect((await rest('GET', '/briefs/detail?id=Projects/Acme/Nope', undefined, RO)).status).toBe(400)

    const agents = (await rest('GET', '/agents', undefined, RO)).body.agents
    expect(agents.hermes.lastSeen).toBeGreaterThan(0)
    expect(agents.reader.lastSeen).toBeGreaterThan(0)
  })

  it('catches an agent up on a project in one call', async () => {
    await call('log_progress', { project: 'Acme', entry: 'Kicked off vendor work.' })
    const { text } = await call('get_project_context', { project: 'Acme' }, RO)
    expect(text).toContain('# Acme — active')
    expect(text).toContain('Kicked off vendor work.')
    expect(text).toContain('## Open briefs')
    expect(text).toContain('Weekly scan')
    expect(text).not.toContain('Vendor comparison [Acme] (cancelled')
    expect(text).toContain('## Recently changed')
  })
})
