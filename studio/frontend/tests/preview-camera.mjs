import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIEW, PITCH_LIMITS, clampPitch, draggedPitch, cameraUniforms, Preview } from '../src/lib/preview.js'

test('positive camera elevation sees roofs first and the floor recedes upwards', () => {
  const [, , cosine, sine] = cameraUniforms(0, DEFAULT_VIEW.pitch)
  // These are the shader height/depth equations with yaw=0, at the same screen x.
  const height = (y, z) => cosine * z - sine * y
  const depth = (y, z) => cosine * y + sine * z
  assert.ok(DEFAULT_VIEW.pitch > 0)
  assert.ok(depth(0, 0.2) < depth(0, 0), 'a roof must be closer than the floor')
  assert.ok(height(0.2, 0) > height(0, 0), 'far floor points rise towards the horizon')
  assert.ok(cameraUniforms(0, -0.2)[3] > 0, 'a negative elevation deliberately views from below')
})

test('drag limits are -30 to +70 degrees and reset uses the same default as startup', () => {
  assert.ok(Math.abs(PITCH_LIMITS.min * 180 / Math.PI + 30) < 1e-10)
  assert.ok(Math.abs(PITCH_LIMITS.max * 180 / Math.PI - 70) < 1e-10)
  assert.equal(clampPitch(-10), PITCH_LIMITS.min)
  assert.equal(clampPitch(10), PITCH_LIMITS.max)
  assert.equal(clampPitch(DEFAULT_VIEW.pitch), DEFAULT_VIEW.pitch)
  const orientation = [1, 0, 0, 0]
  const view = { yaw: 10, pitch: -3, zoom: 2, orientation, draw() {} }
  Preview.prototype.reset.call(view)
  assert.equal(view.yaw, DEFAULT_VIEW.yaw)
  assert.equal(view.pitch, DEFAULT_VIEW.pitch)
  assert.equal(view.zoom, DEFAULT_VIEW.zoom)
  assert.equal(view.orientation, orientation)
})

test('vertical dragging follows the model after the elevation convention fix', () => {
  assert.ok(draggedPitch(DEFAULT_VIEW.pitch, 20) > DEFAULT_VIEW.pitch)
  assert.ok(draggedPitch(DEFAULT_VIEW.pitch, -20) < DEFAULT_VIEW.pitch)
  assert.equal(draggedPitch(DEFAULT_VIEW.pitch, 10000), PITCH_LIMITS.max)
  assert.equal(draggedPitch(DEFAULT_VIEW.pitch, -10000), PITCH_LIMITS.min)
})
