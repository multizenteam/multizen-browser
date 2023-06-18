<template>
  <div
    id="app"
    class="app"
  >
    <top-bar />

    <div class="sessions-and-view">
      <side-bar />
      <content-view v-if="currentSession" />
    </div>

    <info-modal />
  </div>
</template>

<script>
import SideBar from './components/sidebar/bar'
import TopBar from './components/topbar/bar'
import ContentView from './components/view/index'
import InfoModal from './components/info-modal/index'

import { EventBus } from './utils/event-bus'

import { ipcRenderer } from 'electron'
import { mapGetters, mapMutations } from 'vuex'

export default {
  components: {
    SideBar,
    ContentView,
    TopBar,
    InfoModal
  },
  computed: {
    ...mapGetters('sessions', ['currentSession', 'currentSessionIndex'])
  },

  methods: {
    ...mapMutations('sessions', ['addTab', 'removeTab'])
  },

  mounted () {
    ipcRenderer.on('shortcut:ctrl+w', () => {
      if (this.currentSession && this.currentSession.currentTabIndex > 0) {
        this.removeTab({ sessionIndex: this.currentSessionIndex, tabIndex: this.currentSession.currentTabIndex })
      }
    })

    ipcRenderer.on('shortcut:ctrl+t', () => {
      if (!this.currentSession) {
        return
      }
      this.addTab({ sessionIndex: this.currentSessionIndex })
    })

    if (!localStorage.getItem('info-modal-shown')) {
      this.showModal = true
      localStorage.setItem('info-modal-shown', 'true')
      EventBus.$emit('open-info-modal')
    }
  },

  beforeDestroy () {
    ipcRenderer.removeAllListeners('shortcut:ctrl+w')
    ipcRenderer.removeAllListeners('shortcut:ctrl+t')
  }
}
</script>

<style lang="scss">
@import "./assets/scss/style";

html, body {
    padding: 0;
    margin: 0;
    height: 100%;

    * {
        box-sizing: border-box;
    }
}

body {
    font-family: monospace;
    line-height: 1.24;
    font-weight: 400;
    -webkit-font-smoothing: subpixel-antialiased;
    -moz-osx-font-smoothing: auto;
}

#app {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;

    .app-views {
        width: 100%;
        background: #eaeaea;

        .app-views-container {
            height: 100%;
        }
    }
}

.sessions-and-view {
    display: flex;
    flex-direction: row;
    flex: 1;
    overflow: auto;
}

</style>
