// UPNG.js is prepended to this script by ToAPNG.ts before creating the Worker

onmessage = function (ev) {
  var data = ev.data
  var started = performance.now()
  var stage = 'start-message'
  try {
    // 区分尚在排队的请求与已经进入 UPNG.encode 的请求。
    self.postMessage({ id: data.id, type: 'started' })
    stage = 'encode'
    var pngFile = UPNG.encode(
      data.arrayBuffList,
      data.width,
      data.height,
      0,
      data.delayList
    )
    stage = 'post-result'
    self.postMessage(
      { id: data.id, result: pngFile, encodeMs: performance.now() - started },
      [pngFile]
    )
  } catch (error) {
    // Error 对象的属性不会被 JSON.stringify 自动保留，显式传递堆栈。
    self.postMessage({
      id: data.id,
      stage: stage,
      error: {
        name: error && error.name ? error.name : 'Error',
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : undefined,
      },
      encodeMs: performance.now() - started,
    })
  }
}
