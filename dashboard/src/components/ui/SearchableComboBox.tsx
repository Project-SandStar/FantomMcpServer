'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

export interface ComboBoxOption {
  value: string | number;
  label: string;
  description?: string;
}

export interface SearchableComboBoxProps {
  /** Array of options to display */
  options: ComboBoxOption[];
  /** Currently selected value */
  value: string | number | null | undefined;
  /** Callback when value changes */
  onChange: (value: string | number | null) => void;
  /** Placeholder text when no value is selected */
  placeholder?: string;
  /** Whether the combobox is disabled */
  disabled?: boolean;
  /** Whether the combobox is in a loading state */
  isLoading?: boolean;
  /** Optional label text above the combobox */
  label?: string;
  /** Placeholder text for the search input */
  searchPlaceholder?: string;
  /** Additional CSS classes for the container */
  className?: string;
  /** Message to show when no options match the search */
  emptySearchMessage?: string;
  /** Message to show when there are no options at all */
  emptyOptionsMessage?: string;
  /** Whether to allow clearing the selection */
  clearable?: boolean;
  /** Whether to allow free text entry (not just selection from options) */
  allowFreeText?: boolean;
}

export function SearchableComboBox({
  options,
  value,
  onChange,
  placeholder = 'Select an option...',
  disabled = false,
  isLoading = false,
  label,
  searchPlaceholder = 'Search...',
  className = '',
  emptySearchMessage = 'No results found',
  emptyOptionsMessage = 'No options available',
  clearable = true,
  allowFreeText = false,
}: SearchableComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find the selected option (or create a virtual one for free text)
  const selectedOption = useMemo(() => {
    const found = options.find((opt) => opt.value === value);
    if (found) return found;
    // For free text mode, if value exists but not in options, create a virtual option
    if (allowFreeText && value !== null && value !== undefined && value !== '') {
      return { value, label: String(value) };
    }
    return null;
  }, [options, value, allowFreeText]);

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) {
      return options;
    }
    const query = searchQuery.toLowerCase();
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        opt.description?.toLowerCase().includes(query) ||
        String(opt.value).toLowerCase().includes(query)
    );
  }, [options, searchQuery]);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        // In free text mode, commit the search query when clicking outside
        if (allowFreeText && searchQuery.trim()) {
          onChange(searchQuery.trim());
        }
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, allowFreeText, searchQuery, onChange]);

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchQuery('');
        inputRef.current?.blur();
      } else if (event.key === 'Enter' && allowFreeText && searchQuery.trim()) {
        // In free text mode, Enter commits the current search query as the value
        event.preventDefault();
        onChange(searchQuery.trim());
        setIsOpen(false);
        setSearchQuery('');
        inputRef.current?.blur();
      }
    },
    [allowFreeText, searchQuery, onChange]
  );

  // Handle input focus
  const handleInputFocus = useCallback(() => {
    if (!disabled && !isLoading) {
      setIsOpen(true);
      setSearchQuery('');
    }
  }, [disabled, isLoading]);

  // Handle input change
  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = event.target.value;
      setSearchQuery(newValue);
      if (!isOpen) {
        setIsOpen(true);
      }
    },
    [isOpen]
  );

  // Handle free text selection (when user clicks "Use custom value")
  const handleFreeTextSelect = useCallback(() => {
    if (searchQuery.trim()) {
      onChange(searchQuery.trim());
      setIsOpen(false);
      setSearchQuery('');
    }
  }, [searchQuery, onChange]);

  // Check if search query exactly matches an option value
  const exactMatch = useMemo(() => {
    return options.some(
      (opt) =>
        String(opt.value).toLowerCase() === searchQuery.toLowerCase() ||
        opt.label.toLowerCase() === searchQuery.toLowerCase()
    );
  }, [options, searchQuery]);

  // Handle option selection
  const handleSelect = useCallback(
    (option: ComboBoxOption) => {
      onChange(option.value);
      setIsOpen(false);
      setSearchQuery('');
    },
    [onChange]
  );

  // Handle clear selection
  const handleClear = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onChange(null);
      setSearchQuery('');
    },
    [onChange]
  );

  // Handle dropdown toggle
  const handleToggle = useCallback(() => {
    if (!disabled && !isLoading) {
      setIsOpen((prev) => !prev);
      if (!isOpen) {
        setSearchQuery('');
        // Focus input when opening
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    }
  }, [disabled, isLoading, isOpen]);

  // Display value for the input
  // In free text mode, show the actual value even if not in options
  const displayValue = isOpen
    ? searchQuery
    : (selectedOption?.label || (allowFreeText && value ? String(value) : ''));

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Label */}
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      )}

      {/* Input Container */}
      <div
        className={`flex items-center w-full border rounded-lg bg-white transition-colors ${
          isOpen ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-300'
        } ${disabled ? 'bg-gray-100 cursor-not-allowed opacity-60' : ''}`}
      >
        {/* Search Icon */}
        <div className="pl-3 text-gray-400">
          {isLoading ? (
            <svg
              className="w-5 h-5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          )}
        </div>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          placeholder={selectedOption ? '' : (isOpen ? searchPlaceholder : placeholder)}
          disabled={disabled || isLoading}
          className="flex-1 px-2 py-2 bg-transparent focus:outline-none disabled:cursor-not-allowed"
        />

        {/* Clear button (when value selected and dropdown is closed) */}
        {clearable && selectedOption && !isOpen && !disabled && (
          <button
            onClick={handleClear}
            className="p-1.5 mr-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600 transition-colors"
            title="Clear selection"
            type="button"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}

        {/* Dropdown arrow */}
        <button
          onClick={handleToggle}
          className="p-2 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed"
          disabled={disabled || isLoading}
          type="button"
        >
          <svg
            className={`w-5 h-5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
      </div>

      {/* Dropdown */}
      {isOpen && !disabled && !isLoading && (
        <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-64 overflow-y-auto">
          {filteredOptions.length > 0 || (allowFreeText && searchQuery.trim()) ? (
            <div className="py-1">
              {/* Results count header */}
              <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500 border-b border-gray-100 sticky top-0">
                {searchQuery ? (
                  <span>
                    <strong>{filteredOptions.length}</strong>{' '}
                    {filteredOptions.length === 1 ? 'result' : 'results'} for &quot;{searchQuery}&quot;
                    {allowFreeText && ' (or press Enter for custom value)'}
                  </span>
                ) : (
                  <span>
                    <strong>{filteredOptions.length}</strong>{' '}
                    {filteredOptions.length === 1 ? 'option' : 'options'} available
                    {allowFreeText && ' (or type a custom value)'}
                  </span>
                )}
              </div>

              {/* Free text option (shown when allowFreeText and search query doesn't match exactly) */}
              {allowFreeText && searchQuery.trim() && !exactMatch && (
                <button
                  onClick={handleFreeTextSelect}
                  className="w-full text-left px-3 py-2 hover:bg-green-50 transition-colors border-b border-gray-100 bg-green-50/50"
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span className="font-medium text-green-700">Use &quot;{searchQuery}&quot;</span>
                  </div>
                  <div className="text-xs text-gray-500 ml-6">Custom value</div>
                </button>
              )}

              {/* Option list */}
              {filteredOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleSelect(option)}
                  className={`w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors ${
                    value === option.value ? 'bg-blue-100' : ''
                  }`}
                  type="button"
                >
                  <div className="font-medium text-gray-900">{option.label}</div>
                  {option.description && (
                    <div className="text-xs text-gray-500">{option.description}</div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 text-center text-gray-500">
              {searchQuery ? (
                <span>{emptySearchMessage.replace('{query}', searchQuery)}</span>
              ) : (
                <span>{emptyOptionsMessage}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Default export for convenience
export default SearchableComboBox;
