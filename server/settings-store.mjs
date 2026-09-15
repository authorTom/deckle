// The assistant's settings, kept for the whole server rather than per browser.
//
// Deckle's settings normally live in localStorage, which is the right home for
// them: they describe how *this browser* talks to a provider. The server
// library breaks that assumption — it exists so the same library is reachable
// from any device, and asking for the API key again on every one of them is a
// poor answer to "your notes are wherever you are".
//
// So a server library keeps one copy of them here, and every device that signs
// in reads it. Two properties matter, both of them about the key:
//
//   * It lives *outside* the library. The notes folder travels — exports,
//     backups, the machine API, the assistant's own read_note tool — and a
//     provider key must not travel with it. See RESERVED_DIR in
//     library-api.mjs, which is what keeps this folder invisible to all of
//     that.
//   * It is only served to a request that has already passed the password
//     gate. With no DECKLE_PASSWORD the API is open by design, and the caller
//     refuses to store keys at all in that case.
//
// It is stored in plain text, readable by this process and by whoever can read
// the volume. Encrypting it would only move the problem — the server would
// still have to hand the key to the browser, which is what actually calls the
// provider.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const FILE = 'assistant.json'

/** Generous enough for a long system prompt, small enough to stay a settings file. */
export const MAX_SETTINGS_BYTES = 64 * 1024

/** Thrown for a body that isn't settings-shaped. */
export class InvalidSettingsError extends Error {}

export function createSettingsStore(stateDir) {
  const file = path.join(stateDir, FILE)

  return {
    /** The stored settings, or null when nothing has been saved yet. */
    async read() {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
      } catch (err) {
        // Missing is the normal first-run answer. A corrupt file is treated the
        // same way: the device that saves next replaces it, which is a better
        // outcome than refusing to load settings forever.
        if (err.code !== 'ENOENT') {
          console.warn('[deckle] could not read assistant settings:', err.message)
        }
        return null
      }
    },

    /**
     * Replace the stored settings.
     *
     * Written to a temporary name and renamed into place, so a device that
     * disconnects mid-write can't leave a half-written file behind — the same
     * pattern the library API uses for note uploads.
     *
     * What's inside is the client's business: this stores the object it is
     * given rather than modelling every field, so a new setting needs no
     * change here. It checks only that it *is* an object, and that it is small.
     */
    async write(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InvalidSettingsError('settings must be an object')
      }
      // Measured compact, the way the request carried it. Measuring the
      // indented copy refused settings that had arrived comfortably inside
      // the same limit, once the indentation pushed them over.
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_SETTINGS_BYTES) {
        throw new InvalidSettingsError('settings too large')
      }
      const payload = JSON.stringify(value, null, 2)
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
      // Random, not just pid + time: two devices saving in the same
      // millisecond would otherwise share a temp file, and one rename would
      // then fail on a file the other had already moved.
      const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
      try {
        // 0600 from the moment it exists: never briefly world-readable.
        await fs.writeFile(tmp, payload, { mode: 0o600 })
        await fs.rename(tmp, file)
      } catch (err) {
        await fs.rm(tmp, { force: true })
        throw err
      }
    },
  }
}
