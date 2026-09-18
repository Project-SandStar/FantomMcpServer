'use client';

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { Core, ElementDefinition, LayoutOptions } from 'cytoscape';

// Register dagre layout extension
if (typeof cytoscape('layout', 'dagre') === 'undefined') {
  cytoscape.use(dagre);
}

// ============================================
// Types
// ============================================

export interface GraphNode {
  id: string;
  label: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  color?: string;
  isFocal?: boolean;
  language?: string;
  parent?: string;  // For Cytoscape compound nodes
  isGroup?: boolean; // True for language group nodes
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  color?: string;
}

export interface LanguageGroup {
  id: string;
  label: string;
  language: string;
  color: string;
  count: number;
}

export interface GraphData {
  elements: {
    nodes: Array<{ data: GraphNode }>;
    edges: Array<{ data: GraphEdge }>;
  };
  metadata?: {
    title?: string;
    description?: string;
    nodeCount: number;
    edgeCount: number;
    focalNodeId?: string;
    languageGroups?: LanguageGroup[];
  };
}

export interface GraphViewerProps {
  data: GraphData | null;
  layout?: 'dagre' | 'cose' | 'breadthfirst' | 'circle' | 'grid' | 'concentric';
  onNodeClick?: (node: GraphNode) => void;
  onNodeDoubleClick?: (node: GraphNode) => void;
  height?: string;
  className?: string;
  showMinimap?: boolean;
  selectedLanguage?: string; // Currently selected language (single select)
  onLanguageSelect?: (language: string | null) => void;
  minConnections?: number; // Filter nodes with fewer than N connections
  showIsolatedNodes?: boolean; // Show nodes with 0 connections when minConnections is 0
}

// ============================================
// Colors
// ============================================

const NODE_TYPE_COLORS: Record<string, string> = {
  type: '#4B8BBE',
  class: '#4B8BBE',
  method: '#306998',
  constructor: '#FFE873',
  field: '#9B59B6',
  function: '#2ECC71',
  mixin: '#9B59B6',
  enum: '#E67E22',
  'css-rule': '#264DE4',
  interface: '#3498DB',
  default: '#95A5A6'
};

const EDGE_TYPE_COLORS: Record<string, string> = {
  calls: '#2C3E50',
  extends: '#E74C3C',
  implements: '#3498DB',
  contains: '#95A5A6',
  uses: '#F39C12',
  returns: '#1ABC9C',
  parameters: '#9B59B6',
  overrides: '#E67E22'
};

const LANGUAGE_COLORS: Record<string, string> = {
  fantom: '#1E88E5',
  typescript: '#3178C6',
  javascript: '#F7DF1E',
  css: '#264DE4',
  dart: '#0175C2',
  vue: '#42B883',
  python: '#3776AB',
  java: '#ED8B00',
  go: '#00ADD8',
  rust: '#DEA584',
  kotlin: '#7F52FF',
  swift: '#FA7343',
  default: '#95A5A6'
};

// ============================================
// Cytoscape Stylesheet
// ============================================

type CytoscapeStylesheet = {
  selector: string;
  style: Record<string, unknown>;
};

const getStylesheet = (): CytoscapeStylesheet[] => {
  return [
    // Regular nodes
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '10px',
        'font-family': 'Inter, system-ui, sans-serif',
        'color': '#333',
        'text-outline-width': 2,
        'text-outline-color': '#fff',
        'width': 40,
        'height': 40,
        'border-width': 2,
        'border-color': '#333',
        'text-wrap': 'ellipsis',
        'text-max-width': '80px'
      }
    },
    // Focal node styling
    {
      selector: 'node[?isFocal]',
      style: {
        'border-width': 4,
        'border-color': '#E74C3C',
        'width': 50,
        'height': 50,
        'font-weight': 'bold',
        'z-index': 999
      }
    },
    // Bridge nodes (cross-language connections, shown dimmed)
    {
      selector: 'node[?isBridge]',
      style: {
        'opacity': 0.5,
        'border-style': 'dashed',
        'width': 30,
        'height': 30,
        'font-size': '8px'
      }
    },
    // Selected node
    {
      selector: 'node:selected',
      style: {
        'border-width': 4,
        'border-color': '#3B82F6',
        'background-color': '#93C5FD'
      }
    },
    // Active node
    {
      selector: 'node:active',
      style: {
        'overlay-color': '#3B82F6',
        'overlay-opacity': 0.3
      }
    },
    // Edges
    {
      selector: 'edge',
      style: {
        'width': 2,
        'line-color': 'data(color)',
        'target-arrow-color': 'data(color)',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 1.2
      }
    },
    // Extends edges (dashed)
    {
      selector: 'edge[edgeType = "extends"]',
      style: {
        'line-style': 'dashed'
      }
    },
    // Implements edges (dotted)
    {
      selector: 'edge[edgeType = "implements"]',
      style: {
        'line-style': 'dotted'
      }
    },
    // Async call edges (dashed with special color)
    {
      selector: 'edge[?isAsync]',
      style: {
        'line-style': 'dashed',
        'line-color': '#FF5722',
        'target-arrow-color': '#FF5722'
      }
    },
    // Selected edges
    {
      selector: 'edge:selected',
      style: {
        'width': 4,
        'line-color': '#3B82F6',
        'target-arrow-color': '#3B82F6'
      }
    }
  ];
};

// ============================================
// Layout Options
// ============================================

const getLayoutOptions = (layoutName: string): LayoutOptions => {
  const baseOptions = {
    name: layoutName,
    animate: true,
    animationDuration: 500,
    fit: true,
    padding: 40
  };

  switch (layoutName) {
    case 'dagre':
      return {
        ...baseOptions,
        name: 'dagre',
        rankDir: 'TB',
        nodeSep: 40,
        rankSep: 60,
        edgeSep: 10
      } as LayoutOptions;

    case 'cose':
      return {
        ...baseOptions,
        name: 'cose',
        nodeRepulsion: () => 5000,
        idealEdgeLength: () => 60,
        edgeElasticity: () => 50,
        nestingFactor: 5,
        gravity: 0.4,
        gravityRange: 3.8,
        numIter: 2000,
        componentSpacing: 80,
        coolingFactor: 0.99,
        nodeDimensionsIncludeLabels: true,
        tile: true,
        tilingPaddingVertical: 60,
        tilingPaddingHorizontal: 60
      } as LayoutOptions;

    case 'breadthfirst':
      return {
        ...baseOptions,
        name: 'breadthfirst',
        directed: true,
        spacingFactor: 1.5,
        circle: false
      } as LayoutOptions;

    case 'concentric':
      return {
        ...baseOptions,
        name: 'concentric',
        minNodeSpacing: 60,
        concentric: (node: { data: (key: string) => boolean }) => {
          return node.data('isFocal') ? 10 : 1;
        },
        levelWidth: () => 2
      } as LayoutOptions;

    case 'circle':
      return {
        ...baseOptions,
        name: 'circle',
        spacingFactor: 1.5
      } as LayoutOptions;

    case 'grid':
      return {
        ...baseOptions,
        name: 'grid',
        rows: undefined,
        cols: undefined
      } as LayoutOptions;

    default:
      return {
        ...baseOptions,
        name: 'cose'
      } as LayoutOptions;
  }
};

// ============================================
// GraphViewer Component
// ============================================

export function GraphViewer({
  data,
  layout = 'cose',
  onNodeClick,
  onNodeDoubleClick,
  height = '600px',
  className = '',
  selectedLanguage,
  onLanguageSelect,
  minConnections = 0,
  showIsolatedNodes = true
}: GraphViewerProps) {
  const cyRef = useRef<Core | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Extract language groups from metadata
  const languageGroups = useMemo(() => {
    return data?.metadata?.languageGroups || [];
  }, [data]);

  // Auto-select first language if none selected and we have language groups
  useEffect(() => {
    if (languageGroups.length > 0 && !selectedLanguage && onLanguageSelect) {
      // Default to first language (most common)
      onLanguageSelect(languageGroups[0].language);
    }
  }, [languageGroups, selectedLanguage, onLanguageSelect]);

  // Check if a language should be visible - single language selection only
  const isLanguageVisible = useCallback((language: string | undefined): boolean => {
    const normalizedLang = language || 'fantom';
    // If a language is selected, only show that language
    if (selectedLanguage) {
      return normalizedLang === selectedLanguage;
    }
    // If we have language groups but no selection yet, show nothing until auto-select
    if (languageGroups.length > 0) {
      return false;
    }
    // No language filtering - show all
    return true;
  }, [selectedLanguage, languageGroups]);

  // Build a node ID lookup map for efficient edge filtering
  const nodeIdMap = useMemo(() => {
    if (!data) return new Map<string, GraphNode>();
    const map = new Map<string, GraphNode>();
    for (const n of data.elements.nodes) {
      map.set(n.data.id, n.data);
    }
    return map;
  }, [data]);

  // Calculate edge count for each node
  const nodeEdgeCounts = useMemo(() => {
    if (!data) return new Map<string, number>();
    const counts = new Map<string, number>();

    // Initialize all nodes with 0
    for (const n of data.elements.nodes) {
      counts.set(n.data.id, 0);
    }

    // Count edges for each node (both source and target count)
    for (const e of data.elements.edges) {
      counts.set(e.data.source, (counts.get(e.data.source) || 0) + 1);
      counts.set(e.data.target, (counts.get(e.data.target) || 0) + 1);
    }

    return counts;
  }, [data]);

  // Filter elements based on language filters and min connections
  const elements: ElementDefinition[] = useMemo(() => {
    if (!data) return [];

    // First, filter nodes by language AND connection count (skip group nodes)
    const primaryNodes = data.elements.nodes.filter(n => {
      // Skip group nodes entirely - no compound nodes
      if (n.data.isGroup) {
        return false;
      }

      const lang = n.data.language || 'fantom';

      // Check language visibility first
      if (!isLanguageVisible(lang)) {
        return false;
      }

      // Check connection count filter
      const edgeCount = nodeEdgeCounts.get(n.data.id) || 0;

      // If minConnections is 0, check showIsolatedNodes for nodes with 0 edges
      if (minConnections === 0) {
        return edgeCount === 0 ? showIsolatedNodes : true;
      }

      // Filter by minimum connections
      return edgeCount >= minConnections;
    });

    // Build set of primary visible node IDs
    const primaryNodeIds = new Set(primaryNodes.map(n => n.data.id));

    // Find cross-language edges: edges where one endpoint is a primary node
    // and the other is from a different language. This allows CSS nodes to show
    // their connections to TypeScript files, etc.
    const bridgeNodeIds = new Set<string>();
    const crossLanguageEdges = data.elements.edges.filter(e => {
      const sourceVisible = primaryNodeIds.has(e.data.source);
      const targetVisible = primaryNodeIds.has(e.data.target);
      // Already fully visible - skip here, will be included below
      if (sourceVisible && targetVisible) return false;
      // One endpoint is visible, the other is not - this is a cross-language edge
      if (sourceVisible && !targetVisible) {
        // Check the target node exists in data
        if (nodeIdMap.has(e.data.target)) {
          bridgeNodeIds.add(e.data.target);
          return true;
        }
      }
      if (targetVisible && !sourceVisible) {
        // Check the source node exists in data
        if (nodeIdMap.has(e.data.source)) {
          bridgeNodeIds.add(e.data.source);
          return true;
        }
      }
      return false;
    });

    // Get bridge node data from the original data
    const bridgeNodes = bridgeNodeIds.size > 0
      ? data.elements.nodes.filter(n => bridgeNodeIds.has(n.data.id) && !n.data.isGroup)
      : [];

    // Combine primary + bridge node IDs for edge filtering
    const allVisibleIds = new Set([...primaryNodeIds, ...bridgeNodeIds]);

    // Filter edges - both source AND target must be visible (primary or bridge)
    const filteredEdges = data.elements.edges.filter(e => {
      return allVisibleIds.has(e.data.source) && allVisibleIds.has(e.data.target);
    });

    return [
      // Map primary nodes with proper colors
      ...primaryNodes.map(n => {
        const lang = n.data.language || 'fantom';
        return {
          data: {
            ...n.data,
            language: lang,
            color: n.data.color || NODE_TYPE_COLORS[n.data.nodeType] || NODE_TYPE_COLORS.default
          }
        };
      }),
      // Map bridge nodes with dimmed opacity to show they're from a different language
      ...bridgeNodes.map(n => {
        const lang = n.data.language || 'fantom';
        return {
          data: {
            ...n.data,
            language: lang,
            color: n.data.color || NODE_TYPE_COLORS[n.data.nodeType] || NODE_TYPE_COLORS.default,
            isBridge: true // Flag for styling
          }
        };
      }),
      // Map edges with proper colors
      ...filteredEdges.map(e => ({
        data: {
          ...e.data,
          color: e.data.color || EDGE_TYPE_COLORS[e.data.edgeType] || EDGE_TYPE_COLORS.calls
        }
      }))
    ];
  }, [data, isLanguageVisible, nodeEdgeCounts, nodeIdMap, minConnections, showIsolatedNodes]);

  // Handle cytoscape initialization
  const handleCyInit = useCallback((cy: Core) => {
    cyRef.current = cy;

    // Node click handler
    cy.on('tap', 'node', (event) => {
      const node = event.target;
      const nodeData = node.data() as GraphNode;
      setSelectedNode(nodeData);
      if (onNodeClick) {
        onNodeClick(nodeData);
      }
    });

    // Node double click handler
    cy.on('dbltap', 'node', (event) => {
      const node = event.target;
      const nodeData = node.data() as GraphNode;
      if (onNodeDoubleClick) {
        onNodeDoubleClick(nodeData);
      }
    });

    // Background click to deselect
    cy.on('tap', (event) => {
      if (event.target === cy) {
        setSelectedNode(null);
      }
    });
  }, [onNodeClick, onNodeDoubleClick]);

  // Run layout when data or layout changes
  useEffect(() => {
    if (cyRef.current && data && elements.length > 0) {
      const cy = cyRef.current;
      const layoutOptions = getLayoutOptions(layout);
      const layoutInstance = cy.layout(layoutOptions);
      layoutInstance.run();
    }
  }, [data, layout, elements.length]);


  // Zoom controls
  const handleZoomIn = () => {
    if (cyRef.current) {
      cyRef.current.zoom(cyRef.current.zoom() * 1.3);
    }
  };

  const handleZoomOut = () => {
    if (cyRef.current) {
      cyRef.current.zoom(cyRef.current.zoom() / 1.3);
    }
  };

  const handleFit = () => {
    if (cyRef.current) {
      cyRef.current.fit(undefined, 50);
    }
  };

  const handleCenter = () => {
    if (cyRef.current) {
      cyRef.current.center();
    }
  };

  if (!data || elements.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200 ${className}`}
        style={{ height }}
      >
        <div className="text-center text-gray-500">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <p className="text-lg font-medium">No graph data</p>
          <p className="text-sm mt-1">Select a node to visualize its relationships</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {/* Graph Container */}
      <div className="rounded-lg border border-gray-200 overflow-hidden bg-white" style={{ height }}>
        <CytoscapeComponent
          elements={elements}
          stylesheet={getStylesheet()}
          cy={handleCyInit}
          style={{ width: '100%', height: '100%' }}
          userZoomingEnabled={true}
          userPanningEnabled={true}
          boxSelectionEnabled={true}
          autoungrabify={false}
          minZoom={0.1}
          maxZoom={3}
        />
      </div>

      {/* Controls */}
      <div className="absolute top-4 right-4 flex flex-col gap-1 bg-white rounded-lg shadow-lg border border-gray-200 p-1">
        <button
          onClick={handleZoomIn}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title="Zoom In"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
          </svg>
        </button>
        <button
          onClick={handleZoomOut}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title="Zoom Out"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
          </svg>
        </button>
        <div className="h-px bg-gray-200 my-1" />
        <button
          onClick={handleFit}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title="Fit to View"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
        <button
          onClick={handleCenter}
          className="p-2 hover:bg-gray-100 rounded transition-colors"
          title="Center"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </div>

      {/* Selected Node Info */}
      {selectedNode && (
        <div className="absolute bottom-4 left-4 right-4 bg-white rounded-lg shadow-lg border border-gray-200 p-4 max-w-md">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="px-2 py-0.5 text-xs font-medium rounded"
                  style={{
                    backgroundColor: `${NODE_TYPE_COLORS[selectedNode.nodeType] || NODE_TYPE_COLORS.default}20`,
                    color: NODE_TYPE_COLORS[selectedNode.nodeType] || NODE_TYPE_COLORS.default
                  }}
                >
                  {selectedNode.nodeType}
                </span>
                {selectedNode.language && (
                  <span
                    className="px-2 py-0.5 text-xs font-medium rounded"
                    style={{
                      backgroundColor: `${LANGUAGE_COLORS[selectedNode.language] || LANGUAGE_COLORS.default}20`,
                      color: LANGUAGE_COLORS[selectedNode.language] || LANGUAGE_COLORS.default
                    }}
                  >
                    {selectedNode.language}
                  </span>
                )}
                <h4 className="font-semibold text-gray-900 truncate">{selectedNode.label}</h4>
              </div>
              <p className="text-xs text-gray-500 font-mono truncate">{selectedNode.qualifiedName}</p>
              <p className="text-xs text-gray-400 mt-1 truncate">
                {selectedNode.filePath}:{selectedNode.lineStart}
              </p>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="p-1 hover:bg-gray-100 rounded"
            >
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Metadata */}
      {data.metadata && (
        <div className="absolute top-4 left-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2">
          <p className="text-sm font-medium text-gray-700">{data.metadata.title}</p>
          <p className="text-xs text-gray-500">
            {data.metadata.nodeCount} nodes, {data.metadata.edgeCount} edges
          </p>
        </div>
      )}

      {/* Language Legend (when multiple languages present) */}
      {languageGroups.length > 0 && (
        <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2 max-w-xs">
          <p className="text-xs font-medium text-gray-600 mb-2">Language</p>
          <div className="flex flex-wrap gap-2">
            {languageGroups.map(group => {
              const isSelected = selectedLanguage === group.language;
              return (
                <button
                  key={group.language}
                  onClick={() => onLanguageSelect?.(group.language)}
                  className={`flex items-center gap-1 px-2 py-1 rounded transition-all ${
                    isSelected ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:bg-gray-100'
                  }`}
                >
                  <div
                    className="w-3 h-3 rounded-full border-2"
                    style={{
                      backgroundColor: isSelected ? group.color : 'transparent',
                      borderColor: group.color
                    }}
                  />
                  <span className="text-xs text-gray-600">{group.label}</span>
                  <span className="text-xs text-gray-400">({group.count})</span>
                </button>
              );
            })}
          </div>

          {/* Node types legend */}
          <div className="mt-3 pt-2 border-t border-gray-200">
            <p className="text-xs font-medium text-gray-600 mb-2">Node Types</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(NODE_TYPE_COLORS).filter(([key]) => key !== 'default').map(([type, color]) => (
                <div key={type} className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-xs text-gray-600">{type}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Fallback legend when no language groups */}
      {languageGroups.length === 0 && (
        <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2">
          <p className="text-xs font-medium text-gray-600 mb-2">Node Types</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(NODE_TYPE_COLORS).filter(([key]) => key !== 'default').map(([type, color]) => (
              <div key={type} className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-xs text-gray-600">{type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default GraphViewer;
