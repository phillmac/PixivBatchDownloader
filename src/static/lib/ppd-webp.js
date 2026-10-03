;(function () {
  'use strict'

  var _workerUrl = ''

  /** Attach bounded encoder diagnostics to the error returned to the caller. */
  function makeError(message, cause, diagnostic) {
    var error = cause instanceof Error ? cause : new Error(message)
    if (!error.message) error.message = message
    error.ppdWebP = diagnostic
    return error
  }

  /** Animated WebP encoder with one-frame-at-a-time worker backpressure. */
  var PPDWebP = {
    /** Configure the worker script used for bounded animated WebP encoding. */
    init: function (workerUrl) {
      _workerUrl = workerUrl
    },

    /**
     * Encode ImageBitmap frames without materialising a second full-frame set.
     * A single RGBA frame is copied, transferred, encoded and acknowledged before
     * the next frame is read. This keeps the original bitmap cache reusable while
     * bounding conversion-side raw-pixel memory.
     */
    encode: function (bitmaps, delays, options) {
      options = options || {}
      var quality = options.quality !== undefined ? options.quality : 0.94
      var loopCount = options.loopCount !== undefined ? options.loopCount : 0
      var timeoutMs = options.timeoutMs || 120000
      var onProgress =
        typeof options.onProgress === 'function'
          ? options.onProgress
          : function () {}

      if (!_workerUrl) {
        return Promise.reject(
          new Error('PPDWebP: call init(workerUrl) before encode()')
        )
      }
      if (!bitmaps || bitmaps.length === 0) {
        return Promise.reject(
          new Error('PPDWebP: bitmaps array must not be empty')
        )
      }

      var width = bitmaps[0].width
      var height = bitmaps[0].height
      var started = performance.now()
      var stage = 'create-worker'
      var frameIndex = -1
      var worker = new Worker(_workerUrl)
      var timeoutId = 0
      var settled = false
      var pendingFrame = null

      var diagnostic = function () {
        return {
          schemaVersion: 1,
          stage: stage,
          frameIndex: frameIndex,
          frameCount: bitmaps.length,
          width: width,
          height: height,
          rawFrameBytes: width * height * 4,
          timeoutMs: timeoutMs,
          elapsedMs: Math.round(performance.now() - started),
        }
      }

      return new Promise(function (resolve, reject) {
        function clearTimer() {
          if (timeoutId) {
            window.clearTimeout(timeoutId)
            timeoutId = 0
          }
        }

        function cleanup() {
          clearTimer()
          worker.onmessage = null
          worker.onerror = null
          worker.onmessageerror = null
          worker.terminate()
        }

        function fail(message, cause) {
          if (settled) return
          settled = true
          var error = makeError(message, cause, diagnostic())
          if (pendingFrame) {
            pendingFrame.reject(error)
            pendingFrame = null
          }
          cleanup()
          reject(error)
        }

        function armTimeout(nextStage) {
          stage = nextStage
          clearTimer()
          timeoutId = window.setTimeout(function () {
            fail('PPDWebP: worker inactivity timeout')
          }, timeoutMs)
        }

        function progress(nextStage, index, extra) {
          stage = nextStage
          if (typeof index === 'number') frameIndex = index
          onProgress(Object.assign(diagnostic(), extra || {}))
          armTimeout(nextStage)
        }

        function sendFrame(index, rgba) {
          return new Promise(function (frameResolve, frameReject) {
            pendingFrame = {
              index: index,
              resolve: frameResolve,
              reject: frameReject,
            }
            progress('worker-frame', index)
            try {
              worker.postMessage(
                {
                  type: 'frame',
                  index: index,
                  delay: delays[index],
                  rgba: rgba,
                },
                [rgba]
              )
            } catch (error) {
              fail('PPDWebP: could not transfer frame to worker', error)
            }
          })
        }

        worker.onmessage = function (ev) {
          var data = ev.data || {}
          if (data.type === 'progress') {
            progress(data.stage || 'worker-progress', data.index, {
              encodedBytes: data.encodedBytes,
            })
            return
          }
          if (data.type === 'frame-complete') {
            if (!pendingFrame || pendingFrame.index !== data.index) return
            progress('frame-complete', data.index, {
              encodedBytes: data.encodedBytes,
            })
            var done = pendingFrame
            pendingFrame = null
            done.resolve()
            return
          }
          if (data.type === 'error') {
            if (data.stage) stage = 'worker-' + data.stage
            if (typeof data.index === 'number') frameIndex = data.index
            var workerError = new Error(
              data.error && data.error.message
                ? data.error.message
                : 'PPDWebP worker error'
            )
            workerError.name =
              data.error && data.error.name
                ? data.error.name
                : 'PPDWebPWorkerError'
            if (data.error && data.error.stack)
              workerError.stack = data.error.stack
            fail('PPDWebP: worker failed', workerError)
            return
          }
          if (data.type === 'result' && data.blob) {
            if (settled) return
            settled = true
            stage = 'complete'
            cleanup()
            resolve(data.blob)
            return
          }
          fail('PPDWebP: invalid worker response')
        }

        worker.onerror = function (ev) {
          fail(
            'PPDWebP: worker error',
            new Error(ev.message || 'PPDWebP worker error')
          )
        }
        worker.onmessageerror = function () {
          fail('PPDWebP: could not deserialize worker response')
        }

        ;(async function () {
          try {
            worker.postMessage({
              type: 'start',
              width: width,
              height: height,
              quality: quality,
              loopCount: loopCount,
              frameCount: bitmaps.length,
            })
            armTimeout('worker-start')

            var canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            var ctx = canvas.getContext('2d', { willReadFrequently: true })
            if (!ctx)
              throw new Error('PPDWebP: could not create 2D canvas context')

            for (var i = 0; i < bitmaps.length; i++) {
              frameIndex = i
              stage = 'read-frame-pixels'
              ctx.clearRect(0, 0, width, height)
              ctx.drawImage(bitmaps[i], 0, 0)
              var rgba = ctx.getImageData(0, 0, width, height).data.buffer
              await sendFrame(i, rgba)
            }

            frameIndex = bitmaps.length - 1
            armTimeout('assemble-webp')
            worker.postMessage({ type: 'finish' })
          } catch (error) {
            fail('PPDWebP: encode failed', error)
          }
        })()
      })
    },
  }

  window.PPDWebP = PPDWebP
})()
