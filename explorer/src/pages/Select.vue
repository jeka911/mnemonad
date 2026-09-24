<template>
	<div class="select-layout">
		<GradientPanel always-expanded dense variant="fill" title="Sample streams">
			<template #body>
				<div class="q-py-md">
					<SampleStreams />
				</div>
			</template>
		</GradientPanel>

		<GradientPanel always-expanded dense variant="fill" title="My streams">
			<template #body>
				<div class="q-pb-md">
					<MyStreams />
				</div>
			</template>
		</GradientPanel>
	</div>
</template>

<script>
import GradientPanel from '../components/GradientPanel.vue';
import MyStreams from '../mnemonad/MyStreams.vue';
import SampleStreams from '../mnemonad/SampleStreams.vue';

export default {
	name: 'Select',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/select',
	title: 'Select Stream',
	components: { GradientPanel, MyStreams, SampleStreams },
};
</script>

<style scoped>
/* Samples first, because they're the only half that has anything in it for a visitor with
   no wallet connected — which is every first visit. Equal columns rather than a narrow
   sidebar: neither list is subordinate to the other, they're two ways in. */
.select-layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	align-items: start;
	gap: 16px;
}

/* One column below the point where two lists of elided ids stop being readable side by
   side. Samples stay on top, for the same reason they're on the left. */
@media (max-width: 900px) {
	.select-layout {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
