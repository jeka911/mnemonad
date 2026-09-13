<template>
    <svg
        class="spinner"
        xmlns="http://www.w3.org/2000/svg"
        :width="size"
        :height="size"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
    >
        <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
        <path d="M12 2a10 10 0 0 1 10 10"></path>
    </svg>
</template>

<script>
export default {
    name: 'Spinner',
    props: {
        size: {
            type: [Number, String],
            default: 14,
        },
    },
}
</script>

<style scoped>
.spinner {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}
</style>
