/**
 * Pins the Axon v2 embed text layout (lazy-incremental-indexing.md 3.12
 * item 5). Any change to the text a function embeds from changes this
 * snapshot: bump AXON_EMBED_TEXT_VERSION with it, so planAxonProject sees
 * every project as changed and re-embeds it.
 */
import { jest } from '@jest/globals';
import { initAxonGrammar } from '../axon/axonTreeSitter.js';
import { buildAxonEmbeddingChunks, parseAxonSignature, AXON_EMBED_TEXT_VERSION } from '../axon/axonEmbeddingText.js';

jest.setTimeout(30_000);

const BODY = `(a, b: 2) => do
  // add them
  x: a + b
  hisRead(x)
end`;

const input = {
  instance: 'local', project: 'demo', name: 'addIt', qualifiedName: 'local/demo::addIt',
  relPath: 'local/demo/func/addIt.axon', body: BODY, doc: 'Adds.', tags: ['sparkRule'],
  signature: parseAxonSignature('addIt', BODY), calls: ['helper'], calledBy: ['caller'], uses: ['hisRead'],
  bodyLineOffset: 3,
};

describe('Axon embed text layout v2', () => {
  it('is version 2 and produces exactly this text', async () => {
    expect(await initAxonGrammar()).toBe(true);
    expect(AXON_EMBED_TEXT_VERSION).toBe(2);
    const chunks = buildAxonEmbeddingChunks(input as any);
    expect(chunks).toMatchSnapshot();
  });
});
