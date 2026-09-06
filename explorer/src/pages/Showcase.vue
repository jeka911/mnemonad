<template>
	<div style="margin: -8px;">
		<JComponentShowcaseWithContent import-from="monad" :components="customComponents" />
	</div>
</template>

<script>
import { JComponentShowcaseWithContent } from 'themed_varmory';
import ShowcaseGradientButton from '../showcase/ShowcaseGradientButton.vue';
import ShowcaseGradientPanel from '../showcase/ShowcaseGradientPanel.vue';

export default {
	name: 'Showcase',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/showcase',
	title: 'Components',
	components: { JComponentShowcaseWithContent },
	data() {
		return {
			// Merged into the built-in showcase categories. The numeric prefix
			// controls ordering relative to the library's default groups.
			customComponents: {
				'50 Monad': [ShowcaseGradientButton, ShowcaseGradientPanel],
			},
		};
	},
};
</script>
