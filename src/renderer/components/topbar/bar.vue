<template>
  <div class="top-bar">
    <tabs />

    <div
      class="top-bar-actions"
      :class="{ 'macos': isMacOS }"
    >
      <button
        class="top-bar-minimize"
        @click="minimizeWindow"
      >
        <i class="fa fa-window-minimize" />
      </button>
      <button
        class="top-bar-maximize"
        @click="maximizeWindow"
      >
        <i class="fa fa-window-maximize" />
      </button>
      <button
        class="top-bar-close"
        @click="closeWindow"
      >
        <i class="fa fa-times" />
      </button>
    </div>
  </div>
</template>

<script>
import { ipcRenderer } from 'electron'
import Tabs from './tabs'

export default {
  components: {
    Tabs
  },
  data () {
    return {
      isMacOS: process.platform === 'darwin'
    }
  },
  methods: {
    minimizeWindow () {
      ipcRenderer.send('minimize-window')
    },

    maximizeWindow () {
      ipcRenderer.send('maximize-window')
    },

    closeWindow () {
      ipcRenderer.send('close-window')
    }
  }
}
</script>

<style scoped lang="scss">
.top-bar {
    user-select: none;
    -webkit-app-region: drag;
    display: flex;
    align-items: center;
    height: 38px;
    background-color: #342b69;
}

.top-bar-actions {
    display: flex;
    justify-content: flex-end;
    margin-left: auto;
    padding: 0 5px;
    cursor: default;
    -webkit-app-region: no-drag;

    &.macos {
        // todo: adopt it for mac os
        justify-content: flex-start;
        flex-direction: row-reverse;
    }

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
