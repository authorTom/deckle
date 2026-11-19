# Connecting Hermes to Deckle

This makes Deckle the knowledge base for a [Hermes](https://hermes-agent.nousresearch.com/)
agent: Hermes searches it before it starts work, keeps each piece of work in a
Deckle project, saves what it produces there — notes, reports, spreadsheets,
images, code — and logs what it did. You review it all in the Deckle app, where
the Activity feed shows every change under the agent's name.

It also works the other way: you write a **brief** in Deckle — instructions,
files to work from, what you want back — and Hermes, checking on a schedule,
takes it, does it, and delivers the results into the brief for you to review.

Four pieces, all in this folder or already in Deckle:

| Piece | What it does |
| --- | --- |
| Deckle's MCP server, at `/api/v1/mcp` | The tools Hermes calls: `search`, `read`, `list`, `list_projects`, `get_project_context`, `recent_activity`, `list_briefs`, `list_tasks`, `list_bookmarks`, `write_note`, `edit_note`, `save_file`, `create_project`, `update_project`, `log_progress`, `next_brief`, `report_progress`, `ask_user`, `deliver_file`, `complete_brief`, `create_brief`, `add_task`, `update_task`, `delete_task`, `save_bookmark`, `move`, `delete` |
| [`skills/deckle/SKILL.md`](skills/deckle/SKILL.md) | Teaches Hermes when to use them, how to organise projects, how to work a brief, and what never to store |
| [`skills/deckle/scripts/deckle_push.py`](skills/deckle/scripts/deckle_push.py) | Sends large files and whole folders, which MCP is not built for — into a project, or into a brief's Output |
| [`skills/deckle/scripts/deckle_pull.py`](skills/deckle/scripts/deckle_pull.py) | Downloads a brief's context files — PDFs, templates, images — to work on locally |

It needs Deckle's **server library** — Hermes reaches Deckle over the network,
so the notes have to live on the server, not in a browser.

## 1. Give Hermes a token

Generate a secret and add a token for Hermes to Deckle's `.env`, next to
`compose.yaml`:

```bash
openssl rand -base64 32
```

```bash
DECKLE_SERVER_LIBRARY=true
DECKLE_PASSWORD=a-long-passphrase-for-you
DECKLE_API_TOKENS=hermes:rw:PASTE-THE-SECRET-HERE
```

The name before the first colon (`hermes`) is what the Activity feed calls the
agent. `rw` lets it write; start with `r` (read-only) if you want to watch it
search and read for a while first — a read-only token is offered only the
read tools. Then restart Deckle:

```bash
docker compose up -d
```

The startup log should say `MCP server at /api/v1/mcp (same tokens)`. Check
the endpoint answers:

```bash
curl -s -H "Authorization: Bearer PASTE-THE-SECRET-HERE" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://deckle.example.com/api/v1/mcp | head -c 400
```

## 2. Point Hermes at it

Put the token where Hermes can read it — in the environment it runs in, or in
`~/.hermes/.env`:

```bash
DECKLE_URL=https://deckle.example.com
DECKLE_TOKEN=PASTE-THE-SECRET-HERE
```

Then add Deckle to `mcp_servers` in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  deckle:
    url: "https://deckle.example.com/api/v1/mcp"
    headers:
      Authorization: "Bearer ${DECKLE_TOKEN}"
    timeout: 120
```

Deckle's MCP endpoint is Streamable HTTP and answers in plain JSON, which is
Hermes's default for a `url` server — don't set `transport: sse`. Run
`/reload-mcp` in a Hermes session (or restart it) and its tools appear as
`mcp__deckle__search`, `mcp__deckle__save_file` and so on.

If Hermes runs on the same machine as Deckle, `http://localhost:8080` works
for both `DECKLE_URL` and the MCP `url`. In the same Docker network, use the
Deckle service's name instead (`http://deckle:8080`).

## 3. Install the skill

Copy it into Hermes's skills folder:

```bash
cp -r integrations/hermes/skills/deckle ~/.hermes/skills/deckle
```

— or leave it in this repository and list it in `~/.hermes/config.yaml`, so
pulling a new Deckle updates it too:

```yaml
skills:
  external_dirs:
    - /path/to/deckle/integrations/hermes/skills
```

The skill declares `DECKLE_URL` and `DECKLE_TOKEN` as required, so Hermes
passes them to the push and pull scripts' terminal.

## 4. Try it

Ask Hermes something like:

> Research the three most popular open-source ELT tools, compare their pricing
> and connector coverage, and put a report in Deckle.

Then open Deckle. A project appears under **Projects** (the folder icon in the
sidebar, or `Cmd`/`Ctrl`+`K` → *Projects*), and the Activity button in the top
bar counts what Hermes has done since you last looked. Files it saves open in
place: PDFs, images, spreadsheets, Word and PowerPoint documents, CSV, JSON,
text and code.

## 5. Hand it work: briefs

Open the **Agents** tab in Deckle's left panel (the robot icon, or
`Cmd`/`Ctrl`+`K` → *New brief for an agent*) and write a brief: the project it
belongs to, a title, instructions, files to work from (dropped into the form,
folders and ZIPs included), the file types you want back, and optionally the
agent, a priority, a due date, a date not to start before, and a repeat. Queue
it.

Then give Hermes a scheduled job that checks the queue. Ask it, in a session:

> Every 15 minutes, check Deckle for work: call `next_brief`. If it gives you a
> brief, do it following the deckle skill — `report_progress` after each step,
> `deliver_file` (or `deckle_push.py --brief`) for each finished file,
> `ask_user` if you are blocked, `complete_brief` at the end. If there is
> nothing, stop without saying anything.

Hermes's built-in scheduler keeps that job and runs each check in a fresh
session. That is why a brief carries everything needed to start cold — its
instructions, its files, and its run log, which holds your answers and change
requests — and why the skill tells Hermes to rely on the brief rather than on
memory. Fifteen minutes is a suggestion; a check that finds nothing costs one
small request.

What you see in Deckle:

- The card moves from **Queued** to **Running**, showing Hermes's latest
  progress line, live.
- If Hermes needs something from you, the brief moves to **Needs you** with its
  question. Answer it on the card and it goes back in the queue with your
  answer.
- When Hermes is done, the brief is **Ready for review**, with everything it
  delivered listed on the card — Word, PowerPoint, Excel, PDF, anything — each
  opening in place. **Approve** it, or **Request changes** with a comment, which
  queues it again; Hermes picks it up with your comment and its earlier output.
- A brief that repeats (daily, weekly, monthly) is a work stream: each run
  delivers into a dated `Output/<date>/` folder and the next run waits for its
  date.
- The tab's count is how many briefs are waiting on you. The panel also lists
  every agent that has been in touch and when it last checked for work, so a
  scheduled job that has stopped is easy to spot.

If Hermes takes a brief and then goes quiet — the session crashed, the machine
slept — the claim lapses after 30 minutes without a progress report and the
brief goes back in the queue (`DECKLE_BRIEF_LEASE_MINUTES` changes that).

On disk a brief is a folder, so you can also write one by hand:

```
Projects/Acme research/Briefs/2026-11-19 Vendor comparison/
  Brief.md    instructions; front matter: status, agent, priority, due, start, repeat, outputs
  Context/    files to work from
  Output/     what the agent delivers
  Run.md      the dated record — progress, questions, answers, change requests
```

Files in `Projects/<name>/Context/` are offered with every brief in that
project — a style guide, a template, a glossary.

## Sending files and folders

`save_file` takes files up to 10 MB, base64-encoded, which is fine for a chart
or a spreadsheet and wasteful for anything bigger. For those, and for a whole
folder at once, Hermes runs the push script:

```bash
python3 scripts/deckle_push.py report.pdf --project "Acme research" --message "final report"
python3 scripts/deckle_push.py ./output --project "Acme research" --dry-run
python3 scripts/deckle_push.py ./site --to "Projects/Blog relaunch/site"
python3 scripts/deckle_push.py deck.pptx --brief "Projects/Acme/Briefs/2026-11-19 Pitch deck"
```

It never sends hidden files and folders (`.git`, `.env`, `.venv`), dependency
and build caches (`node_modules`, `__pycache__`, `target`…), or files that look
like credentials (`*.pem`, `*.key`, `id_rsa`, `credentials.json`, …), and it
honours a `.deckleignore` file of patterns at the top of a pushed folder. A
file that already exists is replaced — the old copy goes to Deckle's recycle
bin — unless `--no-overwrite` is given. Standard-library Python 3.8+, nothing
to install. You can run it yourself too.

`--brief` delivers into a brief Hermes is working (it must hold it, from
`next_brief`), exactly as `deliver_file` would. Going the other way,
`deckle_pull.py` downloads a brief's context files — including the PDFs and
images MCP's `read` can't return — into a local folder:

```bash
python3 scripts/deckle_pull.py "Projects/Acme/Briefs/2026-11-19 Pitch deck" ./work
python3 scripts/deckle_pull.py "Projects/Acme/Briefs/2026-11-19 Pitch deck" ./work --output   # and earlier output
```

## Other agents

Any MCP client can work briefs with its own token — Claude Code, for one:

```bash
claude mcp add --transport http deckle https://deckle.example.com/api/v1/mcp \
  --header "Authorization: Bearer ANOTHER-SECRET" -s user
```

with `claude-code:rw:ANOTHER-SECRET` added to `DECKLE_API_TOKENS`. Each agent
is told only of briefs addressed to its token's name or to no one, so setting
**Agent** on a brief decides who does it. Agents can queue briefs for each
other with `create_brief`.

## What to expect, honestly

- **Deckle has no AI in it.** Hermes does the thinking; Deckle stores,
  shows, searches and records. Nothing you store is sent anywhere.
- **Search is by words, not meaning.** It ranks notes and the text inside
  Word, Excel, PowerPoint, OpenDocument, CSV, JSON, text and code files.
  **PDFs and images are found by name only**, and by the notes that link to
  them — which is why the skill asks Hermes to describe every important file
  in a note.
- **Every change is recoverable.** A replaced note keeps its old version in
  history; a replaced or deleted file goes to the recycle bin; nothing the
  agent does is permanent unless it asks for `permanent=true` over REST.
- **A read-write token can change anything in the library.** Deckle has no
  per-folder permissions. If that is too much, give Hermes a library of its
  own, or a read-only token plus a separate place to write.
- **Changes appear in an open app at once**, over a live stream — or within
  about 15 seconds behind a proxy that won't carry one.
- **Deckle doesn't run anything.** A brief waits until an agent asks for work;
  if no scheduled job is checking, nothing happens, and the Agents tab shows
  when each agent last checked.
- **You and the agent share a brief's files.** Editing a brief's instructions
  while it runs is allowed, but the agent may already have read them; cancel
  it and run it again instead.
