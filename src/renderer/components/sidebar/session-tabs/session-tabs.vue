<template>
    <div class="session-tabs">
        <slot />
    </div>
</template>

<style scoped lang="scss">
.session-tabs {
    -webkit-app-region: drag;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 5px 0;
    height: 100%;
    overflow: visible;
}
</style>
