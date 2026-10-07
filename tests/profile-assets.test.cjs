const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function loadModule(
  profile,
  {
    getImg = async () => null,
    sleep = async () => {},
    blobToDataURL = async () => 'data:application/octet-stream;base64,AA==',
  } = {}
) {
  const file = path.join(root, 'src/ts/ProfileAssets.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText

  const exports = {}
  const context = vm.createContext({ console })
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === './API') {
      return {
        API: {
          async getUserProfile() {
            return profile
          },
        },
      }
    }
    if (name === './utils/GetImage') return { getImg }
    if (name === './utils/Utils') return { Utils: { sleep, blobToDataURL } }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  return exports
}

function profile(body) {
  return { error: false, message: '', body }
}

test('non-GIF avatar exposes original-size URL and version key', async () => {
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Example',
      imageBig:
        'https://i.pximg.net/user-profile/img/2026/01/01/example_170.png',
      background: null,
    })
  )

  const value = await mod.getProfileAssetMetadata('123')
  assert.equal(value.userId, '123')
  assert.equal(
    value.avatar.downloadUrl,
    'https://i.pximg.net/user-profile/img/2026/01/01/example.png'
  )
  assert.equal(value.avatar.versionKey, value.avatar.downloadUrl)
  assert.equal(value.avatar.isDefault, false)
  assert.equal(value.background, null)
})

test('GIF avatar keeps Pixiv 170px URL because larger variant is not safe', async () => {
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'GIF User',
      imageBig:
        'https://i.pximg.net/user-profile/img/2026/01/01/example_170.gif',
      background: null,
    })
  )

  const value = await mod.getProfileAssetMetadata('123')
  assert.equal(value.avatar.downloadUrl, value.avatar.sourceUrl)
})

test('default Pixiv avatar is identified and left unchanged', async () => {
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Default User',
      imageBig: 'https://s.pximg.net/common/images/no_profile.png',
      background: null,
    })
  )

  const value = await mod.getProfileAssetMetadata('123')
  assert.equal(value.avatar.isDefault, true)
  assert.equal(value.avatar.downloadUrl, value.avatar.sourceUrl)
})

test('profile background metadata preserves URL and privacy flag', async () => {
  const backgroundUrl =
    'https://i.pximg.net/c/1920x960_80_a2_g5/background/img/example.png'
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Background User',
      imageBig: 'https://s.pximg.net/common/images/no_profile.png',
      background: { url: backgroundUrl, isPrivate: true },
    })
  )

  const value = await mod.getProfileAssetMetadata('123')
  assert.equal(value.background.sourceUrl, backgroundUrl)
  assert.equal(value.background.versionKey, backgroundUrl)
  assert.equal(value.background.isPrivate, true)
})

test('Pixiv profile error responses fail instead of exposing partial metadata', async () => {
  const mod = loadModule({
    error: true,
    message: 'profile unavailable',
    body: {},
  })

  await assert.rejects(
    () => mod.getProfileAssetMetadata('123'),
    /profile unavailable/
  )
})

test('asset payload fetches the exact versioned avatar through the quiet image helper', async () => {
  const calls = []
  const fakeBlob = { size: 321, type: 'image/png' }
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Payload User',
      imageBig: 'https://i.pximg.net/user-profile/avatar_170.png',
      background: null,
    }),
    {
      getImg: async (...args) => {
        calls.push(args)
        return fakeBlob
      },
      blobToDataURL: async (blob) => {
        assert.equal(blob, fakeBlob)
        return 'data:image/png;base64,AAAA'
      },
    }
  )

  const value = await mod.getProfileAssetPayload(
    '123',
    'avatar',
    'https://i.pximg.net/user-profile/avatar.png'
  )
  assert.equal(value.kind, 'avatar')
  assert.equal(value.byteLength, 321)
  assert.equal(value.contentType, 'image/png')
  assert.equal(value.dataUrl, 'data:image/png;base64,AAAA')
  assert.deepEqual(calls, [
    ['https://i.pximg.net/user-profile/avatar.png', false],
  ])
})

test('missing profile background returns null without fetching image bytes', async () => {
  let calls = 0
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'No Background',
      imageBig: 'https://s.pximg.net/common/images/no_profile.png',
      background: null,
    }),
    {
      getImg: async () => {
        calls += 1
        return { size: 1, type: 'image/png' }
      },
    }
  )

  assert.equal(await mod.getProfileAssetPayload('123', 'background'), null)
  assert.equal(calls, 0)
})

test('version mismatch fails before fetching asset content', async () => {
  let calls = 0
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Changed User',
      imageBig: 'https://i.pximg.net/user-profile/new_170.png',
      background: null,
    }),
    {
      getImg: async () => {
        calls += 1
        return { size: 1, type: 'image/png' }
      },
    }
  )

  await assert.rejects(
    () =>
      mod.getProfileAssetPayload(
        '123',
        'avatar',
        'https://i.pximg.net/user-profile/old.png'
      ),
    /version changed/
  )
  assert.equal(calls, 0)
})

test('asset payload retries failed browser fetches but stops after the configured bound', async () => {
  let calls = 0
  const sleeps = []
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Retry User',
      imageBig: 'https://i.pximg.net/user-profile/retry_170.png',
      background: null,
    }),
    {
      getImg: async () => {
        calls += 1
        return calls === 3 ? { size: 9, type: 'image/png' } : null
      },
      sleep: async (ms) => sleeps.push(ms),
    }
  )

  const value = await mod.getProfileAssetPayload('123', 'avatar')
  assert.equal(value.byteLength, 9)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [250, 500])
})

test('asset payload rejects oversized browser responses', async () => {
  const mod = loadModule(
    profile({
      userId: '123',
      name: 'Large User',
      imageBig: 'https://i.pximg.net/user-profile/large_170.png',
      background: null,
    }),
    {
      getImg: async () => ({ size: 16 * 1024 * 1024 + 1, type: 'image/png' }),
    }
  )

  await assert.rejects(
    () => mod.getProfileAssetPayload('123', 'avatar'),
    /exceeds automation size limit/
  )
})
