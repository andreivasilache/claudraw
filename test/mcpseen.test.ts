import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastMcp, onMcpSeen, seenMcp } from '../server/mcpseen.ts'

test('seenMcp records the time of the last call per project and tells listeners', () => {
  const got: string[] = []
  onMcpSeen((id) => got.push(id))
  assert.equal(lastMcp('p1'), 0)
  const before = Date.now()
  seenMcp('p1')
  assert.ok(lastMcp('p1') >= before)
  assert.equal(lastMcp('p2'), 0)
  assert.deepEqual(got, ['p1'])
})
