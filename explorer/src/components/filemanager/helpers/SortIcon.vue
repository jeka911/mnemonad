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
        <line x1="4" y1="6" x2="11" y2="6"></line>
        <line x1="4" y1="12" x2="16" y2="12"></line>
        <line x1="4" y1="18" x2="20" y2="18"></line>
    </svg>
</template>

<script>
export default {
    name: 'SortIcon',
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
