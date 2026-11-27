// Local-LAN consumer of mediad's existing gst-plugins-rs signalling protocol.
export function mediaUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/video`
}
export function connectMedia(video, report, url = mediaUrl()) {
  const address = new URL(url)
  if (!['ws:', 'wss:'].includes(address.protocol)) throw Error('信令地址必须使用 ws:// 或 wss://')
  let closed = false,
    session = null,
    pc = null,
    starting = false,
    chain = Promise.resolve(),
    ice = []
  const ws = new WebSocket(address.href),
    send = (value) => {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
    }
  const deadline = setTimeout(() => {
    if (!closed && (!pc || pc.connectionState !== 'connected')) {
      report('摄像头连接超时，请检查设备的视频服务')
      stop()
    }
  }, 15000)
  function stop() {
    if (closed) return
    if (session && ws.readyState === WebSocket.OPEN)
      send({ type: 'endSession', sessionId: session })
    closed = true
    clearTimeout(deadline)
    if (pc) {
      pc.close()
      pc = null
    }
    ws.close()
    if (video.srcObject) video.srcObject.getTracks().forEach((track) => track.stop())
    video.srcObject = null
  }
  function peer() {
    pc = new RTCPeerConnection()
    pc.ontrack = (e) => {
      if (closed) return
      video.srcObject = e.streams[0] || new MediaStream([e.track])
      video.play().catch(() => report('画面已连接，点击视频播放'))
      e.track.onended = () => report('媒体轨道已结束')
    }
    pc.onicecandidate = (e) => {
      if (e.candidate)
        send({
          type: 'peer',
          sessionId: session,
          ice: { candidate: e.candidate.candidate, sdpMLineIndex: e.candidate.sdpMLineIndex },
        })
    }
    pc.onconnectionstatechange = () => {
      if (!pc || closed) return
      const state = pc.connectionState
      if (state === 'connected') {
        clearTimeout(deadline)
        report('摄像头已连接')
      } else if (['failed', 'disconnected', 'closed'].includes(state))
        report('摄像头连接已中断，请重新连接')
    }
    pc.ondatachannel = (e) => {
      e.channel.onmessage = () => {}
    }
  }
  async function message(raw) {
    if (closed) return
    const m = JSON.parse(raw)
    switch (m.type) {
      case 'welcome':
        send({ type: 'list' })
        break
      case 'list':
        if (session || starting) return
        if (!m.producers?.length) {
          report('mediad 尚未发布摄像头，请检查采集管线')
          return
        }
        if (m.producers.length !== 1) {
          report('检测到多个媒体发布端，当前仅支持连接单个本机发布端')
          return
        }
        starting = true
        send({ type: 'startSession', peerId: m.producers[0].id })
        break
      case 'sessionStarted':
        session = m.sessionId
        starting = false
        peer()
        report('正在协商实时画面…')
        break
      case 'peer':
        if (m.sessionId !== session || !pc) return
        if (m.sdp) {
          if (m.sdp.type !== 'offer') throw Error('媒体发布端未提供 offer')
          await pc.setRemoteDescription(m.sdp)
          for (const candidate of ice) await pc.addIceCandidate(candidate)
          ice = []
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          send({ type: 'peer', sessionId: session, sdp: { type: 'answer', sdp: answer.sdp } })
        } else if (m.ice) {
          const candidate = { candidate: m.ice.candidate, sdpMLineIndex: m.ice.sdpMLineIndex }
          if (pc.remoteDescription) await pc.addIceCandidate(candidate)
          else ice.push(candidate)
        }
        break
      case 'endSession':
      case 'sessionRejected':
        report(m.reason || '媒体会话已结束')
        stop()
        break
      case 'error':
        report(m.details || '媒体服务返回错误')
        stop()
        break
    }
  }
  ws.onopen = () => report('正在连接摄像头…')
  ws.onmessage = (e) => {
    chain = chain
      .then(() => message(e.data))
      .catch((error) => {
        report(error.message)
        stop()
      })
  }
  ws.onerror = () => {
    if (!closed) report('无法连接本设备的视频服务，请确认摄像头和视频服务已就绪')
  }
  ws.onclose = () => {
    if (!closed) {
      report('摄像头连接已关闭')
      stop()
    }
  }
  report('正在打开媒体信令连接…')
  return stop
}
