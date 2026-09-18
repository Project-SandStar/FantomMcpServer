'use client';

import { useMemo, useState } from 'react';

interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

interface InputSchema {
  type: string;
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

interface SchemaViewerProps {
  toolName: string;
  schema: InputSchema;
  description?: string;
}

// Example values for common parameter names
const EXAMPLE_VALUES: Record<string, string | number | boolean | string[]> = {
  query: 'readAll',
  search: 'point tag',
  term: 'ahu',
  name: 'MyClass',
  pod: 'haystack',
  type: 'class',
  limit: 10,
  maxResults: 25,
  instanceType: 'skyspark',
  language: 'fantom',
  sources: ['local-docs', 'code'],
  includeSlots: true,
  recursive: false,
};

// Type badge colors
const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  string: { bg: 'bg-green-100', text: 'text-green-800' },
  number: { bg: 'bg-blue-100', text: 'text-blue-800' },
  integer: { bg: 'bg-blue-100', text: 'text-blue-800' },
  boolean: { bg: 'bg-purple-100', text: 'text-purple-800' },
  array: { bg: 'bg-orange-100', text: 'text-orange-800' },
  object: { bg: 'bg-gray-100', text: 'text-gray-800' },
};

export function SchemaViewer({ toolName, schema, description }: SchemaViewerProps) {
  const [copied, setCopied] = useState(false);

  const properties = schema.properties || {};
  const required = schema.required || [];

  // Generate MCP tool definition for copying
  const mcpDefinition = useMemo(() => {
    return JSON.stringify({
      name: toolName,
      description: description || '',
      inputSchema: schema,
    }, null, 2);
  }, [toolName, schema, description]);

  const handleCopyDefinition = () => {
    navigator.clipboard.writeText(mcpDefinition).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const propertyEntries = Object.entries(properties);

  if (propertyEntries.length === 0) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Tool Schema</h3>
          <button
            onClick={handleCopyDefinition}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            {copied ? 'Copied!' : 'Copy MCP Definition'}
          </button>
        </div>
        <p className="text-sm text-gray-500 italic">This tool requires no parameters.</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Tool Schema</h3>
        <button
          onClick={handleCopyDefinition}
          className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {copied ? 'Copied!' : 'Copy MCP Definition'}
        </button>
      </div>

      <div className="space-y-3">
        {propertyEntries.map(([key, prop]) => {
          const isRequired = required.includes(key);
          const typeColor = TYPE_COLORS[prop.type] || TYPE_COLORS.string;
          const exampleValue = EXAMPLE_VALUES[key];
          const typeLabel = prop.type === 'array' && prop.items?.type
            ? `${prop.type}<${prop.items.type}>`
            : prop.type;

          return (
            <div key={key} className="bg-white rounded-md border border-gray-200 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Parameter name */}
                <code className="text-sm font-semibold text-gray-900">{key}</code>

                {/* Type badge */}
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeColor.bg} ${typeColor.text}`}>
                  {typeLabel}
                </span>

                {/* Required indicator */}
                {isRequired && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                    required
                  </span>
                )}

                {/* Optional indicator */}
                {!isRequired && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                    optional
                  </span>
                )}
              </div>

              {/* Description */}
              {prop.description && (
                <p className="text-sm text-gray-600 mt-1.5">{prop.description}</p>
              )}

              {/* Additional info row */}
              <div className="flex flex-wrap gap-3 mt-2 text-xs">
                {/* Enum values */}
                {prop.enum && prop.enum.length > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="text-gray-500">values:</span>
                    <div className="flex flex-wrap gap-1">
                      {prop.enum.map((val) => (
                        <code key={val} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                          {val}
                        </code>
                      ))}
                    </div>
                  </div>
                )}

                {/* Default value */}
                {prop.default !== undefined && (
                  <div className="flex items-center gap-1">
                    <span className="text-gray-500">default:</span>
                    <code className="px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-800">
                      {JSON.stringify(prop.default)}
                    </code>
                  </div>
                )}

                {/* Example value */}
                {exampleValue !== undefined && !prop.enum && (
                  <div className="flex items-center gap-1">
                    <span className="text-gray-500">example:</span>
                    <code className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                      {JSON.stringify(exampleValue)}
                    </code>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Schema summary */}
      <div className="mt-4 pt-3 border-t border-gray-200">
        <p className="text-xs text-gray-500">
          {propertyEntries.length} parameter{propertyEntries.length !== 1 ? 's' : ''}
          ({required.length} required, {propertyEntries.length - required.length} optional)
        </p>
      </div>
    </div>
  );
}
