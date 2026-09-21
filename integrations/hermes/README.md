# Connecting Hermes to Deckle

This makes Deckle the knowledge base for a [Hermes](https://hermes-agent.nousresearch.com/)
agent: Hermes searches it before it starts work, keeps each piece of work in a
Deckle project, saves what it produces there — notes, reports, spreadsheets,
images, code — and logs what it did. You review it all in the Deckle app, where
the Activity feed shows every change under the agent's name.

Three pieces, all in this folder or already in Deckle:

| Piece | What it does |
| --- | --- |
| Deckle's MCP server, at `/api/v1/mcp` | The tools Hermes calls: `search`, `read`, `list`, `list_projects`, `recent_activity`, `write_note`, `save_file`, `create_project`, `update_project`, `log_progress`, `move`, `delete` |
| [`skills/deckle/SKILL.md`](skills/deckle/SKILL.md) | Teaches Hermes when to use them, how to organise projects, and what never to store |
| [`skills/deckle/scripts/deckle_push.py`](skills/deckle/scripts/deckle_push.py) | Sends large files and whole folders, which MCP is not built for |

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
five read tools. Then restart Deckle:

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
passes them to the push script's terminal.

## 4. Try it

Ask Hermes something like:

> Research the three most popular open-source ELT tools, compare their pricing
> and connector coverage, and put a report in Deckle.

Then open Deckle. A project appears under **Projects** (the folder icon in the
sidebar, or `Cmd`/`Ctrl`+`K` → *Projects*), and the Activity button in the top
bar counts what Hermes has done since you last looked. Files it saves open in
place: PDFs, images, spreadsheets, Word and PowerPoint documents, CSV, JSON,
text and code.

## Sending files and folders

`save_file` takes files up to 10 MB, base64-encoded, which is fine for a chart
or a spreadsheet and wasteful for anything bigger. For those, and for a whole
folder at once, Hermes runs the push script:

```bash
python3 scripts/deckle_push.py report.pdf --project "Acme research" --message "final report"
python3 scripts/deckle_push.py ./output --project "Acme research" --dry-run
python3 scripts/deckle_push.py ./site --to "Projects/Blog relaunch/site"
```

It never sends hidden files and folders (`.git`, `.env`, `.venv`), dependency
and build caches (`node_modules`, `__pycache__`, `target`…), or files that look
like credentials (`*.pem`, `*.key`, `id_rsa`, `credentials.json`, …), and it
honours a `.deckleignore` file of patterns at the top of a pushed folder. A
file that already exists is replaced — the old copy goes to Deckle's recycle
bin — unless `--no-overwrite` is given. Standard-library Python 3.8+, nothing
to install. You can run it yourself too.

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
- **Changes appear in an open app within about 15 seconds** — it polls the
  activity log while the tab is visible.
