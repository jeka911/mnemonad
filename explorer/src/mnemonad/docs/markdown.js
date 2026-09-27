import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

/**
 * Markdown → safe HTML for docs read from a stream.
 *
 * The stream is whatever id the component was given, so its markdown is untrusted input: raw
 * HTML is turned off in the parser *and* the output goes through DOMPurify, so a hostile
 * stream can't script the page even through a parser edge case.
 *
 * On top of plain rendering this adds what a docs site built from a folder needs:
 *  - heading ids (GitHub-style slugs) and a table of contents,
 *  - `data-src-lines="a-b"` on every block element — the source line range it came from — so
 *    a search hit (character offsets into the source) can be mapped onto the rendered page,
 *  - link rewriting: links to other docs in the stream become in-app routes, links that leave
 *    the stream go to `sourceBaseUrl` (the repo, say), and dead ones become plain text,
 *  - mermaid fences left as placeholders for the component to render lazily.
 */

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** GitHub-style: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text) {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.replace(/\s/g, '-');
}

function inlineText(token) {
	return (token.children || []).map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : '')).join('');
}

// Every block-level opening token carries its source line range ([start, end), 0-based).
const BLOCK_OPEN = new Set([
	'paragraph_open', 'heading_open', 'blockquote_open', 'bullet_list_open', 'ordered_list_open',
	'list_item_open', 'table_open', 'tr_open', 'hr', 'code_block',
]);

md.core.ruler.push('mnemonad_docs', (state) => {
	const env = state.env;
	const used = new Map();
	env.toc = [];
	const tokens = state.tokens;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.map && BLOCK_OPEN.has(token.type)) {
			token.attrSet('data-src-lines', `${token.map[0]}-${token.map[1]}`);
		}
		if (token.type === 'heading_open') {
			const text = inlineText(tokens[i + 1]);
			let slug = slugify(text) || 'section';
			const n = used.get(slug) || 0;
			used.set(slug, n + 1);
			if (n) slug = `${slug}-${n}`;
			token.attrSet('id', slug);
			env.toc.push({ level: Number(token.tag.slice(1)), text, slug, line: token.map ? token.map[0] : 0 });
		}
	}
});

// Fences: mermaid becomes a placeholder, everything else a normal <pre>, both carrying the
// source lines. The code is escaped either way — it's only ever text until mermaid parses it.
md.renderer.rules.fence = (tokens, idx) => {
	const token = tokens[idx];
	const lines = token.map ? ` data-src-lines="${token.map[0]}-${token.map[1]}"` : '';
	const lang = (token.info || '').trim().split(/\s+/)[0];
	const code = md.utils.escapeHtml(token.content);
	if (lang === 'mermaid') {
		return `<div class="docs-mermaid"${lines}><pre class="docs-mermaid__src">${code}</pre></div>\n`;
	}
	const cls = lang ? ` class="language-${md.utils.escapeHtml(lang)}"` : '';
	return `<pre${lines}><code${cls}>${code}</code></pre>\n`;
};

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Joins `rel` onto directory `dir` ('a/b'), resolving `.`/`..`. Returns null if it climbs
 *  above the root — i.e. the target isn't inside the stream at all. */
function joinPath(dir, rel) {
	const parts = dir ? dir.split('/') : [];
	for (const seg of rel.split('/')) {
		if (!seg || seg === '.') continue;
		if (seg === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else {
			parts.push(seg);
		}
	}
	return parts.join('/');
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const href = token.attrGet('href') || '';
	const link = resolveLink(href, env);
	token.attrs = token.attrs.filter(([name]) => name !== 'href');
	if (link.kind === 'doc') {
		token.attrSet('href', link.href);
		token.attrSet('data-doc-route', link.route);
		if (link.hash) token.attrSet('data-doc-hash', link.hash);
	} else if (link.kind === 'anchor') {
		token.attrSet('href', `#${link.hash}`);
		token.attrSet('data-doc-hash', link.hash);
	} else if (link.kind === 'external') {
		token.attrSet('href', link.href);
		token.attrSet('target', '_blank');
		token.attrSet('rel', 'noopener noreferrer');
	} else {
		// Nowhere to go: rendered as an <a> without href, which reads as plain text.
		token.attrSet('class', 'docs-dead-link');
		token.attrSet('title', `${href} isn't part of these docs`);
	}
	return self.renderToken(tokens, idx, options);
};

/**
 * @param {string} href
 * @param {{docPath: string, docRoutes: Map<string, string>, sourceBaseUrl: ?string, routeHref: (route: string, hash: ?string) => string}} env
 */
function resolveLink(href, env) {
	if (!href) return { kind: 'dead' };
	if (href.startsWith('#')) return { kind: 'anchor', hash: decodeURIComponent(href.slice(1)) };
	if (SCHEME.test(href)) {
		// Only web links; `javascript:` and friends are dropped (DOMPurify would too).
		return /^(https?|mailto):/i.test(href) ? { kind: 'external', href } : { kind: 'dead' };
	}

	const [pathPart, hashPart] = href.split('#');
	const hash = hashPart ? decodeURIComponent(hashPart) : null;
	const docDir = env.docPath.includes('/') ? env.docPath.slice(0, env.docPath.lastIndexOf('/')) : '';
	const target = joinPath(docDir, decodeURIComponent(pathPart));

	if (target !== null) {
		const route = env.docRoutes.get(target) ?? env.docRoutes.get(`${target}/README.md`.replace(/^\//, ''));
		if (route !== undefined) return { kind: 'doc', route, hash, href: env.routeHref(route, hash) };
	}
	// Not a doc in this stream (source code, a sibling package, …): resolved against where the
	// docs come from, if that's known. Resolved as a URL relative to the doc's own location so
	// `..` climbs out of the docs folder exactly as it would in the repo.
	if (env.sourceBaseUrl) {
		const base = new URL(docDir ? `${docDir}/` : '', env.sourceBaseUrl);
		return { kind: 'external', href: new URL(href, base).href };
	}
	return { kind: 'dead' };
}

/**
 * @param {string} text - the doc's markdown source
 * @param {Object} ctx
 * @param {string} ctx.docPath - the doc's path in the stream ('encryption/password.md')
 * @param {Map<string, string>} ctx.docRoutes - every doc's path → its route
 * @param {?string} ctx.sourceBaseUrl - where the stream's root lives (see resolveLink)
 * @param {(route: string, hash: ?string) => string} ctx.routeHref - an in-app URL for a route
 * @returns {{html: string, toc: Array<{level: number, text: string, slug: string, line: number}>}}
 */
export function renderMarkdown(text, ctx) {
	const env = { ...ctx };
	const raw = md.render(text, env);
	const html = DOMPurify.sanitize(raw, {
		ADD_ATTR: ['target', 'data-doc-route', 'data-doc-hash', 'data-src-lines'],
	});
	return { html, toc: env.toc };
}

/** 0-based line number of character `offset` in `text`. */
export function lineAt(text, offset) {
	let line = 0;
	const end = Math.min(offset, text.length);
	for (let i = 0; i < end; i++) {
		if (text.charCodeAt(i) === 10) line++;
	}
	return line;
}
