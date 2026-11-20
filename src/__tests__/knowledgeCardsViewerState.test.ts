// @ts-nocheck -- imports a dashboard module outside rootDir (src); types are checked by the dashboard tsc.
/** Dashboard Knowledge Cards viewer: URL state, selection and export (pure module). */
import { describe, it, expect } from '@jest/globals';
import {
  parseViewerUrl, patchViewerUrl, cardRowId, toggleId, togglePage, chunk, cardsToMarkdown,
} from '../../dashboard/src/lib/knowledgeCardsState.js';

const sp = (s: string) => new URLSearchParams(s);

describe('knowledge cards viewer URL state', () => {
  it('parses projectId=all, an id, or nothing', () => {
    expect(parseViewerUrl(sp('projectId=all')).projectId).toBe('all');
    expect(parseViewerUrl(sp('projectId=126')).projectId).toBe(126);
    expect(parseViewerUrl(sp('projectId=x')).projectId).toBeNull();
    expect(parseViewerUrl(sp('')).projectId).toBeNull();
  });

  it('keeps the card deep link and drops bad filter values', () => {
    const s = parseViewerUrl(sp('projectId=126&card=126:abc:qwen/q:free&mark=bogus&sort=newest'));
    expect(s.card).toBe('126:abc:qwen/q:free');
    expect(s.mark).toBe('');
    expect(s.sort).toBe('newest');
  });

  it('patches the query string, dropping empty and default values, keeping other keys', () => {
    expect(patchViewerUrl('projectId=126&card=x', { mark: 'failed' })).toBe('projectId=126&card=x&mark=failed');
    expect(patchViewerUrl('projectId=126&mark=failed&sort=newest', { mark: '', sort: 'fanin', projectId: 'all' })).toBe('projectId=all');
    expect(patchViewerUrl('projectId=1', { card: null })).toBe('projectId=1');
  });

  it('builds row ids with the card project, writer may contain ":"', () => {
    expect(cardRowId(275, 'n1', 'a/b:free')).toBe('275:n1:a/b:free');
  });
});

describe('knowledge cards viewer selection', () => {
  it('toggles one id and a whole page', () => {
    let s = toggleId(new Set(), 'a');
    expect([...s]).toEqual(['a']);
    s = togglePage(s, ['a', 'b']);
    expect([...s].sort()).toEqual(['a', 'b']);
    s = togglePage(s, ['a', 'b']);
    expect([...s]).toEqual([]);
  });

  it('splits large selections into parts of 1000', () => {
    const ids = Array.from({ length: 2500 }, (_, i) => String(i));
    expect(chunk(ids).map(p => p.length)).toEqual([1000, 1000, 500]);
  });

  it('exports markdown with the card body and sources', () => {
    const md = cardsToMarkdown([{
      rowId: '1:n:w', projectId: 1, kind: 'function', qualifiedName: 'a::f', name: 'f', filePath: 'a.fan', lineStart: 1, lineEnd: 9,
      text: 'function a::f\nDoes things.\n- calls b [a.fan:3]', writerModel: 'w', checkerModel: '', builtAt: '2026-11-01', confidence: 0.9,
      checkResult: 'pass', status: 'fresh', mark: 'good', sources: [{ file: 'a.fan', lineStart: 1, lineEnd: 9, hash: 'abcdef0123456789' }],
    }]);
    expect(md).toContain('## a::f');
    expect(md).toContain('Does things.');
    expect(md).toContain('`a.fan:1-9` sha256 abcdef012345');
  });
});
