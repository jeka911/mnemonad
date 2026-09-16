<template>
	<div>
		<MnemonadHero />
	</div>
</template>

<script>
import GradientPanel from '../components/GradientPanel.vue';
import MyStreams from '../mnemonad/MyStreams.vue';
import HomeVideoBackground from '../components/HomeVideoBackground.vue';
import MnemonadHero from '../components/mnemonad-landing-hero/MnemonadHero.vue';

export default {
	name: 'Home',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/',
	title: 'Home',
	components: { GradientPanel, MyStreams, HomeVideoBackground, MnemonadHero },
};
</script>
