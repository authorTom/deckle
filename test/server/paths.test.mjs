import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BadPathError,
  assertRealPathInside,
  assertValidName,
  joinRelative,
  resolveLibraryPath,
} from '../../server/paths.mjs'
import { makeTempDir } from '../helpers/server.mjs'

describe('resolveLibraryPath', () => {
  const root = path.resolve('/library')

  it('resolves library-relative paths inside the root', () => {
    expect(resolveLibraryPath(root, '')).toBe(root)
    expect(resolveLibraryPath(root, undefined)).toBe(root)
    expect(resolveLibraryPath(root, 'Projects/idea.md')).toBe(path.join(root, 'Projects', 'idea.md'))
    expect(resolveLibraryPath(root, './Projects//./idea.md')).toBe(
      path.join(root, 'Projects', 'idea.md'),
    )
  })

  it.each([
    ['../etc/passwd'],
    ['Projects/../../etc/passwd'],
    ['a/..'],
    ['/etc/passwd'],
    ['idea.md\u0000.png'],
    ['Projects\\..\\secret'],
    ['line\nbreak'],
  ])('refuses %j', (bad) => {
    expect(() => resolveLibraryPath(root, bad)).toThrow(BadPathError)
  })

  it('refuses a non-string', () => {
    expect(() => resolveLibraryPath(root, 42)).toThrow(BadPathError)
  })
})

describe('assertRealPathInside', () => {
  let root
  let outside

  beforeEach(async () => {
    root = await makeTempDir()
    outside = await makeTempDir()
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret')
    await fs.mkdir(path.join(root, 'notes'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('allows existing and not-yet-existing paths inside the root', async () => {
    await expect(assertRealPathInside(root, path.join(root, 'notes'))).resolves.toBeUndefined()
    await expect(
      assertRealPathInside(root, path.join(root, 'notes', 'new', 'deep.md')),
    ).resolves.toBeUndefined()
  })

  it('refuses a symlink that leads out of the root', async () => {
    await fs.symlink(outside, path.join(root, 'escape'))
    await expect(
      assertRealPathInside(root, path.join(root, 'escape', 'secret.md')),
    ).rejects.toThrow(BadPathError)
    await expect(
      assertRealPathInside(root, path.join(root, 'escape', 'not-yet.md')),
    ).rejects.toThrow(BadPathError)
  })
})

describe('names', () => {
  it('accepts plain names and refuses separators and dots', () => {
    expect(() => assertValidName('idea.md')).not.toThrow()
    for (const bad of ['', '.', '..', 'a/b', 'nul\u0000', 42]) {
      expect(() => assertValidName(bad)).toThrow(BadPathError)
    }
  })

  it('joins a prefix and a name', () => {
    expect(joinRelative('', 'a.md')).toBe('a.md')
    expect(joinRelative('Projects', 'a.md')).toBe('Projects/a.md')
  })
})
