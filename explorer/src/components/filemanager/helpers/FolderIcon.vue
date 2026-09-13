<template>
    <svg
        xmlns="http://www.w3.org/2000/svg"
        :width="size"
        :height="size"
        viewBox="0 0 24 24"
        :fill="color"
    >
        <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
    </svg>
</template>

<script>
export default {
    name: 'FolderIcon',
    props: {
        size: {
            type: [String, Number],
            required: false,
            default: 24,
        },
        color: {
            type: String,
            required: false,
            default: 'currentColor',
        },
    },
}
</script>

<style scoped>
svg {
    display: inline-block;
    vertical-align: middle;
}
</style>
