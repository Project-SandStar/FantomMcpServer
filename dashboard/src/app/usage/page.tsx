'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, UsageStats } from '@/lib/api';

export default function UsagePage() {
  const [days, setDays] = useState(7);

  const { data: usage, isLoading, error } = useQuery({
    queryKey: ['usage', days],
    queryFn: () => api.getUsage(days),
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading usage statistics...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-red-800 font-medium">Failed to load usage statistics</h2>
        <p className="text-red-600 mt-1">
          {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      </div>
    );
  }

  if (!usage) return null;

  // Calculate tool usage percentages
  const totalToolCalls = Object.values(usage.toolUsage).reduce((a, b) => a + b, 0);
  const toolUsageEntries = Object.entries(usage.toolUsage)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usage Analytics</h1>
          <p className="text-gray-600 mt-1">
            Statistics from {new Date(usage.periodStart).toLocaleDateString()} to{' '}
            {new Date(usage.periodEnd).toLocaleDateString()}
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value))}
          className="rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
            Total Tool Calls
          </h3>
          <p className="mt-2 text-3xl font-semibold text-gray-900">
            {usage.totalToolCalls.toLocaleString()}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
            Total Searches
          </h3>
          <p className="mt-2 text-3xl font-semibold text-gray-900">
            {usage.totalSearches.toLocaleString()}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
            Unique Tools Used
          </h3>
          <p className="mt-2 text-3xl font-semibold text-gray-900">
            {Object.keys(usage.toolUsage).length}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tool Usage */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Tool Usage</h2>
          {toolUsageEntries.length > 0 ? (
            <div className="space-y-3">
              {toolUsageEntries.map(([name, count]) => {
                const percentage = totalToolCalls > 0 ? (count / totalToolCalls) * 100 : 0;
                return (
                  <div key={name}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-mono text-gray-700 truncate max-w-[60%]" title={name}>
                        {name}
                      </span>
                      <span className="text-gray-500">
                        {count} ({percentage.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No tool usage data available</p>
          )}
        </div>

        {/* Top Searches */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Searches</h2>
          {usage.topSearches.length > 0 ? (
            <div className="overflow-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 text-sm font-medium text-gray-500">Query</th>
                    <th className="text-right py-2 text-sm font-medium text-gray-500">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.topSearches.slice(0, 15).map((search, i) => (
                    <tr key={i} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 text-sm text-gray-700 truncate max-w-[200px]" title={search.query}>
                        {search.query}
                      </td>
                      <td className="py-2 text-sm text-gray-500 text-right">
                        {search.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No search data available</p>
          )}
        </div>
      </div>

      {/* Recent Searches */}
      <div className="mt-6 bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Searches</h2>
        {usage.recentSearches && usage.recentSearches.length > 0 ? (
          <div className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 text-sm font-medium text-gray-500">Query</th>
                  <th className="text-left py-2 text-sm font-medium text-gray-500">Source</th>
                  <th className="text-right py-2 text-sm font-medium text-gray-500">Results</th>
                  <th className="text-right py-2 text-sm font-medium text-gray-500">Time</th>
                </tr>
              </thead>
              <tbody>
                {usage.recentSearches.map((search, i) => (
                  <tr key={i} className="border-b border-gray-100 last:border-0">
                    <td className="py-2 text-sm text-gray-700 truncate max-w-[200px]" title={search.query}>
                      {search.query}
                    </td>
                    <td className="py-2 text-sm text-gray-500">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                        {search.source}
                      </span>
                    </td>
                    <td className="py-2 text-sm text-gray-500 text-right">
                      {search.resultCount}
                    </td>
                    <td className="py-2 text-sm text-gray-500 text-right whitespace-nowrap">
                      {new Date(search.timestamp).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No recent searches</p>
        )}
      </div>

      {/* Raw Data */}
      <div className="mt-6 bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Raw Data</h2>
        <details className="group">
          <summary className="cursor-pointer text-sm text-blue-600 hover:text-blue-700">
            Click to view raw JSON data
          </summary>
          <pre className="mt-4 bg-gray-900 text-gray-100 p-4 rounded-lg text-xs overflow-auto max-h-96">
            {JSON.stringify(usage, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
