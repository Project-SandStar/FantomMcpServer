import {
  catalogueFor, optionLabel, modelHint, findModel, pinFor, fmtContext,
  EMBEDDING_CATALOGUE, RERANK_CATALOGUE, CHAT_CATALOGUE, ROLE_LOCAL,
  DEFAULT_CODE_ASSISTANT_MODEL,
} from '../sidecars/openRouterModels.js';

describe('dropdown options', () => {
  it('formats as "<Label> · <dims>d" with drop-in and text-only qualifiers', () => {
    const labels = catalogueFor('embedding').map(m => optionLabel('embedding', m));
    // The text role's table is 1024d, so nothing on offer is a drop-in for it.
    expect(labels).toEqual([
      'Qwen3 Embedding 4B · 2560d',
      'Qwen3 Embedding 8B · 4096d',
      'OpenAI text-embedding-3-small · 1536d · text-only',
      'OpenAI text-embedding-3-large · 3072d · text-only',
      'Google Gemini Embedding 001 · 3072d · text-only',
    ]);
  });

  it('marks the width-exact model as a drop-in for the code role', () => {
    const four = EMBEDDING_CATALOGUE.find(m => m.id === 'qwen/qwen3-embedding-4b')!;
    expect(optionLabel('code-embedding', four)).toBe('Qwen3 Embedding 4B · 2560d · drop-in');
  });

  it('never renders the pinned provider', () => {
    // Checked per model rather than against a blocklist: some vendor names
    // legitimately appear in a model's own label ("OpenAI text-embedding-3-
    // small"), and what must not leak is the PIN — the upstream chosen for
    // that model, which is an implementation detail of the gate.
    for (const role of ['code-embedding', 'embedding', 'reranker'] as const) {
      for (const m of catalogueFor(role)) {
        const rendered = optionLabel(role, m);
        if (!m.pinProvider) continue;
        if (m.label.toLowerCase().includes(m.pinProvider.toLowerCase())) continue;
        expect(rendered.toLowerCase()).not.toContain(m.pinProvider.toLowerCase());
      }
    }
    // The pin still EXISTS — it is hidden, not removed. The compatibility gate
    // needs it, because two upstreams serving one slug can return different
    // vectors.
    expect(pinFor('qwen/qwen3-embedding-4b')).toBeTruthy();
  });
});

describe('the code dropdown filters to code-capable models', () => {
  it('offers only the Qwen embedders', () => {
    expect(catalogueFor('code-embedding').map(m => m.id)).toEqual([
      'qwen/qwen3-embedding-4b',
      'qwen/qwen3-embedding-8b',
    ]);
  });

  it('offers exactly one reranker, and it is not Voyage', () => {
    expect(RERANK_CATALOGUE).toHaveLength(1);
    expect(RERANK_CATALOGUE[0].id).toBe('qwen/qwen3-reranker-8b');
    expect(JSON.stringify(RERANK_CATALOGUE).toLowerCase()).not.toContain('voyage');
  });
});

describe('the hint states the re-index consequence', () => {
  it('says "no re-index" when a width-exact model exists', () => {
    expect(modelHint('code-embedding')).toBe(
      'Local: qwen3-embedding:4b (2560d). The 4B below matches that width exactly — no re-index.',
    );
  });

  it('says a full re-index is needed when nothing matches the width', () => {
    expect(modelHint('embedding')).toBe(
      'Local: qwen3-embedding:0.6b (1024d). No hosted model matches that width — switching means a full re-index.',
    );
  });

  it('tells the truth about rerank being stateless', () => {
    expect(modelHint('reranker')).toMatch(/never requires a re-index/);
  });

  it('every role has a local counterpart to compare against', () => {
    for (const role of ['code-embedding', 'embedding', 'reranker'] as const) {
      expect(ROLE_LOCAL[role].model).toBeTruthy();
      expect(modelHint(role)).toContain(ROLE_LOCAL[role].model);
    }
  });
});

describe('catalogue integrity', () => {
  it('gives every embedding model a measured width — a wrong one can destroy a table', () => {
    for (const m of EMBEDDING_CATALOGUE) {
      expect(typeof m.dims).toBe('number');
      expect(m.dims).toBeGreaterThan(0);
    }
  });

  it('resolves models by id across both catalogues', () => {
    expect(findModel('qwen/qwen3-embedding-4b')?.dims).toBe(2560);
    expect(findModel('qwen/qwen3-reranker-8b')?.label).toBe('Qwen3 Reranker 8B');
    expect(findModel('nope/nothing')).toBeUndefined();
  });
});


describe('the code-assistant role', () => {
  it('surfaces context and the reasoning flag the way embedders surface dims', () => {
    const labels = catalogueFor('code-assistant').map(m => optionLabel('code-assistant', m));
    expect(labels).toContain('Laguna S 2.1 · 1.05M ctx · tools + reasoning');
    expect(labels).toContain('Qwen3 Coder · 262K ctx · tools only');
  });

  it('marks every tools-without-reasoning model as "tools only"', () => {
    // Each of these reports tools:true, reasoning:false upstream, and
    // askCodebase is a multi-round plan/gather/synthesise loop — so this is
    // the flag that decides whether a choice quietly degrades it.
    for (const id of ['qwen/qwen3-coder', 'qwen/qwen3-coder-plus', 'mistralai/devstral-2512']) {
      const m = findModel(id)!;
      expect(m.tools).toBe(true);
      expect(m.reasoning).toBe(false);
      expect(optionLabel('code-assistant', m)).toContain('tools only');
    }
  });

  it('defaults to a long-context reasoning model, not the code-specialised one', () => {
    // Fantom and Axon are in no model's training data, so code specialisation
    // buys little and long context buys a lot.
    expect(DEFAULT_CODE_ASSISTANT_MODEL).toBe('poolside/laguna-s-2.1');
    const d = findModel(DEFAULT_CODE_ASSISTANT_MODEL)!;
    expect(d.reasoning).toBe(true);
    expect(d.contextTokens).toBeGreaterThan(findModel('qwen/qwen3-coder')!.contextTokens);
  });

  it('still offers the explicitly requested model', () => {
    expect(catalogueFor('code-assistant').map(m => m.id)).toContain('qwen/qwen3-coder');
  });

  it('every chat model can call tools — askCodebase needs that unconditionally', () => {
    for (const m of CHAT_CATALOGUE) expect(m.tools).toBe(true);
  });

  it('warns about the multi-round gather loop in the hint', () => {
    const hint = modelHint('code-assistant');
    expect(hint).toMatch(/tools only/);
    expect(hint).toMatch(/reasoning/);
  });

  it('renders no provider name, like every other picker', () => {
    const all = catalogueFor('code-assistant').map(m => optionLabel('code-assistant', m)).join(' | ');
    for (const name of ['DeepInfra', 'Fireworks', 'Poolside', 'pinned']) {
      expect(all).not.toContain(name);
    }
  });

  it('formats context the way the live catalogue reports it', () => {
    expect(fmtContext(1_050_000)).toBe('1.05M');
    expect(fmtContext(1_000_000)).toBe('1M');
    expect(fmtContext(262_000)).toBe('262K');
    expect(fmtContext(400_000)).toBe('400K');
  });

  it('keeps chat models out of the embedding and rerank pickers', () => {
    // qwen3-coder is a CHAT model; putting it anywhere near a vector table
    // would be a dimension error at best.
    for (const role of ['code-embedding', 'embedding', 'reranker'] as const) {
      const ids = catalogueFor(role).map(m => m.id);
      expect(ids).not.toContain('qwen/qwen3-coder');
      expect(ids).not.toContain('poolside/laguna-s-2.1');
    }
  });

  it('has a label for the new role', () => {
    expect(ROLE_LOCAL['code-assistant'].label).toBe('Code assistant');
  });
});


describe('chat pricing is carried per direction, ready for whoever wires it', () => {
  it('records input and output separately — they are up to 8x apart', () => {
    const codex = findModel('openai/gpt-5.1-codex')!;
    expect(codex.priceIn).toBe(1.25);
    expect(codex.priceOut).toBe(10.00);
    expect(codex.priceOut! / codex.priceIn!).toBe(8);
  });

  it('gives every chat model both rates, so a real estimate needs no new data', () => {
    for (const m of CHAT_CATALOGUE) {
      expect(typeof m.priceIn).toBe('number');
      expect(typeof m.priceOut).toBe('number');
    }
  });

  it('the free tier really is free', () => {
    const free = findModel('poolside/laguna-s-2.1:free')!;
    expect(free.priceIn).toBe(0);
    expect(free.priceOut).toBe(0);
  });
});
