<template>
  <div
    class="session-tab"
    :class="{active}"
  >
    <slot>
      <img
        src="static/icons/icon.png"
        class="session-tab-icon"
      >
    </slot>
  </div>
</template>

<script>

const props = {
  active: {
    type: Boolean,
    default: false
  }
}

export default {
  props
}
</script>

<style scoped lang="scss">
.session-tab {
    -webkit-app-region: no-drag;
    width: 48px;
    height: 48px;
    margin: 3px 0;
    padding: 8px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: 0.2s ease;

    &:hover {
        background-color: rgba(82, 104, 162, 0.3);
        border-radius: 50%;
    }

    &.active {
        background-color: rgba(38, 78, 185, 0.3);
        border-radius: 50%;
    }

    i {
        color: #575757;
    }

    &.new-session {
        width: 42px;
        height: 42px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 10px 0;
        border: 1px solid rgba(54, 74, 128, 0.2);
        border-radius: 12px;
        color: #f1f1f1;
        font-size: 18px;
        transition: .5s ease;
        background-color: rgba(82, 104, 162, 0.2);

        &:hover {
            color: white;
            border-color: rgba(97, 115, 164, 0.9);
            background-color: rgba(97, 115, 164, 0.5);
        }

        i {
            color: #8097e8;
        }
    }

    .session-tab-icon {
        width: 100%;
        height: 100%;
    }
}
</style>
