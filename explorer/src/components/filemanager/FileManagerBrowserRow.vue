<template>

    <div class="rowRow" v-if="row.isFull || row.isEnded || true">
        <template v-if="!disposed" v-for="(item, index) in row.items" :key="item.id">
            <div class="rowItem" :style="{ width: (row.displayWidths && row.displayWidths.length ? row.displayWidths : row.widths)[index] + '%' }">
                <FileManagerBrowserRowItem :item="item" :primaryColor="primaryColor" @itemClick="onItemClick(item)" ref="items"  />
            </div>
        </template>
    </div>

</template>
<script>
import FileManagerBrowserRowItem from './FileManagerBrowserRowItem.vue';
import { toRaw } from 'vue';

export default {
    name: 'FileManagerBrowserRow',
    props: {
        row: Object,
        primaryColor: {
            type: String,
            required: false,
            default: 'var(--q-primary)',
        },
        disposed: {
            type: Boolean,
            default: true,
        },
    },
    emits: ['itemClick', 'back'],
    components: {
        FileManagerBrowserRowItem,
    },
    data() {
        return {
            isDisposed: true,
        }
    },
    watch: {
        disposed(val) {
            this.isDisposed = val;
            if (val) {
                if (this.row && this.row.items) {
                    this.row.items.forEach(item => {
                        const raw = toRaw(item);
                        if (raw && typeof raw.dispose === 'function') raw.dispose();
                    });
                }
            } else {
                if (this.row.items && this.row.items.length) {
                    let folder = null;
                    for (const item of this.row.items) {
                        const raw = toRaw(item);
                        if (raw && !raw.isFolder && raw.folder) {
                            folder = raw.folder;
                            break;
                        }
                    }
                    if (folder) folder.loadPreviews(this.row.items);
                }
            }
        },
    },
    methods: {
        onItemClick(item) {
            this.$emit('itemClick', item);
        },
        dispose() {
            if (this.isDisposed) return;
            if (this.row && this.row.items) {
                this.row.items.forEach(item => {
                    const raw = toRaw(item);
                    if (raw && typeof raw.dispose === 'function') {
                        raw.dispose();
                    }
                });
            }
            this.isDisposed = true;
        },
        restore() {
            if (!this.isDisposed) return;
            this.isDisposed = false;

            if (this.row.items && this.row.items.length) {
                let folder = null;
                for (const item of this.row.items) {
                    const raw = toRaw(item);
                    if (raw && !raw.isFolder && raw.folder) {
                        folder = raw.folder;
                        break;
                    }
                }
                if (folder) {
                    folder.loadPreviews(this.row.items);
                }
            }
        },
        getItemsElements() {
            return this.$refs.items;
        },
    },
    mounted() {
        this.__onItemAdded = (item) => {
            if (this.disposed) {
                return;
            }
            this.$forceUpdate();
        };
        this.__onItemRemoved = () => {
            if (this.disposed) return;
            this.$forceUpdate();
        };
        this.row.on('itemAdded', this.__onItemAdded);
        this.row.on('itemRemoved', this.__onItemRemoved);
    },
    beforeUnmount() {
        if (this.row && this.__onItemAdded) {
            this.row.off('itemAdded', this.__onItemAdded);
        }
        if (this.row && this.__onItemRemoved) {
            this.row.off('itemRemoved', this.__onItemRemoved);
        }
    },
    computed: {
    },
}
</script>
<style type="text/css">
    .rowRow {
        margin-bottom: 0px;
        width: 100%;
        height: var(--row-height, 200px);
    }
    .rowRow::after {
        content: "";
        display: table;
        clear: both;
    }
    .backItem {
        cursor: pointer;
    }
    .backItem:hover {
        opacity: 0.9;
    }
    .rowItem {
        float: left;
        height: var(--row-height, 200px);
    }
    .drive-folder-file {
        width: 100%;
        max-width: 100% !important;
        cursor: pointer;
        overflow: hidden;
        border-radius: 4px !important;
    }
    .rowItem img {
        height: var(--row-height, 200px);
        object-fit: cover;
    }
    .rowItem .q-img {
        height: var(--row-height, 200px);
    }
    .rowItem .q-card {
        padding: 2px;
        box-shadow: none;
    }

    @media screen and (max-width: 900px) {
        .rowItem {
            height: 100px;
        }
        .rowItem img {
            height: 100px;
        }
        .rowItem .q-img {
            height: 100px;
        }
    }
</style>
