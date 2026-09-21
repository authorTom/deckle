---
name: deckle
description: Use Deckle as your long-term knowledge base. Search it before starting work, keep each piece of work in a Deckle project, save every deliverable there (notes, reports, PDFs, spreadsheets, images, code), and log progress so the user can review what you did.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [knowledge-base, memory, files, projects, deckle]
    category: productivity
required_environment_variables:
  - name: DECKLE_URL
    prompt: Deckle server address, e.g. https://deckle.example.com
    help: The address of the Deckle server, without /api/v1. The same server the deckle MCP entry in config.yaml points at.
    required_for: sending large files and whole folders with scripts/deckle_push.py
  - name: DECKLE_TOKEN
    prompt: Deckle API token
    help: The secret of a read-write token in the server's DECKLE_API_TOKENS, e.g. the one in "hermes:rw:<secret>".
    required_for: sending large files and whole folders with scripts/deckle_push.py
---

# Deckle — the user's knowledge base

Deckle is where the user keeps and reviews everything you work on: plain
Markdown notes and ordinary files in folders, shown in the Deckle app with an
activity feed of what you changed. Treat it as your long-term memory. What you
learn in a conversation is lost when the conversation ends; what you put in
Deckle is not.

You reach it through the `deckle` MCP server (tools named `mcp__deckle__…`),
and, for large files and whole folders, through `scripts/deckle_push.py`.

## When to use it

- **Before starting any substantial task** — `search` for what is already
  known, and `list_projects` to see whether the work belongs to an existing
  project. Read the project's `Overview.md` and `Log.md` before continuing
  someone's (or your own earlier) work. `recent_activity` shows what changed
  lately.
- **Whenever you produce something worth keeping** — a report, a dataset, a
  chart, a script, research notes, a decision and its reasons.
- **After each meaningful step** — `log_progress` with what you did, what you
  decided and why, and what is next.
- **When the user asks what you know** about something, or to find a file.

## How work is organised

- Every piece of work lives in a **project**: a folder `Projects/<name>/`.
  Start one with `create_project` (check `list_projects` first so you don't
  make a duplicate). Its `Overview.md` holds the status, summary and tags the
  user sees in Deckle's Projects view.
- Save everything for the project inside its folder. Suggested layout — use
  what fits:
  - `Projects/<name>/Overview.md` — goal, scope, links to the key outputs
  - `Projects/<name>/Log.md` — written by `log_progress`, never by hand
  - `Projects/<name>/<topic>.md` — research notes, findings, decisions
  - `Projects/<name>/Deliverables/` — the finished outputs
  - `Projects/<name>/Sources/` — downloaded papers, data, reference files
- Work that belongs to no project goes in `Inbox/`.
- When a project is finished, `update_project` its status to `done`.

## Writing notes

- `write_note` creates Markdown notes. The default mode never overwrites (a
  clash gets a numbered name, which the tool tells you); use `replace` to
  rewrite a note deliberately — its old version is kept in history — and
  `append` to add to one.
- **Link generously** with `[[wikilinks]]`: `[[Findings]]`, `[[Q3 report.pdf]]`,
  `[[Projects/Acme/Overview]]`. Links become backlinks the user can follow.
- Embed images you saved with Markdown, relative to the note:
  `![Revenue by quarter](charts/revenue.png)`.
- Front matter is welcome and shown as properties:
  ```
  ---
  source: https://example.com/report
  confidence: medium
  tags: [pricing, vendors]
  ---
  ```
- Write for a person reading later: a clear title, what it is, where it came
  from, what it means.

## Saving files

- **Up to about 10 MB**: `save_file`. Text formats (CSV, JSON, code, HTML)
  as `content`; binary files (PDF, PNG, XLSX, DOCX) as base64 with
  `encoding: "base64"`. Always pass a one-line `message` — it is what the user
  reads in the activity feed.
- **Bigger files, or a whole folder**: run the push script from a terminal:
  ```bash
  python3 scripts/deckle_push.py report.pdf --project "Acme research" --message "final report"
  python3 scripts/deckle_push.py ./output --project "Acme research" --message "generated charts"
  python3 scripts/deckle_push.py ./output --project "Acme research" --dry-run   # see first
  ```
  Folders keep their structure. The script never sends hidden files, `.env`
  files, private keys, `.git`, `node_modules` or other caches, and honours a
  `.deckleignore` file.
- **Describe every important file in a note** that links to it. Deckle can
  search inside Word, Excel, PowerPoint, CSV, JSON, text and code files, but
  PDFs and images are found only by their name and by the notes that mention
  them. A one-paragraph summary note makes a PDF findable forever.
- Replacing a file keeps the old copy in Deckle's recycle bin, so correcting a
  deliverable is safe.

## Reading

- `read` returns a note's Markdown, or the text inside a document —
  spreadsheets come back as one table per sheet. Long content arrives in
  windows; follow the `offset` it gives you.
- `search` ranks notes and documents together. Narrow it with `folder` (for
  one project) or `kind` (`note` or `file`).

## Never

- Never store secrets — API keys, passwords, tokens, private keys, `.env`
  files, session cookies — in Deckle, in a note or a file. Deckle is shared
  with the user and backed up; treat it as readable by anyone who reads their
  notes.
- Never delete the user's own notes to tidy up. `delete` moves things to the
  recycle bin, but ask before removing anything you did not create.
- Never write `Log.md` or `Overview.md` front matter by hand — use
  `log_progress` and `update_project`.

## Example

The user asks for a comparison of three ELT vendors.

1. `search` "ELT vendors" and `list_projects` — nothing yet.
2. `create_project` name "Data pipeline vendors", summary "Choose an ELT
   vendor for the marketing pipeline", tags `[research, vendors]`.
3. Research. `save_file` the pricing table as `Sources/pricing.csv`
   (message "pricing scraped from vendor sites").
4. `write_note` `Projects/Data pipeline vendors/Findings` with the analysis,
   linking `[[pricing.csv]]` and embedding the chart you saved.
5. `log_progress`: "Scored three vendors — see [[Findings]]. Next: check
   HubSpot connector coverage."
6. Generate the report PDF, then
   `python3 scripts/deckle_push.py report.pdf --project "Data pipeline vendors" --message "final report"`.
7. `update_project` status `done` once the user is happy.
