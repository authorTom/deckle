# Changelog

What changed in each release, written for someone deciding whether to upgrade.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Deckle
follows [Semantic Versioning](https://semver.org/) — see
[Versioning](README.md#versioning) for what a major, minor and patch bump mean
here.

## [Unreleased]

A hardening release: security fixes, several ways data could be lost, and a
test suite. **If Deckle sits behind a reverse proxy, read the first item under
Changed** — one new setting keeps sign-in throttling working as it should.

### Security

- **The assistant's API key could be read through the file API.** Shared
  assistant settings live in `.deckle-state`, which the library API is meant
  to refuse — but a path written as `./.deckle-state/assistant.json` got past
  the check. Any path that resolves into that folder is now refused, including
  other capitalisations on case-insensitive disks and a `DECKLE_STATE_DIR` set
  somewhere else inside the library. Reaching it took a signed-in session, but
  it also put the key within reach of the assistant's read-only tools.
- **Password guessing was not really throttled.** Sign-in and API-token
  throttling believed `X-Forwarded-For` from anyone, so a script could claim a
  new address on every guess and never be locked out — or lock a real person
  out by claiming theirs. The header is now ignored unless you set
  `DECKLE_TRUST_PROXY`, and the number of addresses tracked is capped.
- **Changing `DECKLE_PASSWORD` signs everyone out**, even with a fixed
  `DECKLE_SESSION_SECRET`. Sessions issued under the old password used to stay
  valid until they expired.
- **One unreadable file could take the server down.** Downloading a note the
  container isn't allowed to read — a root-owned file in a bind mount — crashed
  the process for every user. That request now gets an error and nothing else
  notices.
- **A Content-Security-Policy on every response.** Only the app's own scripts
  run, whatever finds its way into the page.
- Bookmark links are drawn only for `http` and `https` URLs. A `javascript:`
  URL in a synced or hand-edited `bookmarks.json` no longer runs when clicked.
- A ZIP import can no longer exhaust the tab's memory by claiming small sizes
  and inflating to gigabytes.
- The assistant's file tools refuse `..` and absolute paths and won't write into
  hidden folders, whatever the storage underneath would allow; its memory tools
  can't climb out of the memory folder. A queued run's inbox fence no longer
  counts `Assistant inbox/../Projects/plan.md` as inside the inbox.
- Signing out requires the app's own request header, like every other
  state-changing call, so another site can't sign you out.
- Checking the password no longer reveals its length through timing.
- Updated dependencies with published advisories (`linkify-it`, `postcss`,
  `nanoid`, `browserslist`).

### Changed

- **`DECKLE_TRUST_PROXY` — set it to `true` behind Caddy, Traefik or nginx.**
  Without it, Deckle now throttles by the address that connected, which behind
  a proxy is the proxy: every visitor shares one counter, and ten wrong
  passwords from anyone lock everyone out for fifteen minutes. For a chain of
  proxies (Cloudflare in front of Caddy), give the number instead. See
  [Security](README.md#security).
- Completing a recurring task through `PATCH /api/v1/tasks/{id}` rolls its due
  date forward, exactly as ticking it in the app does. It used to complete the
  task and end the series.

### Fixed

- **Autosave could leave a note a paragraph behind the editor.** Two saves could
  overlap whenever a write was slow — a server library on a slow link, or a save
  that also took a history snapshot — and the older one could finish last,
  while the indicator said *Saved*. Saves now happen strictly in order.
- **Tasks and bookmarks could be replaced by an empty list.**
  - A change made while `tasks.json` or `bookmarks.json` was still loading was
    saved on its own, over the file. It is now applied to what loads.
  - A file that wouldn't parse, or came from a newer Deckle, loaded as empty
    and was overwritten by the next change. The app now keeps a copy first
    (`.deckle/tasks.unreadable-<time>.json`), and the API refuses to write
    over it with `500 store_unreadable`.
  - Switching libraries with a change still pending now saves it to the library
    it belongs to, rather than dropping it.
- **Queued runs could lose their place with more than one running at once.**
  Overlapping updates to the run index dropped rows or restored an old status,
  and a run put back to *queued* could be executed twice.
- `/api/v1`: a `PATCH` that renamed a note and carried an invalid edit moved the
  note and then answered `400`; it now changes nothing. A body that is valid
  JSON but not an object (`null`, `[]`) is a `400` rather than a `500`. Due dates
  must be real calendar dates, project and collection colours must be hex, and
  ids must be strings.
- A malformed session cookie or login body is answered as such, not with a
  `500`.
- An export whose client disconnected mid-download stayed in memory for the life
  of the process.
- Saving shared assistant settings close to the size limit could be refused
  because of the file's indentation, and two devices saving in the same moment
  could fail.

### Added

- A test suite — `npm test` — covering the server through its real HTTP handler,
  the API, every storage path, the queue, the assistant's tools and autosave. CI
  runs it on every pull request.

## [1.6.0] — 2026-08-29

### Added

- **Trevor writes where you can watch him.** Answers used to arrive all at
  once: a "Thinking…" line, a wait of however long the model took, then a
  finished paragraph. Every provider now streams, so the answer appears as it
  is written — in the chat, in the selection popover, and behind the new `/`
  commands. Nothing about how he works changed; the waiting did.

- **`/` commands in the editor.** Type `/` on a blank line for `/summarize`,
  `/explain`, `/todo`, or `/ask` followed by a question. The answer is written
  in at the caret as one edit, so a single undo takes it back out. `/ask` can
  search your library and cite what it read.

- **The selection popover can read your other notes.** "Ask AI about
  selection" used to see only the words you had highlighted. It can now search
  and read the rest of the library when the answer depends on it, and cites
  every note it drew on as a `[[wikilink]]` you can click straight through —
  both in the preview and once the text is in the note. It still cannot write
  anything: the tools it is given are the reading ones only.

- **Edits are approved at the text.** When Trevor proposes a change to the
  note you have open, the sheet steps aside and the diff appears at the caret
  with Approve and Reject beside it, rather than over the note you are being
  asked about. Anything he cannot ask for on the page — a folder, a deletion,
  or more than one change at once — still goes through the panel as before.

### Changed

- **He reads what you are typing.** "Summarize this note" used to be answered
  from the last version written to disk, which on a fresh paragraph meant the
  version from before you wrote it. The open note's current text now goes with
  the message, unsaved keystrokes included, trimmed from the middle if the note
  is long enough to crowd out everything else.

### Fixed

- **Notes and memory can no longer give Trevor orders.** The note you have
  open and the memory Trevor has written about you both used to be placed in
  the system prompt, next to the app's own instructions and indistinguishable
  from them. They now travel with your message as quoted material, marked as
  material, and he is told plainly that nothing inside it can instruct him.
  This matters most for text you did not write — a note pasted from the web, a
  shared library, or a memory recorded from a misread earlier turn. Queued
  background runs got the same treatment, where it matters more still because
  nobody is watching them.

- **A long note can no longer crowd out the conversation.** Reading a note fed
  the whole file to the model however big it was, so one large note could spend
  the entire context window and take the rest of the exchange down with it.
  Reads, the open note, and the inline selection are each capped, and a trimmed
  read says so in the text so Trevor knows he is holding an excerpt and edits in
  place rather than rewriting the file from it.

- **A failing model gives up instead of retrying forever.** The loop was
  bounded only by a count of tool calls, which bounds a run that is getting
  somewhere. A model stuck on a path that does not exist would retry it up to
  fifty times, each one a paid request. Three turns where every call fails now
  ends the turn and says so.

- **An expired session hands the key back.** On a server library the API key
  belongs to the server and is lent to each browser that signs in. Pressing
  sign out returned it; a session that simply expired did not, leaving the key
  cached in a browser that could no longer reach the library. Signing back in
  fetches it again, as before.

- **Extended thinking survives streaming.** Claude's thinking blocks are
  resent with their signatures intact across a streamed turn, so switching
  thinking on no longer risks a rejected request on the following message.

## [1.5.1] — 2026-08-23

No application changes. This release exists because 1.5.0 could not publish an
image, so there was nothing to pull.

### Fixed

- **The container image builds again.** `npm ci` hung indefinitely on
  `linux/arm64` under QEMU emulation — the same step finished in four seconds on
  amd64 — so three builds in a row sat silent for six hours until GitHub's
  maximum job time killed them. 1.5.0 got a tag and release notes but no image.

  Each architecture now builds on its own native runner and the two are stitched
  into one manifest list, so there is no emulation left to hang: a build that
  never finished now takes about eighty seconds. Nothing in Deckle caused it —
  the emulation layer was pulled unpinned from upstream and changed underneath
  the repository between 1.4.0 and 1.5.0.

  Every job also carries a timeout now. The default was six hours, which is why
  each hang cost the full six before anyone noticed.

  If you are on 1.5.0, this is the same application. Pull it for an image that
  exists.

## [1.5.0] — 2026-08-23

### Changed

- **The assistant is now Clever Trevor, and he drops down from the top.** He
  used to live in a dock on the right, which shoved the editor sideways every
  time you opened him and left him competing with the note list and the task
  panel for horizontal room — on a narrow window, three docked panels could
  squeeze the editor below phone width. He is now a sheet that drops from the
  top of the screen over the workspace, summoned with **Ctrl/Cmd+J**, dismissed
  with Escape or a click outside. Nothing reflows on the way in or out, and the
  composer has focus the moment he lands.

  He is resizable by his bottom edge rather than his side. The height is
  remembered per browser; the old stored width is not carried over, because a
  width is meaningless as a height.

  The rename is the visible strings and his own self-description — he answers to
  the name if you ask. Nothing about how he works has changed: every edit to a
  note is still shown as a diff you approve, and background jobs still draft
  only inside the inbox and stop for you everywhere else.

- **Heavier chrome.** Type weight is now part of the design system rather than
  thirty-six literals scattered through the stylesheets, which is why the app
  read lighter than it meant to and drifted a step either way depending on the
  screen. Six named weights, applied consistently; dividers and panel edges go
  from a 1px hairline to 1.5px; icons draw at a deliberate stroke instead of
  whatever the icon library shipped. Word-sized things — key caps, pills,
  swatches, the table grid in a note — keep the hairline, because a heavy rule
  around a small shape reads as a mistake.

  The document is deliberately untouched by most of this. Body copy still sets
  at book weight; only the `h1` takes the extra step. The chrome got denser so
  the note would read as the content and the app as the apparatus.

## [1.4.0] — 2026-08-20

### Added

- **See and switch the model without leaving what you're doing.** The assistant
  names its model above the conversation, and that name is the switch: it lists
  every provider you have configured, so moving from a local model to Claude —
  or from Opus to Haiku for something small — is one click. Providers you
  haven't set up don't appear. The shortlist is a shortlist, not a limit:
  **Custom…** in settings still takes any model id the provider accepts, and for
  LM Studio the list is whatever your local server says it is actually serving.

  Deckle also stops offering extended thinking on models that don't support it,
  instead of letting a stored preference turn every message into an error.

- **Queued jobs carry their own model.** Pick one when you queue a job and it is
  pinned there: the list shows what ran each job, a re-run goes to the same
  model, and a job that stopped can be pointed at a bigger model before you
  resume it. Previously every run read whichever model the settings held at the
  moment each turn fired, so changing your model silently changed work that was
  already waiting.

- **The assistant's settings follow you between devices.** Sign in to a
  password-protected server library on a phone, a second laptop, a borrowed
  machine, and the assistant is already configured — provider, model, custom
  instructions and API key. The first device to save hands the server what it
  already had, so nothing is lost on the way in, and the LM Studio URL stays
  behind on each machine, since `localhost` means something different on each
  one. Signing out of the library forgets what it lent that browser.

  The key is kept outside the library (`DECKLE_STATE_DIR`, mode `0600`) and
  served only to a request carrying a valid session, so it cannot leave in an
  export, through the API, or via the assistant's own file-reading tools. A
  server with no `DECKLE_PASSWORD` refuses to hold one at all and says why —
  open to the port is open to the key.

- **A background job says what it is doing.** Each step as it happens —
  *Thinking…*, *Reading Weekly review.md*, *Writing Assistant inbox/Poem.md* —
  instead of a spinner and a title for two minutes. Finished runs list the notes
  they produced as buttons: click one to open it, rather than opening the run to
  find out what it made. A run that stops without finishing raises a toast,
  since the panel is often closed by then.

### Changed

- **The assistant queue moved into the assistant.** It used to be a third tab
  beside Tasks and Bookmarks, which made background work look like a different
  feature from the assistant you were already talking to. It isn't — one is
  answered now and the other later.

  So the panel has two tabs, **Chat** and **Queue**, sharing one composer with
  two buttons: *Send* answers in the conversation, *Queue* (`Cmd/Ctrl ⏎`) hands
  the same words to the background. The Queue tab carries a live count, shows
  the list in full — Needs you, Working, Waiting its turn, Didn't finish,
  Finished — and says so when it is empty. While you are chatting, one line
  above the composer says what the background is doing. A run parked on a
  question badges the assistant's toolbar button, so it stays visible with
  everything closed. The old tab is gone; *Assistant queue* in the command
  palette opens the assistant on the Queue tab.

### Fixed

- **The queue did not work at all on a local or in-browser library.** Its index
  is stored at `.deckle/runs/index.json`, and the helper that reads and writes
  Deckle's own data files passed that whole string to `getFileHandle`, which
  takes a *name*, not a path — so the File System Access API rejected it with
  "Name is not allowed". Every index write threw and every index read quietly
  returned nothing, which is why queued jobs refused to start, vanished on
  reload, and left runs stuck showing "Working". A server library resolves paths
  by URL and never hit it.

  Nested paths now walk their directories, and a queue whose index is missing is
  rebuilt from the run records themselves — so jobs written while the index
  could not be saved come back rather than being lost.

- **Queued jobs could sit at "Waiting its turn" for ever.** Starting a run read
  its record and wrote it back before any of that was wrapped in error handling.
  One refused write — a permission that lapsed on reload, a server that blinked,
  a full disk — and the failure escaped as an unhandled rejection *while the run
  still held its slot in the scheduler*. Every later pass then saw the job as
  already executing and skipped it, so it sat untouched for the rest of the
  session with nothing in the interface and nothing in the console to say why.

  A run's slot is now released on every path out, a job that fails to start
  stays queued instead of being recorded as a run that failed, and the app says
  so rather than failing mutely. The scheduler also runs on a timer as well as
  on a render, so a job that couldn't start a moment ago is tried again when the
  library recovers.

- **A new note could open under the last note's name.** Making a note while the
  one you were reading still had its invented name — and a heading to take a
  real name from — set two things going at once: the rename of the old file and
  the creation of the new one. The rename frees `Untitled.md` the moment it
  moves the file, the new note is handed that very name, and the rename then
  finishes by pointing the tab, the pane and any unsaved edits at where *it*
  ended up. The new note vanished behind the old one. Library changes now happen
  one at a time, so a name is never reissued while a rename is still settling.

- **The thinking toggle appears on OpenRouter.** It was only ever shown for
  Claude and LM Studio, because those were the only two whose request it
  changed — so switching to OpenRouter made the button disappear. OpenRouter's
  unified `reasoning` parameter is now sent when the toggle is on, and the
  reasoning that comes back was already being rendered as *Thought process*. It
  stays hidden for OpenAI, whose `reasoning_effort` is accepted only by its
  reasoning models and is an error on the rest.

## [1.3.0] — 2026-08-13

### Added

- **A queue for the assistant.** Give it a job and it works in the background
  while you carry on writing: *Assistant queue* in the command palette, or the
  third tab beside Tasks and Bookmarks. Runs execute one at a time by default,
  or up to four at once if you'd rather several went in parallel.

  Every run writes into an **Assistant inbox** folder, which is the safety
  boundary: inside it the assistant works freely, and anything outside stops the
  run and shows you the same diff the chat panel would. Deleting always stops,
  wherever it is. A run that genuinely can't proceed can ask you a question and
  park until you answer it.

  The queue makes it plain which runs need you — a badge on the tab counts only
  those, because "three things are running" is not something you have to act on.
  Finished runs list the notes they wrote, and any run can be resumed (carrying
  on with what it had already done) or run again from scratch. A run interrupted
  by closing the tab says so, and offers to carry on.

  Runs are stored in your library under `.deckle/runs/`, so they survive a
  reload and travel with your notes.

## [1.2.0] — 2026-08-13

### Added

- **Assistant memory.** The assistant can now remember what it learns about how
  you work — kept as ordinary Markdown files in `.deckle/memory/` inside your
  library, so it syncs, backs up and exports with your notes, and opens in any
  editor. Read, edit, pin and delete any of it from **Assistant memory** in the
  command palette; turn the whole thing off in the assistant's settings.

  Only a one-line index goes into every message. Bodies are fetched when they
  are relevant to what you asked, within a token budget, so a large memory does
  not quietly become a large bill. Recording something it already knows updates
  the existing memory instead of adding a near-duplicate.

  Memory writes are the one kind of write the assistant makes without asking:
  they touch no note, and the panel is the receipt.

## [1.1.0] — 2026-08-13

### Added

- **An About box.** The version was only in the keyboard sheet, which is no help
  unless you already know the shortcut. *About Deckle* — in the editor menu and
  the command palette — names the version, the library you have open, and which
  of the three backends is holding it, with links to this changelog and the
  source.

## [1.0.0] — 2026-08-13

The first tagged release. Deckle has been running and deployable for a while;
what is new is that a given build can now be named, pinned, and rolled back to.

Nothing about the app itself changes when you upgrade to it, but **what
`:latest` means does** — see below.

### Added

- **Versioning.** Deckle follows Semantic Versioning from this release on. The
  version is shown in the keyboard sheet (`?`), logged at server startup, and
  returned by `GET /api/v1/health` as `version`, so a bug report or an agent can
  name the build it is talking to. The API's OpenAPI document reports it as
  `info.version`.
- **Released image tags.** `:1.0.0` never moves, `:1.0` takes fixes, `:1` takes
  fixes and features but never a breaking change, and `:latest` follows the
  newest release.
- **This changelog.**

### Changed

- **`:latest` now means the newest release, not the newest commit.** It used to
  be republished on every push to `main`, so `docker compose pull` took whatever
  had merged most recently, finished or not. If you were relying on that to
  track development, switch to `:edge` — otherwise there is nothing to do, and
  your next pull becomes a considered release rather than a branch tip.

### Deprecated

- The pre-rename `NIB_*` configuration names and the `.nib` data folder are
  still read, and **will keep being read for the whole 1.x series**. They will
  be removed no earlier than 2.0.0. Rename `NIB_*` to `DECKLE_*` in your `.env`
  whenever it suits; the server logs which deprecated names it honoured at
  startup.

### The app, as of 1.0.0

For anyone arriving here first, this release contains: live WYSIWYG Markdown
editing over plain `.md` files; three storage backends (a folder on disk, the
browser's private storage, or a volume on your own server) behind one interface;
a folder tree with drag-and-drop, spring-loaded folders and a *Move to another
folder…* dialog; import of Markdown files, folders and ZIPs into a folder you
choose; a Todoist-style task planner and bookmark collections stored inside the
library; per-note version history and a recycle bin; an AI assistant that can
search and edit the library with every change shown as an approvable diff;
a command palette; light and dark mode with seven palettes; a responsive layout
with drawers on a phone; and a token-authenticated REST API at `/api/v1`
described by a self-served OpenAPI 3.1 document.

[Unreleased]: https://github.com/authorTom/deckle/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/authorTom/deckle/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/authorTom/deckle/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/authorTom/deckle/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/authorTom/deckle/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/authorTom/deckle/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/authorTom/deckle/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/authorTom/deckle/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/authorTom/deckle/releases/tag/v1.0.0
