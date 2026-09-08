<template>
	<div>
		<GradientPanel always-expanded dense variant="fill" title="My streams">
			<template #body>
				<MyStreams />
			</template>
		</GradientPanel>
	</div>
</template>

<script>
import GradientPanel from '../components/GradientPanel.vue';
import MyStreams from '../mnemonad/MyStreams.vue';

export default {
	name: 'Home',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/',
	title: 'Home',
	components: { GradientPanel, MyStreams },
};
</script>
