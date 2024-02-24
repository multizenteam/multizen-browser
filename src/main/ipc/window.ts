import { BrowserWindow, ipcMain } from "electron";
import env from "../env";

function initWindowIPC(window: BrowserWindow) {
    ipcMain.on("minimize-window", () => {
        if (window && !window.isDestroyed()) {
            window.minimize();
        }
    });

    ipcMain.on("maximize-window", () => {
        if (window && !window.isDestroyed()) {
            if (window.isMaximized()) {
                if (env.platform.isMac) {
                    window.setFullScreen(false);
                } else {
                    window.unmaximize();
                }
            } else {
                if (env.platform.isMac) {
                    window.setFullScreen(true);
                } else {
                    window.maximize();
                }
            }
        }
    });

    ipcMain.on("close-window", () => {
        if (window && !window.isDestroyed()) {
            window.close();
        }
    });
}

export default initWindowIPC;
