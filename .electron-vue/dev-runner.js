'use strict'

const chalk = require('chalk')
const electron = require('electron')
const path = require('path')
const { say } = require('cfonts')
const { spawn } = require('child_process')
const webpack = require('webpack')
const WebpackDevServer = require('webpack-dev-server')
const webpackHotMiddleware = require('webpack-hot-middleware')

const mainConfig = require('./webpack.main.config')
const rendererConfig = require('./webpack.renderer.config')

let electronProcess = null
let manualRestart = false
let hotMiddleware

function init () {
    greeting()

    Promise.all([startRenderer(), startMain()])
        .then(() => {
            startElectron()
        })
        .catch(err => {
            console.error(err)
        })
}

init()

function logStats (proc, data) {
    let log = ''

    log += chalk.yellow.bold(`┏ ${proc} Process ${new Array((19 - proc.length) + 1).join('-')}`)
    log += '\n\n'

    if (typeof data === 'object') {
        data.toString({
            colors: true,
            chunks: false
        }).split(/\r?\n/).forEach(line => {
            log += '  ' + line + '\n'
        })
    } else {
        log += `  ${data}\n`
    }

    log += '\n' + chalk.yellow.bold(`┗ ${new Array(28 + 1).join('-')}`)

    console.info(log)
}

function startRenderer () {
    return new Promise((resolve) => {
        rendererConfig.entry.renderer = [path.join(__dirname, 'dev-client')].concat(rendererConfig.entry.renderer)
        rendererConfig.mode = 'development'
        const compiler = webpack(rendererConfig)
        hotMiddleware = webpackHotMiddleware(compiler, {
            log: false,
            heartbeat: 2500
        })

        compiler.hooks.compilation.tap('compilation', compilation => {
            compilation.hooks.htmlWebpackPluginAfterEmit.tapAsync('html-webpack-plugin-after-emit', (data, cb) => {
                hotMiddleware.publish({ action: 'reload' })
                cb()
            })
        })

        compiler.hooks.done.tap('done', stats => {
            logStats('Renderer', stats)
        })

        const server = new WebpackDevServer(
            compiler,
            {
                hot: true,
                contentBase: path.join(__dirname, '../'),
                quiet: true,
                before (app, ctx) {
                    app.use(hotMiddleware)
                    ctx.middleware.waitUntilValid(() => {
                        resolve()
                    })
                }
            }
        )

        server.listen(9080)
    })
}

function startMain () {
    return new Promise((resolve) => {
        mainConfig.mode = 'development'
        const compiler = webpack(mainConfig)

        compiler.hooks.watchRun.tapAsync('watch-run', (compilation, done) => {
            logStats('Main', chalk.white.bold('compiling...'))
            hotMiddleware.publish({ action: 'compiling' })
            done()
        })

        compiler.watch({}, (err, stats) => {
            if (err) {
                console.info(err)
                return
            }

            logStats('Main', stats)

            if (electronProcess && electronProcess.kill) {
                manualRestart = true
                process.kill(electronProcess.pid)
                electronProcess = null
                startElectron()

                setTimeout(() => {
                    manualRestart = false
                }, 5000)
            }

            resolve()
        })
    })
}

function startElectron () {
    var args = [
        '--inspect=5858',
        path.join(__dirname, '../dist/electron/main.js')
    ]

    // detect yarn or npm and process commandline args accordingly
    if (process.env.npm_execpath.endsWith('yarn.js')) {
        args = args.concat(process.argv.slice(3))
    } else if (process.env.npm_execpath.endsWith('npm-cli.js')) {
        args = args.concat(process.argv.slice(2))
    }

    electronProcess = spawn(electron, args)

    electronProcess.stdout.on('data', data => {
        electronLog(data, 'blue')
    })
    electronProcess.stderr.on('data', data => {
        electronLog(data, 'red')
    })

    electronProcess.on('close', () => {
        if (!manualRestart) process.exit()
    })
}

function electronLog (data, color) {
    let log = ''
    data = data.toString().split(/\r?\n/)
    data.forEach(line => {
        log += `  ${line}\n`
    })
    if (/[0-9A-z]+/.test(log)) {
        console.info(
            chalk[color].bold('┏ Electron -------------------') +
            '\n' +
            log +
            chalk[color].bold('┗ ----------------------------')
        )
    }
}

function greeting () {
    const cols = process.stdout.columns
    const text = cols > 76 ? 'MultiZen' : null

    if (text) {
        say(text, {
            colors: ['blue'],
            font: 'block',
            space: true
        })
    } else {
        console.info(chalk.yellow.bold('\n  MultiZen'))
    }

    console.info(chalk.blue('  getting ready...') + '\n')
}
