'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, FantomInstance } from '@/lib/api';

interface InstanceSelectorProps {
  compact?: boolean;
}

export default function InstanceSelector({ compact = false }: InstanceSelectorProps) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  // Fetch all instances
  const { data: instancesData } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  // Fetch active instance
  const { data: activeData } = useQuery({
    queryKey: ['active-instance'],
    queryFn: api.getActiveInstance,
  });

  // Set active instance mutation
  const setActiveMutation = useMutation({
    mutationFn: (instanceId: number | null) => api.setActiveInstance(instanceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-instance'] });
    },
  });

  const instances = instancesData?.instances || [];
  const activeInstance = activeData?.active ? activeData.instance : null;

  const handleSelect = (instance: FantomInstance | null) => {
    setActiveMutation.mutate(instance?.id ?? null);
    setIsOpen(false);
  };

  // Type badge colors
  const getTypeBadgeColor = (type: string) => {
    switch (type) {
      case 'skyspark':
        return 'bg-blue-100 text-blue-800';
      case 'haxall':
        return 'bg-green-100 text-green-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (compact) {
    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
          </svg>
          <span className="truncate max-w-32">
            {activeInstance ? activeInstance.name : 'No Instance'}
          </span>
          {activeInstance && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${getTypeBadgeColor(activeInstance.type)}`}>
              {activeInstance.type}
            </span>
          )}
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {isOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
            <div className="absolute left-0 mt-1 w-64 bg-white rounded-md shadow-lg z-20 border border-gray-200 max-h-80 overflow-y-auto">
              {instances.length === 0 ? (
                <div className="p-3 text-sm text-gray-500">
                  No instances configured.
                  <a href="/instances" className="block text-blue-600 hover:underline mt-1">
                    Add an instance
                  </a>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => handleSelect(null)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${
                      !activeInstance ? 'bg-gray-50 font-medium' : ''
                    }`}
                  >
                    <span className="text-gray-500">None (use default)</span>
                  </button>
                  {instances.map((instance) => (
                    <button
                      key={instance.id}
                      onClick={() => handleSelect(instance)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${
                        activeInstance?.id === instance.id ? 'bg-blue-50' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`font-medium ${!instance.isValid ? 'text-red-600' : ''}`}>
                          {instance.name}
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${getTypeBadgeColor(instance.type)}`}>
                          {instance.type}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">{instance.path}</div>
                      {!instance.isValid && (
                        <div className="text-xs text-red-500">Invalid path</div>
                      )}
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // Full-size version for settings page
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Active Instance</h3>
      <select
        value={activeInstance?.id || ''}
        onChange={(e) => {
          const id = e.target.value ? parseInt(e.target.value, 10) : null;
          handleSelect(id ? instances.find((i) => i.id === id) || null : null);
        }}
        className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="">None (use default)</option>
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id}>
            {instance.name} ({instance.type})
            {!instance.isValid ? ' - Invalid' : ''}
          </option>
        ))}
      </select>
      {activeInstance && (
        <div className="mt-2 text-xs text-gray-500">
          <div>Path: {activeInstance.path}</div>
          <div>Fan: {activeInstance.fanExecutable}</div>
        </div>
      )}
    </div>
  );
}
