'use client';

import { useMemo, useState } from 'react';

interface LlmPromptHelperProps {
  toolName: string | null;
  toolDescription?: string;
  parameters: Record<string, unknown>;
}

/**
 * Generates copy-paste prompts for using MCP tools with Claude or other LLMs
 */
export function LlmPromptHelper({ toolName, toolDescription, parameters }: LlmPromptHelperProps) {
  const [copied, setCopied] = useState<string | null>(null);

  // Generate various prompt styles
  const prompts = useMemo(() => {
    if (!toolName) return null;

    // Clean parameters
    const cleanParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== '' && value !== null) {
        cleanParams[key] = value;
      }
    }

    const hasParams = Object.keys(cleanParams).length > 0;
    const query = cleanParams.query || cleanParams.search || cleanParams.term || '';

    // Build parameter description
    const paramDescription = hasParams
      ? Object.entries(cleanParams)
          .map(([k, v]) => `${k}="${JSON.stringify(v)}"`)
          .join(', ')
      : '';

    return {
      simple: query
        ? `Use the ${toolName} tool to search for "${query}"`
        : `Use the ${toolName} tool`,
      detailed: hasParams
        ? `Use the ${toolName} tool with the following parameters: ${paramDescription}`
        : `Use the ${toolName} tool to ${toolDescription || 'perform the operation'}`,
      direct: `Call the MCP tool "${toolName}" with arguments: ${JSON.stringify(cleanParams, null, 2)}`,
      natural: generateNaturalPrompt(toolName, cleanParams, query as string),
    };
  }, [toolName, parameters, toolDescription]);

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  if (!toolName || !prompts) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">LLM Prompt Helper</h3>
        <p className="text-sm text-gray-500 italic">
          Select a tool and fill in parameters to generate LLM prompts
        </p>
      </div>
    );
  }

  const promptOptions = [
    {
      key: 'natural',
      label: 'Natural Language',
      description: 'Conversational style',
      prompt: prompts.natural,
    },
    {
      key: 'simple',
      label: 'Simple',
      description: 'Brief and direct',
      prompt: prompts.simple,
    },
    {
      key: 'detailed',
      label: 'Detailed',
      description: 'Explicit parameters',
      prompt: prompts.detailed,
    },
    {
      key: 'direct',
      label: 'Direct MCP',
      description: 'JSON arguments',
      prompt: prompts.direct,
    },
  ];

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">LLM Prompt Helper</h3>
          <p className="text-xs text-gray-500">Copy-paste prompts for Claude or other LLMs</p>
        </div>
      </div>

      <div className="space-y-3">
        {promptOptions.map(({ key, label, description, prompt }) => (
          <div key={key} className="bg-white rounded border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-700">{label}</span>
                <span className="text-xs text-gray-400">{description}</span>
              </div>
              <button
                onClick={() => handleCopy(key, prompt)}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {copied === key ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="px-3 py-2">
              <p className="text-sm text-gray-700 font-mono whitespace-pre-wrap break-words">
                {prompt}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Tips */}
      <div className="mt-4 p-3 bg-blue-50 rounded border border-blue-100">
        <h4 className="text-xs font-semibold text-blue-800 mb-1">Tips for LLM Prompts</h4>
        <ul className="text-xs text-blue-700 space-y-1">
          <li>- Use "Natural Language" for conversational interactions</li>
          <li>- Use "Direct MCP" when you need exact parameter control</li>
          <li>- Add context about what you want to do with the results</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Generate a natural language prompt based on tool and parameters
 */
function generateNaturalPrompt(
  toolName: string,
  params: Record<string, unknown>,
  query: string
): string {
  const queryTerm = query || 'the specified criteria';

  switch (toolName) {
    case 'searchLocalDocs':
      const instanceType = params.instanceType as string | undefined;
      const docsContext = instanceType
        ? `local ${instanceType} documentation`
        : 'local cached documentation';
      return `Search the ${docsContext} for "${queryTerm}" and show me the most relevant results.`;

    case 'searchFantomCode':
      const codeType = params.type as string | undefined;
      const typeContext = codeType ? `${codeType}s` : 'code';
      return `Find ${typeContext} related to "${queryTerm}" in the local indexed Fantom source code.`;

    case 'searchAll':
      return `Search across all local cached documentation and code for "${queryTerm}" and give me a comprehensive overview.`;

    case 'getTypeInfo':
      return `Get detailed information about the type "${params.qualifiedName || queryTerm}" including its slots and documentation.`;

    case 'listPods':
      return `List all available pods${params.instanceId ? ` for instance ${params.instanceId}` : ''}.`;

    case 'indexInstanceDocs':
      return `Index the documentation for instance ${params.instanceId || '(specify instance)'}.`;

    default:
      // Generic prompt
      const paramStr = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      return paramStr
        ? `Use the ${toolName} tool with ${paramStr}`
        : `Use the ${toolName} tool to accomplish this task.`;
  }
}
