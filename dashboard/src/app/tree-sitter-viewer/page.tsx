'use client';

import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ============================================
// Types
// ============================================

interface AstNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  isNamed: boolean;
  childCount: number;
  text?: string;
  children?: AstNode[];
  truncated?: boolean;
}

interface AstResponse {
  success: boolean;
  language: string;
  parseTime: number;
  rootNode: AstNode;
  hasErrors: boolean;
}

// Sample code for each language
const sampleCode: Record<string, string> = {
  typescript: `interface User {
  id: number;
  name: string;
}

function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}

class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }
}`,
  javascript: `class Calculator {
  constructor() {
    this.result = 0;
  }

  add(a, b) {
    return a + b;
  }
}

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`,
  python: `from typing import List

class DataProcessor:
    def __init__(self, data: List[int]):
        self.data = data

    def process(self) -> List[int]:
        return [x * 2 for x in self.data]

def factorial(n: int) -> int:
    if n <= 1:
        return 1
    return n * factorial(n - 1)`,
  dart: `class Counter {
  int _count = 0;

  int get count => _count;

  void increment() {
    _count++;
  }

  void decrement() {
    _count--;
  }
}

void main() {
  final counter = Counter();
  counter.increment();
  print('Count: \${counter.count}');
}`,
  fantom: `using sys

class Calculator {
  Int add(Int a, Int b) {
    return a + b
  }

  static Void main(Str[] args) {
    calc := Calculator()
    echo("2 + 3 = " + calc.add(2, 3))
  }
}`,
};

// ============================================
// AST Tree Node Component
// ============================================

interface TreeNodeProps {
  node: AstNode;
  depth: number;
  selectedNode: AstNode | null;
  onSelect: (node: AstNode) => void;
  expandedNodes: Set<string>;
  onToggle: (nodeKey: string) => void;
  codeLines: string[];
}

function TreeNode({
  node,
  depth,
  selectedNode,
  onSelect,
  expandedNodes,
  onToggle,
  codeLines
}: TreeNodeProps) {
  const nodeKey = `${node.type}-${node.startPosition.row}-${node.startPosition.column}`;
  const isExpanded = expandedNodes.has(nodeKey);
  const isSelected = selectedNode === node;
  const hasChildren = node.children && node.children.length > 0;

  const getNodeColor = (type: string, isNamed: boolean): string => {
    if (!isNamed) return 'text-gray-400';
    if (type.includes('class') || type.includes('interface')) return 'text-blue-600';
    if (type.includes('function') || type.includes('method')) return 'text-purple-600';
    if (type.includes('identifier') || type.includes('name')) return 'text-green-600';
    if (type.includes('string') || type.includes('number')) return 'text-orange-600';
    if (type.includes('type')) return 'text-cyan-600';
    if (type.includes('operator') || type.includes('keyword')) return 'text-pink-600';
    return 'text-gray-700';
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      onToggle(nodeKey);
    }
    onSelect(node);
  };

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div
        onClick={handleClick}
        className={`flex items-center gap-1 py-0.5 px-1 rounded cursor-pointer hover:bg-gray-100 ${
          isSelected ? 'bg-blue-100 ring-1 ring-blue-300' : ''
        }`}
      >
        {/* Expand/Collapse Toggle */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(nodeKey);
            }}
            className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-gray-700"
          >
            <svg
              className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        ) : (
          <span className="w-4" />
        )}

        {/* Node Type */}
        <span className={`font-mono text-sm ${getNodeColor(node.type, node.isNamed)}`}>
          {node.type}
        </span>

        {/* Position */}
        <span className="text-xs text-gray-400 ml-1">
          [{node.startPosition.row}:{node.startPosition.column}]
        </span>

        {/* Text preview for leaf nodes */}
        {node.text && node.text.length < 40 && (
          <span className="text-xs text-gray-500 font-mono ml-2 truncate max-w-xs">
            &quot;{node.text.replace(/\n/g, '\\n')}&quot;
          </span>
        )}

        {/* Child count badge */}
        {hasChildren && !isExpanded && (
          <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full ml-1">
            {node.children!.length}
          </span>
        )}

        {/* Truncated indicator */}
        {node.truncated && (
          <span className="text-xs text-orange-500 ml-1">(truncated)</span>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child, index) => (
            <TreeNode
              key={`${child.type}-${child.startPosition.row}-${child.startPosition.column}-${index}`}
              node={child}
              depth={depth + 1}
              selectedNode={selectedNode}
              onSelect={onSelect}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              codeLines={codeLines}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================
// API Function
// ============================================

async function parseToAst(code: string, language: string): Promise<AstResponse> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/tree-sitter/ast`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code, language })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to parse code');
  }
  return response.json();
}

// ============================================
// Main Page Component
// ============================================

export default function TreeSitterViewerPage() {
  const [code, setCode] = useState(sampleCode.typescript);
  const [language, setLanguage] = useState('typescript');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<AstNode | null>(null);
  const [showOnlyNamed, setShowOnlyNamed] = useState(false);

  // Fetch available grammars
  const { data: grammarsData, isLoading: loadingGrammars } = useQuery({
    queryKey: ['tree-sitter-grammars'],
    queryFn: api.getTreeSitterGrammars,
  });

  // Parse code mutation
  const parseMutation = useMutation({
    mutationFn: ({ code, language }: { code: string; language: string }) =>
      parseToAst(code, language),
    onSuccess: (data) => {
      // Expand root node and first level children
      const keysToExpand = new Set<string>();
      if (data.rootNode) {
        const rootKey = `${data.rootNode.type}-${data.rootNode.startPosition.row}-${data.rootNode.startPosition.column}`;
        keysToExpand.add(rootKey);
        // Also expand first-level children
        data.rootNode.children?.forEach(child => {
          const childKey = `${child.type}-${child.startPosition.row}-${child.startPosition.column}`;
          keysToExpand.add(childKey);
        });
      }
      setExpandedNodes(keysToExpand);
      setSelectedNode(null);
    },
  });

  const handleLanguageChange = (newLang: string) => {
    setLanguage(newLang);
    if (sampleCode[newLang]) {
      setCode(sampleCode[newLang]);
    }
    setExpandedNodes(new Set());
    setSelectedNode(null);
  };

  const handleParse = () => {
    parseMutation.mutate({ code, language });
  };

  const handleToggle = useCallback((nodeKey: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeKey)) {
        next.delete(nodeKey);
      } else {
        next.add(nodeKey);
      }
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    if (!parseMutation.data?.rootNode) return;

    const allKeys = new Set<string>();
    const traverse = (node: AstNode) => {
      const key = `${node.type}-${node.startPosition.row}-${node.startPosition.column}`;
      allKeys.add(key);
      node.children?.forEach(traverse);
    };
    traverse(parseMutation.data.rootNode);
    setExpandedNodes(allKeys);
  }, [parseMutation.data?.rootNode]);

  const handleCollapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  // Filter tree to show only named nodes if enabled
  const filterTree = useCallback((node: AstNode): AstNode | null => {
    if (!showOnlyNamed) return node;

    if (node.isNamed) {
      const filteredChildren = node.children
        ?.map(child => filterTree(child))
        .filter((c): c is AstNode => c !== null);
      return { ...node, children: filteredChildren };
    }

    // Not named, but check if any children are named
    const namedDescendants = node.children
      ?.map(child => filterTree(child))
      .filter((c): c is AstNode => c !== null);

    if (namedDescendants && namedDescendants.length > 0) {
      return { ...node, children: namedDescendants };
    }

    return null;
  }, [showOnlyNamed]);

  const displayTree = useMemo(() => {
    if (!parseMutation.data?.rootNode) return null;
    return filterTree(parseMutation.data.rootNode);
  }, [parseMutation.data?.rootNode, filterTree]);

  const codeLines = useMemo(() => code.split('\n'), [code]);

  const availableGrammars = grammarsData?.available || [];

  // Get highlighted code lines based on selected node
  const getHighlightedCode = useCallback(() => {
    if (!selectedNode) return code;

    const lines = code.split('\n');
    const startRow = selectedNode.startPosition.row;
    const endRow = selectedNode.endPosition.row;

    return lines.map((line, i) => {
      if (i >= startRow && i <= endRow) {
        return `>>> ${line}`;
      }
      return `    ${line}`;
    }).join('\n');
  }, [code, selectedNode]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tree-Sitter AST Viewer</h1>
          <p className="text-gray-600 mt-1">
            Visualize the Abstract Syntax Tree of your code
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Language:</label>
            <select
              value={language}
              onChange={(e) => handleLanguageChange(e.target.value)}
              disabled={loadingGrammars}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
            >
              {availableGrammars.map((lang: string) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleParse}
            disabled={parseMutation.isPending || !code.trim()}
            className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {parseMutation.isPending ? 'Parsing...' : 'Parse to AST'}
          </button>

          {parseMutation.data && (
            <>
              <div className="h-6 w-px bg-gray-300" />
              <button
                onClick={handleExpandAll}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
              >
                Expand All
              </button>
              <button
                onClick={handleCollapseAll}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
              >
                Collapse All
              </button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showOnlyNamed}
                  onChange={(e) => setShowOnlyNamed(e.target.checked)}
                  className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                />
                Show only named nodes
              </label>
            </>
          )}
        </div>

        {/* Parse stats */}
        {parseMutation.data && (
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-200">
            <span className="text-sm text-gray-600">
              Parse time: <strong>{parseMutation.data.parseTime}ms</strong>
            </span>
            <span className="text-sm text-gray-600">
              Language: <strong>{parseMutation.data.language}</strong>
            </span>
            {parseMutation.data.hasErrors && (
              <span className="text-sm text-red-600 font-medium">
                Contains syntax errors
              </span>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {parseMutation.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {parseMutation.error instanceof Error ? parseMutation.error.message : 'Parse failed'}
        </div>
      )}

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Code Input */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="p-3 border-b border-gray-200 bg-gray-50">
            <h2 className="font-semibold text-gray-900">Source Code</h2>
          </div>
          <div className="relative h-[500px] overflow-auto">
            {/* Line numbers column */}
            <div
              className="absolute left-0 top-0 w-12 pt-4 pb-4 pr-2 text-right pointer-events-none select-none bg-gray-50 border-r border-gray-200"
              style={{ minHeight: '100%' }}
            >
              {codeLines.map((_, i) => (
                <div
                  key={i}
                  className={`font-mono text-sm leading-6 ${
                    selectedNode &&
                    i >= selectedNode.startPosition.row &&
                    i <= selectedNode.endPosition.row
                      ? 'text-green-600 font-bold'
                      : 'text-gray-400'
                  }`}
                >
                  {i + 1}
                </div>
              ))}
            </div>

            {/* Code textarea */}
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full h-full font-mono text-sm leading-6 pt-4 pb-4 pl-16 pr-4 border-0 focus:ring-0 resize-none bg-transparent"
              placeholder="Enter code to parse..."
              spellCheck={false}
            />
          </div>
        </div>

        {/* AST Tree */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="p-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">AST Tree</h2>
            {selectedNode && (
              <button
                onClick={() => setSelectedNode(null)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Clear selection
              </button>
            )}
          </div>
          <div className="h-[500px] overflow-auto p-2">
            {parseMutation.isPending ? (
              <div className="flex items-center justify-center h-full">
                <div className="flex flex-col items-center space-y-4">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
                  <div className="text-gray-500">Parsing...</div>
                </div>
              </div>
            ) : displayTree ? (
              <TreeNode
                node={displayTree}
                depth={0}
                selectedNode={selectedNode}
                onSelect={setSelectedNode}
                expandedNodes={expandedNodes}
                onToggle={handleToggle}
                codeLines={codeLines}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                Click &quot;Parse to AST&quot; to view the syntax tree
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Selected Node Details */}
      {selectedNode && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Selected Node Details</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-xs text-gray-500">Type</span>
              <p className="font-mono text-sm font-medium text-gray-900">{selectedNode.type}</p>
            </div>
            <div>
              <span className="text-xs text-gray-500">Named</span>
              <p className="font-mono text-sm font-medium text-gray-900">
                {selectedNode.isNamed ? 'Yes' : 'No'}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-500">Start</span>
              <p className="font-mono text-sm font-medium text-gray-900">
                Line {selectedNode.startPosition.row + 1}, Col {selectedNode.startPosition.column}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-500">End</span>
              <p className="font-mono text-sm font-medium text-gray-900">
                Line {selectedNode.endPosition.row + 1}, Col {selectedNode.endPosition.column}
              </p>
            </div>
          </div>
          {selectedNode.text && (
            <div className="mt-4">
              <span className="text-xs text-gray-500">Text Content</span>
              <pre className="mt-1 p-3 bg-gray-50 rounded-lg text-sm font-mono overflow-x-auto max-h-40">
                {selectedNode.text}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Node Type Legend</h3>
        <div className="flex flex-wrap gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-blue-500"></span>
            <span>Classes/Interfaces</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-purple-500"></span>
            <span>Functions/Methods</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-green-500"></span>
            <span>Identifiers</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-orange-500"></span>
            <span>Literals (strings, numbers)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-cyan-500"></span>
            <span>Types</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-pink-500"></span>
            <span>Keywords/Operators</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded bg-gray-400"></span>
            <span>Anonymous nodes</span>
          </div>
        </div>
      </div>
    </div>
  );
}
