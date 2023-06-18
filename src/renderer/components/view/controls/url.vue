<template>
  <input
    type="text"
    class="input-url"
    placeholder="Type URL here"
    spellcheck="false"
    ref="urlInput"
    @focus="$event.target.select()"
    :value="value"
    @keyup.enter="(e) => $emit('navigate', getWebUri(e.target.value))"
  >
</template>

<script>
import URI from 'urijs'
import { mapGetters } from 'vuex'

const props = {
  value: {
    type: String,
    default: null
  }
}

export default {
  props,
  computed: {
    ...mapGetters('sessions', [
      'currentSession'
    ])
  },

  methods: {
    getWebUri (value) {
      return URI(value).protocol('http:').toString()
    }
  },

  mounted () {
    if (this.$refs.urlInput && this.$refs.urlInput.value === this.currentSession.settings.homePage) {
      this.$refs.urlInput.focus()
      this.$refs.urlInput.select()
    }
  }
}

</script>

<style scoped lang="scss">
.input-url {
    height: 100%;
    width: 100%;
    padding: 12px;
    color: #4d4d58;
    border: none;
    background-color: #c3c3ff;
    border-radius: 12px;
    font-family: monospace;

    &:focus {
        outline: none;
    }
}
</style>
