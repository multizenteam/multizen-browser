import { app } from "electron";
import { resolve, join } from "path";
import env from "./env";

export const getPath = (pathTo: string): string => {
    if (env.main.isDev) {
        return join(pathTo);
    } else {
        return join(__dirname, pathTo);
    }
};

export const appDataPath = env.main.isDev
    ? resolve(process.cwd())
    : resolve(app.getPath("appData"));

export const logsPath = resolve(appDataPath, "Logs", "browser.log");
