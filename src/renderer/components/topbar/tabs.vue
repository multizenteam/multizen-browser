<template>
  <div
    class="tabs-container"
    v-if="currentSession"
  >
    <div
      class="tab"
      :class="{'active' : currentSession.currentTabIndex === index}"
      :key="tab.id"
      v-for="(tab, index) in tabs"
      @click.stop="setActiveTab({sessionIndex: currentSessionIndex, tabIndex: index})"
    >
      <div
        class="tab-name"
        v-if="tab.type === 'settings'"
      >
        <img
          class="tab-favicon"
          src="static/icons/icon.png"
        >
        <div>Session settings</div>
      </div>

      <div
        class="tab-name"
        v-if="tab.type !== 'settings'"
      >
        <img
          v-if="tab.favicon"
          class="tab-favicon"
          :src="tab.favicon"
        >
        <img
          v-else
          class="tab-favicon"
          src="static/icons/icon.png"
        >
        <div class="tab-title">
          {{ tab.title || 'New Tab' }}
        </div>

        <button
          class="tab-close-btn"
          @click.stop="removeTabWithIndex(index)"
        >
          <i class="fa fa-times" />
        </button>
      </div>
    </div>

    <button
      @click="newTab"
      class="new-tab-btn"
    >
      <i class="fa fa-plus" />
    </button>
  </div>
</template>

<script>
import { mapGetters, mapMutations } from 'vuex'

export default {
  computed: {
    ...mapGetters('sessions', [
      'currentSession',
      'currentTab',
      'sessions',
      'currentSessionIndex'
    ]),

    tabs () {
      return this.currentSession.tabs
    }
  },

  methods: {
    ...mapMutations('sessions', [
      'addTab',
      'removeTab',
      'setActiveTab'
    ]),

    newTab () {
      this.addTab({ sessionIndex: this.currentSessionIndex })
    },

    removeTabWithIndex (index) {
      this.removeTab({ sessionIndex: this.currentSessionIndex, tabIndex: index })
    }
  }
}
</script>

<style scoped lang="scss">
.tabs-container {
    display: flex;
    color: #fff;
    padding-right: 5px;
    padding-left: 56px;
    margin-top: auto;
    overflow: overlay;
    -webkit-app-region: no-drag;
}

.tab {
    display: flex;
    position: relative;
    background-color: rgba(29, 28, 59, 0.35);
    padding: 8px 10px 6px 10px;
    margin-right: 6px;
    border-radius: 5px 5px 0 0;

    &:hover {
        background-color: rgba(29, 28, 59, 0.7);
    }

    &.active {
        background-color: #1d1c3b;
    }

    .tab-name {
        display: flex;
        max-width: 150px;
        align-items: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tab-favicon {
        width: 16px;
        height: 16px;
        margin-right: 6px;
    }

    .tab-title {
        padding-right: 18px;
        text-overflow: ellipsis;
        overflow: hidden;
    }

    .tab-close-btn {
        position: absolute;
        right: 5px;
        width: 20px;
        height: 20px;
        font-size: 10px;
        background-color: transparent;
        border: 0;
        outline: 0;
        color: #f4f4f4;
        border-radius: 50%;

        &:hover {
            background-color: rgba(33, 60, 94, 0.9);
        }
    }
}

.new-tab-btn {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 26px;
    height: 26px;
    background-color: transparent;
    border: 0;
    outline: 0;
    color: #f3f3f3;
    border-radius: 50%;

    &:hover {
        background-color: rgba(245, 245, 245, 0.2);
    }
}
</style>
