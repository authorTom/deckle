import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidSettingsError, MAX_SETTINGS_BYTES, createSettingsStore } from '../../server/settings-store.mjs'
import { resolveLegacyEnv } from '../../server/legacy-env.mjs'
import { createLibraryApi } from '../../server/library-api.mjs'
import { createSearch } from '../../server/search.mjs'
import { makeTempDir } from '../helpers/server.mjs'

let root

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('settings store', () => {
  it('reads null before anything is saved, then what was saved', async () => {
    const store = createSettingsStore(path.join(root, 'state'))
    expect(await store.read()).toBeNull()
    await store.write({ provider: 'openai', openaiKey: 'sk' })
    expect(await store.read()).toEqual({ provider: 'openai', openaiKey: 'sk' })
    const stat = await fs.stat(path.join(root, 'state', 'assistant.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('refuses anything but an object', async () => {
    const store = createSettingsStore(root)
    for (const value of [null, undefined, [], 'text', 3]) {
      await expect(store.write(value)).rejects.toThrow(InvalidSettingsError)
    }
  })

  it('measures size as sent, not as indented on disk', async () => {
    const store = createSettingsStore(root)
    // Compact, this fits; indented, the many small keys push it over.
    const value = {}
    let i = 0
    while (JSON.stringify(value).length < MAX_SETTINGS_BYTES - 64) value[`k${i++}`] = 1
    expect(JSON.stringify(value, null, 2).length).toBeGreaterThan(MAX_SETTINGS_BYTES)
    await expect(store.write(value)).resolves.toBeUndefined()

    await expect(store.write({ big: 'x'.repeat(MAX_SETTINGS_BYTES) })).rejects.toThrow('too large')
  })

  it('treats a corrupt file as nothing saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fs.writeFile(path.join(root, 'assistant.json'), '{oops')
    expect(await createSettingsStore(root).read()).toBeNull()
  })

  it('survives concurrent saves', async () => {
    const store = createSettingsStore(root)
    await Promise.all(Array.from({ length: 10 }, (_, n) => store.write({ n })))
    expect(await store.read()).toHaveProperty('n')
    expect((await fs.readdir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('legacy environment names', () => {
  it('maps NIB_* onto DECKLE_* without overriding a new name', () => {
    const { env, honoured } = resolveLegacyEnv({
      NIB_PASSWORD: 'old',
      NIB_SERVER_VAULT: 'true',
      DECKLE_SERVER_LIBRARY: 'false',
      NIB_VAULT_DIR: '',
    })
    expect(env.DECKLE_PASSWORD).toBe('old')
    expect(env.DECKLE_SERVER_LIBRARY).toBe('false')
    expect(env.DECKLE_LIBRARY_DIR).toBeUndefined()
    expect(honoured).toEqual(['NIB_PASSWORD -> DECKLE_PASSWORD'])
  })

  it('treats an empty new value as unset, so a blank password never wins over a real one', () => {
    const { env } = resolveLegacyEnv({ NIB_PASSWORD: 'kept', DECKLE_PASSWORD: '' })
    expect(env.DECKLE_PASSWORD).toBe('kept')
  })
})

describe('search', () => {
  it('ranks title matches first, filters by folder, and notices new notes', async () => {
    const library = createLibraryApi(root)
    await library.init()
    const search = createSearch(library)

    await library.writeText('Projects/Latency review.md', 'the p99 budget')
    await library.writeText('Journal/Monday.md', 'talked about latency, briefly, and then lunch')

    let results = await search.search('latency')
    expect(results.map((r) => r.path)).toEqual(['Projects/Latency review.md', 'Journal/Monday.md'])
    expect(results[1].snippet).toContain('latency')

    results = await search.search('latency', { folder: 'Journal' })
    expect(results.map((r) => r.path)).toEqual(['Journal/Monday.md'])

    await library.writeText('Kettle.md', 'descaling')
    expect((await search.search('descaling')).map((r) => r.path)).toEqual(['Kettle.md'])
    expect(await search.search('   ')).toEqual([])
    expect(await search.search('zebra')).toEqual([])
  })
})
