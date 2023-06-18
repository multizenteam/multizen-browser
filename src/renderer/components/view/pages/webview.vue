<template>
  <div class="view-container">
    <div
      class="controls-bar"
      v-if="view"
    >
      <button
        class="controls-button"
        @click="view.canGoBack() ? view.goBack() : null"
      >
        <i
          class="fa fa-arrow-left"
        />
      </button>

      <button
        class="controls-button"
        @click="view.canGoForward() ? view.goForward() : null"
      >
        <i
          class="fa fa-arrow-right"
        />
      </button>

      <button
        class="controls-button"
        @click="loading ? view.stop() : view.reload()"
      >
        <i
          :class="!loading ? 'fa fa-refresh' : 'fa fa-times'"
        />
      </button>

      <url
        @navigate="navigate($event)"
        :value="currentTab.url"
      />
    </div>

    <div class="view-container-content">
      <webview
        v-show="currentTab"
        autosize
        class="webview"
        ref="view"
        :key="currentTab.session"
        :src="currentTab.url"
        :partition="`persist:${currentTab.session}`"
        :useragent="currentSession.settings.userAgent"
        @dom-ready="loaded"
      />
    </div>
  </div>
</template>

<script>
import Url from './../controls/url'

import get from 'lodash/get'
import { mapGetters, mapMutations } from 'vuex'

const events = {
  'did-finish-load': 'didFinishLoad',
  'page-favicon-updated': 'pageFaviconUpdated',
  'did-start-loading': 'didStartLoading',
  'did-stop-loading': 'didStopLoading',
  'did-navigate': 'didNavigate',
  'did-fail-load': 'didFailLoad'
}

export default {
  data () {
    return {
      view: null,
      loading: false
    }
  },

  components: {
    Url
  },

  computed: {
    ...mapGetters('sessions', [
      'currentSession',
      'currentTab',
      'currentSessionIndex'
    ])
  },

  methods: {
    ...mapMutations('sessions', [
      'updateTab'
    ]),

    navigate (url) {
      if (url !== this.view.getURL()) {
        this.view.loadURL(url)
      }
    },

    didFinishLoad () {
      this.view.removeEventListener('did-finish-load', this.didFinishLoad)
      this.navigate(this.currentTab.url)
    },

    didNavigate (e) {
      this.updateTab({
        sessionIndex: this.currentSessionIndex,
        tabIndex: this.currentSession.currentTabIndex,
        k: 'url',
        v: e.url
      })
    },

    pageFaviconUpdated (r) {
      this.updateTab({
        sessionIndex: this.currentSessionIndex,
        tabIndex: this.currentSession.currentTabIndex,
        k: 'favicon',
        v: get(r, 'favicons.0', null)
      })
    },

    didStartLoading () {
      this.loading = true
    },

    loaded () {
      this.view = this.$refs.view
      Object.keys(events).forEach(event => this.view.addEventListener(event, this[events[event]]))
    },

    didStopLoading () {
      this.loading = false

      this.updateTab({
        sessionIndex: this.currentSessionIndex,
        tabIndex: this.currentSession.currentTabIndex,
        k: 'title',
        v: this.view.getTitle()
      })
    },

    didFailLoad (e) {
      console.info('Load failed with error code: ', e.errorCode)
    },

    initView () {
      this.view = this.$refs.view
      Object.keys(events).forEach(event => this.view.addEventListener(event, this[events[event]]))
    },

    removeEventListeners () {
      Object.keys(events).forEach(event => this.view.removeEventListener(event, this[events[event]]))
    }
  },

  mounted () {
    this.$nextTick(() => this.initView())
  },

  beforeDestroy () {
    this.removeEventListeners()
  },

  watch: {
    url: {
      handler (url) {
        this.updateTab({
          sessionIndex: this.currentSessionIndex,
          tabIndex: this.currentSession.currentTabIndex,
          k: 'url',
          v: url
        })
      }
    }
  }
}
</script>

<style scoped lang="scss">
.controls-bar {
    height: 40px;
    min-height: 40px;
    max-height: 40px;
    background-color: #1d1c3b;
    display: flex;
    align-items: center;
    font-size: 12px;
    border-bottom: 1px solid #1d224a;
    z-index: 1;
    padding: 10px;

    button {
        color: #f3f3f3;
        width: 25px;
        height: 25px;
        border-radius: 50%;
        border: 0;
        background: transparent;
        font-size: 12px;

        &:hover {
            background: rgba(247, 247, 247, 0.2);
        }
    }
}

.controls-button {
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 5px;
    transition: .2s ease;
    cursor: pointer;
}

.view-container {
    height: 100%;
    display: flex;
    flex-direction: column;

    .view-container-content {
        height: 100%;
        position: relative;

        .webview {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            min-width: 100%;
            min-height: 100%;
            display: inline-flex !important;

            &:focus {
                outline: 0;
                border: 0;
            }
        }
    }
}
</style>
