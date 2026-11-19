// DESIGN.md's Contrast Floor Rule, enforced: every palette, in both modes,
// read straight from the stylesheets the app ships. A palette that fails is not
// shipped — this is what makes that true rather than hoped.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = path.resolve(__dirname, '../../src/styles')

type Tokens = Record<string, string>

function parse(file: string): { selector: string; tokens: Tokens }[] {
  const css = fs.readFileSync(path.join(STYLES, file), 'utf8')
  const out: { selector: string; tokens: Tokens }[] = []
  for (const block of css.matchAll(/(:root[^{]*)\{([^}]*)\}/g)) {
    const tokens: Tokens = {}
    for (const [, name, value] of block[2].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) tokens[name] = value
    out.push({ selector: block[1].trim(), tokens })
  }
  return out
}

/** Each palette and mode with every token resolved, inheriting as the cascade does. */
function palettes(): { name: string; t: Tokens }[] {
  const base = parse('theme.css')
  const light = base.find((b) => b.selector === ':root')!.tokens
  const dark = { ...light, ...base.find((b) => b.selector === ":root[data-theme='dark']")!.tokens }
  const out = [
    { name: 'deckle light', t: light },
    { name: 'deckle dark', t: dark },
  ]
  for (const { selector, tokens } of parse('themes.css')) {
    const palette = selector.match(/data-palette='(\w+)'/)?.[1]
    if (!palette || !('bg' in tokens)) continue
    const isDark = selector.includes("data-theme='dark'")
    out.push({ name: `${palette} ${isDark ? 'dark' : 'light'}`, t: { ...(isDark ? dark : light), ...tokens } })
  }
  return out
}

function rgb(hex: string): [number, number, number] {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Channel distance: the summed difference of the red, green and blue channels. */
function delta(a: string, b: string): number {
  const [x, y] = [rgb(a), rgb(b)]
  return x.reduce((sum, v, i) => sum + Math.abs(v - y[i]), 0)
}

const FLOOR: [string, string, number, string][] = [
  ['text', 'bg', 7, 'body and headings'],
  ['text-muted', 'bg', 4.5, 'secondary copy'],
  ['text-muted', 'bg-elevated', 4.5, 'secondary copy on a panel'],
  ['text-faint', 'bg', 4.5, 'timestamps, labels, placeholders'],
  ['text-faint', 'bg-elevated', 4.5, 'the same, on a panel'],
  ['text-faint', 'bg-hover', 4.5, 'the same, on a hovered row'],
  ['text-muted', 'accent-soft', 4.5, "quiet text on a selected row (faint reads as muted there)"],
  ['danger', 'bg', 4.5, 'error text'],
  ['accent-contrast', 'accent', 4.5, 'the label inside a filled button'],
  ['text', 'accent-soft', 4.5, "the active row's name"],
  ['accent', 'accent-soft', 4.5, 'the active tab’s label'],
  ['accent', 'bg', 3, 'focus rings and links'],
]

describe('the Contrast Floor Rule (DESIGN.md)', () => {
  const all = palettes()

  it('finds all seven palettes in both modes', () => {
    expect(all.map((p) => p.name).sort()).toEqual(
      ['deckle', 'slate', 'nord', 'rose', 'forest', 'mono', 'springfield']
        .flatMap((p) => [`${p} dark`, `${p} light`])
        .sort(),
    )
  })

  for (const { name, t } of all) {
    it(name, () => {
      const failures: string[] = []
      for (const [fg, bg, floor, what] of FLOOR) {
        const ratio = contrast(t[fg], t[bg])
        if (ratio < floor) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${floor} (${what})`)
      }
      for (const other of ['bg-hover', 'bg-active']) {
        const d = delta(t['accent-soft'], t[other])
        if (d < 24) failures.push(`accent-soft vs ${other}: delta ${d} < 24 (active must not read as ${other === 'bg-hover' ? 'hovered' : 'pressed'})`)
      }
      // Quieter must still look quieter.
      if (contrast(t['text-muted'], t['bg']) <= contrast(t['text-faint'], t['bg'])) {
        failures.push('text-muted is no stronger than text-faint')
      }
      expect(failures).toEqual([])
    })
  }
})
