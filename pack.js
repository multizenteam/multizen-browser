console.time("build-time");

const builder = require("electron-builder");

const options = {
    productName: "MultiZen Browser",
    appId: "com.imbacorp.multizen",
    artifactName: "MultiZen-Browser_${arch}_${os}.${ext}",
    compression: "normal", // "store” | “normal” | "maximum". - For testing builds, use 'store' to reduce build time significantly.
    removePackageScripts: true,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    directories: {
        output: ".output",
    },
    extraFiles: [
        {
            from: "resources",
            to: "resources",
        },
    ],
    files: ["out/**/*"],
    dmg: {
        contents: [
            {
                x: 410,
                y: 150,
                type: "link",
                path: "/Applications",
            },
            {
                x: 130,
                y: 150,
                type: "file",
            },
        ],
    },
    mac: {
        icon: "resources/icons/icon.png",
    },
    win: {
        icon: "resources/icons/icon.png",
        target: [
            {
                target: "nsis",
                arch: ["x64"],
            },
        ],
    },
    linux: {
        icon: "resources/icons",
        category: "Network;WebBrowser;",
        target: [
            {
                target: "deb",
                arch: ["x64"],
            },
        ],
    },
};

builder
    .build({
        config: options,
    })
    .then((result) => {
        if (result.length) {
            console.log("output:", JSON.stringify(result));
        }
        console.timeEnd("build-time");
    })
    .catch((error) => {
        console.error(error);
    });
