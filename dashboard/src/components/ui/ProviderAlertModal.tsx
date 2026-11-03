'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import type { ProviderWarning } from '@/lib/api';

const TITLES: Record<ProviderWarning['kind'], string> = {
  'provider-quota-exhausted': 'out of credits',
  'provider-rate-limited': 'is rate-limiting requests',
  'provider-auth-failed': 'refused the API key',
  'provider-failed': 'failed',
};

const LABELS: Record<string, string> = {
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  groq: 'Groq',
  openrouter: 'OpenRouter',
};

/**
 * A small popup for an LLM provider problem (out of credits, rate limit, bad
 * key). Names the provider, says what happened, and links to Config → LLM
 * providers. Plain React + Tailwind; closes on Escape or the backdrop.
 */
export function ProviderAlertModal({ warnings, onClose }: { warnings: ProviderWarning[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (warnings.length === 0) return null;
  const first = warnings[0];
  const name = LABELS[first.provider] ?? first.provider;
  const severe = first.kind === 'provider-quota-exhausted' || first.kind === 'provider-auth-failed';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="provider-alert-title"
        className="w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`rounded-t-lg px-5 py-3 ${severe ? 'bg-red-50 dark:bg-red-950' : 'bg-amber-50 dark:bg-amber-950'}`}>
          <h2 id="provider-alert-title" className={`text-base font-semibold ${severe ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200'}`}>
            {name} {TITLES[first.kind]}
          </h2>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm text-gray-700 dark:text-gray-200">
          {warnings.map((w, i) => (
            <p key={`${w.provider}-${w.kind}-${i}`}>
              {w.message}
              {w.status ? <span className="ml-1 text-xs text-gray-400">(HTTP {w.status})</span> : null}
            </p>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Close
          </button>
          <Link
            href="/config/#llm-providers"
            onClick={onClose}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Open LLM providers
          </Link>
        </div>
      </div>
    </div>
  );
}
