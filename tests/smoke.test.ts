import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))

describe('scaffold smoke', () => {
  it('package.json parses and declares the dsh bundle patch', () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name: string
      dsh?: { bundle?: { patch?: string } }
      exports?: Record<string, { types?: string; import?: string }>
    }
    strictEqual(manifest.name, 'dsh-gateway')
    strictEqual(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    deepStrictEqual(manifest.exports?.['.'], {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    })
  })

  it('marked Lexer keeps token.raw for original source spans', async () => {
    const { Lexer } = await import('marked')
    const source = '# 标题\n\n段落文本。\n'
    const tokens = Lexer.lex(source)
    const raw = tokens.map((token) => token.raw).join('')
    expect(raw).toBe(source)
  })
})
