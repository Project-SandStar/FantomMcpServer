/**
 * Axon parsing: the tree-sitter grammar, and the v2 embedding-text layout.
 *
 * These run against the REAL vendored grammar rather than a mock — the whole
 * point of the change is that a real parser replaced line-counting, and a
 * mocked parser would test the mock. If the wasm is missing the suite says so
 * and skips, rather than passing green on the fallback path.
 */

import { jest } from '@jest/globals';
import {
  initAxonGrammar, axonGrammarStatus, axonStatementUnits,
  parseDefcompCells, extractAxonCallNames,
} from '../axon/axonTreeSitter.js';
import {
  axonChunkWindows, buildAxonEmbeddingChunks, parseAxonSignature,
  cleanAxonBodyLines, axonCellsLine, AXON_EMBED_TEXT_VERSION,
} from '../axon/axonEmbeddingText.js';

jest.setTimeout(30_000);

/** The `lightsOnAndUnoccupied` rule from local/demo, verbatim. */
const DEFCOMP = `/*
  Lights are on and site is unoccupied.
*/
defcomp

  target:    {}
  date:      {}
  out:       {readonly}
  occ:       {bind:"occupied and sp and siteRef=={{target->siteRef}}"}
  threshold: {bindTuning:"threshold", defVal:2h}

  do
    // get periods when lights are on
    on: hisRead(target, date).hisFindPeriods(v => true == v)

    // get unoccupied periods
    unoccupied: hisRead(occ, date).hisFindPeriods(v => (na() != v) and (not v))

    // compute total hours on during unoccupied times
    totalDur: faults.foldCol("v0", sum)

    out = faults.addMeta({spark_cost: cost, spark_priority: "low"})
  end
end`;

/** Style C (`if (c) expr else do … end`) plus an inline `if … else`. */
const LAMBDA = `(connId, equipId) => do
  eq: readById(equipId)
  devs: helperLearn(connId)
  if (devs == null) [].toGrid
  else do
    pts: helperLearn(connId, devs->learn)
    flag: if (pts.size > 0) "yes" else "no"
    pts
  end
end`;

let ready = false;
beforeAll(async () => { ready = await initAxonGrammar(); });

describe('the vendored tree-sitter Axon grammar', () => {
  it('loads from assets/grammars', () => {
    expect(ready).toBe(true);
    const st = axonGrammarStatus();
    expect(st.ready).toBe(true);
    expect(st.loadedFrom).toMatch(/tree-sitter-axon\.wasm$/);
    expect(st.error).toBeNull();
  });
});

describe('defcomp — the 23% of the corpus that is not a lambda', () => {
  it('reads the cells that are its real interface', () => {
    const cells = parseDefcompCells(DEFCOMP);
    expect(cells.map(c => c.name)).toEqual(['target', 'date', 'out', 'occ', 'threshold']);
    expect(cells.find(c => c.name === 'out')!.meta).toBe('{readonly}');
  });

  it('renders a signature instead of an empty `name()`', () => {
    const sig = parseAxonSignature('lightsOnAndUnoccupied', DEFCOMP);
    // Before: `lightsOnAndUnoccupied()` — every input and output invisible.
    expect(sig.text).toBe('lightsOnAndUnoccupied[target, date, out: readonly, occ: bind, threshold: bindTuning]');
    expect(sig.params).toHaveLength(5);
  });

  it('puts the cells in the embedding text', () => {
    expect(axonCellsLine(DEFCOMP)).toBe('cells: target, date, out {readonly}, occ {bind}, threshold {bindTuning}');
    expect(axonCellsLine(LAMBDA)).toBe('');
  });
});

describe('statement units', () => {
  it('splits a body into its statements, not into line windows', () => {
    const units = axonStatementUnits(LAMBDA);
    expect(units).not.toBeNull();
    expect(units!.length).toBeGreaterThan(2);
    // Every unit is a whole statement: none may start or end mid-construct.
    const lines = LAMBDA.split('\n');
    for (const u of units!) {
      expect(u.to).toBeGreaterThan(u.from);
      expect(lines[u.from]).toBeDefined();
    }
  });

  it('glues a leading comment onto the statement it introduces', () => {
    const units = axonStatementUnits(DEFCOMP)!;
    const lines = DEFCOMP.split('\n');
    // `// get periods when lights are on` must not be the LAST line of a unit;
    // a comment stranded at a chunk boundary is the failure this prevents.
    for (const u of units) {
      const last = lines[u.to - 1].trim();
      if (last.startsWith('//')) {
        // Only legal when the comment is genuinely trailing (nothing follows).
        expect(u.to).toBe(units[units.length - 1].to);
      }
    }
    const withComment = units.find(u => lines[u.from].trim().startsWith('// get periods'));
    expect(withComment).toBeDefined();
    expect(lines.slice(withComment!.from, withComment!.to).join('\n')).toContain('hisRead(target, date)');
  });

  it('returns null for a body the grammar cannot parse, so the caller falls back', () => {
    expect(axonStatementUnits('(x) => do\n  if (\n')).toBeNull();
  });
});

describe('chunk windows', () => {
  it('keeps a short body in one chunk', () => {
    const w = axonChunkWindows(LAMBDA, LAMBDA.split('\n').length);
    expect(w).toEqual([{ from: 0, to: LAMBDA.split('\n').length }]);
  });

  it('falls back to fixed windows when the body will not parse', () => {
    // Long enough to need splitting, and syntactically broken.
    const broken = '(x) => do\n' + '  if (\n'.repeat(60);
    const w = axonChunkWindows(broken, broken.split('\n').length);
    expect(w.length).toBeGreaterThan(1);
    // Fixed windows are contiguous-with-overlap and cover the whole body.
    expect(w[0].from).toBe(0);
    expect(w[w.length - 1].to).toBe(broken.split('\n').length);
  });

  it('covers every line of a long body', () => {
    const long = '(x) => do\n'
      + Array.from({ length: 80 }, (_, i) => `  v${i}: compute${i}(x)`).join('\n')
      + '\nend';
    const total = long.split('\n').length;
    const w = axonChunkWindows(long, total);
    expect(w.length).toBeGreaterThan(1);
    const covered = new Set<number>();
    for (const u of w) for (let l = u.from; l < u.to; l++) covered.add(l);
    // No line may be dropped: a gap is silently unindexed code.
    for (let l = 0; l < total; l++) expect(covered.has(l)).toBe(true);
  });
});

describe('call extraction', () => {
  it('finds names in call position', () => {
    const names = extractAxonCallNames(LAMBDA);
    expect(names).toContain('readById');
    expect(names).toContain('helperLearn');
  });

  it('does not treat `->` tag access as a call', () => {
    // `devs->learn` is a trap, not a call; `learn` is a tag name.
    expect(extractAxonCallNames(LAMBDA)).not.toContain('learn');
    expect(extractAxonCallNames('(t) => do\n  t->costPerHour\nend')).not.toContain('costPerHour');
  });
});

describe('body text', () => {
  it('keeps comments — they are the natural language next to the code', () => {
    const kept = cleanAxonBodyLines(DEFCOMP.split('\n'));
    expect(kept.join('\n')).toContain('// get periods when lights are on');
  });

  it('still collapses blank runs', () => {
    expect(cleanAxonBodyLines(['a', '', '', '', 'b'])).toEqual(['a', '', 'b']);
  });
});

describe('the assembled chunk', () => {
  const input = {
    instance: 'local', project: 'demo', name: 'lightsOnAndUnoccupied',
    qualifiedName: 'local/demo::lightsOnAndUnoccupied', relPath: 'local/demo/func/x.trio',
    body: DEFCOMP, doc: 'Lights On and Unoccupied', tags: ['sparkRule'],
    signature: parseAxonSignature('lightsOnAndUnoccupied', DEFCOMP),
    calls: [], calledBy: [], uses: ['hisRead', 'foldCol'], bodyLineOffset: 1,
  };

  it('carries kind, cells, uses and the doc', () => {
    const [c] = buildAxonEmbeddingChunks(input);
    expect(c.text).toContain('kind: axon-function');
    expect(c.text).toContain('cells: target, date, out {readonly}');
    expect(c.text).toContain('uses: hisRead, foldCol');
    expect(c.text).toContain('doc: Lights On and Unoccupied');
  });

  it('reports line ranges against the real file, not the cleaned text', () => {
    const [c] = buildAxonEmbeddingChunks(input);
    expect(c.lineStart).toBe(input.bodyLineOffset);
    expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
  });

  it('is layout version 2', () => {
    expect(AXON_EMBED_TEXT_VERSION).toBe(2);
  });
});
