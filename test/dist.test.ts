import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// dist/ is committed (a global install from GitHub does not build anything), so it has to match the sources: run
// `npm run build:ui` and commit before tagging (`npm version` does that by itself).
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = (dir: string) => readdirSync(join(dir, 'assets')).sort()

test('the committed dist/ is what the sources build to', () => {
  const out = mkdtempSync(join(tmpdir(), 'canvas-dist-'))
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', out, '--emptyOutDir'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.equal(readFileSync(join(root, 'dist', 'index.html'), 'utf8'), readFileSync(join(out, 'index.html'), 'utf8'), 'dist/index.html is stale: run npm run build:ui')
  assert.deepEqual(assets(join(root, 'dist')), assets(out), 'dist/assets is stale: run npm run build:ui')
})

test('the fonts the page loads are in dist/ and public/', () => {
  for (const base of ['dist', 'public']) assert.ok(existsSync(join(root, base, 'fonts', 'Excalifont')), `${base}/fonts is missing: npm run fonts`)
})
