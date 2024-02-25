import { app } from "electron";
import { resolve, join } from "path";
import env from "./env";

export const getPath = (pathTo: string): string => {
    if (env.main.isDev) {
        return join(pathTo);
    } else {
        return join(process.resourcesPath, "icons/icon.png");
    }
};

export const appDataPath = env.main.isDev
    ? resolve(process.cwd())
    : resolve(app.getPath("appData"));

export const logsPath = resolve(
    appDataPath,
    env.main.appName,
    "Logs",
    "browser.log",
);
