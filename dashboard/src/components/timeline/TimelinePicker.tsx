'use client';

import { useState, useEffect } from 'react';
import { isoToInputValue, inputValueToIso, presetToIso } from '@/lib/time';

interface TimelinePickerProps {
  value: string | null; // ISO string or null = "now"
  onChange: (iso: string | null) => void;
  label?: string;
  showPresets?: boolean;
}

// Datetime input + preset chips. Sets value to "now" when cleared.
export function TimelinePicker({
  value,
  onChange,
  label = 'As of',
  showPresets = true,
}: TimelinePickerProps) {
  const [local, setLocal] = useState<string>(isoToInputValue(value));
  useEffect(() => {
    setLocal(isoToInputValue(value));
  }, [value]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-gray-600 font-medium">{label}:</label>
      <input
        type="datetime-local"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const iso = inputValueToIso(local);
          onChange(iso);
        }}
        className="px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
      />
      <button
        type="button"
        onClick={() => onChange(null)}
        className="text-xs text-gray-500 hover:text-gray-700 underline"
        title="Clear → use current state"
      >
        clear
      </button>
      {showPresets && (
        <div className="flex gap-1">
          <PresetChip onClick={() => onChange(presetToIso('now'))}>Now</PresetChip>
          <PresetChip onClick={() => onChange(presetToIso('1d'))}>1d ago</PresetChip>
          <PresetChip onClick={() => onChange(presetToIso('7d'))}>7d ago</PresetChip>
          <PresetChip onClick={() => onChange(presetToIso('30d'))}>30d ago</PresetChip>
        </div>
      )}
    </div>
  );
}

function PresetChip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700"
    >
      {children}
    </button>
  );
}
