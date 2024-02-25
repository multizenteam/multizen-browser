<template>
    <input
        ref="urlInput"
        type="text"
        class="input-url"
        placeholder="Type URL here"
        spellcheck="false"
        :value="value"
        @focus="onFocus($event)"
        @keyup.enter="(e: any) => $emit('navigate', getWebUri(e.target?.value))"
    />
</template>

<script lang="ts">
import URI from "urijs";
import { InputHTMLAttributes, ref } from "vue";
import { mapGetters } from "vuex";

const urlInput = ref<InputHTMLAttributes | null>(null);

const props = {
    value: {
        type: String,
        default: null,
    },
};

export default {
    props,
    emits: ["navigate"],
    computed: {
        ...mapGetters("sessions", ["currentSession"]),
    },

    mounted() {
        if (
            urlInput.value &&
            urlInput.value === this.currentSession.settings.homePage
        ) {
            urlInput.value.value.focus();
            urlInput.value.value.select();
        }
    },

    methods: {
        getWebUri(value: string) {
            return URI(value).protocol("http:").toString();
        },

        onFocus(event) {
            event.target.focus();
        },
    },
};
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
