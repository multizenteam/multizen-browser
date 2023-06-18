<template>
  <div
    v-if="showModal"
    class="modal"
    @click.self="showModal=false"
  >
    <div class="modal-content">
      <span
        class="close"
        @click="showModal = false"
      >&times;</span>
      <h2>Welcome to MultiZen Browser v.{{ version }}!</h2>
      <p>
        I'm glad to see you here. MultiZen is an open-source browser.
      </p>
      <p>
        If you need any assistance or want to contribute, please reach out:
      </p>
      <a
        href="https://github.com/oboshto/multizen-browser"
        target="_blank"
      >Contribute on github</a>
      <span>or</span>
      <a
        href="https://discord.gg/pd6MhzPbJ3"
        target="_blank"
      >Join Discord community</a>
    </div>
  </div>
</template>

<script>
import { EventBus } from '../../utils/event-bus'
import { version } from '../../../../package.json'

export default {
  data () {
    return {
      showModal: false,
      version
    }
  },

  created () {
    EventBus.$on('open-info-modal', () => {
      this.showModal = true
    })
  }
}
</script>

<style scoped lang="scss">
.modal {
    display: flex;
    justify-content: center;
    align-items: center;
    position: fixed;
    z-index: 1;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    overflow: auto;
    background-color: rgba(0,0,0,0.4);
    cursor: default;

    h2 {
        margin-bottom: 20px;
    }

    a {
        color: #1268cb;
    }
}

.modal-content {
    margin: auto;
    padding: 20px 30px 30px 30px;
    border: 1px solid #888;
    width: 650px;
    border-radius: 6px;
    background-color: #eceeff;
}

.close {
    color: #aaa;
    float: right;
    font-size: 28px;
    font-weight: bold;
}

.close:hover,
.close:focus {
    color: black;
    text-decoration: none;
    cursor: pointer;
}
</style>
