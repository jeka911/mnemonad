<template>
    <svg
        xmlns="http://www.w3.org/2000/svg"
        :width="size"
        :height="size"
        viewBox="0 0 24 24"
        fill="none"
        :stroke="color"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
    >
        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
    </svg>
</template>

<script>
export default {
    name: 'RefreshIcon',
    props: {
        size: {
            type: [String, Number],
            required: false,
            default: 16,
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
