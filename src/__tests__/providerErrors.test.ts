import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  classifyProviderError, classifyError, ProviderHttpError, warningFor, kindOfWarning,
  markProviderExhausted, providerExhaustedState, clearProviderExhausted, finalizeWarnings,
} from '../embedding/providerErrors.js';

// Shapes copied from real Gemini 429 bodies (google.rpc.Status).
const GEMINI_QUOTA_EXHAUSTED = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count', quotaId: 'GenerateContentPaidTierInputTokensPerModelPerDay' }] },
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
    ],
  },
}, null, 2);

const GEMINI_PREPAY_EMPTY = JSON.stringify({
  error: { code: 429, message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.', status: 'RESOURCE_EXHAUSTED' },
}, null, 2);

const GEMINI_RATE_LIMIT_PER_MINUTE = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' },
    ],
  },
}, null, 2);

const GEMINI_PLAIN_429 = JSON.stringify({
  error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' },
});

describe('classifyProviderError', () => {
  it('Gemini 429 with a per-day QuotaFailure and billing text = quota-exhausted', () => {
    expect(classifyProviderError(429, GEMINI_QUOTA_EXHAUSTED)).toBe('quota-exhausted');
  });
  it('Gemini 429 "prepayment credits are depleted" = quota-exhausted', () => {
    expect(classifyProviderError(429, GEMINI_PREPAY_EMPTY)).toBe('quota-exhausted');
  });
  it('Gemini 429 with only a per-minute quota id = rate-limited, despite the "quota" wording', () => {
    expect(classifyProviderError(429, GEMINI_RATE_LIMIT_PER_MINUTE)).toBe('rate-limited');
  });
  it('Gemini 429 without quota text = rate-limited', () => {
    expect(classifyProviderError(429, GEMINI_PLAIN_429)).toBe('rate-limited');
  });
  it('OpenRouter 402 insufficient credits = quota-exhausted', () => {
    expect(classifyProviderError(402, '{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}')).toBe('quota-exhausted');
  });
  it('Anthropic 400 credit balance too low = quota-exhausted', () => {
    expect(classifyProviderError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}')).toBe('quota-exhausted');
  });
  it('Groq 429 rate limit = rate-limited', () => {
    expect(classifyProviderError(429, '{"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000. Please try again in 2.5s.","type":"tokens","code":"rate_limit_exceeded"}}')).toBe('rate-limited');
  });
  it('401 = auth; 500 = other', () => {
    expect(classifyProviderError(401, '{"error":"invalid api key"}')).toBe('auth-invalid');
    expect(classifyProviderError(500, 'oops')).toBe('other');
  });
});

describe('classifyError', () => {
  it('reads a ProviderHttpError', () => {
    const e = new ProviderHttpError('gemini', 429, GEMINI_QUOTA_EXHAUSTED);
    expect(e.message.startsWith('Gemini HTTP 429:')).toBe(true);
    expect(classifyError(e)).toEqual({ provider: 'gemini', status: 429, kind: 'quota-exhausted' });
  });
  it('reads a status from a plain message (sidecar OpenRouter route)', () => {
    expect(classifyError(new Error('OpenRouter /chat/completions failed: 402 {"error":{"message":"Insufficient credits"}}')).kind).toBe('quota-exhausted');
  });
  it('a network error = other', () => {
    expect(classifyError(new Error('fetch failed')).kind).toBe('other');
  });
});

describe('warningFor', () => {
  it('names the provider, the fix and the fallback', () => {
    const w = warningFor('gemini', 'quota-exhausted', 429, 'OpenRouter');
    expect(w).toEqual({
      kind: 'provider-quota-exhausted',
      provider: 'gemini',
      status: 429,
      message: 'Gemini has no credits left. Add credits or pick another provider in Config → LLM providers. This answer came from OpenRouter.',
    });
    expect(kindOfWarning(w)).toBe('quota-exhausted');
  });
});

describe('exhausted state', () => {
  beforeEach(() => { clearProviderExhausted(); delete process.env.FANTOM_PROVIDER_EXHAUSTED_TTL_MS; });

  it('is remembered for 30 min by default, then expires', () => {
    const t0 = 1_000_000;
    markProviderExhausted('gemini', 429, t0);
    expect(providerExhaustedState('gemini', t0 + 29 * 60_000)).not.toBeNull();
    expect(providerExhaustedState('gemini', t0 + 31 * 60_000)).toBeNull();
    expect(providerExhaustedState('anthropic', t0)).toBeNull();
  });
  it('TTL 0 turns the memory off', () => {
    process.env.FANTOM_PROVIDER_EXHAUSTED_TTL_MS = '0';
    markProviderExhausted('gemini', 429);
    expect(providerExhaustedState('gemini')).toBeNull();
  });
});

describe('finalizeWarnings (what the ask result carries)', () => {
  it('Gemini out of credits, OpenRouter answered: the warning names OpenRouter', () => {
    const out = finalizeWarnings([warningFor('gemini', 'quota-exhausted', 429)], 'openrouter', 'deepseek/deepseek-v4-flash');
    expect(out).toEqual([{
      kind: 'provider-quota-exhausted', provider: 'gemini', status: 429,
      message: 'Gemini has no credits left. Add credits or pick another provider in Config → LLM providers. This answer came from OpenRouter (deepseek/deepseek-v4-flash).',
    }]);
  });
  it('no fallback worked: the warning says no answer was written', () => {
    const [w] = finalizeWarnings([warningFor('gemini', 'quota-exhausted', 429)], 'none', 'unavailable');
    expect(w.kind).toBe('provider-quota-exhausted');
    expect(w.message).toMatch(/no credits left.*no answer was written/);
  });
});
