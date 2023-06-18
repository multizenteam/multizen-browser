<template>
  <div class="side-footer">
    <button
      @click="openInfoModal"
      class="open-info-modal-btn"
    >
      <i class="fa fa-question" />
    </button>
    <span>{{ version }}</span>
  </div>
</template>

<script>
import { EventBus } from '../../utils/event-bus'
import { version } from './../../../../package'

export default {
  computed: {
    version () {
      return version
    }
  },

  methods: {
    openInfoModal () {
      EventBus.$emit('open-info-modal')
    }
  }
}

</script>

<style scoped lang="scss">
.side-footer {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    min-height: 20px;
    padding-bottom: 10px;
    font-size: 10px;
    text-align: center;
    color: #6b6b6b;

    a {
        margin: 2px 0;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
        transition: .2s ease;

        &:hover {
            color: white;
        }
    }
}

.open-info-modal-btn {
    background-color: #697ca6;
    border: 0;
    outline: 0;
    border-radius: 4px;
    margin-bottom: 5px;
    cursor: pointer;

    &:hover {
        background-color: #9baed7;
    }
}
</style>
