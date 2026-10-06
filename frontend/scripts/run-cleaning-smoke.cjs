// 冒烟脚本：用 TypeScript 自带的 transpileModule（纯 JS，无原生依赖）
// 即时转译 src 下的 TS 源码，在 Node 中验证管道清洗流转规则。
const fs = require('fs')
const path = require('path')
const Module = require('module')
const ts = require('typescript')

const FRONTEND_ROOT = path.join(__dirname, '..')
const SRC_ROOT = path.join(FRONTEND_ROOT, 'src')

// 支持 @/ 路径别名与 .ts 扩展的即时编译 require
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(SRC_ROOT, request.slice(2))
  }
  try {
    return originalResolve.call(this, request, parent, ...rest)
  } catch (error) {
    const tsCandidate = `${request}.ts`
    if (fs.existsSync(tsCandidate)) {
      return tsCandidate
    }
    const indexCandidate = path.join(request, 'index.ts')
    if (fs.existsSync(indexCandidate)) {
      return indexCandidate
    }
    throw error
  }
}

Module._extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

require(path.join(__dirname, 'cleaning-smoke-entry.ts'))
