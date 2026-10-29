const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

/** 在现有 Node/VM 测试架构中加载诊断源码及其纯函数依赖。 */
function diagnosticsLoader(context, dependencies = {}) {
  const root = path.resolve(__dirname, '../../src/ts')
  const cache = new Map()
  return function load(relative) {
    const file = path.resolve(root, relative)
    if (cache.has(file)) return cache.get(file)
    const exports = {}
    cache.set(file, exports)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText
    vm.runInContext(`(function(require, exports) {${code}\n})`, context, {
      filename: file,
    })((name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('.'))
        return load(path.resolve(path.dirname(file), name + '.ts'))
      throw new Error(`unexpected require ${name}`)
    }, exports)
    return exports
  }
}

module.exports = { diagnosticsLoader }
