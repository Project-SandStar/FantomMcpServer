'use client';

export function RunFromSidecarToggle({
  on,
  onChange,
  accent = 'blue',
  hint,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  accent?: 'blue' | 'purple' | 'gray';
  hint?: string;
}) {
  const accentBg = on
    ? accent === 'purple' ? 'bg-purple-600' : 'bg-blue-600'
    : 'bg-gray-300';
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
      <button
        type="button"
        onClick={() => onChange(!on)}
        className="flex items-center gap-2 group"
      >
        <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${accentBg}`}>
          <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </span>
        <span className="text-gray-700 group-hover:text-gray-900">
          Run from sidecar {on ? '· on' : '· off'}
        </span>
      </button>
      {hint && <span className="text-gray-400 italic truncate">{hint}</span>}
    </div>
  );
}
