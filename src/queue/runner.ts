// Executing one queued run, one step at a time.
//
// This is not `useAssistant.runLoop` with different arguments, and the
// difference is worth stating because the two look alike. The chat panel
// pauses for approval by awaiting a promise the UI resolves — the loop is
// still on the stack, the user is still there, the browser has not moved. A
// queued run has to stop for a person who may not come back today: the loop
// must *return*, everything needed to continue must be on disk, and picking it
// back up may happen after a reload, in a different tab, or eventually in a
// server-side worker that never had the promise.
//
// So this is a step machine. `advance` runs until the work is done or until it
// owes somebody an answer, and says which. Resuming is calling it again.

import { runTurn } from '../ai/providers'
import { buildPreview, executeTool, toolByName, TOOL_DEFS } from '../ai/tools'
import type { ActionPreview } from '../ai/tools'
import { SYSTEM_PROMPT } from '../ai/prompt'
import { buildMemoryContext } from '../memory/context'
import { buildContextBlock } from '../ai/context'
import type { AssistantSettings, ChatMessage, ToolCall, ToolDef } from '../ai/types'
import { isInsideInbox } from './settings'
import type { Run, RunWrite } from './types'

/** Tool calls before a run is stopped for going in circles. */
const MAX_STEPS = 25

export const ASK_USER = 'ask_user'

/**
 * Only offered to queued runs. In the chat panel the user is right there, so a
 * tool for asking them a question would be a worse way to do what the model
 * can already do by simply saying something.
 */
const ASK_USER_TOOL: ToolDef = {
  name: ASK_USER,
  description:
    'Ask the person who queued this run a question, when you genuinely cannot proceed without their answer — an ambiguous target note, a decision only they can make. The run parks until they reply, so use it when being wrong would waste the work, and otherwise make a reasonable choice and say what you assumed.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What you need to know. One question, phrased so it can be answered in a sentence.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  readOnly: true,
}

const QUEUE_TOOLS: ToolDef[] = [...TOOL_DEFS, ASK_USER_TOOL]

export type Outcome =
  | { kind: 'done'; summary: string }
  | { kind: 'needs-approval'; preview: ActionPreview }
  | { kind: 'needs-input'; question: string }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' }

export interface RunContext {
  dir: FileSystemDirectoryHandle
  run: Run
  settings: AssistantSettings
  inbox: string
  signal: AbortSignal
  /** Persist the run as it stands. Called after every turn. */
  onTurn: () => Promise<void>
}

let counter = 0
const uid = () => `q${Date.now().toString(36)}${(counter++).toString(36)}`

/** The path a mutating call would touch, or null if it touches none. */
function writeTargets(call: ToolCall): string[] {
  const a = call.arguments
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (call.name) {
    case 'write_file':
    case 'create_folder':
    case 'delete_file':
    case 'delete_folder':
      return [str('path')].filter(Boolean)
    // Both ends: moving a note *into* the inbox still removes it from wherever
    // it was, which is a change outside the inbox.
    case 'move_file':
      return [str('from'), str('to')].filter(Boolean)
    default:
      return []
  }
}

function isDestructive(name: string): boolean {
  return name === 'delete_file' || name === 'delete_folder'
}

/**
 * May this call run without asking?
 *
 * Reads and memory writes always may. A note write may when it stays inside
 * the inbox — that is the whole safety story: a queued run can draft freely in
 * its own folder, and everything else stops for a person.
 *
 * Deletions never may, inbox or not. They are recoverable from the recycle bin,
 * but "the assistant deleted something while I was making coffee" is not a
 * sentence worth the convenience.
 */
export function needsApproval(call: ToolCall, inbox: string): boolean {
  const def = toolByName(call.name)
  if (def?.readOnly || def?.autoApply) return false
  if (isDestructive(call.name)) return true
  const targets = writeTargets(call)
  if (!targets.length) return true
  return !targets.every((path) => isInsideInbox(path, inbox))
}

function describeWrite(call: ToolCall, before: string | null): RunWrite | null {
  const targets = writeTargets(call)
  if (!targets.length) return null
  const path = call.name === 'move_file' ? targets[targets.length - 1] : targets[0]
  const kind =
    call.name === 'write_file' ? (before ? 'overwrite' : 'create') : 'other'
  return { path, kind, applied: true }
}

/** Execute a call and append its result to the transcript. */
export async function executeAndRecord(
  ctx: RunContext,
  call: ToolCall,
): Promise<void> {
  let before: string | null = null
  if (call.name === 'write_file' && typeof call.arguments.path === 'string') {
    // Only to label the write as a create or an overwrite in the run's
    // "what it did" list; executeTool does its own history snapshot.
    try {
      const { readNote } = await import('../fs/library')
      before = await readNote(ctx.dir, call.arguments.path)
    } catch {
      before = null
    }
  }

  // Say what is about to happen before it happens: a long tool call is
  // exactly when the list most needs to explain itself.
  ctx.run.summary = describeProgress(call)
  await ctx.onTurn()

  let content: string
  let isError = false
  try {
    content = await executeTool(ctx.dir, call, { settings: ctx.settings })
    const write = describeWrite(call, before)
    if (write) ctx.run.writes.push(write)
  } catch (e) {
    content = `Error: ${(e as Error).message}`
    isError = true
  }

  ctx.run.messages.push({
    id: uid(),
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError,
  })
}

/** Append a tool result the caller produced (a decline, or a person's reply). */
export function recordToolResult(
  run: Run,
  call: ToolCall,
  content: string,
  isError = false,
): void {
  run.messages.push({
    id: uid(),
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError,
  })
}

/**
 * Work through the calls a turn produced, stopping at the first that needs a
 * person. Whatever is left — including the blocker — stays on the run, because
 * a provider will reject an assistant turn with three tool calls and two
 * results.
 */
async function processCalls(ctx: RunContext): Promise<Outcome | null> {
  const calls = ctx.run.pendingCalls ?? []
  while (calls.length) {
    if (ctx.signal.aborted) return { kind: 'cancelled' }
    const call = calls[0]

    if (call.name === ASK_USER) {
      const question =
        typeof call.arguments.question === 'string' && call.arguments.question.trim()
          ? call.arguments.question.trim()
          : 'Trevor needs your input to continue.'
      ctx.run.question = question
      return { kind: 'needs-input', question }
    }

    if (needsApproval(call, ctx.inbox)) {
      ctx.run.pendingPreview = await buildPreview(ctx.dir, call)
      return { kind: 'needs-approval', preview: ctx.run.pendingPreview }
    }

    await executeAndRecord(ctx, call)
    calls.shift()
  }
  ctx.run.pendingCalls = undefined
  ctx.run.pendingPreview = undefined
  ctx.run.question = undefined
  return null
}

function buildSystem(ctx: RunContext): string {
  return [
    SYSTEM_PROMPT,
    `You are running in the background from a queue, not in a live chat. The person who queued this is not watching.

- Put your output in the "${ctx.inbox}" folder — create a note there with a clear name. That folder is yours to write in freely.
- Anything outside "${ctx.inbox}" stops the run and waits for the person to approve the exact change, so only reach outside it when the task genuinely requires editing an existing note.
- Deleting anything always waits for approval, wherever it is.
- Finish with a short plain summary of what you did and where you put it. That summary is what they see in the queue.`,
    ctx.run.contextPath
      ? `The note open when this was queued was "${ctx.run.contextPath}". If the task says "this note" without naming one, that is the one — read it first.`
      : '',
    ctx.settings.systemPrompt.trim()
      ? `Additional instructions from the user:\n${ctx.settings.systemPrompt.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** A one-line "what happened" for the queue list. */
/**
 * What the run is doing, right now, in the words of the thing it is doing it
 * to. Written onto the run after every turn so the list can show progress
 * rather than a spinner and a title — "working" for two minutes tells you
 * nothing about whether it is working *well*.
 */
function describeProgress(call: ToolCall): string {
  const a = call.arguments
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (call.name) {
    case 'read_note':
      return `Reading ${str('path')}`
    case 'write_file':
      return `Writing ${str('path')}`
    case 'move_file':
      return `Moving ${str('from')}`
    case 'create_folder':
      return `Creating ${str('path')}`
    case 'delete_file':
    case 'delete_folder':
      return `Deleting ${str('path')}`
    case 'search_notes':
      return `Searching for “${str('query')}”`
    case 'list_notes':
      return 'Looking through the library'
    default:
      return `Running ${call.name}`
  }
}

function summarise(text: string, writes: RunWrite[]): string {
  const firstLine = text.trim().split('\n').find((l) => l.trim())?.trim()
  if (firstLine) return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
  if (writes.length) return `Wrote ${writes.map((w) => w.path).join(', ')}`
  return 'Finished with nothing to report.'
}

/**
 * Run until the work is done or somebody is owed an answer.
 *
 * Safe to call again on the same run: it picks up from whatever is left in
 * `pendingCalls`, which is how approve, reject and reply all resume.
 */
export async function advance(ctx: RunContext): Promise<Outcome> {
  const memory = ctx.settings.memory
    ? await buildMemoryContext(ctx.dir, ctx.run.prompt)
        .then((m) => m.text)
        .catch(() => '')
    : ''
  const system = buildSystem(ctx)

  // Memory travels in the user turn, not the system prompt — the same rule the
  // chat panel follows, and for the same reason: it is text the model wrote
  // about the user, and text the model wrote must not arrive wearing the app's
  // authority. It matters more here than in the chat, because nobody is
  // watching a queued run. See src/ai/context.ts.
  //
  // Message 0 is always the prompt the run was queued with (src/queue/useQueue.ts).
  const contextBlock = buildContextBlock({ memoryText: memory })
  const forProvider = (turns: ChatMessage[]): ChatMessage[] =>
    contextBlock
      ? turns.map((m, i) =>
          i === 0 ? { ...m, content: `${contextBlock}\n\n${m.content}` } : m,
        )
      : turns

  // Anything left over from the last stop, before asking the model for more.
  if (ctx.run.pendingCalls?.length) {
    const resumed = await processCalls(ctx)
    if (resumed) return resumed
    await ctx.onTurn()
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.signal.aborted) return { kind: 'cancelled' }

    // The wait for the model is the longest silence in a run, and the one most
    // often mistaken for nothing happening.
    ctx.run.summary = ctx.run.writes.length
      ? `Thinking… (${ctx.run.writes.length} ${
          ctx.run.writes.length === 1 ? 'note' : 'notes'
        } so far)`
      : 'Thinking…'
    await ctx.onTurn()

    const turn = await runTurn(
      ctx.settings,
      system,
      forProvider(ctx.run.messages),
      QUEUE_TOOLS,
      ctx.signal,
    )
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: turn.text,
      reasoning: turn.reasoning,
      toolCalls: turn.toolCalls,
      providerRaw: turn.raw,
    }
    ctx.run.messages.push(assistantMessage)

    if (!turn.toolCalls.length) {
      await ctx.onTurn()
      return { kind: 'done', summary: summarise(turn.text, ctx.run.writes) }
    }

    ctx.run.pendingCalls = [...turn.toolCalls]
    await ctx.onTurn()

    const outcome = await processCalls(ctx)
    await ctx.onTurn()
    if (outcome) return outcome
  }

  return {
    kind: 'failed',
    error: `Stopped after ${MAX_STEPS} steps without finishing. Resume it to let it keep going, or re-run with a narrower instruction.`,
  }
}
