import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const scratch = mkdtempSync(join(tmpdir(), 'canvas-version-'))
const repo = join(scratch, 'repo')
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
execFileSync('git', ['init', '-q', repo])
writeFileSync(join(repo, 'f'), '1')
git('add', '.')
git('commit', '-qm', 'one')
for (const t of ['v0.1.0', 'v0.2.0', 'v0.10.0', 'v1.0.0-rc1', 'nightly']) git('tag', t)

process.env.CANVAS_UPDATE_REPO = repo
const { VERSION, compare, latestTag, newestTag, versionInfo } = await import('../server/version.ts')

test('versions compare as numbers, not text', () => {
  assert.ok(compare('v0.10.0', 'v0.2.0')! > 0)
  assert.ok(compare('1.0.0', '1.0.0') === 0)
  assert.equal(compare('v1.0.0-rc1', '1.0.0'), null)
  assert.equal(newestTag('abc\trefs/tags/v0.2.0\nabc\trefs/tags/v0.10.0\nabc\trefs/tags/nightly\nabc\trefs/tags/v1.0.0-rc1\n'), 'v0.10.0')
  assert.equal(newestTag(''), null)
})

test('the newest tag is found in the background and never blocks the first answer', async () => {
  assert.equal(latestTag(), null) // starts the check, answers at once
  for (let i = 0; i < 50 && !latestTag(); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(latestTag(), 'v0.10.0')
  const info = versionInfo()
  assert.equal(info.version, VERSION)
  assert.equal(info.latest, compare('v0.10.0', VERSION)! > 0 ? '0.10.0' : undefined)
})
