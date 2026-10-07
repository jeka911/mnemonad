<template>
	<Teleport to="body">
		<div v-if="isVisible" class="ctxMenu" :style="{ left: posX + 'px', top: posY + 'px' }" @click.stop>
			<template v-if="mode === 'item'">
				<div class="ctxMenuItem ctxMenuDanger" @click="onDelete">Delete</div>
			</template>
			<template v-else>
				<div class="ctxMenuItem" @click="onMakeDir">Make Dir</div>
				<div class="ctxMenuItem" @click="onNewFile">New File</div>
				<div class="ctxMenuSep"></div>
				<div class="ctxMenuItem" @click="onRefresh">Refresh</div>
			</template>
		</div>
	</Teleport>
</template>

<script>
const LONG_TAP_MS = 500;
const LONG_TAP_MOVE_THRESHOLD = 10;
const MENU_WIDTH = 140;
const MENU_HEIGHT = 40;

export default {
	name: 'FileManagerContextMenu',
	emits: ['delete', 'mkdir', 'newFile', 'refresh'],
	data() {
		return {
			isVisible: false,
			posX: 0,
			posY: 0,
			mode: 'item',
			targetItemName: null,
			targetItemType: null,
		};
	},
	methods: {
		attachTo(containerEl) {
			this._container = containerEl;

			this._onContextMenu = (e) => {
				const el = e.target.closest('[data-item-name]');
				if (!el || el.dataset.itemType === 'back') {
					e.preventDefault();
					this._showBackground(e.clientX, e.clientY);
					return;
				}
				e.preventDefault();
				this._show(el, e.clientX, e.clientY);
			};

			this._touchStartX = 0;
			this._touchStartY = 0;
			this._longTapTimer = null;
			this._longTapFired = false;

			this._onTouchStart = (e) => {
				const el = e.target.closest('[data-item-name]');
				if (!el || el.dataset.itemType === 'back') return;

				const t = e.touches[0];
				this._touchStartX = t.clientX;
				this._touchStartY = t.clientY;
				this._longTapFired = false;

				this._longTapTimer = setTimeout(() => {
					this._longTapFired = true;
					this._show(el, t.clientX, t.clientY);
				}, LONG_TAP_MS);
			};

			this._onTouchMove = (e) => {
				if (!this._longTapTimer) return;
				const t = e.touches[0];
				const dx = t.clientX - this._touchStartX;
				const dy = t.clientY - this._touchStartY;
				if (dx * dx + dy * dy > LONG_TAP_MOVE_THRESHOLD * LONG_TAP_MOVE_THRESHOLD) {
					clearTimeout(this._longTapTimer);
					this._longTapTimer = null;
				}
			};

			this._onTouchEnd = (e) => {
				clearTimeout(this._longTapTimer);
				this._longTapTimer = null;
				if (this._longTapFired) {
					e.preventDefault();
				}
			};

			this._onDocClick = (e) => {
				if (this._longTapFired) {
					e.stopPropagation();
					e.preventDefault();
					this._longTapFired = false;
					return;
				}
				if (this.isVisible && !e.target.closest('.ctxMenu')) {
					console.log('ctxMenu: click-outside, closing');
					this.close();
				}
			};

			this._onKeyDown = (e) => {
				if (this.isVisible && e.key === 'Escape') {
					this.close();
				}
			};

			this._onScroll = () => {
				if (this.isVisible) this.close();
			};

			containerEl.addEventListener('contextmenu', this._onContextMenu);
			containerEl.addEventListener('touchstart', this._onTouchStart, { passive: false });
			containerEl.addEventListener('touchmove', this._onTouchMove, { passive: true });
			containerEl.addEventListener('touchend', this._onTouchEnd);
			containerEl.addEventListener('touchcancel', this._onTouchEnd);
			containerEl.addEventListener('scroll', this._onScroll);
			document.addEventListener('click', this._onDocClick, true);
			document.addEventListener('keydown', this._onKeyDown);
		},

		_show(el, x, y) {
			this.mode = 'item';
			this.targetItemName = el.dataset.itemName;
			this.targetItemType = el.dataset.itemType;
			this.posX = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
			this.posY = Math.min(y, window.innerHeight - MENU_HEIGHT - 8);
			this.isVisible = true;
		},

		_showBackground(x, y) {
			this.mode = 'background';
			this.targetItemName = null;
			this.targetItemType = null;
			this.posX = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
			this.posY = Math.min(y, window.innerHeight - MENU_HEIGHT * 3 - 8);
			this.isVisible = true;
		},

		close() {
			this.isVisible = false;
			this.targetItemName = null;
			this.targetItemType = null;
		},

		onDelete() {
			this.$emit('delete', { name: this.targetItemName, type: this.targetItemType });
			this.close();
		},

		onMakeDir() {
			this.$emit('mkdir');
			this.close();
		},

		onNewFile() {
			this.$emit('newFile');
			this.close();
		},

		onRefresh() {
			this.$emit('refresh');
			this.close();
		},
	},
	beforeUnmount() {
		clearTimeout(this._longTapTimer);
		if (this._container) {
			this._container.removeEventListener('contextmenu', this._onContextMenu);
			this._container.removeEventListener('touchstart', this._onTouchStart);
			this._container.removeEventListener('touchmove', this._onTouchMove);
			this._container.removeEventListener('touchend', this._onTouchEnd);
			this._container.removeEventListener('touchcancel', this._onTouchEnd);
			this._container.removeEventListener('scroll', this._onScroll);
		}
		document.removeEventListener('click', this._onDocClick, true);
		document.removeEventListener('keydown', this._onKeyDown);
	},
};
</script>

<style scoped>
.ctxMenu {
	position: fixed;
	z-index: 9200;
	background: var(--q-surface-2, #1e1147);
	border: 1px solid var(--q-surface-border, #33246b);
	border-radius: 6px;
	box-shadow: 0 4px 16px var(--q-shadow-drop, rgba(32, 0, 82, .08));
	min-width: 120px;
	padding: 4px 0;
	user-select: none;
	color: var(--q-text, #d8d3ea);
}
.ctxMenuItem {
	padding: 8px 16px;
	cursor: pointer;
	font-size: 14px;
	transition: background-color 0.15s ease;
}
.ctxMenuItem:hover {
	background-color: var(--q-surface-3, #2a1a5c);
}
.ctxMenuDanger {
	color: var(--q-negative, #f87171);
}
.ctxMenuSep {
	height: 1px;
	background: var(--q-surface-border, #33246b);
	margin: 4px 0;
}
</style>
