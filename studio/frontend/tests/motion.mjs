import assert from 'node:assert/strict'
import test from 'node:test'
import { normalize, isFeedbackFresh, unitQuaternion, velocityFor } from '../src/lib/motion.ts'

test('speed and radial displacement both scale continuously', () => {
  const prefs = { speed: 35, forward: 0.4, turn: 1.5 }
  assert.ok(Math.abs(velocityFor(0, -0.5, 21.5, prefs).vx - 0.043) < 1e-12)
  assert.equal(velocityFor(-0.4, 0, 20, prefs).vyaw, 0.12)
  const { x, y } = normalize(1, 1)
  assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-10)
})
test('only finite nonzero measured body orientations rotate the model', () => {
  assert.deepEqual(unitQuaternion([2, 0, 0, 0]), [1, 0, 0, 0])
  assert.equal(unitQuaternion([0, 0, 0, 0]), undefined)
  assert.equal(unitQuaternion([NaN, 0, 0, 0]), undefined)
})
test('lateral slider uses Y with left positive, shares speed and limits the trained lateral range', () => {
  const prefs = { speed: 100, forward: 0.5, turn: 1 }
  assert.equal(velocityFor(0, 0, 100, prefs, -1).vy, 0.3)
  assert.equal(velocityFor(0, 0, 50, prefs, 1).vy, -0.15)
  assert.equal(velocityFor(0, 0, 100, prefs, 2).vy, -0.3)
  assert.equal(velocityFor(0, 0, 100, prefs, 0).vy, 0)
  const combined = velocityFor(-0.5, -0.5, 50, prefs, -0.5)
  assert.equal(combined.vx, 0.125)
  assert.equal(combined.vyaw, 0.25)
  assert.equal(combined.vy, 0.075)
})

test('deadman rejects missing, disconnected, and 1.5s old feedback', () => {
  assert.equal(isFeedbackFresh(true, true, 1499), true)
  for (const args of [
    [false, true, 1],
    [true, false, 0],
    [true, true, 1500],
  ])
    assert.equal(isFeedbackFresh(...args), false)
})
