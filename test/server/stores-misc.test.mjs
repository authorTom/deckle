import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
