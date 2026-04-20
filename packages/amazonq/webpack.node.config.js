/*!
 * Standalone webpack config for the main (Node) target only.
 * Uses a simple tsc-based transpile loader instead of esbuild-loader,
 * to work around group policy blocking esbuild.exe on this machine.
 */

'use strict'

const path = require('path')
const webpack = require('webpack')
const fs = require('fs')
const CircularDependencyPlugin = require('circular-dependency-plugin')
const { NLSBundlePlugin } = require('vscode-nls-dev/lib/webpack-bundler')
const typescript = require('typescript')

const currentDir = __dirname
const packageJson = JSON.parse(fs.readFileSync(path.join(currentDir, 'package.json'), 'utf8'))
const packageId = `${packageJson.publisher}.${packageJson.name}`

// Inline TS transpile loader — no external loader package needed
const inlineTsLoader = {
    loader: require.resolve('./tsc-loader.js'),
}

module.exports = {
    name: 'main',
    target: 'node',
    mode: 'development',
    devtool: 'source-map',
    entry: {
        'src/extensionNode': './src/extensionNode.ts',
    },
    output: {
        path: path.resolve(currentDir, 'dist'),
        filename: '[name].js',
        libraryTarget: 'commonjs2',
    },
    externals: {
        vscode: 'commonjs vscode',
        vue: 'root Vue',
        tls: 'commonjs tls',
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            '@aws/fully-qualified-names$': '@aws/fully-qualified-names/node/aws_fully_qualified_names.js',
        },
        fallback: { timers: false },
    },
    node: { __dirname: false },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules|testFixtures/,
                use: [inlineTsLoader],
            },
            {
                test: /node_modules[\\|/](amazon-states-language-service|vscode-json-languageservice)/,
                use: { loader: 'umd-compat-loader' },
            },
        ],
    },
    plugins: [
        new NLSBundlePlugin(packageId),
        new webpack.DefinePlugin({ EXTENSION_VERSION: JSON.stringify(packageJson.version) }),
        new webpack.DefinePlugin({ __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false' }),
        new CircularDependencyPlugin({ exclude: /node_modules|testFixtures/, failOnError: true }),
    ],
    optimization: { minimize: false },
}
