<template>
	<router-view v-slot="{ Component }" ref="routerView">
		<component ref="view" :is="Component" v-if="isComponentVisible" />
	</router-view>
</template>

<script>
import { APP_TITLE } from '../settings.js';

export default {
	name: 'RoutedPage',
	data() {
		return {
			title: APP_TITLE,
			pageTitle: '',
			authRequired: false,
			requiredAuthLevel: null,
			isComponentVisible: true,
			contentViewEnabled: true,
		};
	},
	watch: {
		'$route'() {
			this.authRequired = false;
			const component = this.$route?.matched[0]?.components?.default;
			if (component) {
				this.authRequired = component.authRequired;
				this.requiredAuthLevel = component.requiredAuthLevel || null;
				this.pageTitle = component.title || '';
				this.checkAccess();
				this.refreshTitle();
			}
		},
	},
	mounted() {
		const component = this.$route?.matched[0]?.components?.default;
		if (component) {
			this.pageTitle = component.title || '';
		}
		this.refreshTitle();
	},
	methods: {
		refreshTitle: function() {
			document.title = (this.pageTitle ? ('' + this.pageTitle + ' @ ') : '') + this.title;
		},
		// Access hook — always allows for now, ready for future auth gating.
		checkAccess: function() {
			this.isComponentVisible = true;
			this.contentViewEnabled = true;
			return true;
		},
		enoughAccessLevel: function() {
			return true;
		},
	},
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.05s ease;
}

.fade-enter-to,
.fade-leave-from {
	opacity: 0.7;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
