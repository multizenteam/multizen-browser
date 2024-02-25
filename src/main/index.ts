import { app, shell, BrowserWindow, screen, globalShortcut } from "electron";
import { join } from "path";
import logger from "electron-log";
import { logsPath, appDataPath, getPath } from "./util";
import env from "./env";
import TrayMenuBuilder from "./tray";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import ipcInit from "./ipc/init";

let mainWindow: BrowserWindow | null = null;
let trayBuilder: TrayMenuBuilder | null = null;

app.name = env.main.appName;
app.setPath("userData", join(appDataPath, env.main.appName));
logger.transports.file.resolvePathFn = () => logsPath;
logger.errorHandler.startCatching();

const titleVersion = env.main.isDev
    ? "DEVELOPMENT"
    : `${env.main.appVersion}`.trim();

function createWindow(): void {
    const currentDisplay = screen.getDisplayNearestPoint(
        screen.getCursorScreenPoint(),
    );
    const WORK_AREA_RATIO = 0.9;

    mainWindow = new BrowserWindow({
        title: `${env.main.appName} ${titleVersion}`,
        width: Math.floor(currentDisplay.workAreaSize.width * WORK_AREA_RATIO),
        height: Math.floor(
            currentDisplay.workAreaSize.height * WORK_AREA_RATIO,
        ),
        minWidth: 992,
        minHeight: 600,
        useContentSize: true,
        frame: false,
        icon: getPath("resources/icons/icon.png"),
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            nodeIntegration: true,
            webviewTag: true,
            webSecurity: true,
            contextIsolation: false,
        },
    });

    mainWindow.setMenuBarVisibility(false);

    mainWindow.on("ready-to-show", () => {
        if (!mainWindow) {
            logger.error('"mainWindow" is not defined');
        }

        mainWindow.show();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    trayBuilder = new TrayMenuBuilder(mainWindow);
    trayBuilder.buildMenu();

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url);
        return { action: "deny" };
    });

    if (mainWindow) {
        ipcInit(mainWindow);
    }

    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
        mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    } else {
        mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    }
}

app.on("before-quit", () => {
    logger.log("App is going to quit.");

    trayBuilder?.destroyMenu();
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId("com.electron");

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on("browser-window-created", (_, window) => {
        optimizer.watchWindowShortcuts(window);
    });

    createWindow();

    app.on("activate", () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.on("browser-window-focus", () => {
        globalShortcut.registerAll(["CommandOrControl+W"], () => {
            mainWindow?.webContents.send("shortcut:ctrl+w");
        });
        globalShortcut.registerAll(["CommandOrControl+T"], () => {
            mainWindow?.webContents.send("shortcut:ctrl+t");
        });
    });

    app.on("browser-window-blur", () => {
        globalShortcut.unregisterAll();
    });
});

app.on("window-all-closed", () => {
    logger.log("All windows are closed. It's time to exit MultiZen.");
    app.quit();
});
