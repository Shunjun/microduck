import test from 'node:test'
import assert from 'node:assert/strict'
import { servoResponseCount, referenceOffsetDegrees, observedDirection, demoPose, demoDegrees } from '../src/lib/commissioning.ts'

test('serial validation accepts a servo response without requiring normal policy readiness or all 15 servos', () => {
  assert.equal(servoResponseCount({ readings: [{ id: 20, ticks: 0, error: null }] }), 1)
  assert.equal(servoResponseCount({ readings: [{ id: 20, ticks: null, error: 'timeout' }] }), 0)
  assert.equal(servoResponseCount({ readings: [{ id: 20, ticks: 10, error: 'fault' }] }), 0)
  assert.equal(servoResponseCount(null), 0)
})
test('direction needs opposite observations and rejects tiny/noisy or implausibly large movements', () => {
  assert.equal(observedDirection(2000, 2114, 1886), 1)
  assert.equal(observedDirection(2000, 1886, 2114), -1)
  for (const points of [[2114, 2130], [2001, 1999], [3000, 1000]])
    assert.equal(observedDirection(2000, ...points), null)
})
test('angle annotation is relative to the saved pose and does not guess a missing direction', () => {
  assert.equal(referenceOffsetDegrees(2050, 1026, -1), -90)
  assert.equal(referenceOffsetDegrees(-68, -68, 1), 0)
  assert.equal(referenceOffsetDegrees(100, 0, null), null)
  assert.equal(referenceOffsetDegrees(null, 0, 1), null)
})
test('model demonstration changes only the selected virtual joint and leaves the source pose intact', () => {
  const reference = Array(15).fill(.2)
  const pose = demoPose(reference, 3, 1)
  assert.ok(Math.abs(pose[3] - .2 - Math.PI / 18) < 1e-9)
  assert.equal(pose[2], .2)
  assert.equal(reference[3], .2)
  assert.equal(demoDegrees(9), 5)
})
