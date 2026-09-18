'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

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

  getUser(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }
}`,
  javascript: `class Calculator {
  constructor() {
    this.result = 0;
  }

  add(a, b) {
    return a + b;
  }

  multiply(a, b) {
    return a * b;
  }
}

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`,
  python: `from typing import List, Optional

class DataProcessor:
    def __init__(self, data: List[int]):
        self.data = data

    def process(self) -> List[int]:
        return [x * 2 for x in self.data]

    def find_max(self) -> Optional[int]:
        return max(self.data) if self.data else None

def factorial(n: int) -> int:
    if n <= 1:
        return 1
    return n * factorial(n - 1)`,
  vue: `<template>
  <div class="container">
    <h1>{{ title }}</h1>
    <button @click="increment">Count: {{ count }}</button>
    <ul>
      <li v-for="item in items" :key="item.id">
        {{ item.name }}
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const count = ref(0);
const title = 'Vue Component';
const items = ref([
  { id: 1, name: 'Item 1' },
  { id: 2, name: 'Item 2' },
]);

const increment = () => count.value++;
</script>`,
  fantom: `using sys

class Calculator {
  Int add(Int a, Int b) {
    return a + b
  }

  Int multiply(Int a, Int b) {
    return a * b
  }

  static Void main(Str[] args) {
    calc := Calculator()
    echo("2 + 3 = " + calc.add(2, 3))
    echo("4 * 5 = " + calc.multiply(4, 5))
  }
}`,
  json: `{
  "name": "mcp-fantom",
  "version": "1.0.0",
  "description": "Fantom MCP Server",
  "dependencies": {
    "express": "^5.0.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}`,
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sample Page</title>
</head>
<body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <h1>Welcome</h1>
    <p>This is a sample HTML page.</p>
  </main>
</body>
</html>`,
  css: `/* Main styles */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

.header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 2rem;
}

.button {
  display: inline-block;
  padding: 10px 20px;
  background-color: #3498db;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.button:hover {
  background-color: #2980b9;
}`,
};

export default function CodeParserPage() {
  const [code, setCode] = useState(sampleCode.typescript);
  const [language, setLanguage] = useState('typescript');
  const [parseResult, setParseResult] = useState<any>(null);

  // Fetch available grammars
  const { data: grammarsData, isLoading: loadingGrammars } = useQuery({
    queryKey: ['tree-sitter-grammars'],
    queryFn: api.getTreeSitterGrammars,
  });

  // Parse code mutation
  const parseMutation = useMutation({
    mutationFn: ({ code, language }: { code: string; language: string }) =>
      api.parseCode(code, language),
    onSuccess: (data) => {
      setParseResult(data);
    },
  });

  const handleLanguageChange = (newLang: string) => {
    setLanguage(newLang);
    if (sampleCode[newLang]) {
      setCode(sampleCode[newLang]);
    }
    setParseResult(null);
  };

  const handleParse = () => {
    parseMutation.mutate({ code, language });
  };

  const availableGrammars = grammarsData?.available || [];
  const supportedLanguages = grammarsData?.supported || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Code Parser</h1>
          <p className="text-gray-600 mt-1">
            Parse code using tree-sitter grammars
          </p>
        </div>
      </div>

      {/* Grammar Status */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold mb-3">Grammar Status</h2>
        {loadingGrammars ? (
          <div className="text-gray-500">Loading grammars...</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {supportedLanguages.map((lang: string) => {
              const isAvailable = availableGrammars.includes(lang);
              return (
                <span
                  key={lang}
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    isAvailable
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {lang}
                  {isAvailable ? ' ✓' : ' ✗'}
                </span>
              );
            })}
          </div>
        )}
        <p className="text-sm text-gray-500 mt-3">
          {availableGrammars.length} of {supportedLanguages.length} grammars available
        </p>
      </div>

      {/* Code Input */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Input */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Source Code</h2>
              <div className="flex items-center gap-3">
                <select
                  value={language}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {availableGrammars.map((lang: string) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleParse}
                  disabled={parseMutation.isPending || !code.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {parseMutation.isPending ? 'Parsing...' : 'Parse Code'}
                </button>
              </div>
            </div>
          </div>
          <div className="p-4">
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full h-96 font-mono text-sm p-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
              placeholder="Enter code to parse..."
              spellCheck={false}
            />
          </div>
        </div>

        {/* Right: Results */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold">Parse Results</h2>
          </div>
          <div className="p-4">
            {parseMutation.isPending ? (
              <div className="flex items-center justify-center h-96">
                <div className="flex flex-col items-center space-y-4">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
                  <div className="text-gray-500">Parsing...</div>
                </div>
              </div>
            ) : parseMutation.error ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <h3 className="text-red-800 font-medium">Parse Error</h3>
                <p className="text-red-600 mt-1">
                  {parseMutation.error instanceof Error
                    ? parseMutation.error.message
                    : 'Unknown error'}
                </p>
              </div>
            ) : parseResult ? (
              <div className="space-y-4 h-96 overflow-y-auto">
                {/* Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-blue-50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-blue-700">
                      {parseResult.classes?.length || 0}
                    </div>
                    <div className="text-xs text-blue-600">Classes</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-purple-700">
                      {parseResult.functions?.length || 0}
                    </div>
                    <div className="text-xs text-purple-600">Functions</div>
                  </div>
                  <div className="bg-green-50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-green-700">
                      {parseResult.imports?.length || 0}
                    </div>
                    <div className="text-xs text-green-600">Imports</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-gray-700">
                      {parseResult.parseTime || 0}ms
                    </div>
                    <div className="text-xs text-gray-600">Parse Time</div>
                  </div>
                </div>

                {/* Errors */}
                {parseResult.errors && parseResult.errors.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <h3 className="font-medium text-red-800 mb-2">
                      Parse Errors ({parseResult.errors.length})
                    </h3>
                    <ul className="space-y-1 text-sm text-red-600">
                      {parseResult.errors.map((err: any, i: number) => (
                        <li key={i} className="font-mono">
                          Line {err.location?.startLine || '?'}: {err.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Classes */}
                {parseResult.classes && parseResult.classes.length > 0 && (
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Classes</h3>
                    <div className="space-y-2">
                      {parseResult.classes.map((cls: any, i: number) => (
                        <div
                          key={i}
                          className="bg-blue-50 border border-blue-100 rounded-lg p-3"
                        >
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 bg-blue-200 text-blue-800 text-xs rounded">
                              class
                            </span>
                            <span className="font-semibold text-gray-900">
                              {cls.name}
                            </span>
                            {cls.extends && (
                              <span className="text-sm text-gray-500">
                                extends {cls.extends}
                              </span>
                            )}
                          </div>
                          {cls.methods && cls.methods.length > 0 && (
                            <div className="mt-2 text-sm text-gray-600">
                              Methods: {cls.methods.map((m: any) => m.name).join(', ')}
                            </div>
                          )}
                          {cls.fields && cls.fields.length > 0 && (
                            <div className="text-sm text-gray-600">
                              Fields: {cls.fields.map((f: any) => f.name).join(', ')}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Functions */}
                {parseResult.functions && parseResult.functions.length > 0 && (
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Functions</h3>
                    <div className="space-y-2">
                      {parseResult.functions.map((func: any, i: number) => (
                        <div
                          key={i}
                          className="bg-purple-50 border border-purple-100 rounded-lg p-3"
                        >
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 bg-purple-200 text-purple-800 text-xs rounded">
                              {func.isAsync ? 'async fn' : 'fn'}
                            </span>
                            <span className="font-semibold text-gray-900">
                              {func.name}
                            </span>
                            {func.returnType && (
                              <span className="text-sm text-gray-500">
                                : {func.returnType}
                              </span>
                            )}
                          </div>
                          {func.signature && (
                            <div className="mt-1 text-sm font-mono text-gray-600 bg-white rounded px-2 py-1">
                              {func.signature}
                            </div>
                          )}
                          <div className="text-xs text-gray-500 mt-1">
                            Line {func.location?.startLine || '?'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Imports */}
                {parseResult.imports && parseResult.imports.length > 0 && (
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Imports</h3>
                    <div className="space-y-1">
                      {parseResult.imports.map((imp: any, i: number) => (
                        <div
                          key={i}
                          className="bg-green-50 border border-green-100 rounded px-3 py-2 text-sm"
                        >
                          <span className="text-green-700 font-mono">
                            {imp.source}
                          </span>
                          {imp.items && imp.items.length > 0 && (
                            <span className="text-gray-500 ml-2">
                              ({imp.items.map((it: any) => it.name).join(', ')})
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* No results */}
                {!parseResult.classes?.length &&
                  !parseResult.functions?.length &&
                  !parseResult.imports?.length &&
                  !parseResult.errors?.length && (
                    <div className="text-center text-gray-500 py-8">
                      No structures extracted from this code
                    </div>
                  )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-96 text-gray-500">
                Click &quot;Parse Code&quot; to analyze the source code
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
