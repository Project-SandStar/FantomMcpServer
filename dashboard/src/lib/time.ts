// Shared time-formatting helpers for the time-travel UI.

export function formatRunAnchor(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'invalid';
  // Local-time human format: "2026-05-03 14:22 UTC" — show UTC since the
  // server records timestamps in UTC.
  return d.toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

export function presetToIso(preset: 'now' | '1d' | '7d' | '30d' | 'earliest'): string {
  const now = Date.now();
  switch (preset) {
    case 'now':
      return new Date().toISOString();
    case '1d':
      return new Date(now - 86_400_000).toISOString();
    case '7d':
      return new Date(now - 7 * 86_400_000).toISOString();
    case '30d':
      return new Date(now - 30 * 86_400_000).toISOString();
    case 'earliest':
      return new Date(0).toISOString();
  }
}

export function isoToInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // datetime-local expects YYYY-MM-DDTHH:MM (local time)
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function inputValueToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
