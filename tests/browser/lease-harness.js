function send(message) {
  const port = chrome.runtime.connect({ name: 'global-download-lease' })

  return new Promise((resolve, reject) => {
    let settled = false

    port.onMessage.addListener((reply) => {
      if (settled) return
      settled = true
      resolve(reply)
      port.disconnect()
    })

    port.onDisconnect.addListener(() => {
      if (settled) return
      settled = true
      const error = chrome.runtime.lastError
      reject(
        new Error(error?.message || 'Lease port disconnected before reply')
      )
    })

    port.postMessage(message)
  })
}

window.leaseTest = {
  acquire(requestId, fileId) {
    return send({
      msg: 'global_download_lease_acquire',
      requestId,
      fileId,
    })
  },
  renew(requestId, leaseId) {
    return send({
      msg: 'global_download_lease_renew',
      requestId,
      leaseId,
    })
  },
  release(requestId, leaseId) {
    return send({
      msg: 'global_download_lease_release',
      requestId,
      leaseId,
    })
  },
}
