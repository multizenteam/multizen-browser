import set from 'lodash/set'
import crypto from 'crypto'

const defaultHomePage = 'https://start.duckduckgo.com/'
const defaultUserAgent = window.navigator.userAgent
const sessionId = crypto.randomUUID()

export default {
  namespaced: true,
  state: {
    currentSessionIndex: 0,
    sessions: [{
      tabs: [{
        type: 'settings',
        favicon: null,
        id: crypto.randomUUID(),
        title: 'Session Settings',
        session: sessionId
      }],
      settings: {
        homePage: defaultHomePage,
        userAgent: defaultUserAgent
      },
      id: sessionId,
      currentTabIndex: 0
    }]
  },

  mutations: {
    addSession: (s) => {
      const sessionId = crypto.randomUUID()
      s.sessions.push({
        tabs: [{
          type: 'settings',
          id: crypto.randomUUID(),
          title: 'Session Settings',
          session: sessionId
        }],
        id: sessionId,
        currentTabIndex: 0,
        settings: {
          homePage: defaultHomePage,
          userAgent: defaultUserAgent
        }
      })
      s.currentSessionIndex = s.sessions.length - 1
    },

    addTab: (s, { sessionIndex }) => {
      s.sessions[sessionIndex].tabs.push({
        favicon: null,
        id: crypto.randomUUID(),
        url: s.sessions[sessionIndex].settings.homePage,
        title: 'New Tab',
        session: s.sessions[sessionIndex].id
      })
      s.sessions[sessionIndex].currentTabIndex = s.sessions[sessionIndex].tabs.length - 1
    },

    removeTab: (s, { sessionIndex, tabIndex }) => {
      s.sessions[sessionIndex].tabs.splice(tabIndex, 1)
      if (s.sessions[sessionIndex].currentTabIndex > tabIndex) {
        s.sessions[sessionIndex].currentTabIndex -= 1
      }
      if (s.sessions[sessionIndex].currentTabIndex >= s.sessions[sessionIndex].tabs.length) {
        s.sessions[sessionIndex].currentTabIndex = s.sessions[sessionIndex].tabs.length - 1
      }
    },

    removeSession: (s, sessionIndex) => {
      s.sessions.splice(sessionIndex, 1)
      if (s.currentSessionIndex >= s.sessions.length) {
        s.currentSessionIndex = s.sessions.length - 1
      }
    },

    updateTab: (s, { sessionIndex, tabIndex, k, v }) => {
      set(s.sessions[sessionIndex].tabs[tabIndex], k, v)
    },

    updateSessionSetting: (s, { sessionIndex, k, v }) => {
      set(s.sessions[sessionIndex].settings, k, v)
    },

    setActiveTab: (s, { sessionIndex, tabIndex }) => {
      s.sessions[sessionIndex].currentTabIndex = tabIndex
    },

    setActiveSession: (s, sessionIndex) => {
      s.currentSessionIndex = sessionIndex
    }
  },

  getters: {
    currentSessionIndex: (s) => s.currentSessionIndex,
    currentSession: (s) => s.sessions[s.currentSessionIndex],
    currentTab: (s) => s.sessions[s.currentSessionIndex].tabs[s.sessions[s.currentSessionIndex].currentTabIndex],
    sessions: (s) => s.sessions
  }
}
