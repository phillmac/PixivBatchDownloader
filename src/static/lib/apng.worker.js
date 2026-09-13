// UPNG.js is prepended to this script by ToAPNG.ts before creating the Worker

onmessage = function (ev) {
  var data = ev.data
  var started = performance.now()
  var stage = 'start-message'
  var framesCompressed = 0
  var preparedFrames = []
  var frame = null
  var lastFrameMs = null
  var compressionStarted = null
  var originals = {
    framize: UPNG.encode.framize,
    compressPNG: UPNG.encode.compressPNG,
    _filterZero: UPNG.encode._filterZero,
    _main: UPNG.encode._main,
  }

  // 只发送阶段和帧级标量；像素不进入消息或失败日志。
  function progress() {
    self.postMessage({
      id: data.id,
      type: 'progress',
      progress: {
        stage: stage,
        frameCount: data.arrayBuffList.length,
        framesCompressed: framesCompressed,
        frame: frame,
        lastFrameMs: lastFrameMs,
        encodeMs: Math.round(performance.now() - started),
        compressionMs:
          compressionStarted === null
            ? null
            : Math.round(performance.now() - compressionStarted),
      },
    })
  }

  try {
    // 区分尚在排队的请求与已经进入 UPNG.encode 的请求。
    self.postMessage({ id: data.id, type: 'started' })
    stage = 'encode'

    // 包装编码器入口以观察进度，不改变滤波、压缩参数或编码结果。
    UPNG.encode.framize = function () {
      stage = 'frame-differences'
      progress()
      var result = originals.framize.apply(this, arguments)
      stage = 'palette-analysis'
      progress()
      return result
    }
    UPNG.encode.compressPNG = function (out) {
      preparedFrames = out.frames
      compressionStarted = performance.now()
      stage = 'compress-frames'
      progress()
      return originals.compressPNG.apply(this, arguments)
    }
    UPNG.encode._filterZero = function () {
      var rect = preparedFrames[framesCompressed].rect
      frame = {
        index: framesCompressed,
        width: rect.width,
        height: rect.height,
      }
      stage = 'compress-frame'
      progress()
      var frameStarted = performance.now()
      var result = originals._filterZero.apply(this, arguments)
      lastFrameMs = Math.round(performance.now() - frameStarted)
      framesCompressed++
      return result
    }
    UPNG.encode._main = function () {
      frame = null
      stage = 'assemble-png'
      progress()
      return originals._main.apply(this, arguments)
    }

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
  } finally {
    // worker 会被后续请求复用；成功或异常都必须还原入口。
    for (var name in originals) UPNG.encode[name] = originals[name]
  }
}
