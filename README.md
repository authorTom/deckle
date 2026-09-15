# Deckle

**A clean, minimalist, web-based knowledge management platform.**

Markdown notes with live WYSIWYG editing, a Todoist-style task planner,
bookmarks with collections and comments, and an AI assistant that can search and
edit your knowledge base — plus a keyboard-driven command palette, light and
dark mode, and a fully responsive layout.

Everything lives as plain Markdown files in a folder you can open, and you
choose where: on your own computer, or — if you self-host with Docker — in a
volume on your own server, which makes Deckle fully web based and leaves nothing
on the device you're using. No third-party account, no lock-in.

**[deckle.redacre.net](https://deckle.redacre.net/)** — the project website: what
Deckle does, how to install it, and the questions people ask first. There is no
hosted version to sign up for; you run it yourself.

![Markdown notes with a folder tree, editor tabs, live WYSIWYG editing, and a backlinks panel](docs/screenshots/editor.png)

| Task planner — Inbox, Today, Upcoming with a mini calendar | Bookmarks — collections and per-bookmark comments |
| --- | --- |
| ![Todoist-style task planner with due dates, priorities, and a month calendar](docs/screenshots/tasks.png) | ![Bookmarks with coloured collections and a comment box](docs/screenshots/bookmarks.png) |
| **AI assistant — search and edit your library (dark mode)** | **Command palette — everything a keystroke away** |
| ![AI assistant panel in dark mode](docs/screenshots/assistant.png) | ![Command palette in dark mode, listing commands from new note to split editor and themes](docs/screenshots/palette.png) |

## Why it exists

Note-taking apps ask you to choose between two bad options. The hosted ones are
polished but keep your notes in their database, on their terms, for as long as
they stay in business. The local ones keep your files but tie you to one
machine, or to a sync service you also have to trust.

Deckle keeps the files as ordinary `.md` on disk — openable in any editor,
syncable, backed up by whatever you already use — while running entirely in the
browser. Self-host it and the same library is reachable from a laptop, a phone or
Safari with nothing stored on the device.

The AI assistant follows the same principle: it can read and rewrite your whole
library, but every change to a note is shown as a diff you approve first, and
your API keys go nowhere except the provider — held in your browser, or, if you
self-host behind a password, on your own server so your other devices are
already set up. The one thing it writes on its own is its memory of how you
work, which is Markdown you can read and delete.

## What it does

- **Live WYSIWYG markdown** — type markdown (`# `, `**bold**`, `- list`) and it
  renders inline as you go (powered by TipTap / ProseMirror).
- **Local folder library** — pick a folder and Deckle reads and writes your notes
  there as real `.md` files. Open the same folder in another editor, sync it, or
  back it up — it's just Markdown on disk. (Chromium browsers; Safari and Firefox use
  private in-browser storage — see
  [Where your notes are stored](#where-your-notes-are-stored).)
- **Or a server library** — self-host with Docker and your notes can live in a
  volume on your own server instead, password protected, reachable from any
  browser or device with nothing stored locally.
- **Folder tree** — browse nested subfolders, create folders, and
  **drag-and-drop** notes between them: drop onto a folder, onto any note
  already inside one, or hold over a shut folder and it springs open so you can
  carry a note further down in one go.
- **Move to another folder…** — when dragging isn't practical (a long tree, a
  collapsed destination, a phone), move a note by naming its destination
  instead: from the note's row in the tree, from a search result, from the
  editor menu, or from the command palette. Pick a folder from the whole
  library, or type a name — including a nested one like `Archive/2026` — and it
  is created on the way.
- **Command palette** — `Ctrl`/`Cmd`+`K` opens a fast, fully keyboard-driven
  palette for commands, formatting, and jumping to any note.
- **Search across the library** — find notes by title, path, or file contents.
- **Tasks and planner** — a Todoist-style panel docked on the left: Inbox,
  Today, Upcoming (agenda and mini month calendar), projects, priorities
  (P1–P4), recurring tasks, a completed log, and a bin for deleted tasks
  (restorable, auto-purged after 30 days). Highlight text in a note and press
  `Ctrl`/`Cmd`+`Shift`+`A` to capture it as a task that links back to the note.
  Tasks live in a hidden `.deckle/tasks.json` inside your library, so they sync and
  back up with your notes.
- **Bookmarks** — save URLs, pages and products into coloured collections, each
  with its own comment box. Paste a link to add it, or select a link in a note
  and use the bookmark button — captured bookmarks link back to their source
  note. Stored in `.deckle/bookmarks.json` in the library.
- **Version history** — restore points are saved automatically: before every AI
  edit, periodically while you type, and before every restore. Open the clock
  icon to preview, restore or delete a note's earlier versions (kept in a hidden
  `.history` folder, 20 per note).
- **Recycle bin** — deleted notes move to a hidden `.trash` folder and can be
  restored or permanently removed.
- **AI assistant** — an optional right-side chat panel that can search and read
  your whole library and create, edit, move or delete notes and folders. Every
  change to a note is shown as a diff and must be approved before it runs. Ask questions
  about your notes and it finds and cites the relevant ones. Works with an
  Anthropic, OpenAI or [OpenRouter](https://openrouter.ai) API key, or fully
  locally via [LM Studio](https://lmstudio.ai). Reasoning models show a
  collapsible "Thought process". The model it is using is named above the
  conversation and switches from there — provider included, so moving between a
  local model and Claude is one click, not a trip to a settings screen. Your API
  key stays in your browser — or, on a password-protected server library, on the
  server, so every device you sign in from is configured already.
- **Send it, or queue it** — the assistant's composer has two buttons. *Send*
  answers in the conversation; *Queue* hands the same words to the background
  and gives you the box back. The panel has a **Queue** tab beside Chat holding
  everything in flight — what needs you, what is working, what is waiting its
  turn — and one line above the composer keeps you posted while you chat. Jobs run one at a time or several at once, and their
  output lands in an **Assistant inbox** folder. Each is pinned to the model you
  queued it against — send the long one to Opus and the tidy-up to Haiku, and
  see which ran what. That folder is the safety boundary — inside it the
  assistant writes freely; anything outside stops the run and asks you to
  approve the exact change, and deletions always ask. A run that needs a
  decision can ask you a question and wait: only those are badged, on the
  assistant button itself, so a parked run is visible with the panel closed.
  Finished runs list what they wrote, and any run can be resumed or re-run.
  Runs live in `.deckle/runs/` inside the library.
- **Assistant memory** — the assistant keeps what it learns about how you work
  as ordinary Markdown in a hidden `.deckle/memory/` folder: one file per fact,
  with a one-line index. Only that index is sent with every message; the rest is
  fetched when it is relevant to what you asked, inside a token budget, and
  recording something it already knows updates that memory rather than adding a
  near-duplicate. Read, edit, pin or delete any of it from *Assistant memory* in
  the command palette — or open the files in any editor. Off with one tick box.
- **Semantic library search (optional)** — enable embeddings in the assistant
  settings (OpenAI or a local LM Studio embedding model) and library search
  matches by meaning, not just keywords. Vectors are cached locally and only
  changed notes are re-embedded; keyword (BM25) search always works without it.
- **Inline Ask AI** — highlight text and click the brain icon to improve, fix,
  shorten, summarise, explain, or run a custom prompt on just that passage, then
  Replace / Insert / Copy the result.
- **Quick formatting** — toolbar and floating selection menu for bold, italic,
  strikethrough, inline code, headings (H1–H3), lists and quotes.
- **Focus mode** — hide all chrome for distraction-free writing
  (`Ctrl`/`Cmd`+`Shift`+`F`, or `Esc` to exit).
- **About** — *About Deckle* in the editor menu or the command palette names the
  version you are running, the library you have open, and which of the three
  backends is holding it.
- **Light and dark mode** — defaults to your system preference; choice persists.
- **Responsive** — desktop, tablet and mobile (collapsible note drawer).
- **Import** — drop `.md` files, or a whole folder of them, anywhere on the note
  tree; nested folders keep their structure and nothing is ever overwritten.
  Importing from the picker asks where the notes should go first — any folder in
  the library, or a new one you name — and tells you how many it found before
  writing anything.
- **Export** — download a note as `.md`, export it to PDF via a clean print
  layout, or take the whole knowledge base as a ZIP: every note in its folder
  structure plus your tasks, bookmarks and the assistant's memory, optionally
  with the recycle bin and version history for a full backup.
- **REST API (optional)** — a token-authenticated API at `/api/v1` so an agent
  or script can search, read, write and organise your knowledge base, described
  by an OpenAPI 3.1 document the server publishes itself. See
  [API](#api).

## Where your notes are stored

Deckle has three storage backends behind the same library interface. Whichever you
use, your notes are ordinary `.md` files in an identical folder layout — so a
library copied from a disk folder into the server's volume (or the other way
round) just works. Only the in-browser library is awkward to copy, since it lives
in browser-managed storage rather than a folder you can open.

- **A folder on your computer** — **Chromium desktop browsers** (Chrome, Edge,
  Brave, Opera) use the
  [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API):
  you pick a real folder on disk and your notes are ordinary files you can open
  in other apps, sync, or back up.
- **Privately in your browser** — **Safari and Firefox** fall back to the
  [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system):
  notes are still real `.md` files, but they live in private browser storage on
  your device — not in a folder you can browse — because those browsers don't
  implement the folder picker.
- **On your own server** — when you self-host with Docker, notes are stored in a
  volume on the machine running Deckle. The app then works from any browser,
  including Safari and mobile, and nothing is kept on the device you're using.

When a server library is available, Deckle asks which you want on first load; you can
switch later from the command palette (`Ctrl`/`Cmd`+`K`). Nothing is copied
between backends automatically.

## Run it

### With Docker (recommended)

Every push to `main` publishes a multi-arch (amd64 + arm64) image to GitHub
Container Registry, so deploying needs no source checkout and no local build.

```bash
curl -O https://raw.githubusercontent.com/authorTom/deckle/main/compose.yaml
docker compose up -d          # pulls ghcr.io/authortom/deckle:latest
```

Open **<http://localhost:8080>**.

The bundled `compose.yaml` **enables the server library** and mounts a volume for
it, because that is the setup most people deploying Deckle to a server actually
want. It starts with **no password** unless you set one — read
[Security](#security) before putting it anywhere reachable.

To change the host port, pin an image tag, or set the password, drop a `.env`
next to `compose.yaml` (Compose reads it automatically):

```bash
curl -O https://raw.githubusercontent.com/authorTom/deckle/main/.env.example
mv .env.example .env          # then edit DECKLE_PORT / DECKLE_IMAGE / DECKLE_PASSWORD
```

Updating:

```bash
docker compose pull && docker compose up -d
```

That takes the newest release. To decide for yourself how far each pull moves
you, set `DECKLE_IMAGE` in `.env` to whichever tag matches your appetite:

| Tag | What you get |
| --- | --- |
| `:latest` | The newest release. The default |
| `:1` | Newest `1.x` — fixes and new features, never a breaking change |
| `:1.4` | Newest `1.4.x` — fixes only |
| `:1.4.2` | Exactly that release. Never moves, so a rollback is a one-line edit |
| `:edge` | The tip of `main`, unreleased. For trying things, not for deployments |

Every release is described in the [changelog](CHANGELOG.md), and what those
numbers promise is spelled out under [Versioning](#versioning).

**Running the image directly**, without compose. Note that the image itself
ships with the server library **off**, so this is a static file server with notes
on your device:

```bash
docker run -d --name deckle -p 8080:8080 --restart unless-stopped \
  ghcr.io/authortom/deckle:latest

# ...or with a server library:
docker run -d --name deckle -p 8080:8080 --restart unless-stopped \
  -e DECKLE_SERVER_LIBRARY=true -e DECKLE_PASSWORD=a-long-passphrase \
  -v nib-vault:/data \
  ghcr.io/authortom/deckle:latest
```

To build the image yourself rather than pull it, uncomment the `build:` block in
`compose.yaml` and run `docker compose up -d --build`.

### From source

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build to dist/
npm run preview  # preview the production build
```

On first run in a Chromium browser, click **Open folder** and choose a folder to
use as your library — Deckle remembers it for next time (you may be asked to re-grant
access on return). In Safari or Firefox, click **Get started** to create the
private in-browser library.

To use the AI assistant, open the panel (sparkles icon) → settings (gear) and
pick a provider: Anthropic (Claude), OpenAI, OpenRouter, or a local LM Studio
server. Keys are kept in `localStorage` and sent only to the provider you chose.

There is also a containerised dev server, if you would rather not install Node:

```bash
docker compose --profile dev up dev   # → http://localhost:5173
```

That profile runs Vite alone, so the server library isn't reachable from it and
Deckle offers only the local backends. To develop against the server library with hot
reload, run the API server next to Vite instead — `npm run dev` proxies `/api`
to `http://127.0.0.1:8080` (override with `DECKLE_API_TARGET`):

```bash
DECKLE_SERVER_LIBRARY=true DECKLE_LIBRARY_DIR=./library node server/index.mjs &
npm run dev                           # → http://localhost:5173
```

To run the tests — the server through its real HTTP handler, the API, every
storage path, the assistant's tools and autosave:

```bash
npm test                              # once, as CI runs it
npm run test:watch                    # re-run on change
```

## Configuration

Only relevant when the server library is enabled.

| Variable | Default | What it does |
| --- | --- | --- |
| `DECKLE_SERVER_LIBRARY` | *(off)* | `true` enables the server library |
| `DECKLE_PASSWORD` | *(none)* | Password for the library. **Blank means no password at all** |
| `DECKLE_LIBRARY_NAME` | `My Notes` | Name shown in the app |
| `DECKLE_SESSION_SECRET` | *(random)* | Fixed cookie-signing key, so restarts don't sign everyone out |
| `DECKLE_SESSION_TTL_DAYS` | `30` | How long a sign-in lasts |
| `DECKLE_TRUST_PROXY` | *(none)* | `true` behind a reverse proxy (a number for a chain of them), so sign-in throttling sees real client addresses |
| `DECKLE_LIBRARY_DIR` | `/data` | Where the notes live inside the container |
| `DECKLE_STATE_DIR` | `<library>/.deckle-state` | Deckle's own state — the shared assistant settings. Never served as part of the library |
| `DECKLE_API_TOKENS` | *(none)* | Bearer tokens for the [API](#api). Blank leaves it switched off |
| `DECKLE_API_CORS_ORIGINS` | *(none)* | Origins allowed to call `/api/v1` from a browser |
| `DECKLE_PORT` | `8080` | Host port (compose only) |

Everything else — theme, AI provider, embeddings — is set in the app itself. On
a server library with a password, the assistant's settings (including the API
key) are kept by the server rather than by one browser, so signing in from a new
device finds the assistant already configured. See
[Assistant settings across devices](#assistant-settings-across-devices).

### Assistant settings across devices

The assistant's settings — provider, model, custom instructions and the API key
— normally live in the browser you typed them into. That is the right home for a
library on your own disk, but not for a server library, which exists precisely
so the same notes are reachable from a laptop, a phone and a borrowed machine.

So a **password-protected** server library keeps one copy of them for everyone
who signs in:

- Sign in on a new device and the assistant is already configured. Nothing to
  turn on.
- The first device to save seeds the server with what it already has, so
  switching to a server library never loses a key you had entered.
- Everything travels except the **LM Studio URL** — that usually points at
  `localhost`, which is a different machine's localhost on every device.
- Signing out of the server library forgets the settings it lent that browser.

They are stored in `DECKLE_STATE_DIR` (by default `.deckle-state` inside the
library directory, mode `0600`), which is *not* part of the library: the file
API refuses to read it, it never appears in a tree, a listing, or an export, and
the assistant's own tools cannot reach it. Only a request holding a valid
session cookie can read it back.

**Without `DECKLE_PASSWORD` the server declines to hold a key at all**, and says
so in the settings panel. An open server would hand it to anyone who could reach
the port, and that is the user's decision to make deliberately, not a default to
inherit.

### Upgrading from before the rename

This app was called Nib, and its configuration was named `NIB_*` — `NIB_PASSWORD`,
`NIB_SERVER_VAULT`, and so on. Those names are still read, so pulling a new image
over an existing `.env` keeps working, and the server logs which deprecated names
it honoured at startup. Rename them at your convenience — they are read for the
whole of 1.x and removed no earlier than 2.0.0.

Two things deliberately keep their old names, because changing them would move
data rather than rename it:

- The Docker volume is still `nib-vault`. Renaming it in `compose.yaml` would
  create a new, empty volume and serve an empty library while your notes sat in
  the old one. To rename it, migrate the contents yourself first.
- Tasks and bookmarks moved from `.nib/` to `.deckle/` inside your library.
  Deckle reads the old folder when the new one is empty and writes to the new one
  from then on, so nothing is lost. The leftover `.nib/` is a stale copy you can
  delete once you have saved a change.

On first load with a server library available, pick **On this server** and enter
the password. To switch away later, open the command palette → *Sign out of the
server library* (or *Leave the server library* when no password is set). The same
entry reads *Switch to the server library* when you're using a local one.

## Versioning

Deckle follows [Semantic Versioning](https://semver.org). The number exists to
answer one question before you pull: **do I need to read anything first?**

- **Major** (`1.4.2` → `2.0.0`) — something you depend on changed. A removed or
  incompatibly changed `/api/v1` endpoint, a configuration name dropped rather
  than aliased, a library layout an older Deckle can no longer read, a storage
  backend or browser no longer supported, or a change to the container's volume
  path or port. If an upgrade needs you to do something, it is a major.
- **Minor** (`1.4.2` → `1.5.0`) — new things; your deployment keeps working
  untouched. New endpoints and fields, new configuration with safe defaults, new
  features and UI.
- **Patch** (`1.4.2` → `1.4.3`) — bug fixes, performance, accessibility, docs,
  and security fixes that need no configuration change.

A redesign is not a breaking change. What is promised is the API, the
configuration names, the on-disk layout and the shape of the deployment —
not that the app looks the same.

Three numbers move independently, and it's worth knowing which is which:

| Number | Where you see it | Moves when |
| --- | --- | --- |
| The app's version | *About Deckle* in the app (also the `?` sheet), the startup log, `GET /api/v1/health` | Every release |
| The API version | The `/api/v1` path itself | Only when the API contract breaks |
| Data-format versions | `version` inside `.deckle/tasks.json` and `bookmarks.json` | Only when that file's shape changes |

So a 2.0.0 does not renumber your task file, and a new task-file format does not
force a major — each says only what it is about.

Every release is in the [changelog](CHANGELOG.md), and on
[Releases](https://github.com/authorTom/deckle/releases).

## API

Deckle can expose the whole knowledge base over HTTP at `/api/v1`, so an agent can
search your notes, answer from them, write new ones, and file tasks and
bookmarks — everything the app can do, without a browser.

It is off until you configure a token, and it needs the **server library**: a
local folder or in-browser library lives on your device, where nothing outside
that browser can reach it.

```bash
# in .env, next to compose.yaml
DECKLE_SERVER_LIBRARY=true
DECKLE_API_TOKENS=hermes:rw:$(openssl rand -base64 32)
```

```bash
docker compose up -d
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/health
```

Tokens are comma-separated. Each is either a bare secret (read-write) or
`name:scope:secret`, where scope is `r` or `rw`. Give every consumer its own, so
one can be revoked without disturbing the rest, and use `r` for anything that
only reads — a read-only token gets `403` on any write.

```bash
DECKLE_API_TOKENS=hermes:rw:SECRET_ONE,dashboard:r:SECRET_TWO
```

Every deployment publishes its own OpenAPI 3.1 description, so most agent
frameworks can generate tools from it rather than having them written by hand:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/openapi.json
```

The three calls that matter most for answering questions from a knowledge base:

```bash
# 1. Find the relevant notes (ranked, with snippets)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/api/v1/search?q=latency+budget&limit=5"

# 2. Read one in full
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/api/v1/notes/Projects/idea.md"

# 3. Write what you learned back
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST http://localhost:8080/api/v1/notes \
  -d '{"title":"Latency review","folder":"Projects","content":"# Latency review\n\n…"}'
```

### Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness, the Deckle version, and which library is served |
| `GET` | `/openapi.json` | This API's OpenAPI 3.1 description |
| `GET` | `/notes` | List notes (`folder`, `limit`, `offset`, `sort`, `include_content`) |
| `POST` | `/notes` | Create a note; collisions get a numbered name rather than overwriting |
| `GET` | `/notes/{path}` | Read a note (`?format=markdown` for the raw file) |
| `PUT` | `/notes/{path}` | Create or replace a note |
| `PATCH` | `/notes/{path}` | `append` / `prepend` / `content`, or rename and move |
| `DELETE` | `/notes/{path}` | To the recycle bin (`?permanent=true` to erase) |
| `GET` | `/search` | BM25-ranked search with snippets (`q`, `limit`, `folder`) |
| `GET` | `/folders` | The folder and note tree |
| `POST` | `/folders` | Create a folder, including missing parents |
| `DELETE` | `/folders/{path}` | Delete a folder; its notes go to the recycle bin |
| `POST` | `/import` | Create up to 1000 notes in one call |
| `GET` | `/export` | The whole library as a ZIP (`?include_hidden=true` for a full backup) |
| `GET` `POST` | `/tasks` | List (`filter=inbox\|today\|upcoming\|overdue\|completed`) or add |
| `GET` `PATCH` `DELETE` | `/tasks/{id}` | Read, edit, complete or bin a task |
| `GET` `POST` | `/projects` | Task projects |
| `GET` `POST` | `/bookmarks` | List and save bookmarks |
| `GET` `PATCH` `DELETE` | `/bookmarks/{id}` | Read, edit or delete a bookmark |
| `GET` `POST` | `/collections` | Bookmark collections |
| `GET` | `/history` | Version snapshots (`?path=` for one note) |
| `GET` | `/history/{snapshot}` | Read a snapshot's content |
| `POST` | `/history/{snapshot}/restore` | Restore a snapshot over its note |
| `GET` | `/trash` | What is in the recycle bin |
| `POST` | `/trash/{trashName}/restore` | Restore a deleted note |
| `DELETE` | `/trash/{trashName}` | Erase one recycle-bin item |

Paths are library-relative with `/` separators — `Projects/idea.md` — and the
`.md` is added if you leave it off. Hidden dot folders are reserved by Deckle and
rejected; `.trash`, `.history` and `.deckle` have their own endpoints instead.
Errors are always `{ "error": { "code": …, "message": … } }` with a matching
HTTP status.

## How it's built

React · TypeScript · Vite · TipTap + tiptap-markdown (editor) · lucide-react
(icons) · @anthropic-ai/sdk (Claude; OpenAI-compatible providers via `fetch`).

The library — a folder on disk, OPFS, or the server — is the source of truth for
notes; IndexedDB only remembers your chosen folder and caches search embeddings.
All three backends sit behind the browser's `FileSystemDirectoryHandle`
interface, so the rest of the app doesn't know or care which one is in use: the
server library is an adapter ([`src/fs/remote.ts`](src/fs/remote.ts)) that
implements that same interface over HTTP.

The container's server ([`server/`](server/)) is plain Node with **no
dependencies** — only built-in modules — so there is nothing to audit or patch
beyond Node itself.

```
server/                  # Container runtime (Node built-ins only, no deps)
  index.mjs              # Entry point: boot, listen, graceful shutdown
  app.mjs                # The HTTP app: configuration, routing, error handling
  library-api.mjs        # Server library file API (tree/read/write/mkdir/delete)
  library-store.mjs      # Library semantics server-side: trash, history, tasks…
  auth.mjs               # Optional password gate + signed session cookies
  api.mjs                # /api/v1 REST API for agents and scripts
  api-auth.mjs           # Bearer tokens for the API, with read-only scopes
  throttle.mjs           # Failed-attempt throttling, and trusted-proxy client addresses
  dates.mjs              # Recurring-task dates, mirroring src/tasks/dates.ts
  openapi.mjs            # The API's self-served OpenAPI 3.1 description
  search.mjs             # BM25 ranking behind GET /api/v1/search
  zip.mjs                # Streaming ZIP writer behind GET /api/v1/export
  paths.mjs              # Library path validation (traversal + symlink escapes)
  legacy-env.mjs         # Honours the pre-rename NIB_* configuration names
  static.mjs             # Serves the built SPA: caching, gzip, security headers

src/
  App.tsx                # Layout, theme, focus mode, modals, command palette
  fs/                    # Library backends: disk, OPFS, remote; version history
  fs/appData.ts          # The hidden .deckle folder, and reading its old name
  db/notes.ts            # IndexedDB store for the chosen folder handle
  ai/                    # Chat loop, providers, library tools, retrieval, settings
  tasks/                 # Task state and persistence (.deckle/tasks.json)
  bookmarks/             # Bookmark state and persistence (.deckle/bookmarks.json)
  hooks/                 # Theme, notes tree, autosave, move, search, history
  components/            # Sidebar, editor, palette, assistant, panels, modals
  memory/                # Assistant memory (.deckle/memory/*.md)
  queue/                 # Background run queue (.deckle/runs/), executed in the browser
  lib/                   # Markdown, PDF and ZIP export; Markdown import; BM25
  styles/                # theme / global / editor / print CSS

test/                    # npm test (Vitest)
  server/                # The server through its real HTTP handler: auth, API, storage
  client/                # Library, storage, queue, assistant tools, hooks and autosave
  helpers/               # An in-memory File System Access API, and a test server
```

## Security

Relevant when you enable the server library.

- **One library, one password.** Deckle has no user accounts, so everyone who signs
  in shares the same notes.
- **A blank `DECKLE_PASSWORD` means no protection.** Anyone who can reach the port
  can read and write every note. That is only reasonable behind a VPN,
  Tailscale, or a reverse proxy that authenticates — the server logs a warning
  at startup when it happens.
- **How signing in works.** The password is checked in constant time and
  exchanged for a signed, `HttpOnly`, `SameSite=Strict` session cookie — it
  isn't stored in the browser and isn't sent again after sign-in. Repeated
  failures from one address are throttled (10 per 15 minutes). Sessions last
  `DECKLE_SESSION_TTL_DAYS`; if one expires while the app is open, Deckle returns to
  the unlock screen rather than failing saves silently. Changing
  `DECKLE_PASSWORD` signs every session out.
- **Behind a reverse proxy, set `DECKLE_TRUST_PROXY=true`.** Throttling counts
  failures per client address. Without the setting Deckle uses the address that
  connected — which, behind Caddy or nginx, is the proxy for everyone — and
  ignores `X-Forwarded-For`, because any client can write that header and would
  otherwise dodge the throttle by naming a new address on every guess. With it,
  only the entries your proxy appended are believed.
- **The page runs only its own scripts.** Every response carries a
  Content-Security-Policy with `script-src 'self'`, so script that reaches the
  page by any route — a note, a bookmark, a dependency bug — cannot run. It
  still allows the browser to call any AI provider, including an LM Studio on
  your network.
- **AI keys.** The server never proxies AI requests — your browser always calls
  the provider itself. Where the key is *kept* depends on the deployment: with a
  password set, the server holds one copy for every device that signs in, stored
  outside the library (`DECKLE_STATE_DIR`, mode `0600`) and served only to a
  request carrying a valid session. The library API refuses to read it, so it
  cannot leave in an export, through `/api/v1`, or via the assistant's own
  file-reading tools. With no password set the server declines to hold a key at
  all, and each browser keeps its own.
- **API tokens are passwords.** A read-write token can read, rewrite and delete
  every note. Give each consumer its own so one can be revoked alone, and start
  anything new on a read-only (`r`) token until its behaviour looks sane.
  Rotating means editing `DECKLE_API_TOKENS` and restarting; there is no token
  store to clean up. Failed attempts are throttled (20 per 15 minutes).
- **The API and the app share a library, not a login.** `/api/v1` ignores the
  session cookie and accepts only `Authorization: Bearer`. A browser never
  attaches that header on its own, so there is no CSRF surface and a stolen
  session cookie cannot reach the API.
- **Agent edits are as recoverable as yours.** Deleting through the API moves
  the note to the same recycle bin, and overwriting snapshots the replaced
  version into the same history — so a bad agent run is undone from the app's
  own dialogs rather than from a backup.
- **Queued runs are fenced into one folder.** A background run may write freely
  only inside the Assistant inbox; anything outside it stops and waits for you
  to approve the exact change, and deletions stop wherever they are. Everything
  it does is still snapshotted to `.history` and recoverable from `.trash`.
- **The assistant writes without asking in exactly one place.** Its own memory,
  under `.deckle/memory/`, which touches no note. Everything that changes a note
  still goes through the diff. The memory is plain Markdown you can read, edit
  and delete — from *Assistant memory* in the command palette, or in any editor.

> **HTTPS matters in production.** The File System Access API and OPFS require a
> secure context — `http://localhost` is fine for local use, but anything served
> from another host must sit behind TLS (Caddy, Traefik, or nginx with
> certificates), or the local library features won't be available. The server
> library works without a secure context, but sends your password and session
> cookie in the clear, so it needs TLS just as much. The cookie is marked
> `Secure` automatically when the request arrives over HTTPS.

## Backing up

The quickest route is in the app: **Export** at the bottom of the sidebar (or
the command palette) downloads the whole knowledge base as a ZIP, with a tick
box to include the recycle bin and version history. That works on every backend,
including the in-browser library that has no folder to copy. The API can do the
same thing unattended:

```bash
curl -H "Authorization: Bearer $TOKEN" -OJ \
  "http://localhost:8080/api/v1/export?include_hidden=true"
```

Otherwise your notes are just files:

```bash
docker run --rm -v nib-vault:/data -v "$PWD:/out" \
  alpine tar czf /out/deckle-backup.tar.gz -C /data .
```

That includes the hidden `.deckle` (tasks, bookmarks, assistant memory),
`.history` and `.trash`
folders, so it is a complete library. Or mount a host directory instead of the
named volume (`./notes:/data`, which must be writable by uid 1000) and point
your editor or existing backup tool straight at it.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `K` | Open the command palette |
| `Ctrl`/`Cmd` + `Shift` + `A` | Capture selection as a task / toggle the task panel |
| `Ctrl`/`Cmd` + `Shift` + `F` | Toggle focus mode |
| `Esc` | Close the topmost dialog / exit focus mode |

## Licence

MIT — see [LICENSE](LICENSE).
