import { BrowserWindow } from "electron";
import initWindowIPC from "./window";

function ipcInit(window: BrowserWindow) {
    initWindowIPC(window);
}

export default ipcInit;
