import Vue from 'vue'
import Vuex from 'vuex'
import sessions from './modules/sessions'

import createPersistedState from 'vuex-persistedstate'

Vue.use(Vuex)

export default new Vuex.Store({
  modules: {
    sessions
  },
  strict: process.env.NODE_ENV !== 'production',
  plugins: [createPersistedState({
    key: 'multizen-browser-storage'
  })]
})
