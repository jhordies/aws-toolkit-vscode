/*!
 * Minimal webpack loader that transpiles TypeScript using the TypeScript
 * compiler API directly — no esbuild binary required.
 */

'use strict'

const typescript = require('typescript')
const path = require('path')

module.exports = function tscLoader(source) {
    const callback = this.async()
    const filePath = this.resourcePath

    // Load tsconfig from the package directory
    const configPath = typescript.findConfigFile(
        path.dirname(filePath),
        typescript.sys.fileExists,
        'tsconfig.json'
    )

    let compilerOptions = {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2021,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        sourceMap: true,
        inlineSources: true,
        declaration: false,
        skipLibCheck: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: false,
    }

    if (configPath) {
        const configFile = typescript.readConfigFile(configPath, typescript.sys.readFile)
        if (!configFile.error) {
            const parsed = typescript.parseJsonConfigFileContent(
                configFile.config,
                typescript.sys,
                path.dirname(configPath)
            )
            compilerOptions = { ...parsed.options, ...compilerOptions }
        }
    }

    const result = typescript.transpileModule(source, {
        compilerOptions,
        fileName: filePath,
        reportDiagnostics: false,
    })

    if (result.sourceMapText) {
        const map = JSON.parse(result.sourceMapText)
        callback(null, result.outputText, map)
    } else {
        callback(null, result.outputText)
    }
}
