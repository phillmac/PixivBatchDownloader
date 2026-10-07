const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function loadModule(profile) {
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
