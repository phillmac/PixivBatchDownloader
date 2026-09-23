function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve(reply)
    })
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
