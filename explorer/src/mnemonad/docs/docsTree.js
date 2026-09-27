import { isFolderEntry } from '../search/folderSearch.js';

/**
 * Turns a restored stream folder into a docs site's structure: which markdown files exist,
 * what each is called, and how they nest.
 *
 * Conventions, all derived from the files themselves (no config file to keep in step):
 *  - A doc's title is its first `# heading`, falling back to its filename.
 *  - A folder's `README.md` is that folder's own page (the root one is the landing page) and
 *    isn't listed separately.
 *  - A doc's route is its path without `.md`; a README's is its folder's path.
 *  - Within a folder: docs by title, then subfolders by title.
 */

/** @typedef {{kind: 'doc', path: string, route: string, title: string, summary: string}} DocNode */
/** @typedef {{kind: 'folder', path: string, route: ?string, title: string, summary: string, children: Array<DocNode|FolderNode>}} FolderNode */

const decoder = new TextDecoder('utf-8', { fatal: false });

function humanize(name) {
	const base = name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
	return base.charAt(0).toUpperCase() + base.slice(1);
}

/** First `# heading`, skipping fenced code (a `#` comment inside a code block isn't a title). */
export function titleOf(text) {
	let inFence = false;
	for (const line of text.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence) continue;
		const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
		if (m) return stripMarkdown(m[1]);
	}
	return null;
}

/**
 * Every ATX heading with its 0-based source line, skipping fenced code — cheap enough to run
 * per search hit, which is what it's for (naming the section a hit falls in without rendering
 * the doc). Slugs come from the renderer, not from here.
 * @returns {Array<{level: number, text: string, line: number}>}
 */
export function headingsOf(text) {
	const out = [];
	let inFence = false;
	text.split('\n').forEach((line, i) => {
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
		if (inFence) return;
		const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (m) out.push({ level: m[1].length, text: stripMarkdown(m[2]), line: i });
	});
	return out;
}

/** First prose paragraph's first sentence, stripped of markdown — a card's one-line subtitle. */
export function summaryOf(text) {
	let inFence = false;
	const paragraph = [];
	for (const line of text.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
		if (inFence) continue;
		if (/^\s*(#|[-*+] |\d+\. |>|\||<)/.test(line) || !line.trim()) {
			if (paragraph.length) break;
			continue;
		}
		paragraph.push(line.trim());
	}
	const plain = stripMarkdown(paragraph.join(' '));
	const sentence = plain.match(/^(.+?[.!?])(\s|$)/);
	return (sentence ? sentence[1] : plain).slice(0, 160);
}

/** Inline markdown syntax removed, for showing source text as plain prose. */
export function stripMarkdown(text) {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		// Emphasis as CommonMark reads it: `*`/`**` anywhere, but `_`/`__` only at word edges —
		// an underscore inside a word is a literal (search_index.db must not lose its `_`).
		.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
		.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
		.replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1$2')
		.replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1$2')
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** @returns {string} the route for a doc at `path` ('a/b.md' → 'a/b', 'a/README.md' → 'a'). */
export function routeOfPath(path) {
	const noExt = path.replace(/\.md$/i, '');
	if (/(^|\/)readme$/i.test(noExt)) return noExt.replace(/\/?readme$/i, '');
	return noExt;
}

/**
 * @param {any} root - a restored stream folder
 * @returns {Promise<{tree: FolderNode, docs: Map<string, {path: string, route: string, title: string, text: string}>}>}
 *   `docs` is keyed by file path, and includes READMEs.
 */
export async function buildDocsTree(root) {
	const docs = new Map();

	async function walk(folder, prefix, name) {
		const node = {
			kind: 'folder',
			path: prefix,
			route: null,
			title: humanize(name),
			summary: '',
			children: [],
		};
		const docNodes = [];
		const folderNodes = [];
		for (const entry of await folder.list()) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (isFolderEntry(entry)) {
				const child = await walk(entry, path, entry.name);
				if (child.children.length || child.route !== null) folderNodes.push(child);
				continue;
			}
			if (!/\.md$/i.test(entry.name)) continue;
			const text = decoder.decode(await entry.getContent());
			const doc = {
				path,
				route: routeOfPath(path),
				title: titleOf(text) || humanize(entry.name),
				text,
			};
			docs.set(path, doc);
			if (/^readme\.md$/i.test(entry.name)) {
				node.route = doc.route;
				node.title = prefix ? doc.title : node.title;
				node.summary = summaryOf(text);
			} else {
				docNodes.push({ kind: 'doc', path, route: doc.route, title: doc.title, summary: summaryOf(text) });
			}
		}
		const byTitle = (a, b) => a.title.localeCompare(b.title);
		node.children = [...docNodes.sort(byTitle), ...folderNodes.sort(byTitle)];
		if (!node.summary) node.summary = `${node.children.length} ${node.children.length === 1 ? 'page' : 'pages'}`;
		return node;
	}

	const tree = await walk(root, '', 'Docs');
	return { tree, docs };
}

/** @returns {?{path: string, route: string, title: string, text: string}} the doc for `route`. */
export function docForRoute(docs, route) {
	for (const doc of docs.values()) {
		if (doc.route === route) return doc;
	}
	return null;
}
