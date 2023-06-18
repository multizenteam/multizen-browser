<template>
  <div class="view-settings">
    <div
      class="settings-wrap"
      v-if="currentSession"
    >
      <h1>Session Settings</h1>
      <div class="session-info">
        <p>Session ID: {{ currentSession.id }}</p>
        <p>These settings apply to the current session only.</p>
        <button
          @click="closeSession"
          class="close-session-btn"
        >
          Close session
        </button>
      </div>
      <hr>
      <div>
        <div class="settings-block">
          <h4>Home page</h4>
          <div class="input-block">
            <input
              class="d-block"
              type="url"
              required
              @blur="saveHomePage"
              @change="saveHomePage"
              v-model="homePage"
            >
          </div>
        </div>
        <hr>
        <div class="settings-block">
          <h4>User Agent</h4>
          <div class="input-block">
            <div class="d-flex">
              <input
                class="d-block"
                type="text"
                @blur="saveUserAgent"
                @change="saveUserAgent"
                v-model="userAgent"
              >
              <button
                class="set-ua-btn"
                @click="setDefaultUserAgent"
              >
                <i class="fa fa-globe" /> Set default
              </button>

              <button
                class="set-ua-btn"
                @click="setRandomUserAgent"
              >
                <i class="fa fa-refresh" /> Get random
              </button>
            </div>
          </div>
        </div>
        <hr>

        <div class="settings-block">
          <div class="input-block">
            <label class="checkbox-block disabled">
              <input
                type="checkbox"
                disabled
              >
              <span>Disable Ads <span style="font-style: italic">(COMING SOON!)</span></span>
            </label>
          </div>
        </div>
        <hr>

        <div class="settings-block">
          <div class="input-block">
            <label class="checkbox-block disabled">
              <input
                type="checkbox"
                disabled
              >
              <span>Enable Proxy <span style="font-style: italic">(COMING SOON!)</span></span>
            </label>
          </div>
        </div>
        <hr>

        <div class="settings-block">
          <div class="input-block">
            <label class="checkbox-block disabled">
              <input
                type="checkbox"
                disabled
              >
              <span>Default Search Engine <span style="font-style: italic">(COMING SOON!)</span></span>
            </label>
          </div>
        </div>
        <hr>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters, mapMutations } from 'vuex'
import userAgents from '../../../user-agents/useragents.json'
const defaultUserAgent = window.navigator.userAgent

export default {
  data () {
    return {
      userAgent: '',
      homePage: '',
      defaultUserAgent
    }
  },

  computed: {
    ...mapGetters('sessions', ['currentSession', 'currentSessionIndex'])
  },

  created () {
    this.userAgent = this.currentSession.settings.userAgent
    this.homePage = this.currentSession.settings.homePage
  },

  methods: {
    ...mapMutations('sessions', ['updateSessionSetting', 'removeSession']),

    saveHomePage () {
      this.homePage = this.urlify(this.homePage.trim())
      this.updateSessionSetting({
        sessionIndex: this.currentSessionIndex,
        k: 'homePage',
        v: this.homePage
      })
    },

    setDefaultUserAgent () {
      this.userAgent = defaultUserAgent
      this.saveUserAgent()
    },

    setRandomUserAgent () {
      this.userAgent = this.getRandomUserAgent()
      this.saveUserAgent()
    },

    saveUserAgent () {
      this.updateSessionSetting({
        sessionIndex: this.currentSessionIndex,
        k: 'userAgent',
        v: this.userAgent
      })
    },

    closeSession () {
      this.removeSession({ sessionIndex: this.currentSessionIndex })
    },

    urlify (url) {
      return (url.indexOf('://') === -1) ? 'https://' + url : url
    },

    getRandomUserAgent () {
      return userAgents[Math.floor((Math.random() * userAgents.length))]
    }
  }
}
</script>

<style scoped lang="scss">
.view-settings {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: left;
    font-size: 16px;
    color: #6c6969;
    overflow: auto;
}

.settings-wrap {
    width: 100%;
    max-width: 800px;
    height: 100%;
    padding-top: 100px;
}

.close-session-btn {
    font-family: monospace;
    text-transform: uppercase;
    background-color: #f8c9c9;
    border: 1px solid #dc7575;
    border-radius: 5px;
    outline: 0;
    padding: 5px 9px;
    cursor: pointer;
    white-space: nowrap;
    font-weight: bold;

    &:hover {
        background-color: #f8d8d8;
        border: 1px solid #cc4242;
    }
}

.session-info {
    margin-bottom: 20px;
    font-size: 14px;
}

h4 {
    font-size: 13px;
    text-transform: uppercase;
    margin-bottom: 6px;
}

hr {
    width: 100%;
    height: 1px;
    display: block;
    background-color: #d8d8d8;
    border: 0;
    margin: 16px 0;
}

.settings-block {
    text-align: left;
}

.input-block {
    label{
        color: #27262e;
        font-size: 14px;
    }

    input[type="text"], input[type="url"] {
        width: 100%;
        padding: 6px;
        outline: 0;
        border: 2px solid #d9d9ff;
        border-radius: 3px;
        transition: 0.3s ease;

        &:read-only {
            cursor: default;
            color: gray;
            border: 2px solid #bebebe;
        }

        &:focus {
            border: 2px solid #7575dc;
        }
    }

    .radio-block {
        margin: 7px 0;
        display: block;
    }

    .checkbox-block {
        font-size: 13px;
        font-weight: bold;
        text-transform: uppercase;

        &.disabled {
            color: #999;
            cursor: not-allowed;
        }
    }
}

.set-ua-btn {
    font-family: monospace;
    text-transform: uppercase;
    background-color: #c9c9f8;
    border: 1px solid #7575dc;
    border-radius: 5px;
    outline: 0;
    padding: 5px 9px;
    margin-left: 12px;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
        background-color: #d8d8f8;
        border: 1px solid #4242cc;

        i {
            transform: rotate(360deg);
        }
    }

    i {
        transition: 0.5s ease;
    }
}
</style>
