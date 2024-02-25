<template>
    <div class="top-bar" :class="{ macos: isMac }">
        <tabs />

        <div class="top-bar-actions">
            <template v-if="isMac">
                <button class="top-bar-close" @click="closeWindow">
                    <i class="fa fa-times" />
                </button>
                <button class="top-bar-minimize" @click="minimizeWindow">
                    <i class="fa fa-window-minimize" />
                </button>
                <button class="top-bar-maximize" @click="maximizeWindow">
                    <i class="fa fa-window-maximize" />
                </button>
            </template>

            <template v-else>
                <button class="top-bar-minimize" @click="minimizeWindow">
                    <i class="fa fa-window-minimize" />
                </button>
                <button class="top-bar-maximize" @click="maximizeWindow">
                    <i class="fa fa-window-maximize" />
                </button>
                <button class="top-bar-close" @click="closeWindow">
                    <i class="fa fa-times" />
                </button>
            </template>
        </div>
    </div>
</template>

<script lang="ts">
import Tabs from "./tabs.vue";

export default {
    components: {
        Tabs,
    },
    data() {
        return {
            isMac: process.platform === "darwin",
        };
    },
    methods: {
        minimizeWindow() {
            window.electron.ipcRenderer.send("minimize-window");
        },

        maximizeWindow() {
            window.electron.ipcRenderer.send("maximize-window");
        },

        closeWindow() {
            window.electron.ipcRenderer.send("close-window");
        },
    },
};
</script>

<style scoped lang="scss">
.top-bar {
    user-select: none;
    -webkit-app-region: drag;
    display: flex;
    align-items: center;
    height: 38px;
    background-color: #342b69;

    &.macos {
        flex-direction: row-reverse;

        .top-bar-actions {
            margin-left: 0;

            button {
                position: relative;
                width: 14px;
                height: 14px;
                outline: none;
                margin: 0 3px;
                border: 0;
                background: rgba(137, 150, 193, 0.22);
                border-radius: 50%;
                text-align: center;
                cursor: default;
                transition: 0.2s ease;
                color: rgb(0 0 0 / 31%);
                font-size: 8px;

                &:hover {
                    i {
                        opacity: 1;
                    }
                }

                &.top-bar-close {
                    background-color: #ff5f56;
                }

                &.top-bar-minimize {
                    background-color: #ffbd2e;
                }

                &.top-bar-maximize {
                    background-color: #27c93f;
                }

                i {
                    display: flex;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    opacity: 0;
                }
            }
        }

        .tabs-container {
            padding-left: 12px;
            margin-right: auto;
        }
    }
}

.top-bar-actions {
    display: flex;
    justify-content: flex-end;
    margin-left: auto;
    padding: 0 5px;
    cursor: default;
    -webkit-app-region: no-drag;

    button {
        width: 24px;
        height: 24px;
        outline: none;
        margin: 0 3px;
        border: 0;
        background: rgba(137, 150, 193, 0.22);
        border-radius: 50%;
        text-align: center;
        cursor: default;
        transition: 0.2s ease;
        color: #f8f9fb;
        font-size: 10px;

        &:hover {
            background: rgba(137, 150, 193, 0.55);
        }
    }
}
</style>
