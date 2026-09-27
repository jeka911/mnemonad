<template>
	<div class="page-intro">
		<div class="page-intro-heading-row">
			<div v-if="icon" class="page-intro-icon" aria-hidden="true">
				<q-icon :name="icon" size="30px" />
			</div>

			<div>
				<slot />
			</div>
		</div>

		<q-input
			v-if="search"
			ref="searchInput"
			v-model="text"
			class="page-intro-search"
			borderless
			dense
			:placeholder="searchPlaceholder"
			@update:model-value="onInput"
			@keyup.enter="submit"
			@keydown.esc="clear"
		>
			<template #prepend>
				<q-icon name="search" size="23px" />
			</template>

			<template #append>
				<q-icon
					v-if="text"
					name="close"
					size="18px"
					class="page-intro-clear cursor-pointer"
					role="button"
					aria-label="Clear search"
					@click="clear"
				/>
				<span v-else class="page-intro-shortcut">
					<span>⌘</span>
					<span>K</span>
				</span>
			</template>
		</q-input>

		<!-- A line of context tied to the search field (what it searches, say). -->
		<div v-if="$slots['below-search']" class="page-intro-below-search">
			<slot name="below-search" />
		</div>
	</div>
</template>

<script>
const LIVE_DEBOUNCE_MS = 400;
const LIVE_MIN_CHARS = 2;

export default {
	name: 'PageIntro',

	props: {
		// Quasar icon name for the icon box (e.g. an outlined material icon
		// such as "o_description"). Omit to render without an icon box.
		icon: {
			type: String,
			default: '',
		},
		// Set false to render just the icon + slot content, no search input —
		// useful for a page intro that doesn't need one.
		search: {
			type: Boolean,
			default: true,
		},
		// Initial / externally-set search text (e.g. restored from the URL). The field stays
		// editable; `search` fires on Enter (and, with `live`, as you type).
		query: {
			type: String,
			default: '',
		},
		// Search as the user types: `search` fires once typing pauses, not only on Enter.
		// Clearing the field fires it at once with ''.
		live: {
			type: Boolean,
			default: false,
		},
		searchPlaceholder: {
			type: String,
			default: 'Search...',
		},
	},

	emits: ['search'],

	data () {
		return {
			text: this.query,
		}
	},

	created() {
		this._lastEmitted = this.query;
		this._debounce = null;
	},

	watch: {
		// Follows the page's own query (Back/Forward, a result clicked elsewhere clearing it) —
		// except when the page is only echoing what this field just sent: in live mode that echo
		// trails the typing by one pause, and writing it back would undo the keystrokes since.
		query(value) {
			if (value === this._lastEmitted) return;
			this._lastEmitted = value;
			this.text = value;
		},
	},

	methods: {
		emitSearch(text) {
			this._lastEmitted = text;
			this.$emit('search', text);
		},
		onInput(value) {
			clearTimeout(this._debounce);
			if (!this.live) return;
			const text = (value || '').trim();
			if (!text) {
				this.emitSearch('');
				return;
			}
			if (text.length < LIVE_MIN_CHARS) return;
			this._debounce = setTimeout(() => this.emitSearch(text), LIVE_DEBOUNCE_MS);
		},
		submit() {
			clearTimeout(this._debounce);
			this.emitSearch((this.text || '').trim());
		},
		clear() {
			clearTimeout(this._debounce);
			this.text = '';
			this.emitSearch('');
		},
	},

	// The ⌘K / Ctrl+K hint shown in the field is real: it focuses the field from anywhere on
	// the page.
	mounted() {
		this._onKeydown = (event) => {
			if (!this.search) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				this.$refs.searchInput?.focus();
			}
		};
		window.addEventListener('keydown', this._onKeydown);
	},

	beforeUnmount() {
		clearTimeout(this._debounce);
		window.removeEventListener('keydown', this._onKeydown);
	},
}
</script>

<style scoped>
.page-intro-clear {
	color: var(--muted, #8a94a6);
}

.page-intro-clear:hover {
	color: var(--text, #fff);
}

/* Sits above a host section's decorative overlay (e.g. a ::after dot-grid),
   which is why this needs relative + z-index rather than relying on DOM
   order alone — matches how sibling content blocks position themselves in
   whatever section ends up hosting this. */
.page-intro {
	position: relative;
	z-index: 1;
}

.page-intro-heading-row {
	display: flex;
	align-items: center;
	gap: 18px;
}

.page-intro-icon {
	display: grid;
	place-items: center;
	width: 64px;
	height: 64px;
	flex: 0 0 64px;
	color: var(--accent, #7357ff);
	background: rgba(107, 76, 165, 0.09);
	border: 1px solid rgba(131, 93, 224, 0.12);
	border-radius: 15px;
}

.page-intro-search {
	width: min(100%, 520px);
	margin-top: 26px;
}

.page-intro-below-search {
	margin-top: 10px;
	padding-left: 4px;
	font-size: 12px;
	line-height: 1.5;
	color: var(--muted, var(--q-text-muted));
}

/* `borderless` keeps Quasar from drawing its own frame, so the box is
   rebuilt on .q-field__control instead: fixed height, radius, padding,
   surface and inset highlight. */
.page-intro-search :deep(.q-field__control) {
	height: 54px;
	padding: 0 12px 0 16px;
	color: #aaa5ba;
	background: rgba(17, 14, 26, 0.72);
	border: 1px solid var(--border, rgba(131, 93, 224, 0.22));
	border-radius: 13px;
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
	transition:
		border-color 160ms ease,
		box-shadow 160ms ease;
}

.page-intro-search :deep(.q-field__control):hover {
	border-color: var(--border-strong, rgba(131, 93, 224, 0.28));
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

/* Quasar sizes the prepend/append gutters to the field height; reset so
   they sit centred and keep the gap the original layout had. Also pins the
   prepend's colour explicitly: Quasar hardcodes color on .q-field__marginal
   (of which prepend is one), which would otherwise override whatever colour
   the slotted icon wants. */
.page-intro-search :deep(.q-field__prepend) {
	height: auto;
	padding-right: 13px;
	color: #aaa5ba;
}

.page-intro-search :deep(.q-field__append) {
	height: auto;
	padding-left: 8px;
}

.page-intro-search :deep(.q-field__native) {
	padding: 0;
	font-size: 15px;
	color: var(--text, #f3f1fb);
}

.page-intro-search :deep(.q-field__native)::placeholder {
	color: #aaa5ba;
	opacity: 1;
}

.page-intro-shortcut {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 6px 8px;
	font-size: 12px;
	color: #a19bad;
	background: rgba(132, 100, 198, 0.08);
	border: 1px solid rgba(132, 100, 198, 0.09);
	border-radius: 8px;
}

/* Light mode — driven by Quasar's body.body--light class, matching how
   GradientPanel / GradientButton / BlockNumber / AppFooter already theme
   (see GradientPanel.vue for why: the production bundle can end up with two
   Quasar instances, desyncing $q.dark.isActive from the body class). */
body.body--light .page-intro-icon {
	background:
		linear-gradient(180deg, rgba(115, 87, 255, 0.07), rgba(115, 87, 255, 0.025));
	border-color: rgba(115, 87, 255, 0.08);
}

body.body--light .page-intro-search :deep(.q-field__control) {
	color: #696c7e;
	background: rgba(255, 255, 255, 0.74);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

body.body--light .page-intro-search :deep(.q-field__control):hover {
	border-color: rgba(115, 87, 255, 0.28);
	box-shadow:
		0 6px 20px rgba(76, 61, 160, 0.05),
		inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

body.body--light .page-intro-search :deep(.q-field__native)::placeholder {
	color: #696c7e;
}

body.body--light .page-intro-search :deep(.q-field__prepend) {
	color: #696c7e;
}

body.body--light .page-intro-shortcut {
	color: #77798a;
	background: rgba(113, 102, 177, 0.07);
	border-color: rgba(113, 102, 177, 0.08);
}

@media (max-width: 760px) {
	.page-intro-heading-row {
		align-items: flex-start;
	}

	.page-intro-icon {
		width: 54px;
		height: 54px;
		flex-basis: 54px;
	}
}
</style>
