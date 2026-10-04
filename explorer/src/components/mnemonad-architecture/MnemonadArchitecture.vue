<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import globeUrl from './assets/globe.webp'
import personUrl from './assets/person.webp'
import ladyUrl from './assets/lady.webp'

const props = defineProps({
  theme: {
    type: String,
    default: 'dark',
    validator: (v) => ['dark', 'light'].includes(v),
  },
  /** Block key → where clicking it goes. Keys: the four top cards ('users', 'agents', 'dapps',
   *  'integrations') and 'sdk', 'encrypt', 'cdc', 'monad', 'data', 'sync', 'built',
   *  'offchain'. An in-app path (starting with '/') goes through the router; anything else is
   *  a plain navigation. Blocks without an entry stay non-interactive. */
  links: {
    type: Object,
    default: () => ({}),
  },
})

// Null when the diagram is rendered outside a router (it still works, links just reload).
const router = useRouter()

function openLink(key) {
  const href = props.links[key]
  if (!href) return
  if (href.startsWith('/') && router) router.push(href)
  else window.location.assign(href)
}

// What a screen reader announces for each linkable block (the cards build theirs from their
// own text, see linkAttrs). Kept to the block's visible wording.
const blockLabels = {
  sdk: 'Mnemonad SDK: JavaScript / TypeScript, simple API',
  encrypt: 'Encrypt: end-to-end encryption',
  cdc: 'Write, append, read and search over efficient CDC diffs',
  monad: 'Monad Blockchain: stores diffs and chunks',
  data: 'Your data: files, folders, databases, media, AI memory, any binary data',
  sync: 'Sync',
  built: 'Built for: appendable, verifiable, programmable, permanent, composable',
  offchain: 'Off-chain storage, any backend',
}

/** Attributes that make a block a keyboard-reachable link — none when it has no link. */
function linkAttrs(key, label = blockLabels[key]) {
  if (!props.links[key]) return {}
  return { role: 'link', tabindex: 0, 'aria-label': label }
}

/* ------------------------------------------------------------------ data */

const cards = [
  { key: 'users', tag: 'USERS', x: 28, w: 372, tx: 60, dot: 215, start: 500,
    lines: ['Store files, apps,', 'databases, and more'] },
  { key: 'agents', tag: 'AI AGENTS', x: 434, w: 351, tx: 464, dot: 605, start: 700,
    lines: ['Persistent memory,', 'knowledge bases, tools,', 'and autonomous workflows'] },
  { key: 'dapps', tag: 'dApps', x: 818, w: 347, tx: 857, dot: 1000, start: 900,
    lines: ['Build on-chain', 'with real data'] },
  { key: 'integrations', tag: 'INTEGRATIONS', x: 1198, w: 378, tx: 1256, dot: 1386, start: 1100,
    lines: ['Sync, backups, data proofs,', 'share, collaborate,', 'import / export, and more'] },
]

const dataItems = ['Files', 'Folders', 'Databases', 'Media', 'AI Memory', 'Any binary data']
const dataY = [447, 497, 543, 592, 643, 694]

const builtItems = ['Appendable', 'Verifiable', 'Programmable', 'Permanent', 'Composable']
const builtY = [520, 567, 614, 660, 707]

// x = logo centre, lx = label start (8px after the logo), groups spaced evenly up to the divider
const storages = [
  { key: 'ipfs', label: 'IPFS', x: 407, lx: 429 },
  { key: 'filecoin', label: 'Filecoin', x: 501, lx: 521 },
  { key: 'walrus', label: 'Walrus', x: 624, lx: 649 },
  { key: 'arweave', label: 'Arweave', x: 746, lx: 772 },
  { key: 'custom', label: 'Custom', x: 882, lx: 906 },
]

// Connector paths. Packets travel along each one.
const flows = [
  { id: 'users', d: 'M215,243 V262 Q215,276 229,276 H645', dur: 2.2, begin: 2.2 },
  { id: 'agents', d: 'M605,243 V262 Q605,276 619,276 H645', dur: 1.3, begin: 2.6 },
  { id: 'dapps', d: 'M1000,243 V262 Q1000,276 986,276 H954', dur: 1.4, begin: 2.4 },
  { id: 'integrations', d: 'M1386,243 V262 Q1386,276 1372,276 H954', dur: 2.2, begin: 2.9 },
  { id: 'sdk', d: 'M800,286 V313', dur: 0.9, begin: 2.3, arrow: true },
  { id: 'cdc1', d: 'M800,425 V451', dur: 0.9, begin: 2.6, arrow: true },
  { id: 'cdc2', d: 'M800,510 V529', dur: 0.8, begin: 2.9, arrow: true },
  { id: 'data', d: 'M328,449 H360 Q385,449 385,474 V550', dur: 1.6, begin: 2.2 },
  { id: 'sync', d: 'M424,579 H497', dur: 0.9, begin: 2.8, arrow: true },
  { id: 'offdown', d: 'M557,668 V752', dur: 1.5, begin: 3.0, arrow: true, dashed: true },
  { id: 'offup', d: 'M958,757 V674', dur: 1.5, begin: 3.6, arrow: true },
  { id: 'verif', d: 'M1097,588 H1150', dur: 0.9, begin: 3.2, dashed: true },
  { id: 'built', d: 'M1277,555 V505 Q1277,482 1300,482 H1329', dur: 1.3, begin: 3.4 },
]

const topFlows = ['sdk', 'cdc1', 'cdc2']
const hotFlows = {
  users: ['users', ...topFlows],
  agents: ['agents', ...topFlows],
  dapps: ['dapps', ...topFlows],
  integrations: ['integrations', ...topFlows],
  sdk: ['users', 'agents', 'dapps', 'integrations', ...topFlows],
  encrypt: ['sdk', 'cdc1'],
  cdc: ['cdc1', 'cdc2'],
  monad: ['cdc2', 'sync', 'offdown', 'offup', 'verif', 'built'],
  data: ['data', 'sync'],
  offchain: ['offdown', 'offup'],
  built: ['built', 'verif'],
}
const hotNodes = {
  users: ['sdk', 'cdc', 'monad'],
  agents: ['sdk', 'cdc', 'monad'],
  dapps: ['sdk', 'cdc', 'monad'],
  integrations: ['sdk', 'cdc', 'monad'],
  sdk: ['cdc', 'monad'],
  encrypt: ['sdk'],
  data: ['monad'],
  offchain: ['monad'],
  built: ['monad'],
  monad: ['offchain', 'built'],
}

/* ----------------------------------------------------------------- state */

const root = ref(null)
const svg = ref(null)
const hover = ref(null)
const live = ref(false)
const paused = ref(false)
const reduced = ref(false)

const activeData = ref(0)
const activeBuilt = ref(0)
const activeStore = ref(0)

const typed = reactive(Object.fromEntries(cards.map((c) => [c.key, 0])))

const isFlowHot = (id) => !!hover.value && (hotFlows[hover.value] || []).includes(id)
const isNodeHot = (key) =>
  hover.value === key || (!!hover.value && (hotNodes[hover.value] || []).includes(key))

/* --------------------------------------------------------------- helpers */

const MONO_ADV = 10.6 // 18px JetBrains Mono (0.6em) with -0.2 letter-spacing
const tagWidth = (label) => label.length * 14.6 + 18

function lineText(card, i) {
  const before = card.lines.slice(0, i).join('').length
  return card.lines[i].slice(0, Math.max(0, typed[card.key] - before))
}
function cursorPos(card) {
  const total = card.lines.join('').length
  if (typed[card.key] >= total) return null
  let left = typed[card.key]
  for (let i = 0; i < card.lines.length; i++) {
    if (left <= card.lines[i].length) return { x: card.tx + left * MONO_ADV + 1, y: 90 + i * 23 - 15 }
    left -= card.lines[i].length
  }
  return null
}

// Isometric cube faces, centred on (cx, cy)
function cube(cx, cy, s) {
  const k = s * 0.866
  const p = (pts) => pts.map((q) => q.join(',')).join(' ')
  return {
    top: p([[cx, cy - s], [cx + k, cy - s / 2], [cx, cy], [cx - k, cy - s / 2]]),
    left: p([[cx - k, cy - s / 2], [cx, cy], [cx, cy + s], [cx - k, cy + s / 2]]),
    right: p([[cx, cy], [cx + k, cy - s / 2], [cx + k, cy + s / 2], [cx, cy + s]]),
  }
}
function hex(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

// Deterministic twinkling background specks, kept STAR_MARGIN inside the frame
const STAR_MARGIN = 32
const stars = (() => {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  return Array.from({ length: 70 }, () => ({
    x: STAR_MARGIN + rnd() * (1600 - 2 * STAR_MARGIN),
    y: STAR_MARGIN + rnd() * (980 - 2 * STAR_MARGIN),
    r: rnd() * 1.3 + 0.3,
    d: (rnd() * 6).toFixed(2), t: (3 + rnd() * 4).toFixed(2),
  }))
})()

const bottomCubes = [cube(200, 930, 28), cube(248, 905, 28), cube(296, 878, 31)]
const sdkCube = cube(606, 378, 27)
const dataCube = cube(0, 0, 13) // local to its row icon
const ipfsCube = cube(0, 0, 17)

/* ------------------------------------------------------------- lifecycle */

const timers = []
let observer

function startTyping() {
  cards.forEach((c) => {
    const total = c.lines.join('').length
    if (reduced.value) return (typed[c.key] = total)
    timers.push(setTimeout(() => {
      const iv = setInterval(() => {
        if (paused.value) return
        typed[c.key]++
        if (typed[c.key] >= total) clearInterval(iv)
      }, 26)
      timers.push(iv)
    }, c.start))
  })
}

function startCycles() {
  const cycle = (r, n, ms) =>
    timers.push(setInterval(() => { if (!paused.value) r.value = (r.value + 1) % n }, ms))
  cycle(activeData, dataItems.length, 1300)
  cycle(activeBuilt, builtItems.length, 1600)
  cycle(activeStore, storages.length, 1100)
}

function setPaused(p) {
  paused.value = p
  if (!svg.value) return
  p ? svg.value.pauseAnimations() : svg.value.unpauseAnimations()
}

// Animate only while the component is on screen AND the tab is visible.
// The first start also waits for both, so a background tab plays the intro when opened.
let inView = false
let tabVisible = true

function syncRunning() {
  const run = inView && tabVisible
  if (run && !live.value) {
    live.value = true
    svg.value?.setCurrentTime?.(0)
    startTyping()
    startCycles()
  }
  if (live.value) setPaused(!run)
}

function onVisibilityChange() {
  tabVisible = document.visibilityState === 'visible'
  syncRunning()
}

// The diagram's text is laid out for these faces (the typing caret's x is computed
// from JetBrains Mono's advance width — MONO_ADV above), and the app itself only loads Space
// Grotesk/Mono. Added on first mount rather than site-wide, so pages without the diagram
// don't download them. A <link>, not a CSS @import: Vite concatenates component CSS, and an
// @import that doesn't end up first in its stylesheet is silently ignored.
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Architects+Daughter&family=Gelasio:ital,wght@1,700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap'
function ensureFonts() {
  if (document.querySelector(`link[href="${FONTS_HREF}"]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = FONTS_HREF
  document.head.appendChild(link)
}

onMounted(() => {
  ensureFonts()
  reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  svg.value?.pauseAnimations?.() // SMIL timeline waits for the first start too
  tabVisible = document.visibilityState === 'visible'
  document.addEventListener('visibilitychange', onVisibilityChange)
  observer = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
    syncRunning()
  }, { threshold: 0.15 })
  observer.observe(root.value)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  observer?.disconnect()
  timers.forEach((t) => { clearTimeout(t); clearInterval(t) })
})

const rootClass = computed(() => ({
  [`theme-${props.theme}`]: true,
  'is-live': live.value,
  'is-paused': paused.value,
  'is-reduced': reduced.value,
  'has-hover': !!hover.value,
}))
</script>

<template>
  <div ref="root" class="mn" :class="rootClass">
    <svg
      ref="svg"
      class="mn-svg"
      viewBox="0 0 1600 980"
      role="img"
      aria-label="Mnemonad architecture: users, AI agents, dApps and integrations build through the Mnemonad SDK, which writes CDC diffs to the Monad blockchain, with large chunks offloaded to off-chain storage."
    >
      <defs>
        <!-- staggered halftone for the 3D side faces (rows offset by half a step) -->
        <pattern id="mn-dots" width="6" height="10.4" patternUnits="userSpaceOnUse">
          <rect width="6" height="10.4" style="fill: var(--dots-bg)" />
          <circle cx="1.5" cy="2.6" r="1.05" style="fill: var(--dots-fg)" />
          <circle cx="4.5" cy="7.8" r="1.05" style="fill: var(--dots-fg)" />
        </pattern>
        <!-- same halftone, skewed so rows run parallel to each side face's top edge
             and squeezed horizontally for foreshortening: matrix(k, -slope*k, 0, 1, 0, 0) -->
        <pattern id="mn-face-a" width="6" height="10.4" patternUnits="userSpaceOnUse" patternTransform="matrix(0.8 -0.48 0 1 0 0)">
          <rect width="6" height="10.4" style="fill: var(--dots-bg)" />
          <circle cx="1.5" cy="2.6" r="1.15" style="fill: var(--dots-fg)" />
          <circle cx="4.5" cy="7.8" r="1.15" style="fill: var(--dots-fg)" />
        </pattern>
        <pattern id="mn-face-b" width="6" height="10.4" patternUnits="userSpaceOnUse" patternTransform="matrix(0.8 -0.4 0 1 0 0)">
          <rect width="6" height="10.4" style="fill: var(--dots-bg)" />
          <circle cx="1.5" cy="2.6" r="1.15" style="fill: var(--dots-fg)" />
          <circle cx="4.5" cy="7.8" r="1.15" style="fill: var(--dots-fg)" />
        </pattern>
        <pattern id="mn-dots-dense" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" style="fill: var(--dense-bg)" />
          <circle cx="2" cy="2" r="0.9" style="fill: var(--dense-fg)" />
        </pattern>
        <pattern id="mn-dots-light" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" style="fill: var(--cube-bg)" />
          <circle cx="2" cy="2" r="1" style="fill: var(--cube-fg)" />
        </pattern>
        <marker id="mn-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" style="fill: var(--arrow)" />
        </marker>
        <filter id="mn-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <!-- light-mode glow: a lavender halo from the shape's silhouette, so dark
             strokes don't blur into grey shadows -->
        <filter id="mn-glow-tint" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3.5" result="b" />
          <feFlood class="glow-flood" />
          <feComposite in2="b" operator="in" result="g" />
          <feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="mn-glow-lg" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <linearGradient id="mn-sheen" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset="0.5" stop-color="#fff" stop-opacity="0.55" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <radialGradient id="mn-bg" cx="0.5" cy="0.55" r="0.65">
          <stop offset="0" stop-opacity="0.55" style="stop-color: var(--bg-glow)" />
          <stop offset="1" stop-opacity="0" style="stop-color: var(--bg)" />
        </radialGradient>
        <!-- thin ink outline for the cropped raster art (used in light mode) -->
        <filter id="mn-outline" x="-5%" y="-5%" width="110%" height="110%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="0.8" result="d" />
          <feFlood class="outline-flood" />
          <feComposite in2="d" operator="in" result="o" />
          <feMerge><feMergeNode in="o" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="mn-outline-lady" x="-5%" y="-5%" width="110%" height="110%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="1.1" result="d" />
          <feFlood class="outline-lady-flood" />
          <feComposite in2="d" operator="in" result="o" />
          <feMerge><feMergeNode in="o" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <!-- packet glow baked into a gradient (solid r≈4 core + soft halo), so moving
             packets don't re-run a blur filter every frame -->
        <radialGradient id="mn-packet">
          <stop offset="0" class="pk-core" />
          <stop offset="0.4" class="pk-core" />
          <stop offset="0.55" class="pk-halo" style="stop-opacity: 0.35" />
          <stop offset="1" class="pk-halo" style="stop-opacity: 0" />
        </radialGradient>
        <radialGradient id="mn-packet-hot">
          <stop offset="0" class="pk-core-hot" />
          <stop offset="0.4" class="pk-core-hot" />
          <stop offset="0.55" class="pk-halo" style="stop-opacity: 0.5" />
          <stop offset="1" class="pk-halo" style="stop-opacity: 0" />
        </radialGradient>
        <mask id="mn-globe-mask" style="mask-type: alpha">
          <image :href="globeUrl" x="-68" y="-68" width="136" height="136" />
        </mask>
        <clipPath id="mn-cdc-hl"><rect x="692" y="484" width="203" height="21" rx="2" /></clipPath>
        <path
          v-for="f in flows"
          :id="`mn-p-${f.id}`"
          :key="`def-${f.id}`"
          :d="f.d"
        />
      </defs>

      <!-- ============================================== background -->
      <rect width="1600" height="980" fill="url(#mn-bg)" />
      <g class="stars">
        <circle
          v-for="(s, i) in stars"
          :key="i"
          :cx="s.x" :cy="s.y" :r="s.r"
          :style="{ animationDelay: `${s.d}s`, animationDuration: `${s.t}s` }"
        />
      </g>

      <!-- ============================================== top cards -->
      <g
        v-for="(c, ci) in cards"
        :key="c.key"
        class="reveal"
        :style="{ '--d': `${0.1 + ci * 0.12}s` }"
      >
        <g
          class="card node"
          :class="{ hot: isNodeHot(c.key), linked: !!links[c.key] }"
          v-bind="linkAttrs(c.key, `${c.tag}: ${c.lines.join(' ')}`)"
          @mouseenter="hover = c.key"
          @mouseleave="hover = null"
          @click="openLink(c.key)"
          @keydown.enter.prevent="openLink(c.key)"
        >
          <rect class="frame dashed" :x="c.x" y="22" :width="c.w" height="220" rx="4" />
          <rect class="tag-bg" :x="c.x + 24" y="36" :width="tagWidth(c.tag)" height="30" />
          <text class="tag" :x="c.x + 33" y="58">{{ c.tag }}</text>
          <text
            v-for="(l, li) in c.lines"
            :key="li"
            class="desc"
            :x="c.tx"
            :y="90 + li * 23"
          >{{ lineText(c, li) }}</text>
          <rect
            v-if="cursorPos(c)"
            class="caret"
            :x="cursorPos(c).x" :y="cursorPos(c).y"
            width="9" height="18"
          />

          <!-- USERS illustration -->
          <g v-if="c.key === 'users'">
            <g class="person" style="--pd: 0s">
              <image class="raster" :href="personUrl" x="56" y="128" width="192" height="108" />
              <polygon class="screen-glow" points="179,188 231,188 219,227 167,227" />
            </g>
            <path class="ink draw-loop" pathLength="1" d="M232,172 C240,146 262,134 288,140" />
            <path class="ink arrow-head" style="--dur: 3.6s" d="M280,132 L290,140 L279,147" />
            <g class="float" style="--fd: 0s">
              <rect class="ink-box" x="258" y="170" width="38" height="36" rx="3" />
              <circle class="ink thin" cx="284" cy="180" r="3.5" />
              <path class="ink thin" d="M261,203 L272,189 L280,197 L285,192 L294,203" />
            </g>
            <g class="float" style="--fd: .6s">
              <path class="ink-box" d="M316,120 H336 L348,132 V162 H316 Z" />
              <path class="ink thin" d="M336,120 V132 H348 M322,140 H342 M322,147 H342 M322,154 H336" />
            </g>
            <g class="float" style="--fd: 1.2s">
              <rect class="purple-box" x="316" y="176" width="32" height="32" rx="3" />
              <path d="M327,184 L339,192 L327,200 Z" fill="#fff" />
            </g>
          </g>

          <!-- AI AGENTS illustration -->
          <g v-if="c.key === 'agents'">
            <g transform="translate(604,205) scale(0.75)"><g class="robot">
              <path class="ink" d="M0,-45 V-58" />
              <circle class="antenna" cx="0" cy="-64" r="6" />
              <rect class="ink-box" x="-16" y="-4" width="32" height="10" />
              <path class="ink-box" d="M-42,38 C-42,14 -24,4 0,4 C24,4 42,14 42,38" />
              <rect class="ink-box" x="-46" y="-34" width="8" height="18" rx="3" />
              <rect class="ink-box" x="38" y="-34" width="8" height="18" rx="3" />
              <rect class="ink-box" x="-38" y="-46" width="76" height="44" rx="12" />
              <rect x="-26" y="-36" width="52" height="22" rx="10" fill="#8f6ff0" />
              <g class="eyes">
                <rect x="-15" y="-30" width="9" height="10" rx="2" fill="#1c1633" />
                <rect x="6" y="-30" width="9" height="10" rx="2" fill="#1c1633" />
              </g>
              <path class="ink thin" d="M-18,18 H18 M-18,26 H10" />
            </g></g>
            <g transform="translate(-10,8)"><g class="bubble">
              <path class="purple-box" d="M668,158 H720 Q726,158 726,164 V196 Q726,202 720,202 H684 L672,212 L674,202 H668 Q662,202 662,196 V164 Q662,158 668,158 Z" />
              <circle class="typing-dot" cx="680" cy="180" r="3.6" style="--td: 0s" />
              <circle class="typing-dot" cx="694" cy="180" r="3.6" style="--td: .18s" />
              <circle class="typing-dot" cx="708" cy="180" r="3.6" style="--td: .36s" />
            </g></g>
          </g>

          <!-- dApps illustration -->
          <g v-if="c.key === 'dapps'">
            <g class="person" style="--pd: 0.7s">
              <image class="raster-lady" :href="ladyUrl" x="866" y="128" width="192" height="108" />
              <polygon class="screen-glow" points="995,190 1045,190 1032,225 981,225" />
            </g>
            <rect
              v-for="(q, qi) in [[1074,128],[1106,128],[1074,160],[1106,160]]"
              :key="qi"
              class="app-tile"
              :style="{ '--ad': `${qi * 0.45}s` }"
              :x="q[0]" :y="q[1]" width="24" height="24" rx="6"
            />
          </g>

          <!-- INTEGRATIONS illustration -->
          <g v-if="c.key === 'integrations'">
            <g transform="translate(1238,160)">
              <path
                class="ink-box"
                d="M0,0 H22 a8,8 0 1 1 16,0 H60 V22 a8,8 0 1 1 0,16 V60 H0 Z"
              />
            </g>
            <g transform="translate(1298,160)"><g class="puzzle-b">
              <path
                class="purple-box"
                d="M0,0 H22 a8,8 0 1 1 16,0 H60 V22 a8,8 0 1 1 0,16 V60 H0 V38 a8,8 0 1 0 0,-16 Z"
              />
            </g></g>
          </g>

          <circle class="port" :cx="c.dot" cy="243" r="5" />
        </g>
      </g>

      <!-- ============================================== connectors -->
      <g class="reveal" style="--d: .55s">
        <g v-for="f in flows" :key="`line-${f.id}`" :class="{ hot: isFlowHot(f.id) }">
          <path
            class="line"
            :class="f.dashed ? 'dashed-line' : 'draw'"
            :d="f.d"
            :pathLength="f.dashed ? undefined : 1"
            :marker-end="f.arrow ? 'url(#mn-arrow)' : undefined"
          />
          <path class="flow" :d="f.d" />
        </g>

        <circle class="port" cx="652" cy="276" r="5" />
        <circle class="port" cx="947" cy="276" r="5" />
        <text class="label" x="800" y="281" text-anchor="middle">BUILD AND INTERACT THROUGH</text>

        <circle class="port" cx="328" cy="449" r="5" />
        <circle class="port" cx="1333" cy="482" r="5" />
        <path class="line" d="M349,579 H362" marker-end="url(#mn-arrow)" />
      </g>

      <!-- packets -->
      <g v-if="!reduced" class="packets">
        <template v-for="f in flows" :key="`pk-${f.id}`">
          <circle
            v-for="n in 2"
            :key="n"
            class="packet"
            :class="{ hot: isFlowHot(f.id) }"
            r="10"
            opacity="0"
          >
            <animateMotion
              :dur="`${f.dur * 2}s`"
              :begin="`${f.begin + (n - 1) * f.dur}s`"
              repeatCount="indefinite"
              calcMode="spline"
              keyPoints="0;1"
              keyTimes="0;1"
              keySplines="0.4 0 0.3 1"
            >
              <mpath :href="`#mn-p-${f.id}`" />
            </animateMotion>
            <animate
              attributeName="opacity"
              values="0;1;1;0;0"
              keyTimes="0;0.08;0.42;0.5;1"
              :dur="`${f.dur * 2}s`"
              :begin="`${f.begin + (n - 1) * f.dur}s`"
              repeatCount="indefinite"
            />
          </circle>
        </template>
      </g>

      <!-- ============================================== SDK -->
      <g class="reveal" style="--d: .75s">
        <g
          class="node box3d"
          :class="{ hot: isNodeHot('sdk'), linked: !!links.sdk }"
          v-bind="linkAttrs('sdk')"
          @mouseenter="hover = 'sdk'"
          @mouseleave="hover = null"
          @click="openLink('sdk')"
          @keydown.enter.prevent="openLink('sdk')"
        >
          <polygon class="face-top" points="527,332 557,314 1095,314 1065,332" />
          <polygon class="face-side" points="1065,332 1095,314 1095,405 1065,423" />
          <rect class="frame solid" x="527" y="332" width="538" height="91" />
          <g class="sdk-cube">
            <polygon :points="sdkCube.top" fill="#b9a4ff" stroke-width="1.5" style="stroke: var(--void)" />
            <polygon :points="sdkCube.left" fill="#8f6ff0" stroke-width="1.5" style="stroke: var(--void)" />
            <polygon :points="sdkCube.right" fill="#6a4ad8" stroke-width="1.5" style="stroke: var(--void)" />
          </g>
          <text class="title" x="675" y="375">Mnemonad SDK</text>
          <text class="sub" x="675" y="403">JavaScript / TypeScript · Simple API</text>
        </g>
      </g>

      <!-- X + ENCRYPT -->
      <g class="reveal" style="--d: .9s">
        <g class="x-mark">
          <path d="M1138,353 L1167,383 M1167,353 L1138,383" />
        </g>
        <g
          class="node"
          :class="{ hot: isNodeHot('encrypt'), linked: !!links.encrypt }"
          v-bind="linkAttrs('encrypt')"
          @mouseenter="hover = 'encrypt'"
          @mouseleave="hover = null"
          @click="openLink('encrypt')"
          @keydown.enter.prevent="openLink('encrypt')"
        >
          <rect x="1215" y="316" width="22" height="104" fill="url(#mn-dots)" />
          <rect class="frame dashed" x="1215" y="316" width="355" height="104" rx="4" />
          <g class="lock">
            <path class="shackle" d="M1273,362 V348 a15,15 0 0 1 30,0 V362" />
            <rect x="1262" y="360" width="52" height="44" rx="8" fill="#8f6ff0" stroke-width="2.5" style="stroke: var(--ink)" />
            <circle class="keyhole" cx="1288" cy="378" r="5.5" />
            <rect class="keyhole" x="1285.5" y="380" width="5" height="12" rx="2" />
          </g>
          <rect class="tag-bg" x="1345" y="330" width="122" height="28" />
          <text class="tag" x="1356" y="351">ENCRYPT</text>
          <text class="desc" x="1358" y="380">End-to-end</text>
          <text class="desc" x="1358" y="403">encryption</text>
        </g>
      </g>

      <!-- ============================================== CDC diffs -->
      <g class="reveal" style="--d: 1s">
        <g
          class="node"
          :class="{ hot: isNodeHot('cdc'), linked: !!links.cdc }"
          v-bind="linkAttrs('cdc')"
          @mouseenter="hover = 'cdc'"
          @mouseleave="hover = null"
          @click="openLink('cdc')"
          @keydown.enter.prevent="openLink('cdc')"
        >
          <rect class="frame solid thin-frame" x="624" y="454" width="352" height="56" rx="2" />
          <text class="cdc" x="642" y="476">WRITE / APPEND / READ / SEARCH</text>
          <rect x="692" y="484" width="203" height="21" rx="2" style="fill: var(--hl)" />
          <g clip-path="url(#mn-cdc-hl)">
            <rect class="sheen" x="614" y="484" width="70" height="21" fill="url(#mn-sheen)" />
          </g>
          <text class="cdc" x="642" y="499">OVER <tspan font-weight="700" style="fill: var(--hl-text)">EFFICIENT CDC DIFFS</tspan></text>
        </g>
      </g>

      <!-- ============================================== Monad -->
      <g class="reveal" style="--d: 1.15s">
        <g
          class="node box3d"
          :class="{ hot: isNodeHot('monad'), linked: !!links.monad }"
          v-bind="linkAttrs('monad')"
          @mouseenter="hover = 'monad'"
          @mouseleave="hover = null"
          @click="openLink('monad')"
          @keydown.enter.prevent="openLink('monad')"
        >
          <polygon class="face-top" points="503,548 533,530 1095,530 1065,548" />
          <polygon class="face-side" points="1065,548 1095,530 1095,647 1065,665" />
          <rect class="frame solid" x="503" y="548" width="562" height="117" />
          <g transform="translate(598,607)">
            <circle class="ripple" r="34" />
            <circle class="ripple" r="34" style="animation-delay: 1.3s" />
            <g class="monad-logo">
              <rect x="-30" y="-30" width="60" height="60" rx="16" fill="#9d7ff5" transform="rotate(45)" />
              <rect x="-12" y="-12" width="24" height="24" rx="6" transform="rotate(45)" style="fill: var(--panel)" />
            </g>
          </g>
          <text class="title" x="672" y="593">Monad Blockchain</text>
          <text class="sub is-small" x="673" y="623">Stores diffs and chunks on the fastest</text>
          <text class="sub is-small" x="673" y="646">blockchain, <tspan class="strong">very fast.</tspan></text>
          <g class="blocks">
            <rect v-for="b in 5" :key="b" :x="930 + b * 20" y="648" width="14" height="8" rx="1.5"
                  :style="{ '--bd': `${b * 0.35}s` }" />
          </g>
        </g>
      </g>

      <!-- verifiable on-chain -->
      <g class="reveal" style="--d: 1.25s">
        <rect class="verif-sq" x="1152" y="574" width="28" height="28" rx="5" />
        <text class="label wide" x="1196" y="585">VERIFIABLE</text>
        <text class="label wide" x="1196" y="602">ON-CHAIN</text>
      </g>

      <!-- ============================================== YOUR DATA -->
      <g class="reveal" style="--d: 1.2s">
        <g
          class="node"
          :class="{ hot: isNodeHot('data'), linked: !!links.data }"
          v-bind="linkAttrs('data')"
          @mouseenter="hover = 'data'"
          @mouseleave="hover = null"
          @click="openLink('data')"
          @keydown.enter.prevent="openLink('data')"
        >
          <path class="frame solid offset" d="M333,368 H339 V736 H36 V730" />
          <rect class="frame solid" x="30" y="362" width="303" height="368" />
          <rect class="tag-bg" x="50" y="376" width="158" height="30" />
          <text class="tag" x="60" y="398">YOUR DATA</text>

          <g
            v-for="(item, i) in dataItems"
            :key="item"
            class="list-item"
            :class="{ active: activeData === i }"
          >
            <rect class="row-hl" x="38" :y="dataY[i] - 31" width="287" height="50" rx="8" />
            <g :transform="`translate(81,${dataY[i] - 6})`"><g class="icon">
              <template v-if="i === 0">
                <path class="accent" d="M-10,-14 H4 L11,-7 V14 H-10 Z" />
                <path class="accent thin" d="M4,-14 V-7 H11 M-5,-2 H6 M-5,3 H6 M-5,8 H3" />
              </template>
              <path v-else-if="i === 1" class="accent" d="M-14,-11 H-4 L0,-6 H14 V11 H-14 Z" />
              <template v-else-if="i === 2">
                <ellipse class="accent" cx="0" cy="-9" rx="12" ry="4.5" />
                <path class="accent" d="M-12,-9 V9 A12,4.5 0 0 0 12,9 V-9 M-12,0 A12,4.5 0 0 0 12,0" />
              </template>
              <template v-else-if="i === 3">
                <rect class="accent" x="-14" y="-12" width="28" height="24" rx="2" />
                <circle class="accent thin" cx="5" cy="-4" r="2.8" />
                <path class="accent thin" d="M-12,10 L-4,0 L2,6 L6,2 L12,10" />
              </template>
              <template v-else-if="i === 4">
                <path class="accent" d="M-2,-13 C-10,-15 -15,-8 -13,-3 C-17,0 -16,8 -10,10 C-9,14 -3,15 -2,12 Z" />
                <path class="accent" d="M2,-13 C10,-15 15,-8 13,-3 C17,0 16,8 10,10 C9,14 3,15 2,12 Z" />
                <path class="accent thin" d="M-8,-7 Q-4,-3 -8,1 M8,-7 Q4,-3 8,1 M-9,6 H-5 M9,6 H5" />
              </template>
              <g v-else class="accent">
                <polygon :points="dataCube.top" />
                <polygon :points="dataCube.left" />
                <polygon :points="dataCube.right" />
              </g>
            </g></g>
            <text class="item" x="137" :y="dataY[i]">{{ item }}</text>
          </g>
        </g>

        <g
          class="sync"
          :class="{ hot: isFlowHot('sync'), linked: !!links.sync }"
          v-bind="linkAttrs('sync')"
          @click="openLink('sync')"
          @keydown.enter.prevent="openLink('sync')"
        >
          <!-- the four squares leave gaps between them: one invisible box over squares and
               label, so a click anywhere on the block lands on it -->
          <rect v-if="links.sync" class="hit-area" x="364" y="550" width="58" height="78" />
          <rect v-for="(q, qi) in [[372,558],[396,558],[372,582],[396,582]]" :key="qi"
                :x="q[0]" :y="q[1]" width="18" height="18" rx="4"
                :style="{ '--sd': `${[0, 1, 3, 2][qi] * 0.25}s` }" />
          <text class="label" x="393" y="622" text-anchor="middle">SYNC</text>
        </g>
      </g>

      <!-- ============================================== BUILT FOR -->
      <g class="reveal" style="--d: 1.3s">
        <g
          class="node"
          :class="{ hot: isNodeHot('built'), linked: !!links.built }"
          v-bind="linkAttrs('built')"
          @mouseenter="hover = 'built'"
          @mouseleave="hover = null"
          @click="openLink('built')"
          @keydown.enter.prevent="openLink('built')"
        >
          <path class="frame solid offset" d="M1328,447 H1322 V743 H1566 V737" />
          <rect class="frame solid" x="1328" y="441" width="244" height="296" />
          <rect class="tag-bg" x="1356" y="454" width="152" height="30" />
          <text class="tag" x="1366" y="476">BUILT FOR</text>

          <g
            v-for="(item, i) in builtItems"
            :key="item"
            class="list-item"
            :class="{ active: activeBuilt === i }"
          >
            <rect class="row-hl" x="1337" :y="builtY[i] - 30" width="226" height="48" rx="8" />
            <g :transform="`translate(1380,${builtY[i] - 6})`"><g class="icon">
              <template v-if="i === 0">
                <path class="accent" d="M-10,-14 H4 L11,-7 V14 H-10 Z" />
                <path class="accent thin" d="M4,-14 V-7 H11 M-5,-1 H6 M-5,4 H6 M-5,9 H2" />
              </template>
              <template v-else-if="i === 1">
                <path class="accent" d="M0,-14 L12,-9 V0 C12,8 6,12 0,15 C-6,12 -12,8 -12,0 V-9 Z" />
                <path class="accent" d="M-5,0 L-1,4 L6,-4" />
              </template>
              <path v-else-if="i === 2" class="accent" d="M-9,-8 L-17,0 L-9,8 M9,-8 L17,0 L9,8 M4,-12 L-4,12" />
              <path v-else-if="i === 3" class="accent" stroke-width="3" d="M0,0 C-4,-6 -8,-8 -11,-8 C-15,-8 -18,-4 -18,0 C-18,4 -15,8 -11,8 C-8,8 -4,6 0,0 C4,-6 8,-8 11,-8 C15,-8 18,-4 18,0 C18,4 15,8 11,8 C8,8 4,6 0,0 Z" />
              <g v-else class="accent">
                <polygon :points="hex(0, -7, 7.5)" />
                <polygon :points="hex(-7, 6, 7.5)" />
                <polygon :points="hex(7, 6, 7.5)" />
              </g>
            </g></g>
            <text class="item sans" x="1416" :y="builtY[i]">{{ item }}</text>
          </g>
        </g>
      </g>

      <!-- ============================================== side notes -->
      <g class="reveal" style="--d: 1.35s">
        <text class="note" x="580" y="708">Large chunks <tspan font-weight="700">may</tspan> be offloaded</text>
        <rect x="806" y="715" width="124" height="22" rx="2" style="fill: var(--hl)" />
        <text class="note" x="580" y="731">to off-chain storage to <tspan font-weight="700" style="fill: var(--hl-text)">reduce cost.</tspan></text>
        <text class="note" x="980" y="713">References / Proofs</text>
        <text class="note" x="980" y="736">on-chain</text>
      </g>

      <!-- ============================================== OFF-CHAIN -->
      <g class="reveal" style="--d: 1.45s">
        <g
          class="node box3d"
          :class="{ hot: isNodeHot('offchain'), linked: !!links.offchain }"
          v-bind="linkAttrs('offchain')"
          @mouseenter="hover = 'offchain'"
          @mouseleave="hover = null"
          @click="openLink('offchain')"
          @keydown.enter.prevent="openLink('offchain')"
        >
          <polygon class="face-top" points="365,772 395,757 1265,757 1235,772" />
          <polygon class="face-side face-side--flat" points="1235,772 1265,757 1265,909 1235,924" />
          <rect class="frame solid" x="365" y="772" width="870" height="152" />
          <text class="section" x="387" y="807">OFF-CHAIN STORAGE <tspan class="muted" dx="6">(Any Backend)</tspan></text>
          <rect class="frame dashed inner" x="380" y="826" width="842" height="86" rx="4" />

          <g
            v-for="(s, i) in storages"
            :key="s.key"
            class="storage"
            :class="{ active: activeStore === i }"
          >
            <g :transform="`translate(${s.x},870)`"><g class="logo">
              <g v-if="s.key === 'ipfs'" class="spin-y">
                <polygon :points="ipfsCube.top" fill="#7fe9f2" />
                <polygon :points="ipfsCube.left" fill="#25c4d8" />
                <polygon :points="ipfsCube.right" fill="#138fb0" />
              </g>
              <text v-else-if="s.key === 'filecoin'" class="fil" x="0" y="13" text-anchor="middle">ƒ</text>
              <template v-else-if="s.key === 'walrus'">
                <rect x="-17" y="-17" width="34" height="34" rx="3" fill="#7c5cff" />
                <text class="walrus" x="0" y="9" text-anchor="middle">W</text>
              </template>
              <template v-else-if="s.key === 'arweave'">
                <circle r="17" fill="none" stroke-width="2.2" style="stroke: var(--ink)" />
                <text class="arweave" x="0" y="7" text-anchor="middle">a</text>
              </template>
              <g v-else class="layers">
                <path d="M-15,-7 L0,-14 L15,-7 L0,0 Z" fill="#8f6ff0" />
                <path d="M-15,0 L0,7 L15,0" />
                <path d="M-15,7 L0,14 L15,7" />
              </g>
            </g></g>
            <text class="store-label" :x="s.lx" y="876">{{ s.label }}</text>
          </g>

          <path class="line" d="M982,842 V898" />
          <text class="store-note" x="1004" y="863">Use the storage you need.</text>
          <text class="store-note" x="1004" y="884">Keep costs low. Stay flexible.</text>
        </g>
      </g>

      <!-- ============================================== hand notes -->
      <g class="reveal" style="--d: 1.6s">
        <g transform="translate(26,816) rotate(-17)">
          <text class="hand is-small" x="0" y="0">SMALL DIFFS</text>
          <text class="hand is-small" x="4" y="24">ON-CHAIN.</text>
          <text class="hand is-small" x="8" y="51">BIG FILES OFF-CHAIN.</text>
          <text class="hand is-small" x="12" y="76">LOWER COSTS.</text>
        </g>
        <path class="ink hand-arrow" pathLength="1" d="M260,772 C290,776 306,800 302,832" />
        <path class="ink arrow-head" d="M294,824 L302,834 L310,823" />

        <path class="dust" d="M70,966 C100,958 130,962 168,948" />
        <g v-for="(cb, i) in bottomCubes" :key="i" class="bob" :style="{ '--bd': `${i * 0.35}s` }">
          <polygon :points="cb.top" :style="{ fill: i === 2 ? '#a88cff' : 'url(#mn-dots-light)', stroke: 'var(--ink)' }" stroke-width="2" />
          <polygon :points="cb.left" :style="{ fill: i === 2 ? '#7a58ea' : 'url(#mn-dots-dense)', stroke: 'var(--ink)' }" stroke-width="2" />
          <polygon :points="cb.right" :style="{ fill: i === 2 ? 'url(#mn-dots-dense)' : 'var(--void)', stroke: 'var(--ink)' }" stroke-width="2" />
        </g>

        <g transform="translate(1356,800) rotate(-13)">
          <text class="hand is-small" x="0" y="0">YOUR DATA</text>
          <text class="hand is-small" x="28" y="25">GOES FURTHER.</text>
        </g>
        <path class="ink hand-arrow" pathLength="1" d="M1362,834 C1362,862 1384,884 1414,884" />
        <path class="ink arrow-head" d="M1405,876 L1415,884 L1405,892" />

        <g transform="translate(1510,890)">
          <g class="globe">
            <circle class="globe-halo" r="68" />
            <image :href="globeUrl" x="-68" y="-68" width="136" height="136" />
            <!-- shine only catches the land + ring: masked by the image's own alpha -->
            <g mask="url(#mn-globe-mask)">
              <rect class="globe-sheen" x="-150" y="-80" width="60" height="160" fill="url(#mn-sheen)" />
            </g>
            <circle class="globe-ring" r="64.8" />
          </g>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------ themes */
.mn {
  --bg: #07060c;
  --bg-glow: #1a1333;
  --panel: #0e0c17;
  --void: #0d0b16;
  --face-top: #1b1633;
  --ink: #ece8f7;
  --text-2: #d7d1ec;
  --muted: #b8b0d4;
  --strong: #ffffff;
  --title: #d6cbff;
  --section: #b9a8ff;
  --tag: #5c3fd6;
  --tag-text: #ede8ff;
  --line: #7d6bf0;
  --line-hi: #d4c9ff;
  --line-hot: #cfc4ff;
  --flow-hot: #ffffff;
  --arrow: #a393ff;
  --accent: #a88cff;
  --violet: #8f6ff0;
  --hl: #4b2fc4;
  --hl-text: #ffffff;
  --packet: #f1ecff;
  --packet-hot: #ffffff;
  --packet-halo: #d9ceff;
  --star: #b8a8ff;
  --dots-bg: #13102a;
  --dots-fg: #c9bff3;
  --dense-bg: #1a1530;
  --dense-fg: #b3a4ff;
  --cube-bg: #efeaff;
  --cube-fg: #1a1530;
  --outline: transparent;
  --glow: url(#mn-glow);
}
.mn.theme-light {
  --bg: #f6f4fb;
  --bg-glow: #e4dcff;
  --panel: #ffffff;
  --void: #ffffff;
  --face-top: #ebe5ff;
  --ink: #1d1736;
  --text-2: #3d3658;
  --muted: #6e6790;
  --strong: #140f2b;
  --title: #3b22b3;
  --section: #5a3fd6;
  --tag: #5c3fd6;
  --tag-text: #ffffff;
  --line: #8a77ee;
  --line-hi: #5b45d6;
  --line-hot: #5b3fd6;
  --flow-hot: #3b22b3;
  --arrow: #6f5ae6;
  --accent: #6d4fe0;
  --hl: #ddd2ff;
  --hl-text: #2a1791;
  --packet: #6d4fe0;
  --packet-hot: #3b22b3;
  --packet-halo: #8f6ff0;
  --star: #7c68e8;
  --dots-bg: #efeaff;
  --dots-fg: #8a77ee;
  --dense-bg: #ece6ff;
  --dense-fg: #7c68e8;
  --cube-bg: #ffffff;
  --cube-fg: #7c68e8;
  --outline: #1d1736;
  --glow: url(#mn-glow-tint);
}
.mn.theme-light .raster { filter: url(#mn-outline); }
.outline-flood { flood-color: var(--outline); }
/* lady.png is drawn with black outlines: give her a light edge on dark, like the other figure */
.mn.theme-dark .raster-lady { filter: url(#mn-outline-lady); }
.outline-lady-flood { flood-color: var(--ink); }
.glow-flood { flood-color: #8f6ff0; flood-opacity: 0.55; }

.mn {
  width: 100%;
  max-width: 1600px;
  /* A picture, not copy: clicks and drags on its blocks shouldn't highlight text. */
  -webkit-user-select: none;
  user-select: none;
  background: var(--bg);
  transition: background-color 0.4s;
  border-radius: 16px;
  overflow: hidden;
}
.mn-svg {
  display: block;
  width: 100%;
  height: auto;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ---------------------------------------------------------- typography */
text { fill: var(--ink); }
.tag { font-size: 21px; font-weight: 700; letter-spacing: 2px; fill: var(--tag-text); }
.tag-bg { fill: var(--tag); }
.desc { font-size: 18px; letter-spacing: -0.2px; }
.title { font-size: 30px; font-weight: 700; fill: var(--title); letter-spacing: -0.5px; }
.sub { font-size: 17px; fill: var(--text-2); }
/* .is-small, never .sm: Quasar ships a global responsive-visibility class .sm that sets
   display: none !important at every viewport width except its own "sm" breakpoint. */
.sub.is-small { font-size: 16px; }
.sub .strong { font-weight: 700; fill: var(--strong); }
.label { font-size: 13px; letter-spacing: 2.2px; fill: var(--text-2); }
.label.wide { font-size: 13px; letter-spacing: 2.6px; }
.cdc { font-size: 15px; letter-spacing: 1.5px; fill: var(--text-2); }
.note { font-size: 16px; fill: var(--text-2); }
.item { font-size: 18px; }
.item.sans,
.store-label,
.store-note { font-family: Inter, system-ui, sans-serif; }
.item.sans { font-size: 18px; }
.store-label { font-size: 17px; }
.store-note { font-size: 14px; fill: var(--text-2); }
.section { font-size: 19px; font-weight: 700; letter-spacing: 1.5px; fill: var(--section); }
.section .muted { font-weight: 400; letter-spacing: 0.5px; fill: var(--muted); }
.hand { font-family: 'Architects Daughter', 'Comic Sans MS', cursive; font-size: 22px; letter-spacing: 1.5px; }
.hand.is-small { font-size: 18px; letter-spacing: 1.2px; }
/* Gelasio: Georgia's metric-compatible open counterpart, loaded with the other fonts, for
   systems without Georgia (most Linux) — otherwise the ƒ falls to whatever serif is around. */
.fil { font-family: Georgia, Gelasio, serif; font-style: italic; font-size: 44px; font-weight: 700; fill: #3d9bff; }
.walrus { font-family: Inter, sans-serif; font-weight: 800; font-size: 25px; fill: #fff; }
.arweave { font-family: Inter, sans-serif; font-size: 22px; fill: var(--ink); }

/* -------------------------------------------------------------- shapes */
.frame { fill: var(--panel); stroke: var(--line); stroke-width: 2; transition: stroke 0.3s, filter 0.3s; }
.frame.dashed { stroke-width: 1.5; stroke-dasharray: 2 5; stroke-linecap: round; }
.frame.inner { fill: none; stroke-width: 1.3; }
.frame.thin-frame { stroke-width: 1.6; }
.frame.offset { fill: none; }
.face-top { fill: var(--face-top); stroke: var(--line); stroke-width: 2; stroke-linejoin: round; }
.face-side { fill: url(#mn-face-a); stroke: var(--line); stroke-width: 2; stroke-linejoin: round; }
.face-side--flat { fill: url(#mn-face-b); } /* off-chain box: shallower top edge (slope 0.5) */

.ink, .ink-box { stroke: var(--ink); stroke-width: 2.4; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.ink-box { fill: var(--void); }
.ink.thin { stroke-width: 1.8; }
.accent { stroke: var(--accent); stroke-width: 2.4; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.accent.thin { stroke-width: 1.8; }
.purple-box { fill: var(--violet); stroke: var(--ink); stroke-width: 2.2; stroke-linejoin: round; }
.port { fill: var(--void); stroke: var(--arrow); stroke-width: 2.2; }
.verif-sq { fill: #5c3fd6; stroke: var(--arrow); stroke-width: 2; }
.layers path { stroke: var(--accent); stroke-width: 2.2; fill: none; stroke-linejoin: round; }
.layers path:first-child { fill: #8f6ff0; }
.x-mark path { stroke: #9d7ff5; stroke-width: 8; stroke-linecap: round; fill: none; }
.shackle { stroke: var(--ink); stroke-width: 5; fill: none; stroke-linecap: round; }
.keyhole { fill: #fff; }
.dust { stroke: #6d5bd0; stroke-width: 6; stroke-dasharray: 1 7; stroke-linecap: round; fill: none; opacity: 0.6; }

.stars circle { fill: var(--star); opacity: 0.08; }

/* ---------------------------------------------------------- connectors */
.line { stroke: var(--line); stroke-width: 2.2; fill: none; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.3s; }
.dashed-line { stroke-dasharray: 6 6; }
.flow { stroke: var(--line-hi); stroke-width: 2.2; fill: none; stroke-dasharray: 2 14; stroke-linecap: round; opacity: 0; }
.packet { fill: url(#mn-packet); }
.packet.hot { fill: url(#mn-packet-hot); }
.pk-core { stop-color: var(--packet); }
.pk-core-hot { stop-color: var(--packet-hot); }
.pk-halo { stop-color: var(--packet-halo); }

/* ---------------------------------------------------------- hover/hot */
.node { cursor: default; }
.node.hot .frame,
.node.hot .face-top,
.node.hot .face-side { stroke: var(--line-hot); filter: var(--glow); }
.node.hot .frame.dashed { stroke-dasharray: none; }
.hot > .line { stroke: var(--line-hot); filter: var(--glow); }
.hot > .flow { stroke: var(--flow-hot); opacity: 1 !important; animation-duration: 0.45s !important; }
/* dim via fill-opacity, not opacity: packets waiting for their first run sit at the
   SVG origin with opacity="0", and a CSS opacity would override that and reveal them */
.has-hover .packet:not(.hot) { fill-opacity: 0.25; }

.card { transition: transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1); }
.linked { cursor: pointer; }
.linked:focus { outline: none; }
.linked:focus-visible :is(.frame, .face-top, .face-side) { stroke: var(--line-hot); stroke-dasharray: none; filter: var(--glow); }
.sync.linked:focus-visible rect:not(.hit-area) { stroke: var(--strong); filter: var(--glow); }
/* fill must be painted (not none) to catch the pointer; transparent paints nothing visible */
.sync .hit-area { fill: transparent; stroke: none !important; filter: none !important; animation: none; }
.card.hot { transform: translateY(-4px); }

/* ------------------------------------------------------------- lists */
.row-hl { fill: #8f6ff0; opacity: 0; transition: opacity 0.5s; }
.list-item .icon { transform-box: fill-box; transform-origin: center; transition: transform 0.5s cubic-bezier(0.3, 1.6, 0.5, 1), filter 0.5s; }
.list-item text { transition: fill 0.4s; }
.list-item.active .row-hl { opacity: 0.14; }
.list-item.active .icon { transform: scale(1.12); filter: var(--glow); }
.list-item.active text { fill: var(--strong); }

.storage .logo { transform-box: fill-box; transform-origin: center; transition: transform 0.5s cubic-bezier(0.3, 1.6, 0.5, 1), filter 0.5s; }
.storage text { transition: fill 0.4s; }
.storage.active .logo { transform: translateY(-5px) scale(1.12); filter: var(--glow); }
.storage.active .store-label { fill: var(--strong); }
.storage:not(.active) .store-label { fill: var(--text-2); }

/* ============================================================ motion
   Everything waits for .is-live (IntersectionObserver) and pauses with
   .is-paused when scrolled out of view. */
.mn :is(.reveal, .flow, .draw, .person, .screen-glow, .float, .draw-loop,
        .antenna, .eyes, .bubble, .typing-dot, .app-tile, .puzzle-b,
        .sdk-cube, .x-mark, .shackle, .keyhole, .sheen, .ripple, .monad-logo,
        .blocks rect, .verif-sq, .sync rect, .spin-y, .bob, .globe, .globe-sheen,
        .globe-halo, .stars circle, .caret, .hand-arrow, .arrow-head) {
  animation-play-state: paused;
}
.mn.is-live :is(.reveal, .flow, .draw, .person, .screen-glow, .float, .draw-loop,
        .antenna, .eyes, .bubble, .typing-dot, .app-tile, .puzzle-b,
        .sdk-cube, .x-mark, .shackle, .keyhole, .sheen, .ripple, .monad-logo,
        .blocks rect, .verif-sq, .sync rect, .spin-y, .bob, .globe, .globe-sheen,
        .globe-halo, .stars circle, .caret, .hand-arrow, .arrow-head) {
  animation-play-state: running;
}
.mn.is-paused * { animation-play-state: paused !important; }

/* entrance */
.reveal { opacity: 0; animation: mn-rise 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) var(--d, 0s) forwards; }
@keyframes mn-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }

.draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: mn-draw 1s ease-out 0.7s forwards; }
@keyframes mn-draw { to { stroke-dashoffset: 0; } }

.flow { animation: mn-flow 1.1s linear infinite, mn-fade-in 0.8s ease 1.8s forwards; }
@keyframes mn-flow { to { stroke-dashoffset: -16; } }
@keyframes mn-fade-in { to { opacity: 0.75; } }

.caret { fill: var(--accent); animation: mn-blink 0.8s steps(1) infinite; }
@keyframes mn-blink { 50% { opacity: 0; } }

/* users / dapps person (cropped image) */
.person { animation: mn-breathe 4s ease-in-out var(--pd, 0s) infinite; }
@keyframes mn-breathe { 50% { transform: translateY(-3px); } }
.screen-glow { fill: #fff; mix-blend-mode: screen; opacity: 0; animation: mn-screen 2.4s ease-in-out var(--pd, 0s) infinite; }
@keyframes mn-screen { 50% { opacity: 0.22; } }
.float { transform-box: fill-box; animation: mn-float 3.6s ease-in-out var(--fd, 0s) infinite; }
@keyframes mn-float { 50% { transform: translateY(-7px); } }
/* looping hand-drawn arrows: the line draws in over the first 40%, then the head appears */
.draw-loop { stroke-dasharray: 1; animation: mn-dash-loop 3.6s ease-in-out infinite; }
@keyframes mn-dash-loop { 0% { stroke-dashoffset: 1; } 40%, 100% { stroke-dashoffset: 0; } }
.arrow-head { opacity: 0; animation: mn-arrow-head var(--dur, 4s) linear infinite; }
@keyframes mn-arrow-head { 0%, 39% { opacity: 0; } 45%, 100% { opacity: 1; } }

/* robot */
.antenna { fill: #9d7ff5; stroke: var(--ink); stroke-width: 2.2; animation: mn-antenna 1.6s ease-in-out infinite; }
@keyframes mn-antenna { 50% { fill: #fff; filter: var(--glow); } }
.eyes { transform-box: fill-box; transform-origin: center; animation: mn-blink-eyes 4s infinite; }
@keyframes mn-blink-eyes { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
.bubble { transform-box: fill-box; transform-origin: 0% 100%; animation: mn-pop 4s cubic-bezier(0.3, 1.6, 0.5, 1) infinite; }
@keyframes mn-pop { 0% { transform: scale(0); opacity: 0; } 10%, 85% { transform: scale(1); opacity: 1; } 95%, 100% { transform: scale(0); opacity: 0; } }
.typing-dot { fill: var(--ink); transform-box: fill-box; animation: mn-dot 1s ease-in-out var(--td) infinite; }
@keyframes mn-dot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-5px); opacity: 1; } }

/* dapps */
.app-tile { fill: none; stroke: var(--ink); stroke-width: 2.4; animation: mn-tile 1.8s ease-in-out var(--ad) infinite; }
@keyframes mn-tile { 0%, 100% { fill: transparent; } 25%, 45% { fill: #8f6ff0; } }

/* integrations */
.puzzle-b { animation: mn-snap 4s cubic-bezier(0.5, 0, 0.2, 1) infinite; }
@keyframes mn-snap {
  0% { transform: translate(34px, -22px) rotate(14deg); opacity: 0; }
  15% { opacity: 1; }
  40% { transform: translate(0, 0) rotate(0); }
  44% { transform: translate(-2px, 0); }
  48%, 88% { transform: translate(0, 0); opacity: 1; }
  100% { transform: translate(34px, -22px) rotate(14deg); opacity: 0; }
}

/* sdk */
.sdk-cube { transform-box: fill-box; transform-origin: center; animation: mn-cube 4s ease-in-out infinite; }
@keyframes mn-cube { 0%, 100% { transform: translateY(2px); } 50% { transform: translateY(-5px); filter: var(--glow); } }
.x-mark { transform-box: fill-box; transform-origin: center; animation: mn-x 5s cubic-bezier(0.6, 0, 0.2, 1) infinite; }
@keyframes mn-x { 0%, 70% { transform: rotate(0); } 90%, 100% { transform: rotate(180deg); } }
.shackle { animation: mn-shackle 3.2s ease-in-out infinite; }
@keyframes mn-shackle { 0%, 55%, 100% { transform: translateY(0); } 65%, 80% { transform: translateY(-7px); } }
.keyhole { animation: mn-keyhole 3.2s ease-in-out infinite; }
@keyframes mn-keyhole { 0%, 55%, 100% { fill: #fff; } 65%, 80% { fill: #ffe38a; } }

/* cdc */
.sheen { animation: mn-sheen 2.8s ease-in-out infinite; }
@keyframes mn-sheen { 0% { transform: translateX(0); } 60%, 100% { transform: translateX(300px); } }

/* monad */
.ripple { fill: none; stroke: #9d7ff5; stroke-width: 2; opacity: 0; transform-origin: 0 0; animation: mn-ripple 2.6s ease-out infinite; }
@keyframes mn-ripple { 0% { transform: scale(0.9); opacity: 0.8; } 100% { transform: scale(1.8); opacity: 0; } }
.monad-logo { transform-origin: 0 0; animation: mn-monad 6s cubic-bezier(0.6, 0, 0.2, 1) infinite; }
@keyframes mn-monad { 0%, 70% { transform: rotate(0); } 85%, 100% { transform: rotate(90deg); } }
.blocks rect { fill: #8f6ff0; opacity: 0.15; animation: mn-block 2.2s ease-in-out var(--bd) infinite; }
@keyframes mn-block { 0%, 100% { opacity: 0.15; } 30%, 50% { opacity: 0.9; } }
.verif-sq { animation: mn-verif 2s ease-in-out infinite; }
@keyframes mn-verif { 50% { fill: #9d7ff5; filter: var(--glow); } }

/* sync */
.sync rect { fill: none; stroke: var(--ink); stroke-width: 2.2; animation: mn-sync 1s ease-in-out var(--sd) infinite; }
@keyframes mn-sync { 0%, 100% { fill: transparent; } 20%, 40% { fill: #8f6ff0; } }
.sync.hot rect:not(.hit-area) { stroke: var(--strong); filter: var(--glow); }

/* storage */
.spin-y { transform-box: fill-box; transform-origin: center; animation: mn-spin-y 4s ease-in-out infinite; }
@keyframes mn-spin-y { 0%, 60% { transform: rotate(0); } 80%, 100% { transform: rotate(120deg); } }

/* hand-drawn corner bits */
.hand-arrow { stroke-dasharray: 1; animation: mn-dash-loop 4s ease-in-out infinite; }
.bob { animation: mn-bob 3s ease-in-out var(--bd) infinite; }
@keyframes mn-bob { 50% { transform: translateY(-8px); } }
.globe { animation: mn-globe-float 5s ease-in-out infinite; }
@keyframes mn-globe-float { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-6px) rotate(3deg); } }
.globe-ring { fill: none; stroke: var(--ink); stroke-width: 2.6; }
.globe-sheen { opacity: 0.35; animation: mn-globe-sheen 6s ease-in-out infinite; }
@keyframes mn-globe-sheen { 0%, 55% { transform: translateX(0); } 100% { transform: translateX(300px); } }
.globe-halo { fill: none; stroke: #8f6ff0; stroke-width: 2; opacity: 0; transform-origin: 0 0; animation: mn-halo 3.5s ease-out infinite; }
/* peaks at r≈78 so it stays inside the 1600x980 frame (globe centre 1510,890) */
@keyframes mn-halo { 0% { transform: scale(1); opacity: 0.6; } 100% { transform: scale(1.15); opacity: 0; } }

.stars circle { animation: mn-twinkle 5s ease-in-out infinite; }
@keyframes mn-twinkle { 50% { opacity: 0.7; } }

/* reduced motion: show the finished state, keep hover highlighting */
.mn.is-reduced * { animation: none !important; }
.mn.is-reduced .reveal { opacity: 1; }
.mn.is-reduced .draw { stroke-dashoffset: 0; }
.mn.is-reduced .bubble { opacity: 1; }
.mn.is-reduced :is(.draw-loop, .hand-arrow) { stroke-dashoffset: 0; }
.mn.is-reduced .arrow-head { opacity: 1; }
</style>
