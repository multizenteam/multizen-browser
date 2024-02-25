import os from "os";
import { version } from "../../package.json";

export default {
    main: {
        appName: "MultiZen Browser",
        isDev: process.env.NODE_ENV === "development",
        appVersion: version || "",
    },
    platform: {
        isMac: os.platform() === "darwin",
        isWindows: os.platform() === "win32",
    },
};
