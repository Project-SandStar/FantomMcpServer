import { describe, it, expect } from '@jest/globals';
import { __candidateTextForTest } from '../embedding/crossEncoderReranker.js';

const hit = { nodeId: 'a', name: 'checkPongTimeout', qualifiedName: 'w::Sox.checkPongTimeout', nodeType: 'method', filePath: 'f', lineStart: 1,
  semanticScore: 0.5, graphScore: 0, combinedScore: 0.5, signature: 'checkPongTimeout()', chunkText: 'if (Date.now() - lastPong > POLL_MS) reconnect();' } as any;

describe('reranker candidate text', () => {
  it('off (0): name, signature, doc only; same text as before', () => {
    expect(__candidateTextForTest(hit, 0)).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()');
    expect(__candidateTextForTest(hit)).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()');
  });
  it('on: adds the start of the chunk text, cut to codeChars', () => {
    expect(__candidateTextForTest(hit, 20)).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()\nif (Date.now() - las');
  });
  it('on but no text: unchanged', () => {
    expect(__candidateTextForTest({ ...hit, chunkText: undefined }, 1000)).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()');
  });
});

import { chunkBody } from '../embedding/crossEncoderReranker.js';
describe('reranker code modes', () => {
  const stored = 'kind: method\nfile: sox worker | imports: polygon\nw Sox checkPongTimeout\ncheckPongTimeout()\n// check the pong\nimport x from "y";\nif (late) reconnect();';
  const r = { ...hit, chunkText: stored } as any;
  it('chunkBody drops preamble, leading comments and imports', () => {
    expect(chunkBody(r)).toBe('if (late) reconnect();');
  });
  it('body mode sends only the code', () => {
    expect(__candidateTextForTest(r, 1000, 'body')).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()\nif (late) reconnect();');
  });
  it('missing-doc mode skips hits that have a doc comment', () => {
    expect(__candidateTextForTest({ ...r, documentation: 'Checks the pong.' }, 1000, 'missing-doc')).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()\nChecks the pong.');
    expect(__candidateTextForTest(r, 1000, 'missing-doc')).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()\nif (late) reconnect();');
  });
  it('all mode is unchanged', () => {
    expect(__candidateTextForTest(r, 1000, 'all')).toBe('w::Sox.checkPongTimeout\ncheckPongTimeout()\n' + stored);
  });
});
