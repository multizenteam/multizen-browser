import debug from 'electron-debug'
import installExtension, { VUEJS_DEVTOOLS, APOLLO_DEVELOPER_TOOLS } from 'electron-devtools-installer'
import logger from 'electron-log'
import path from 'path'
import { app, BrowserWindow, screen, shell, Tray, Menu, globalShortcut, ipcMain } from 'electron'
import { config as dotenvConfig } from 'dotenv'
import { initialize as initializeElectronRemote } from '@electron/remote/main'
import { version } from '../../package.json'
const contextMenu = require('electron-context-menu')

const appName = 'MultiZen Browser'
const devMode = process.env.NODE_ENV === 'development'
const appDataPath = devMode ? path.resolve(process.cwd()) : path.resolve(app.getPath('appData'))
const logsPath = path.resolve(appDataPath, 'Logs', 'browser.log')
const appVersion = version || ''
const titleVersion = devMode ? 'DEVELOPMENT' : `${appVersion}`.trim()
const windowTitle = `MultiZen Browser ${titleVersion}`
const pathApp = path.join('file://', __dirname, '/index.html')
const electronWindowLocation = devMode ? 'http://127.0.0.1:9080' : pathApp
const isMacOS = process.platform === 'darwin'

app.name = appName
app.setPath('userData', path.join(appDataPath, appName))
logger.transports.file.resolvePath = () => logsPath
logger.catchErrors()

let electronWindow

function initializeDevMode () {
  dotenvConfig({ path: '.env.development' })
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
function initializeProductionMode () {
  dotenvConfig({ path: path.join(path.dirname(process.argv[0]), '.env') })
  global.__static = path.join(__dirname, '/static').replace(/\\/g, '\\\\')
}

function installExtensions () {
  installExtension(VUEJS_DEVTOOLS)
    .catch((err) => logger.error('Unable to install `vue-devtools`: \n', err))

  installExtension(APOLLO_DEVELOPER_TOOLS)
    .catch((err) => logger.error('Unable to install `apollo-devtools`: \n', err))
}

function showElectronWindow () {
  if (!electronWindow) {
    const currentDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const WORK_AREA_RATIO = 0.9

    electronWindow = new BrowserWindow({
      title: windowTitle,
      width: Math.floor(currentDisplay.workAreaSize.width * WORK_AREA_RATIO),
      height: Math.floor(currentDisplay.workAreaSize.height * WORK_AREA_RATIO),
      minWidth: 992,
      minHeight: 600,
      useContentSize: true,
      frame: false,
      icon: getPath('static/icons/icon.png'),
      webPreferences: {
        nodeIntegration: true,
        webviewTag: true,
        webSecurity: true,
        enableRemoteModule: true,
        contextIsolation: false
      }
    })

    electronWindow.setMenuBarVisibility(false)

    electronWindow.loadURL(electronWindowLocation)

    electronWindow.on('closed', () => {
      electronWindow = null
    })

    electronWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)

      return { action: 'deny' }
    })
  }

  if (electronWindow.isMinimized()) {
    electronWindow.restore()
  }

  electronWindow.focus()
}

function getPath (pathTo) {
  if (devMode) {
    return path.join(pathTo)
  } else {
    return path.join(__dirname, pathTo)
  }
}

function buildTray () {
  const tray = new Tray(getPath('static/icons/icon.png'))
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open MultiZen',
      click: () => {
        showElectronWindow()
      }
    },
    {
      label: 'Show logs',
      click: () => {
        shell.openPath(logsPath)
      }
    },
    {
      label: 'Exit',
      click: async () => {
        app.exit()
        app.quit()
      }
    }
  ])
  tray.setToolTip('MultiZen Browser')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    showElectronWindow()
  })
}

// Main
initializeElectronRemote()

debug({
  devToolsMode: 'previous',
  enabled: true
})

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(() => {
    logger.log('Browser is ready to work')

    process.on('uncaughtException', (error) => {
      logger.error('Nodejs uncaught Exception:', error)
    })

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Nodejs unhandled Rejection:', reason, 'Promise:', promise)
    })

    if (devMode) {
      initializeDevMode()
    } else {
      initializeProductionMode()
    }

    installExtensions()
    buildTray()
    showElectronWindow()
  })

  contextMenu()

  app.on('web-contents-created', (_, contents) => {
    if (contents.getType() === 'webview') {
      contextMenu({
        window: {
          webContents: contents,
          inspectElement: contents.inspectElement.bind(contents)
        }
      })
    }
  })

  app.on('browser-window-focus', () => {
    globalShortcut.registerAll(
      ['CommandOrControl+W'],
      () => {
        electronWindow.webContents.send('shortcut:ctrl+w')
      }
    )
    globalShortcut.registerAll(
      ['CommandOrControl+T'],
      () => {
        electronWindow.webContents.send('shortcut:ctrl+t')
      }
    )
  })

  app.on('browser-window-blur', () => {
    globalShortcut.unregisterAll()
  })

  app.on('second-instance', (e, argv) => {
    logger.log('Second instance detected')
  })

  app.on('window-all-closed', () => {
    logger.log('All windows are closed. It\'s time to exit MultiZen.')
    app.quit()
  })
} else {
  app.quit()
}

app.on('before-quit', async (event) => {
  logger.log('App is going to quit.')

  if (electronWindow && !electronWindow.isDestroyed()) {
    electronWindow.removeAllListeners('close')
    electronWindow.close()
  }

  app.removeAllListeners()
})

ipcMain.on('minimize-window', (event) => {
  if (electronWindow && !electronWindow.isDestroyed()) {
    electronWindow.minimize()
  }
})

ipcMain.on('maximize-window', (event) => {
  if (electronWindow && !electronWindow.isDestroyed()) {
    if (electronWindow.isMaximized()) {
      if (isMacOS) {
        electronWindow.setFullScreen(false)
      } else {
        electronWindow.unmaximize()
      }
    } else {
      if (isMacOS) {
        electronWindow.setFullScreen(true)
      } else {
        electronWindow.maximize()
      }
    }
  }
})

ipcMain.on('close-window', (event) => {
  if (electronWindow && !electronWindow.isDestroyed()) {
    electronWindow.close()
  }
})
