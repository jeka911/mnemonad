<template>
	<div>
		<DocSectionHeader class="q-mb-md" />

		<div class="q-px-md">
			todo
		</div>
	</div>
</template>

<script>
import DocSectionHeader from '../components/DocSectionHeader.vue';
import GradientPanel from '../components/GradientPanel.vue';

export default {
	name: 'Docs',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/docs',
	title: 'Docs',
	components: {
		DocSectionHeader,
		GradientPanel,
	},
};
</script>
