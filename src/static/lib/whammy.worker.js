// whammy.js is prepended to this script before the worker is created.

/** Convert encoded frame bytes to base64 without overflowing the argument stack. */
function bytesToBase64(bytes) {
  var chunkSize = 0x8000
  var binary = ''
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

/** Convert an encoded WebP frame blob into the data URL expected by Whammy. */
function blobToDataURL(blob) {
  return blob.arrayBuffer().then(function (buffer) {
    return 'data:image/webp;base64,' + bytesToBase64(new Uint8Array(buffer))
  })
}

/** Compile the accumulated Whammy frames and resolve with the resulting WebM blob. */
function compileVideo(encoder) {
  return new Promise(function (resolve) {
    encoder.compile(false, function (blob) {
      resolve(blob)
    })
  })
}

/** Active acknowledged-streaming WebM jobs, keyed by request id. */
var jobs = new Map()

/**
 * Encode one transferred bitmap into the active Whammy job.
 * The worker owns the bitmap on entry and always closes it before returning.
 */
async function encodeFrame(job, bitmap, delay) {
  try {
    job.ctx.clearRect(0, 0, job.width, job.height)
    job.ctx.drawImage(bitmap, 0, 0)
    var blob = await job.canvas.convertToBlob({
      type: 'image/webp',
      quality: job.quality,
    })
    var dataURL = await blobToDataURL(blob)
    job.encoder.add(dataURL, delay)
  } finally {
    if (bitmap && bitmap.close) bitmap.close()
  }
}

/**
 * Handle the acknowledged streaming protocol used by the page coordinator.
 * Each frame is fully encoded and released before frame-complete is posted.
 */
async function handleStreaming(data) {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('Whammy worker requires OffscreenCanvas')
  }
  if (data.type === 'start') {
    var canvas = new OffscreenCanvas(data.width, data.height)
    jobs.set(data.id, {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      encoder: new Whammy.Video(),
      width: data.width,
      height: data.height,
      quality: data.quality,
      nextIndex: 0,
    })
    self.postMessage({ id: data.id, type: 'ready' })
    return
  }

  if (data.type === 'cancel') {
    jobs.delete(data.id)
    self.postMessage({ id: data.id, type: 'cancelled' })
    return
  }

  var job = jobs.get(data.id)
  if (!job) throw new Error('Unknown Whammy streaming job')

  if (data.type === 'frame') {
    if (data.index !== job.nextIndex) {
      throw new Error('Unexpected Whammy frame index')
    }
    await encodeFrame(job, data.bitmap, data.delay)
    job.nextIndex++
    self.postMessage({ id: data.id, type: 'frame-complete', index: data.index })
    return
  }

  if (data.type === 'finish') {
    var result = await compileVideo(job.encoder)
    jobs.delete(data.id)
    self.postMessage({ id: data.id, type: 'result', result: result })
    return
  }

  throw new Error('Unknown Whammy worker message type')
}

/**
 * Handle the legacy whole-bitmap-list protocol for fallback callers.
 * Every transferred bitmap is closed on both success and failure.
 */
async function handleLegacy(data) {
  var bitmaps = data.bitmaps
  var canvas = new OffscreenCanvas(data.width, data.height)
  var job = {
    canvas: canvas,
    ctx: canvas.getContext('2d'),
    encoder: new Whammy.Video(),
    width: data.width,
    height: data.height,
    quality: data.quality,
  }
  try {
    for (var i = 0; i < bitmaps.length; i++) {
      await encodeFrame(job, bitmaps[i], data.delays[i])
    }
    var webm = await compileVideo(job.encoder)
    self.postMessage({ id: data.id, result: webm })
  } finally {
    if (bitmaps && bitmaps.length) {
      bitmaps.forEach(function (bitmap) {
        if (bitmap && bitmap.close) bitmap.close()
      })
    }
  }
}

onmessage = async function (ev) {
  var data = ev.data
  try {
    if (data.type) {
      await handleStreaming(data)
    } else {
      await handleLegacy(data)
    }
  } catch (error) {
    jobs.delete(data.id)
    self.postMessage({
      id: data.id,
      type: data.type ? 'error' : undefined,
      error: error && error.message ? error.message : String(error),
    })
  }
}
