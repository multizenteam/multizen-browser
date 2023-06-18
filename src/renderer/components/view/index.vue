<template>
  <div class="app-views">
    <div
      class="app-views-container"
      v-if="currentTab"
    >
      <web-view-container
        v-if="currentTab.type !== 'settings'"
        :key="currentSession.currentTabIndex"
      />

      <settings-view
        v-if="currentTab.type === 'settings'"
        :key="currentSessionIndex"
      />
    </div>
  </div>
</template>

<script>
import SettingsView from './pages/settings'
import WebViewContainer from './pages/webview'
import { mapGetters } from 'vuex'

export default {
  components: {
    SettingsView,
    WebViewContainer
  },

  computed: {
    ...mapGetters('sessions', [
      'currentSession',
      'currentSessionIndex',
      'currentTab'
    ])
  }
}
</script>

<style scoped>

</style>
