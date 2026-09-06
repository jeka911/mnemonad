<template>
	<div>
		<GradientPanel always-expanded dense variant="fill" title="My vectors">
			<template #body>
				<MyVectors />
			</template>
		</GradientPanel>
	</div>
</template>

<script>
import GradientPanel from '../components/GradientPanel.vue';
import MyVectors from '../mnemonad/MyVectors.vue';

export default {
	name: 'Home',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/',
	title: 'Home',
	components: { GradientPanel, MyVectors },
};
</script>
