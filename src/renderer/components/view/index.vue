<template>
    <div class="app-views">
        <div v-if="currentTab" class="app-views-container">
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

<script lang="ts">
import SettingsView from "./pages/settings.vue";
import WebViewContainer from "./pages/webview.vue";
import { mapGetters } from "vuex";

export default {
    components: {
        SettingsView,
        WebViewContainer,
    },

    computed: {
        ...mapGetters("sessions", [
            "currentSession",
            "currentSessionIndex",
            "currentTab",
        ]),
    },
};
</script>

<style scoped></style>
