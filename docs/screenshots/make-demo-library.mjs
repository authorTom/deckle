// Builds the demo library the README screenshots are taken from.
//
// The screenshots used to come from a library that existed only on one machine,
// which meant they could not be retaken once it was gone. This script rebuilds
// it from scratch instead: same notes, tasks and bookmarks every time, with all
// dates relative to today so the planner and the calendar always look current.
//
//   node docs/screenshots/make-demo-library.mjs /tmp/demo
//
// Then serve it and drive the captures with capture.mjs.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const out = process.argv[2]
if (!out) {
  console.error('usage: node make-demo-library.mjs <target-dir>')
  process.exit(1)
}

// ---- Dates ------------------------------------------------------------------
// Everything hangs off local midnight today, so "Today" and "Tomorrow" group
// correctly and the mini calendar marks the right days.
const today = new Date()
today.setHours(0, 0, 0, 0)

/** Local "YYYY-MM-DD" for today + n days. Not toISOString, which is UTC. */
function day(offset) {
  const d = new Date(today)
  d.setDate(d.getDate() + offset)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.now()

// ---- Notes ------------------------------------------------------------------

// Paragraphs are kept on one source line each, however long. A soft wrap inside
// a paragraph or blockquote round-trips through the editor as a hard break, so
// wrapping the source here puts a visible gap mid-sentence in the screenshot.
const notes = {
  'Welcome.md': `# Welcome to Deckle

Your notes, tasks, and bookmarks — **plain files, fully local**.

## Why Deckle?

- Live WYSIWYG Markdown editing
- A knowledge base your agent fills — notes, PDFs, spreadsheets, images
- A Todoist-style planner with due dates and a calendar
- Bookmarks with collections and comments

> Everything is stored as plain Markdown in a folder you choose — open it in any editor, sync it, or back it up however you like.

Press \`Ctrl/Cmd + K\` to open the command palette.
`,

  'Projects/Product launch plan.md': `# Product launch plan

Shipping the pricing page, the changelog and the announcement in the same week.

## Open questions

- Do we gate the API behind the paid tier at launch, or after?
- Who owns the status page if something breaks on the day?

## Sequence

1. Freeze the pricing copy
2. Rebuild the changelog from the release notes
3. Announcement goes out once the page is live, not before
`,

  'Projects/Website redesign.md': `# Website redesign

The old site was three landing pages wearing a trench coat. One grid, one type scale, one accent.

- Type scale settled at 1.2, which survives translation better than 1.25
- Hairline rules instead of cards — the content is the structure
- Dark mode is not a filter over the light palette; the greys are re-picked
`,

  'Reading/Atomic Habits.md': `# Atomic Habits

The argument that stuck: you do not rise to the level of your goals, you fall to the level of your systems.

- Make it obvious, attractive, easy, satisfying
- Habit stacking: attach the new thing to a thing you already do without thinking
- Environment beats willpower, reliably

Worth pairing with the argument for keeping notes as plain files — see [[Welcome]].
`,

  'Ideas.md': `# Ideas

- A reading queue that admits when you are never going to read something
- Plain-text budget, one file per month, no app
- Keyboard-only photo triage
- A changelog that writes itself from commit messages, badly, then gets edited
`,

  'Meeting notes.md': `# Meeting notes

## Launch review

Pricing page is the blocker. Copy is 80% there; the comparison table is the part nobody agrees on.

**Decided:** ship without the comparison table, add it the week after.

## Beta feedback themes

- Folder drag-and-drop was discovered without prompting
- Two people asked where the notes actually live — the answer needs to be on the first screen, not in the docs
- Nobody used the split editor until they saw it in the palette
`,
}

// ---- Tasks ------------------------------------------------------------------

const LAUNCH = 'p-launch'
const PERSONAL = 'p-personal'

// [title, project, due, priority]. Priority drives the check colour: 1 red,
// 2 amber, 3 blue, 4 plain — spread across the visible rows so the planner
// shot shows the scale rather than a column of one colour.
const tasks = [
  ['Send invoice #42', LAUNCH, day(-1), 1],
  ['Finalise pricing page copy', LAUNCH, day(0), 1],
  ['Review beta feedback', LAUNCH, day(0), 3],
  ['Water the plants', PERSONAL, day(0), 4],
  ['Email venue about launch party', LAUNCH, day(1), 3],
  ['Renew passport', PERSONAL, day(3), 2],
  ['Read the Vite 6 migration notes', null, day(4), 4],
  ['Book photographer', LAUNCH, day(5), 3],
  ['Draft launch announcement', LAUNCH, null, 4],
  ['Try the Colemak layout for a week', null, null, 4],
  ['Back up the photo library', null, null, 4],
]

const taskStore = {
  version: 1,
  tasks: tasks.map(([title, projectId, due, priority], i) => ({
    id: `t-${i + 1}`,
    title,
    projectId,
    due,
    priority,
    recurrence: null,
    completedAt: null,
    deletedAt: null,
    createdAt: now - (tasks.length - i) * HOUR,
  })),
  projects: [
    { id: LAUNCH, name: 'Launch', color: '#3b82f6' },
    { id: PERSONAL, name: 'Personal', color: '#22c55e' },
  ],
}

// ---- Bookmarks --------------------------------------------------------------

const TOBUY = 'c-tobuy'
const READING = 'c-reading'
const DEVTOOLS = 'c-devtools'

const bookmarks = [
  [
    'AeroPress Go travel coffee press',
    'https://www.amazon.co.uk/dp/B07YBRV4LX',
    TOBUY,
    '£37 at the moment — wait for under £30. Sarah recommends the standard one instead.',
    HOUR,
  ],
  [
    'Local-first software',
    'https://www.inkandswitch.com/local-first/',
    READING,
    'The seven ideals. The one about "the network is optional" is the whole argument for keeping notes as files.',
    DAY,
  ],
  ['TipTap — headless editor framework', 'https://tiptap.dev', DEVTOOLS, '', 2 * DAY],
  ['Standing desk mat', 'https://www.etsy.com/listing/standing-desk-mat', TOBUY, '', 3 * DAY],
  ['How to take smart notes', 'https://fortelabs.com/blog/how-to-take-smart-notes/', READING, '', 4 * DAY],
  ['Vite', 'https://vitejs.dev', DEVTOOLS, '', 5 * DAY],
]

const bookmarkStore = {
  version: 1,
  bookmarks: bookmarks.map(([title, url, collectionId, comment, age], i) => ({
    id: `b-${i + 1}`,
    url,
    title,
    comment,
    collectionId,
    createdAt: now - age,
  })),
  collections: [
    { id: TOBUY, name: 'To buy', color: '#f59e0b' },
    { id: READING, name: 'Reading list', color: '#8b5cf6' },
    { id: DEVTOOLS, name: 'Dev tools', color: '#14b8a6' },
  ],
}

// ---- Write ------------------------------------------------------------------

for (const [rel, body] of Object.entries(notes)) {
  const dest = path.join(out, rel)
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, body, 'utf8')
}

await mkdir(path.join(out, '.deckle'), { recursive: true })
await writeFile(
  path.join(out, '.deckle', 'tasks.json'),
  JSON.stringify(taskStore, null, 2),
  'utf8',
)
await writeFile(
  path.join(out, '.deckle', 'bookmarks.json'),
  JSON.stringify(bookmarkStore, null, 2),
  'utf8',
)

console.log(
  `demo library written to ${out}\n` +
    `  ${Object.keys(notes).length} notes, ${taskStore.tasks.length} tasks, ` +
    `${bookmarkStore.bookmarks.length} bookmarks`,
)
