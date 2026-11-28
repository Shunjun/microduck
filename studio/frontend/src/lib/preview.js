// Depth-tested browser rendering. Studio uses full CAD geometry; joint order follows robotctl.
export const DEFAULT_VIEW = Object.freeze({ yaw: 0.8, pitch: 0.3, zoom: 1 })
export const PITCH_LIMITS = Object.freeze({ min: -Math.PI / 6, max: 70 * Math.PI / 180 })
export const clampPitch = (pitch) => Math.max(PITCH_LIMITS.min, Math.min(PITCH_LIMITS.max, pitch))
export const draggedPitch = (pitch, deltaY) => clampPitch(pitch + deltaY * 0.008)
export const cameraUniforms = (yaw, pitch) => [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch)]
const add = (a, b) => a.map((v, i) => v + b[i])
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const rotate = (q, v) => {
  const t = cross(q.slice(1), v).map((x) => 2 * x)
  return add(
    v,
    add(
      t.map((x) => q[0] * x),
      cross(q.slice(1), t),
    ),
  )
}
const mul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
]
const compose = (a, b) => ({ p: add(a.p, rotate(a.q, b.p)), q: mul(a.q, b.q) })
export function parseMesh(buffer) {
  const v = new DataView(buffer)
  let o = 0
  const n = (method, size) => () => {
    if (o + size > v.byteLength) throw Error('模型数据不完整')
    const x = v[method](o, true)
    o += size
    return x
  }
  const u8 = n('getUint8', 1),
    u16 = n('getUint16', 2),
    i16 = n('getInt16', 2),
    u32 = n('getUint32', 4),
    f32 = n('getFloat32', 4),
    vec = () => [f32(), f32(), f32()],
    quat = () => [f32(), f32(), f32(), f32()]
  if (String.fromCharCode(u8(), u8(), u8(), u8()) !== 'DUCK' || u32() !== 1)
    throw Error('模型版本不匹配')
  const nm = u16(),
    nb = u16(),
    np = u16()
  const meshes = Array.from({ length: nm }, () => {
    const nv = u16(),
      nt = u16()
    return {
      vertices: Array.from({ length: nv }, vec),
      triangles: Array.from({ length: nt }, () => [u16(), u16(), u16()]),
    }
  })
  const bodies = Array.from({ length: nb }, () => ({
    parent: i16(),
    joint: i16(),
    p: vec(),
    q: quat(),
    axis: vec(),
  }))
  const parts = Array.from({ length: np }, () => {
    const body = u16(),
      mesh = u16(),
      rgb = [u8(), u8(), u8()]
    u8()
    return { body, mesh, rgb, p: vec(), q: quat() }
  })
  return { meshes, bodies, parts }
}
const VERTEX_SHADER = `
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat3 u_rotation;
uniform vec3 u_translation;
uniform vec3 u_color;
uniform float u_shade;
uniform vec2 u_size;
uniform vec4 u_camera;
uniform float u_scale;
varying vec3 v_color;
void main() {
  vec3 world = u_rotation * a_position + u_translation;
  float x = u_camera.x * world.x - u_camera.y * world.y;
  float depth = u_camera.y * world.x + u_camera.x * world.y;
  float z = world.z - 0.13;
  float height = u_camera.z * z - u_camera.w * depth;
  float distance = u_camera.z * depth + u_camera.w * z;
  gl_Position = vec4(2.0 * x * u_scale / u_size.x,
                     -0.06 + 2.0 * height * u_scale / u_size.y,
                     distance / 4.0, 1.0);
  vec3 normal = u_rotation * a_normal;
  float light = .5 + .5 * abs(dot(normal / max(length(normal), 1.0e-12), vec3(.3, -.5, .8)));
  v_color = u_color * mix(1.0, light, u_shade);
}`
const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_color;
void main() { gl_FragColor = vec4(v_color, 1.0); }
`

function shader(gl, type, source) {
  const result = gl.createShader(type)
  gl.shaderSource(result, source)
  gl.compileShader(result)
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(result)
    gl.deleteShader(result)
    throw Error(`3D 着色器加载失败：${error}`)
  }
  return result
}

export class Preview {
  constructor(canvas) {
    this.canvas = canvas
    this.lifetime = new AbortController()
    this.angles = Array(15).fill(0)
    Object.assign(this, DEFAULT_VIEW)
    this.model = null
    this.queued = false
    this.disposed = false
    this.error = null
    this.gl = canvas.getContext('webgl', { alpha: true, antialias: true, depth: true })
    this.onLost = (event) => {
      event.preventDefault()
      this.lost = true
    }
    this.onRestored = () => {
      this.lost = false
      try {
        this.initialize()
        this.draw()
      } catch (error) {
        this.error = error
      }
    }
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    if (this.gl) {
      try {
        this.initialize()
      } catch (error) {
        this.error = error
      }
    } else {
      this.error = Error('此浏览器未启用 WebGL，无法显示 3D 姿态')
    }

    let last = null
    canvas.addEventListener('pointerdown', (event) => {
      last = [event.clientX, event.clientY]
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!last) return
      this.yaw += (event.clientX - last[0]) * 0.01
      this.pitch = draggedPitch(this.pitch, event.clientY - last[1])
      last = [event.clientX, event.clientY]
      this.draw()
    })
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(name, () => (last = null))
    }
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        this.zoom = Math.max(0.5, Math.min(2.5, this.zoom * Math.exp(-event.deltaY * 0.001)))
        this.draw()
      },
      { passive: false },
    )
    this.observer = new ResizeObserver(() => this.draw())
    this.observer.observe(canvas)
  }

  initialize() {
    const gl = this.gl
    const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    this.program = gl.createProgram()
    gl.attachShader(this.program, vertex)
    gl.attachShader(this.program, fragment)
    gl.linkProgram(this.program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw Error(`3D 程序加载失败：${gl.getProgramInfoLog(this.program)}`)
    }
    this.positions = gl.getAttribLocation(this.program, 'a_position')
    this.normals = gl.getAttribLocation(this.program, 'a_normal')
    this.rotation = gl.getUniformLocation(this.program, 'u_rotation')
    this.translation = gl.getUniformLocation(this.program, 'u_translation')
    this.color = gl.getUniformLocation(this.program, 'u_color')
    this.shade = gl.getUniformLocation(this.program, 'u_shade')
    this.size = gl.getUniformLocation(this.program, 'u_size')
    this.camera = gl.getUniformLocation(this.program, 'u_camera')
    this.scale = gl.getUniformLocation(this.program, 'u_scale')
    this.meshBuffers = []
    this.uploadedModel = null
    this.gridBuffer = gl.createBuffer()
    const grid = []
    for (let k = -6; k <= 6; k++) {
      for (const p of [
        [k * 0.05, -0.3, 0],
        [k * 0.05, 0.3, 0],
        [-0.3, k * 0.05, 0],
        [0.3, k * 0.05, 0],
      ]) {
        grid.push(...p, 0, 0, 0)
      }
    }
    this.gridCount = grid.length / 6
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    //Compatible: both the original STL bake and older DUCK assets can contain mixed winding.
    // Keep both sides; use depth, rather than triangle order, to decide visibility.
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
  }

  async load() {
    if (this.error) throw this.error
    const response = await fetch('/duck.bin', { signal: this.lifetime.signal })
    if (!response.ok) throw Error('模型加载失败')
    this.model = parseMesh(await response.arrayBuffer())
    this.draw()
  }

  highlightJoint(index) { this.selectedJoint = index; this.draw() }

  pose(angles, orientation = [1, 0, 0, 0]) {
    this.angles = angles
    this.orientation = orientation
    this.draw()
  }
  reset() {
    Object.assign(this, DEFAULT_VIEW)
    this.draw()
  }
  draw() {
    if (this.queued || this.disposed) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      if (!this.disposed) this.render()
    })
  }

  bind(buffer) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(this.positions)
    gl.vertexAttribPointer(this.positions, 3, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(this.normals)
    gl.vertexAttribPointer(this.normals, 3, gl.FLOAT, false, 24, 12)
  }

  uploadModel() {
    if (this.uploadedModel === this.model) return
    const gl = this.gl
    for (const mesh of this.meshBuffers) gl.deleteBuffer(mesh.buffer)
    this.meshBuffers = this.model.meshes.map((mesh) => {
      const data = new Float32Array(mesh.triangles.length * 18)
      let offset = 0
      for (const indices of mesh.triangles) {
        const points = indices.map((i) => mesh.vertices[i])
        const normal = cross(
          points[1].map((x, i) => x - points[0][i]),
          points[2].map((x, i) => x - points[0][i]),
        )
        const length = Math.hypot(...normal) || 1
        for (const point of points) {
          data.set(point, offset)
          data.set(
            normal.map((x) => x / length),
            offset + 3,
          )
          offset += 6
        }
      }
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      return { buffer, count: mesh.triangles.length * 3 }
    })
    this.uploadedModel = this.model
  }

  transform(pose) {
    // Matrix columns are the transformed local basis vectors, as WebGL expects.
    this.gl.uniformMatrix3fv(
      this.rotation,
      false,
      new Float32Array([
        ...rotate(pose.q, [1, 0, 0]),
        ...rotate(pose.q, [0, 1, 0]),
        ...rotate(pose.q, [0, 0, 1]),
      ]),
    )
    this.gl.uniform3f(this.translation, ...pose.p)
  }

  render() {
    if (this.disposed || this.error || this.lost || !this.model) return
    const canvas = this.canvas,
      gl = this.gl
    const w = canvas.clientWidth,
      h = canvas.clientHeight
    if (w <= 0 || h <= 0) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(w * dpr)),
      height = Math.max(1, Math.round(h * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.depthMask(true)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.uniform2f(this.size, w, h)
    // Positive pitch is camera elevation above the floor. Clip depth increases away
    // from the viewer, so elevation contributes -sin(pitch) to the depth axis.
    gl.uniform4f(this.camera, ...cameraUniforms(this.yaw, this.pitch))
    gl.uniform1f(this.scale, Math.min(w, h) * 2.3 * this.zoom)

    // The grid is a background guide, not an opaque floor cutting through the feet.
    this.transform({ p: [0, 0, 0], q: [1, 0, 0, 0] })
    gl.uniform3f(this.color, 0.74, 0.78, 0.7)
    gl.uniform1f(this.shade, 0)
    gl.depthMask(false)
    this.bind(this.gridBuffer)
    gl.drawArrays(gl.LINES, 0, this.gridCount)
    gl.depthMask(true)

    const poses = []
    for (const body of this.model.bodies) {
      let pose = { p: body.p, q: body.q }
      if (body.joint >= 0) {
        const angle = this.angles[body.joint] || 0,
          s = Math.sin(angle / 2)
        pose = compose(pose, {
          p: [0, 0, 0],
          q: [Math.cos(angle / 2), ...body.axis.map((x) => x * s)],
        })
      }
      // Rotate the trunk about its measured origin. The floor grid remains horizontal.
      if (body.parent < 0 && this.orientation) pose.q = mul(this.orientation, pose.q)
      poses.push(body.parent < 0 ? pose : compose(poses[body.parent], pose))
    }
    // Full-resolution CAD stays in static GPU buffers, shared by every repeated part.
    // Only rigid transforms and material colour change as the servos move.
    this.uploadModel()
    gl.uniform1f(this.shade, 1)
    for (const part of this.model.parts) {
      const mesh = this.meshBuffers[part.mesh]
      this.transform(compose(poses[part.body], part))
      gl.uniform3f(this.color, ...(this.selectedJoint >= 0 && this.model.bodies[part.body].joint === this.selectedJoint ? [0.92, 0.56, 0.2] : part.rgb.map((value) => value / 255)))
      this.bind(mesh.buffer)
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count)
    }
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    this.observer.disconnect()
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    if (!this.gl) return
    for (const mesh of this.meshBuffers || []) this.gl.deleteBuffer(mesh.buffer)
    this.gl.deleteBuffer(this.gridBuffer)
    this.gl.deleteProgram(this.program)
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
