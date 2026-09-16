<template>
  <section class="mn-hero" :style="sectionStyle">

    <div class="mn-art" aria-hidden="true" :style="artStyle">
      <img class="mn-art-img mn-art-img--dark" :src="resolvedBackground" alt="" />
      <img class="mn-art-img mn-art-img--light" :src="resolvedBackgroundLight" alt="" />
    </div>

    <div class="mn-hero-inner">
      <div class="mn-copy" ref="copyCol">
        <p class="mn-eyebrow" style="user-select: none; position: absolute;"><ScrambleCycler :words="eyebrowWords" :interval-ms="2200" /> {{ eyebrowRest }}</p>

        <h1 style="padding-top: 30px;">
          <span>{{ titleLine1 }}</span>
          <span>{{ titleLine2 }}</span>
          <span class="mn-gradient-text">{{ titleLine3 }}</span>
        </h1>

        <p class="mn-description">{{ description }}</p>

        <div class="mn-actions">
          <GradientButton
            :label="primaryLabel"
            icon-right="arrow_forward"
            size="lg"
            @click="onPrimaryClick"
          />
          <GradientButton
            :label="secondaryLabel"
            icon-right="north_east"
            size="lg"
            outline
            class="mn-btn-secondary-gb"
            @click="onSecondaryClick"
          />
        </div>

        <div class="mn-features">
          <article v-for="feature in features" :key="feature.title" class="mn-feature">
            <span class="mn-feature-icon" aria-hidden="true" v-html="feature.icon"></span>
            <span>{{ feature.title }}</span>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<script>
import defaultBackground from './assets/mnemonad-hero-bg.jpg'
import defaultBackgroundLight from './assets/mnemonad-hero-bg-light.jpg'
import GradientButton from '../GradientButton.vue'
import ScrambleCycler from '../ScrambleCycler.vue'

const ICONS = {
  bolt: '<svg viewBox="0 0 24 24"><path d="M13.5 2 5 13h6l-.5 9L19 11h-6l.5-9Z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  cube: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>'
}

export default {
  name: 'MnemonadHero',

  components: { GradientButton, ScrambleCycler },

  emits: ['network-click', 'wallet-click', 'primary-click', 'secondary-click'],

  props: {
    brand: { type: String, default: 'Mnemonad' },
    brandHref: { type: String, default: '/' },
    backgroundImage: { type: String, default: '' },
    backgroundImageLight: { type: String, default: '' },
    eyebrow: { type: String, default: 'PERSISTENT DATA LAYER FOR THE NEXT INTERNET' },
    /** Demo of ScrambleCycler: rotates in place of `eyebrow`'s first word, the rest of
     * `eyebrow` renders as static text after it. Swap this out (or drop back to plain
     * `eyebrow` text) once past the demo stage. */
    eyebrowWords: {
      type: Array,
      default: () => ['PERSISTENT', 'PERMISSIONLESS', 'PROGRAMMABLE', 'VERIFIABLE', 'PORTABLE', 'ENCRYPTABLE', 'DECENTRALIZED', 'EFFICIENT', 'SCALABLE', 'COMPOSABLE'],
    },
    titleLine1: { type: String, default: 'Your data.' },
    titleLine2: { type: String, default: 'On Monad.' },
    titleLine3: { type: String, default: 'For what’s next.' },
    description: {
      type: String,
      default:
        'Mnemonad is a storage layer for Monad, giving users and AI agents persistent storage for arbitrary binary data, filesystems, and filesystem-like state — with flexible, optimized decentralized storage options, encryption, and a simple developer experience.'
    },
    primaryLabel: { type: String, default: 'Launch dApp' },
    primaryHref: { type: String, default: '/select' },
    secondaryLabel: { type: String, default: 'Explore' },
    secondaryHref: { type: String, default: '#explorer' },
    networkLabel: { type: String, default: 'Monad Testnet' },
    walletLabel: { type: String, default: 'Connect Wallet' },
    navItems: {
      type: Array,
      default: () => [
        { label: 'Home', href: '#', active: true },
        { label: 'Explorer', href: '#explorer' },
        { label: 'Docs', href: '#docs' },
        { label: 'SDK', href: '#sdk' },
        { label: 'Blog', href: '#blog' }
      ]
    },
    features: {
      type: Array,
      default: () => [
        { title: 'Ready for users and AI', icon: ICONS.bolt },
        { title: 'Encryption by design', icon: ICONS.lock },
        { title: 'Efficient CDC diff sync', icon: ICONS.cube },
        { title: 'Developer friendly SDK', icon: ICONS.file }
      ]
    }
  },

  data() {
    return {
      // Left edge of the art panel, in px relative to the section — null until measured
      // (or below the breakpoint where CSS takes over entirely, see measureArtLeft()), so
      // artStyle() falls back to the plain CSS-positioned default with no inline override.
      artLeftPx: null
    }
  },

  computed: {
    resolvedBackground() {
      return this.backgroundImage || defaultBackground
    },
    resolvedBackgroundLight() {
      return this.backgroundImageLight || defaultBackgroundLight
    },
    // Everything in `eyebrow` after its first word — kept derived from the prop (rather
    // than a second hardcoded string) so a caller overriding `eyebrow` still gets a
    // sensible suffix instead of the demo's own default text.
    eyebrowRest() {
      return this.eyebrow.split(' ').slice(1).join(' ')
    },
    sectionStyle() {
      return { '--mn-min-height': this.minHeight }
    },
    // Pins the art panel's left edge to exactly where the copy column ends, so it takes
    // up exactly the remaining width to the right edge — rather than the CSS default's
    // fixed min(820px, 70vw) guess, which doesn't track that column's actual rendered
    // width across fonts/viewports. Measuring the copy column itself (not just the
    // headline) matters: the headline is often narrower than the column — the
    // description, or the other h1 lines, can reach further right than it does — so
    // anchoring to the headline alone left the art panel overlapping whichever of those
    // was actually widest. `right` stays the CSS default (0), so left+right together let
    // the browser compute the exact width.
    artStyle() {
      return this.artLeftPx != null ? { left: this.artLeftPx + 'px', width: 'auto' } : {}
    }
  },

  mounted() {
    this._onResize = () => this.measureArtLeft()
    window.addEventListener('resize', this._onResize)
    // Measured once after this render settles, and again once webfonts finish loading —
    // a measurement taken against a fallback font would freeze the art panel's left edge
    // at that font's (usually different) text width instead of the real one.
    this.$nextTick(() => this.measureArtLeft())
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.measureArtLeft())
    }
  },

  beforeUnmount() {
    window.removeEventListener('resize', this._onResize)
  },

  methods: {
    // Below the breakpoint where the art panel's CSS switches to its mobile layout
    // (repositioned near the bottom, then hidden entirely — see the max-width: 820px
    // rule), this measurement has nothing meaningful to say — resets to null so
    // artStyle() stops overriding left/width and CSS fully takes over. Above that, this
    // is the ONLY thing that positions the art panel's left edge (the CSS default is
    // just a pre-measurement fallback) — a fixed vw-based breakpoint here previously
    // caused it to overlap the copy column at some widths, since neither side's box
    // model accounted for the other's actual size.
    measureArtLeft() {
      if (window.innerWidth <= 820 || !this.$refs.copyCol) {
        this.artLeftPx = null
        return
      }
      const copyRect = this.$refs.copyCol.getBoundingClientRect()
      const heroRect = this.$el.getBoundingClientRect()
      this.artLeftPx = Math.round(copyRect.right - heroRect.left)
    },
    // GradientButton is a plain <button> (no href), unlike the <a> tags these replaced —
    // emit the same events as before (back-compat for anyone already listening) and
    // navigate manually so primaryHref/secondaryHref keep doing something.
    onPrimaryClick(event) {
      this.$emit('primary-click', event)
      this._navigate(this.primaryHref)
    },
    onSecondaryClick(event) {
      this.$emit('secondary-click', event)
      this._navigate(this.secondaryHref)
    },
    // primaryHref/secondaryHref now point at real in-app routes by default (e.g.
    // `/select`), not just the placeholder `#anchor`s this shipped with originally — a
    // plain `window.location.href` assignment would still "work" for those but forces a
    // full page reload, throwing away SPA state (the connected wallet included). Anything
    // starting with `/` goes through the router instead; anything else (an external URL,
    // a bare hash) falls back to a real navigation, same as before.
    _navigate(href) {
      if (!href) return
      if (href.startsWith('/')) this.$router.push(href)
      else window.location.href = href
    }
  }
}
</script>

<style scoped>
.mn-hero {
  --mn-bg: #03030a;
  --mn-text: #f6f4ff;
  --mn-muted: #b9b7ca;
  --mn-line: rgba(145, 125, 255, 0.26);
  --mn-purple: #8d6bff;
  --mn-pink: #d665ff;
  --mn-cyan: #73e3ff;
  /* Shared by .mn-hero-inner's padding-top and .mn-art's top below, so the art panel
     starts at exactly the same Y as the eyebrow line above it ("PERMISSIONLESS DATA
     LAYER...") — one value instead of two that would otherwise have to be kept in sync
     by hand. */
  --mn-copy-top: clamp(40px, 6vh, 100px);

  position: relative;
  min-height: var(--mn-min-height);
  overflow: hidden;
  isolation: isolate;
  color: var(--mn-text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

/* Light mode overrides just this one custom property — everything below that reads
   color from `.mn-hero`'s own inherited `color` (the h1 spans) picks it up for free.
   Kept as body.body--light rather than a JS $q.dark computed for the same reason as the
   art image swap above: matches GradientButton / GradientPanel / BlockNumber / AppFooter. */
body.body--light .mn-hero {
  --mn-text: #2a2440;
  --mn-muted: #5b5570;
}

.mn-nav {
  position: relative;
  z-index: 10;
  width: min(1480px, calc(100% - 56px));
  height: 94px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 28px;
}

.mn-brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  width: max-content;
  color: #eeeaff;
  text-decoration: none;
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.03em;
}

.mn-brand-mark {
  position: relative;
  width: 34px;
  height: 30px;
  display: inline-flex;
  gap: 4px;
  transform: skewY(-9deg);
  filter: drop-shadow(0 0 12px rgba(135, 99, 255, 0.5));
}

.mn-brand-mark span {
  flex: 1;
  border-radius: 3px;
  background: linear-gradient(145deg, #7d9cff 0%, #8e65ff 56%, #d16aff 100%);
  clip-path: polygon(0 11%, 100% 0, 100% 89%, 0 100%);
}

.mn-nav-links {
  display: flex;
  align-items: center;
  gap: 36px;
}

.mn-nav-links a {
  position: relative;
  color: #c8c6d8;
  text-decoration: none;
  font-size: 14px;
  line-height: 1;
  transition: color 180ms ease;
}

.mn-nav-links a:hover,
.mn-nav-links a.active { color: #fff; }

.mn-nav-links a.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -13px;
  height: 2px;
  border-radius: 999px;
  background: linear-gradient(90deg, #8671ff, #d55dff);
  box-shadow: 0 0 13px rgba(149, 102, 255, 0.7);
}

.mn-nav-actions {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 14px;
}

.mn-network,
.mn-wallet {
  height: 50px;
  border-radius: 15px;
  border: 1px solid rgba(131, 107, 255, 0.28);
  color: #f2eeff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
}

.mn-network:hover,
.mn-wallet:hover { transform: translateY(-1px); }

.mn-network {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 0 15px;
  background: rgba(8, 8, 21, 0.72);
  backdrop-filter: blur(12px);
}

.mn-network svg {
  width: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}

.mn-network-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #38e592;
  box-shadow: 0 0 12px rgba(56, 229, 146, 0.85);
}

.mn-wallet {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0 19px;
  font-weight: 650;
  background: linear-gradient(100deg, #5549ef 0%, #7a46ff 54%, #b836e8 100%);
  box-shadow: 0 9px 32px rgba(105, 62, 241, 0.24), inset 0 1px rgba(255,255,255,.16);
}

.mn-wallet svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mn-art {
  position: absolute;
  z-index: -2;
  top: var(--mn-copy-top);
  right: 0px;
  width: min(820px, 70vw);
  height: calc(100% - var(--mn-copy-top));
  pointer-events: none;
}

.mn-art-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: top right;
  /* No filter here — even a subtle contrast/saturate push shifts the image's own
     background pixels (recolored to match the page background exactly, see
     assets/mnemonad-hero-bg*.jpg) away from that match, which reads as a faint edge. */
  transform: scale(1.03);
}

/* Light/dark switched purely via body.body--light (not a JS $q.dark computed) — a
   production build can end up with two Quasar instances (themed_varmory ships its own),
   desyncing $q.dark.isActive from the class actually written to <body>. Keying off the
   class here matches GradientButton / GradientPanel / BlockNumber / AppFooter. Both
   images stay in the DOM (no v-if) so the swap is instant, no re-fetch on toggle. */
.mn-art-img--light {
  display: none;
}

body.body--light .mn-art-img--dark {
  display: none;
}

body.body--light .mn-art-img--light {
  display: block;
}

.mn-hero-inner {
  position: relative;
  z-index: 3;
  width: min(1480px, calc(100% - 56px));
  padding-top: var(--mn-copy-top);
  padding-bottom: 94px;
}

.mn-copy {
  width: min(620px, 35vw);
  /* Makes this the containing block for .mn-eyebrow's `width: 100%` below — without it,
     that absolutely positioned line's containing block is a wider ancestor further up,
     and its text (with no width to wrap against) can overflow straight past this column
     into the art panel beside it at some viewport widths. */
  position: relative;
}

.mn-eyebrow {
  width: 100%;
  margin: 0 0 24px;
  color: #9c8aff;
  font-size: 12px;
  line-height: 1.5;
  font-weight: 700;
  letter-spacing: 0.3em;
  /* The whole line, not just the ScrambleCycler word in it — same var(--font-mono) the
     component itself now defaults to, so the two stay in the same font on purpose rather
     than by coincidence of whatever this line otherwise inherits. */
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
}

body.body--light .mn-eyebrow {
  color: var(--q-primary);
}

.mn-copy h1 {
  margin: 0;
  display: flex;
  flex-direction: column;
  font-size: clamp(38px, 4.5vw, 58px);
  line-height: 0.98;
  letter-spacing: -0.055em;
  font-weight: 780;
}

.mn-gradient-text {
  width: max-content;
  max-width: 100%;
  padding-right: .08em;
  background: linear-gradient(96deg, #efc6ff 0%, #c982ff 45%, #8c6cff 100%);
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

/* The dark-mode gradient is pale pastel by design (it needs to pop off a near-black
   background) — unreadable at that same lightness against a light page, so this swaps in
   a darker gradient built from the same brand purples rather than just dimming it. */
body.body--light .mn-gradient-text {
  background: linear-gradient(96deg, #6b3fd6 0%, #7749ff 45%, #4a2f9e 100%);
  background-clip: text;
  -webkit-background-clip: text;
}

.mn-description {
  width: min(580px, 100%);
  margin: 28px 0 0;
  color: #c0bdce;
  font-size: clamp(17px, 1.3vw, 20px);
  line-height: 1.55;
  letter-spacing: -0.015em;
}

body.body--light .mn-description {
  color: var(--mn-muted);
}

.mn-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 34px;
}

/* GradientButton's own icon size (1.715em) is fine at its default use elsewhere, but
   reads oversized next to these two CTAs' short labels — scoped to just this section
   rather than changing the shared component's default for every other call site. */
.mn-actions :deep(.gradient-btn__icon) {
  font-size: 0.8575em;
}

.mn-features {
  display: grid;
  grid-template-columns: repeat(4, max-content);
  gap: 25px;
  margin-top: 50px;
}

.mn-feature {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #bcb8d4;
  font-size: 12px;
  line-height: 1.35;
  max-width: 128px;
}

body.body--light .mn-feature {
  color: var(--mn-muted);
}

.mn-feature-icon {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: #8d76ff;
}

body.body--light .mn-feature-icon {
  color: var(--q-primary);
}

.mn-feature-icon :deep(svg) {
  width: 25px;
  height: 25px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (max-width: 1180px) {
  .mn-nav { grid-template-columns: 1fr auto; }
  .mn-nav-links { display: none; }
  .mn-copy { width: min(610px, 54vw); }
  /* No .mn-art override here anymore — its left edge (and therefore its width, via the
     base rule's right: 0) is measured in JS from the actual end of the headline text
     down to the 820px breakpoint below, so it can never overlap .mn-copy regardless of
     how wide that column is at a given viewport width. See measureArtLeft(). */
  .mn-features { grid-template-columns: repeat(2, max-content); }
}

@media (max-width: 820px) {
  .mn-hero {  }
  .mn-nav { width: calc(100% - 32px); height: 78px; }
  .mn-network { display: none; }
  .mn-wallet { height: 44px; padding: 0 14px; }
  .mn-brand { font-size: 19px; }
  .mn-brand-mark { width: 29px; height: 26px; }

  .mn-hero-inner {
    width: calc(100% - 40px);
    padding-top: 68px;
  }

  .mn-copy { width: min(620px, 100%); }
  .mn-copy h1 { font-size: clamp(48px, 13vw, 72px); }
  .mn-description { font-size: 16px; max-width: 560px; }
  .mn-actions { flex-wrap: wrap; }
  .mn-features { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 16px; }
  .mn-feature { max-width: 170px; }

  .mn-art {
    top: auto;
    right: -34%;
    bottom: 12px;
    width: 142%;
    height: 520px;
    opacity: .93;
    display: none;
  }
}

@media (max-width: 520px) {
  .mn-nav-actions { gap: 8px; }
  .mn-wallet span { display: none; }
  .mn-wallet { width: 44px; padding: 0; justify-content: center; }
  .mn-eyebrow { font-size: 10px; letter-spacing: .22em; }
  .mn-copy h1 { font-size: clamp(43px, 14vw, 64px); }
  .mn-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .mn-features { margin-top: 38px; }
  .mn-art { right: -55%; width: 175%; height: 450px; }
}
</style>
