import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asksForNewDiagram } from '../server/tools.ts'

test('create_diagram accepts requests that clearly ask for separate diagrams', () => {
  for (const t of ['create a new diagram named X', 'make two separate diagrams', 'Create three diagrams named "A", "B" and "C"', 'a diagram called Plan'])
    assert.equal(asksForNewDiagram(t), true, t)
})

test('create_diagram still refuses plain drawing requests', () => {
  for (const t of ['draw a horse', 'make a flow diagram of login', 'add boxes to the diagram', 'create a timeline diagram'])
    assert.equal(asksForNewDiagram(t), false, t)
})
