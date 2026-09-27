import { describe, it, expect } from 'vitest';
import TextWindowChunkingStrategy from '../../lib/search/chunking/TextWindowChunkingStrategy.js';

describe('TextWindowChunkingStrategy', () => {
	it('returns no chunks for empty text', () => {
		expect(new TextWindowChunkingStrategy().chunk('')).toEqual([]);
	});

	it('returns a single chunk when the whole text fits under the size', () => {
		const chunker = new TextWindowChunkingStrategy({ size: 1000, overlap: 100 });
		const text = 'a short piece of text';
		const chunks = chunker.chunk(text);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toEqual({ startOffset: 0, endOffset: text.length, text });
	});

	it('every chunk\'s offsets round-trip back to the exact same text', () => {
		const chunker = new TextWindowChunkingStrategy({ size: 50, overlap: 10 });
		const text = 'word '.repeat(40).trim();
		for (const chunk of chunker.chunk(text)) {
			expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
		}
	});

	it('splits long text into multiple overlapping chunks', () => {
		const chunker = new TextWindowChunkingStrategy({ size: 50, overlap: 10 });
		const text = 'word '.repeat(40).trim(); // ~200 chars
		const chunks = chunker.chunk(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (let i = 1; i < chunks.length; i++) {
			// Each chunk after the first starts before the previous one ends — that's the overlap.
			expect(chunks[i].startOffset).toBeLessThan(chunks[i - 1].endOffset);
		}
	});

	it('covers the whole text with no gaps', () => {
		const chunker = new TextWindowChunkingStrategy({ size: 50, overlap: 10 });
		const text = 'word '.repeat(40).trim();
		const chunks = chunker.chunk(text);
		expect(chunks[chunks.length - 1].endOffset).toBe(text.length);
	});

	it('prefers breaking on a paragraph boundary over a hard mid-word cut', () => {
		const chunker = new TextWindowChunkingStrategy({ size: 60, overlap: 5 });
		const text = 'First paragraph with some words here.\n\nSecond paragraph that continues on with more text after it.';
		const chunks = chunker.chunk(text);
		// The first chunk should end right at (or very near) the paragraph break, not mid-word.
		expect(text.slice(0, chunks[0].endOffset).endsWith('\n\n')).toBe(true);
	});

	it('rejects an overlap that is not smaller than the chunk size', () => {
		expect(() => new TextWindowChunkingStrategy({ size: 100, overlap: 100 })).toThrow();
		expect(() => new TextWindowChunkingStrategy({ size: 100, overlap: 150 })).toThrow();
	});
});
