import { BrowserWindow, Menu, Tray, shell, app } from "electron";
import env from "./env";
import { getPath, logsPath } from "./util";
import logger from "electron-log";

export default class TrayMenuBuilder {
    mainWindow: BrowserWindow;

    tray: Tray | null;

    isForceClose: boolean;

    constructor(mainWindow: BrowserWindow) {
        this.mainWindow = mainWindow;
        this.tray = null;
        this.isForceClose = false;
    }

    buildMenu() {
        this.tray = new Tray(getPath("resources/icons/icon.png"));

        const contextMenu = this.buildTray();

        this.tray.setToolTip(env.main.appName);
        this.tray.setContextMenu(contextMenu);

        this.tray.on("click", () => {
            this.mainWindow.show();
        });
    }

    buildTray(): Menu {
        return Menu.buildFromTemplate([
            {
                label: "Open MultiZen",
                click: () => {
                    this.mainWindow.show();
                },
            },
            {
                label: "Show logs",
                click: () => {
                    shell.openPath(logsPath);
                },
            },
            {
                label: "Exit",
                click: async () => {
                    app.exit();
                    app.quit();
                },
            },
        ]);
    }

    destroyMenu() {
        this.tray?.destroy();
    }
}
