<template>
	<div
		class="rowsContainer"
		:class="{rowsContainerActive: isOnFront}"
		:style="{zIndex: zIndex, minHeight: height, maxHeight: height, '--row-height': rowHeight }" ref="rowsContainer">
		<FileManagerBrowserRow v-for="(item, index) in rows" :row="item" :primaryColor="primaryColor" :key="item.id" :disposed="rowsDisposed[index]" ref="rows"
			@itemClick="onItemClick"  />
		<FileManagerContextMenu ref="contextMenu" @delete="onDeleteItem" @mkdir="onMakeDir" @newFile="onNewFile" @refresh="onRefresh" />
	</div>
	<!-- Thin custom scrollbar overlay (native one is hidden). Overlays the right
		 edge of the scroll viewport — it never changes the width/layout of the
		 rows or buttons. -->
	<div
		class="wm-scrollbar"
		:class="{ 'wm-scrollbar--active': isDraggingScrollbar }"
		v-show="scrollbarVisible && isOnFront"
		:style="{ zIndex: zIndex + 1 }"
		@pointerdown.self="onTrackDown"
	>
		<div
			class="wm-scrollbar-thumb"
			:style="{ height: thumbHeight + 'px', transform: 'translateY(' + thumbTop + 'px)' }"
			@pointerdown="onThumbDown"
		></div>
	</div>
</template>

<script>
import FileManagerBrowserRow from './FileManagerBrowserRow.vue';
import FileManagerContextMenu from './menus/FileManagerContextMenu.vue';
import { toRaw, shallowReactive, reactive } from 'vue';

export default {
	name: 'FileManagerFolderView',
	components: {
		FileManagerBrowserRow,
		FileManagerContextMenu,
	},
	// Declared explicitly: this component's template has two root nodes (the rows
	// container + the scrollbar overlay), so Vue can't auto-inherit these as fallthrough
	// attrs on a single root the way it would otherwise — without this, itemClick/mkdir/
	// newFile/refresh listeners passed in from FileManagerBrowser.vue trigger a Vue warning
	// even though they're actually consumed via this.$emit(...) below.
	emits: ['itemClick', 'mkdir', 'newFile', 'refresh'],
	props: {
		folder: {
			type: Object,
			required: true,
		},
		height: {
			type: String,
			required: false,
			default: '600px',
		},
		rowHeight: {
			type: String,
			required: false,
			default: '200px',
		},
		primaryColor: {
			type: String,
			required: false,
			default: 'var(--q-primary)',
		},
	},
	data() {
		return {
			isOnFront: false,
			zIndex: 9000,

			rows: shallowReactive([]),
			rowsDisposed: reactive([]),
			rowsIds: {},
			cachedRowHeight: null,
			firstRowToKeep: 0,
			lastRowToKeep: 0,

			// custom scrollbar state
			scrollbarVisible: false,
			thumbTop: 0,
			thumbHeight: 0,
			isDraggingScrollbar: false,
		}
	},
	watch: {
		rowHeight: function() {
			this.cachedRowHeight = null;
		},
		// folder: function(newFolder, oldFolder) {
		//     console.log('FileManagerFolderView: folder changed:', newFolder, oldFolder);
		//     this.rows = newFolder.rows || [];
		//     console.log('New rows:', this.rows);
		//     this.cachedRowHeight = null;
		//     this.firstRowToKeep = 0;
		//     this.lastRowToKeep = 0;
		//     this.detachEventsFromFolder(oldFolder);
		//     this.attachEventsToFolder(newFolder);
		// },
	},
	methods: {
		onItemClick(item) {
			this.$emit('itemClick', item);
		},
		onDeleteItem({ name }) {
			this.folder.removeChild(name);
		},
		onMakeDir() {
			this.$emit('mkdir');
		},
		onNewFile() {
			this.$emit('newFile');
		},
		onRefresh() {
			this.$emit('refresh');
		},
		async bringToFront() {
			this.isOnFront = true;
			this.$nextTick(() => this.updateScrollbar());
			await new Promise((res)=>setTimeout(res, 300));
			this.zIndex = 9001;
		},
		async sendToBack() {
			this.isOnFront = false;
			await new Promise((res)=>setTimeout(res, 300));
			this.zIndex = 9000;
		},
		disposeRow(rowIndex) {
			if (rowIndex >= 0 && rowIndex < this.rowsDisposed.length) {
				this.rowsDisposed[rowIndex] = true;
			}
		},
		restoreRow(rowIndex) {
			if (rowIndex >= 0 && rowIndex < this.rowsDisposed.length) {
				this.rowsDisposed[rowIndex] = false;
			}
		},
		measureRowHeight() {
			// All rows are uniform fixed height, so derive it straight from the DOM.
			// scrollHeight / rowCount is exact and immune to $refs ordering, media-query
			// height changes, and not-yet-rendered rows. Only cache a real (>0) value.
			const container = this.$refs.rowsContainer;
			if (container && this.rows.length > 0 && container.scrollHeight > 0) {
				this.cachedRowHeight = container.scrollHeight / this.rows.length;
			}
			// Fall back to a sane default only until the DOM is measurable; never cache it.
			return this.cachedRowHeight || 200;
		},
		isRowVisible(rowIndex) {
			const container = this.$refs.rowsContainer;
			if (!container || rowIndex < 0 || rowIndex >= this.rows.length) {
				return false;
			}

			const rowHeight = this.measureRowHeight();
			const rowTop = rowIndex * rowHeight;
			const rowBottom = rowTop + rowHeight;

			const containerScrollTop = container.scrollTop;
			const containerScrollBottom = containerScrollTop + container.clientHeight;

			return rowBottom >= containerScrollTop && rowTop <= containerScrollBottom;
		},
		recalculateVisibles(scrollTop = null, containerHeight = null) {
			let nScrollTop = scrollTop;
			let nContainerHeight = containerHeight;
			if (scrollTop === null || containerHeight === null) {
				const container = this.$refs.rowsContainer;
				nScrollTop = container.scrollTop;
				nContainerHeight = container.clientHeight;
			}

			const rowHeight = this.measureRowHeight();

			const firstVisibleRow = Math.floor(nScrollTop / rowHeight);
			const lastVisibleRow = Math.ceil((nScrollTop + nContainerHeight) / rowHeight);

			this.firstRowToKeep = Math.max(0, firstVisibleRow - 3);
			this.lastRowToKeep = Math.min(this.rows.length - 1, lastVisibleRow + 3);
		},
		onScrolled() {
			if (this.__scrollRaf) return;
			this.__scrollRaf = requestAnimationFrame(() => {
				this.__scrollRaf = null;
				const container = this.$refs.rowsContainer;
				if (!container) return;
				const scrollTop = container.scrollTop;
				if (this.__lastScrolledTop !== undefined && Math.abs(this.__lastScrolledTop - scrollTop) <= 200) {
					return;
				}
				this.__lastScrolledTop = scrollTop;
				this.recalculateVisibles(scrollTop, container.clientHeight);
				for (let i = 0; i < this.rows.length; i++) {
					if (i < this.firstRowToKeep || i > this.lastRowToKeep) {
						this.disposeRow(i);
					} else {
						this.restoreRow(i);
					}
				}
			});
		},
		async loadPreviewsInterval() {
			const delayTillNext = 10;
			try {
				for (let i = this.firstRowToKeep; i <= this.lastRowToKeep; i++) {
					if (this.$refs.rows && this.$refs.rows[i]) {
						const rowItems = this.$refs.rows[i].getItemsElements();
						if (!rowItems || !rowItems.length) continue;
						for (let j = 0; j < rowItems.length; j++) {
							if (rowItems[j] && !rowItems[j].previewInitialized) {
								await rowItems[j].initializePreview();
								this.__loadPreviewsTimeout = setTimeout(() => {
									this.loadPreviewsInterval();
								}, delayTillNext);
								return true;
							}
						}
					}
				}
			} catch (e) {
				console.error('Error loading previews:', e);
			}
			this.__loadPreviewsTimeout = setTimeout(() => {
				this.loadPreviewsInterval();
			}, delayTillNext);
		},
		attachEventsToFolder() {
			this.folder.on('rowAdded', this.__onRowAdded);
			this.folder.on('rowRemoved', this.__onRowRemoved);
		},
		detachEventsFromFolder() {
			this.folder.off('rowAdded', this.__onRowAdded);
			this.folder.off('rowRemoved', this.__onRowRemoved);
		},
		getRowsFromFolderData() {
		},
		scrollToBottom() {
			if (this.$refs.rowsContainer) {
				this.$refs.rowsContainer.scrollTop = this.$refs.rowsContainer.scrollHeight;
			}
		},

		// ── custom scrollbar ──────────────────────────────────────────────
		// Recompute thumb size/position from the scroll container's live metrics.
		updateScrollbar() {
			const c = this.$refs.rowsContainer;
			if (!c) { this.scrollbarVisible = false; return; }
			const { scrollHeight, clientHeight, scrollTop } = c;
			if (scrollHeight <= clientHeight + 1) { this.scrollbarVisible = false; return; }

			const trackH = clientHeight;
			const minThumb = 28;
			const thumbH = Math.max(minThumb, Math.round(trackH * clientHeight / scrollHeight));
			const maxTop = trackH - thumbH;
			const scrollable = scrollHeight - clientHeight;
			const top = scrollable > 0 ? Math.round(maxTop * scrollTop / scrollable) : 0;

			this.thumbHeight = thumbH;
			this.thumbTop = top;
			this.scrollbarVisible = true;
		},
		onThumbDown(e) {
			e.preventDefault();
			e.stopPropagation();
			const c = this.$refs.rowsContainer;
			if (!c) return;

			const startY = e.clientY;
			const startScroll = c.scrollTop;
			const scrollable = c.scrollHeight - c.clientHeight;
			const maxTop = c.clientHeight - this.thumbHeight;

			// disable smooth scrolling so the thumb tracks the pointer 1:1
			const prevBehavior = c.style.scrollBehavior;
			c.style.scrollBehavior = 'auto';
			this.isDraggingScrollbar = true;

			const move = (ev) => {
				const dy = ev.clientY - startY;
				const delta = maxTop > 0 ? (dy / maxTop) * scrollable : 0;
				c.scrollTop = Math.max(0, Math.min(scrollable, startScroll + delta));
				this.updateScrollbar();
			};
			const up = () => {
				this.isDraggingScrollbar = false;
				c.style.scrollBehavior = prevBehavior;
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		},
		onTrackDown(e) {
			// click on empty track: jump so the thumb centers under the pointer
			const c = this.$refs.rowsContainer;
			if (!c) return;
			const rect = e.currentTarget.getBoundingClientRect();
			const y = e.clientY - rect.top;
			const scrollable = c.scrollHeight - c.clientHeight;
			const ratio = Math.max(0, Math.min(1, (y - this.thumbHeight / 2) / (c.clientHeight - this.thumbHeight)));
			c.scrollTop = ratio * scrollable;
			this.updateScrollbar();
		},
	},
	mounted() {
		this.loadPreviewsInterval();
		this.folder.rows.map(r=>{
			this.rowsIds[r.id] = true;
			this.rows.push(r);
			this.rowsDisposed.push(true);
		});

		setTimeout(()=>{
			this.recalculateVisibles();
			if (this.rows.length - 3 <= this.lastRowToKeep) {
				let i = this.rows.length - 1;
				this.$nextTick(() => {
					this.restoreRow(i);
				});
			}

			for (let i = 0; i < 10; i++) {
				this.restoreRow(i);
			}
			this.updateScrollbar();
		}, 200);
		
		console.log('Mounted FileManagerFolderView with rows:', this.rows, toRaw(this.folder.rows));
		this.__onRowAdded = (row) => {
			console.log('Row added event received for row:', row.id);
			if (this.rowsIds[row.id]) {
				return;
			}
			this.rowsIds[row.id] = true;
			this.rows.push(row);
			this.rowsDisposed.push(true);
			this.recalculateVisibles();
			if (this.rows.length - 3 <= this.lastRowToKeep) {
				let i = this.rows.length - 1;
				this.$nextTick(() => {
					this.restoreRow(i);
				});
			}
			this.$nextTick(() => this.updateScrollbar());
		};
		this.__onRowRemoved = (row) => {
			const idx = this.rows.indexOf(row);
			if (idx !== -1) {
				this.rows.splice(idx, 1);
				this.rowsDisposed.splice(idx, 1);
			}
			delete this.rowsIds[row.id];
		};
		this.__onWindowResize = () => {
			this.cachedRowHeight = null;
			this.$nextTick(() => this.updateScrollbar());
		};
		window.addEventListener('resize', this.__onWindowResize);
		this.__onContainerScroll = (event) => {
			// keep the thumb in sync every frame (the virtualization in
			// onScrolled is throttled to 200px, too coarse for a smooth thumb)
			if (!this.__sbRaf) {
				this.__sbRaf = requestAnimationFrame(() => {
					this.__sbRaf = null;
					this.updateScrollbar();
				});
			}
			this.onScrolled(event);
		};
		this.attachEventsToFolder(this.folder);
		this.$refs.rowsContainer.addEventListener('scroll', this.__onContainerScroll);
		this.$refs.contextMenu.attachTo(this.$refs.rowsContainer);
	},
	unmounted() {
		if (this.folder && this.__onRowAdded) {
			this.folder.off('rowAdded', this.__onRowAdded);
		}
		if (this.__onWindowResize) {
			window.removeEventListener('resize', this.__onWindowResize);
		}
		this.detachEventsFromFolder(this.folder);
		if (this.__onContainerScroll && this.$refs.rowsContainer) {
			this.$refs.rowsContainer.removeEventListener('scroll', this.__onContainerScroll);
		}
		if (this.__scrollRaf) {
			cancelAnimationFrame(this.__scrollRaf);
		}
		if (this.__sbRaf) {
			cancelAnimationFrame(this.__sbRaf);
		}
		clearTimeout(this.__loadPreviewsTimeout);
	},
}
</script>

<style scoped>
.rowsContainer {
	left: 0px;
	right: 0px;
	position: absolute;
	max-height: 600px;
	overflow-y: auto;
	scroll-behavior: smooth;

	opacity: 0;
	transition: opacity .3s;

	scrollbar-width: none;
}

.rowsContainer::-webkit-scrollbar {
	display: none;
}

.rowsContainer.rowsContainerActive {
	opacity: 1;
}

/* Thin overlay scrollbar — sits at the right edge of the scroll viewport, on
   top of content, so it never affects the width/layout of rows or buttons.
   Matches the app's native scrollbar style (see common.css --sb-thumb tokens):
   10px wide with a 2px transparent inset border and a rounded, theme-aware thumb. */
.wm-scrollbar {
	position: absolute;
	top: 0;
	bottom: 0;
	right: 0;
	width: 10px;
	background: transparent;
	cursor: pointer;
	/* don't let a drag select page text */
	user-select: none;
	touch-action: none;
}

.wm-scrollbar-thumb {
	position: absolute;
	left: 0;
	top: 0;
	width: 100%;
	box-sizing: border-box;
	border-radius: 999px;
	background-color: var(--sb-thumb, color-mix(in srgb, var(--q-primary, #836ef9) 35%, transparent));
	/* transparent border + padding-box clip → slim inset thumb, like the native one */
	border: 2px solid transparent;
	background-clip: padding-box;
	transition: background-color 0.2s ease;
	will-change: transform;
}
.wm-scrollbar:hover .wm-scrollbar-thumb,
.wm-scrollbar.wm-scrollbar--active .wm-scrollbar-thumb {
	background-color: var(--sb-thumb-hover, color-mix(in srgb, var(--q-primary, #836ef9) 55%, transparent));
}
</style>
