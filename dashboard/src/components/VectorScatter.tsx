'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';

// ============================================
// Types
// ============================================

export interface VectorPoint {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  x: number;
  y: number;
  score?: number;  // For search results
  language?: string; // Language for grouping
}

export interface LanguageGroup {
  language: string;
  label: string;
  color: string;
  count: number;
}

export interface VectorScatterProps {
  data: VectorPoint[];
  highlightIds?: Set<string>;
  onPointClick?: (point: VectorPoint) => void;
  onPointHover?: (point: VectorPoint | null) => void;
  height?: number;
  colorBy?: 'nodeType' | 'file' | 'score' | 'language';
  sizeBy?: 'uniform' | 'score';
  showLabels?: boolean;
  className?: string;
  // Language filtering
  enableLanguageGrouping?: boolean;
  languageFilters?: Set<string>; // Languages to show (empty = show all)
  selectedLanguage?: string | null; // Currently selected language
  onLanguageSelect?: (language: string | null) => void;
  // GPU rendering
  useGPU?: boolean; // Use Canvas/WebGL for GPU acceleration
}

// ============================================
// Color Schemes
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
// VectorScatter Component
// ============================================

export function VectorScatter({
  data,
  highlightIds,
  onPointClick,
  onPointHover,
  height = 500,
  colorBy = 'nodeType',
  sizeBy = 'uniform',
  showLabels = false,
  className = '',
  enableLanguageGrouping = false,
  languageFilters = new Set(),
  selectedLanguage = null,
  onLanguageSelect,
  useGPU = true // Default to GPU rendering for performance
}: VectorScatterProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height });
  const [hoveredPoint, setHoveredPoint] = useState<VectorPoint | null>(null);
  const [transform, setTransform] = useState(d3.zoomIdentity);

  // Extract unique languages from data
  const languageGroups: LanguageGroup[] = useMemo(() => {
    if (!enableLanguageGrouping) return [];

    const langCounts = new Map<string, number>();
    for (const point of data) {
      const lang = point.language || 'fantom';
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }

    return Array.from(langCounts.entries())
      .map(([language, count]) => ({
        language,
        label: language.charAt(0).toUpperCase() + language.slice(1),
        color: LANGUAGE_COLORS[language] || LANGUAGE_COLORS.default,
        count
      }))
      .sort((a, b) => b.count - a.count); // Sort by count descending
  }, [data, enableLanguageGrouping]);

  // Auto-select first language if none selected and grouping is enabled
  useEffect(() => {
    if (enableLanguageGrouping && languageGroups.length > 0 && selectedLanguage === null && onLanguageSelect) {
      // Default to first language (most common)
      onLanguageSelect(languageGroups[0].language);
    }
  }, [enableLanguageGrouping, languageGroups, selectedLanguage, onLanguageSelect]);

  // Check if a language should be visible
  // Single language selection - only show selected language, never all
  const isLanguageVisible = useCallback((language: string | undefined): boolean => {
    const normalizedLang = language || 'fantom';
    // If a language is selected, only show that language
    if (selectedLanguage) {
      return normalizedLang === selectedLanguage;
    }
    // If no language selected yet (initial state), show nothing until auto-select kicks in
    // This prevents loading all languages at once
    if (enableLanguageGrouping && languageGroups.length > 0) {
      return false;
    }
    // Fall back to languageFilters if provided
    if (languageFilters.size > 0) {
      return languageFilters.has(normalizedLang);
    }
    return true;
  }, [languageFilters, selectedLanguage, enableLanguageGrouping, languageGroups]);

  // Filter data based on language
  const filteredData = useMemo(() => {
    if (!enableLanguageGrouping) return data;
    return data.filter(point => isLanguageVisible(point.language));
  }, [data, enableLanguageGrouping, isLanguageVisible]);

  // Update dimensions on resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width } = containerRef.current.getBoundingClientRect();
        setDimensions({ width, height });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, [height]);

  // Get color for a point
  const getColor = useCallback((point: VectorPoint): string => {
    if (colorBy === 'language') {
      const lang = point.language || 'fantom';
      return LANGUAGE_COLORS[lang] || LANGUAGE_COLORS.default;
    }
    if (colorBy === 'nodeType') {
      return NODE_TYPE_COLORS[point.nodeType] || NODE_TYPE_COLORS.default;
    }
    if (colorBy === 'file') {
      // Hash file path to color
      let hash = 0;
      for (let i = 0; i < point.filePath.length; i++) {
        hash = ((hash << 5) - hash) + point.filePath.charCodeAt(i);
        hash = hash & hash;
      }
      return d3.hsl(Math.abs(hash % 360), 0.7, 0.5).formatHex();
    }
    if (colorBy === 'score' && point.score !== undefined) {
      // Color from red (low) to green (high)
      const color = d3.interpolateRdYlGn(point.score);
      return color;
    }
    return NODE_TYPE_COLORS.default;
  }, [colorBy]);

  // Get size for a point
  const getSize = useCallback((point: VectorPoint): number => {
    const baseSize = 5;
    if (sizeBy === 'score' && point.score !== undefined) {
      return baseSize + point.score * 10;
    }
    return baseSize;
  }, [sizeBy]);

  // GPU-accelerated Canvas rendering
  useEffect(() => {
    if (!useGPU || !canvasRef.current || filteredData.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true // Enable GPU acceleration hint
    });
    if (!ctx) return;

    const { width, height: h } = dimensions;
    const margin = { top: 20, right: 20, bottom: 30, left: 40 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = h - margin.top - margin.bottom;

    // Set canvas size with device pixel ratio for sharp rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    // Calculate data extent
    const xExtent = d3.extent(filteredData, d => d.x) as [number, number];
    const yExtent = d3.extent(filteredData, d => d.y) as [number, number];

    // Add padding to extent
    const xPadding = (xExtent[1] - xExtent[0]) * 0.1 || 1;
    const yPadding = (yExtent[1] - yExtent[0]) * 0.1 || 1;

    // Create scales
    const xScale = d3.scaleLinear()
      .domain([xExtent[0] - xPadding, xExtent[1] + xPadding])
      .range([0, innerWidth]);

    const yScale = d3.scaleLinear()
      .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
      .range([innerHeight, 0]);

    // Clear canvas
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, h);

    // Apply transform
    ctx.save();
    ctx.translate(margin.left + transform.x, margin.top + transform.y);
    ctx.scale(transform.k, transform.k);

    // Draw points - batch by color for better GPU performance
    const pointsByColor = new Map<string, VectorPoint[]>();
    for (const point of filteredData) {
      const color = getColor(point);
      if (!pointsByColor.has(color)) {
        pointsByColor.set(color, []);
      }
      pointsByColor.get(color)!.push(point);
    }

    // Render batched by color
    for (const [color, points] of pointsByColor) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const point of points) {
        const x = xScale(point.x);
        const y = yScale(point.y);
        const r = getSize(point);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fill();

      // Draw borders for highlighted points
      for (const point of points) {
        if (highlightIds?.has(point.id)) {
          const x = xScale(point.x);
          const y = yScale(point.y);
          const r = getSize(point);
          ctx.strokeStyle = '#E74C3C';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
    }

    // Draw labels if enabled (only for visible points)
    if (showLabels && filteredData.length < 200) {
      ctx.fillStyle = '#333';
      ctx.font = '9px Inter, system-ui, sans-serif';
      for (const point of filteredData) {
        const x = xScale(point.x);
        const y = yScale(point.y);
        ctx.fillText(point.name, x + 8, y + 4);
      }
    }

    ctx.restore();

    // Draw axes
    ctx.fillStyle = '#666';
    ctx.font = '10px Inter, system-ui, sans-serif';

    // X axis
    const xTicks = xScale.ticks(5);
    for (const tick of xTicks) {
      const x = margin.left + xScale(tick);
      ctx.fillText(tick.toFixed(1), x - 10, h - 10);
    }

    // Y axis
    const yTicks = yScale.ticks(5);
    for (const tick of yTicks) {
      const y = margin.top + yScale(tick);
      ctx.fillText(tick.toFixed(1), 5, y + 3);
    }

    // Store scales for click handling
    (canvas as any)._scales = { xScale, yScale, margin };
    (canvas as any)._data = filteredData;

  }, [filteredData, dimensions, transform, getColor, getSize, highlightIds, showLabels, useGPU]);

  // Canvas zoom and interaction handlers
  useEffect(() => {
    if (!useGPU || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const { width, height: h } = dimensions;
    const margin = { top: 20, right: 20, bottom: 30, left: 40 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = h - margin.top - margin.bottom;

    // Create zoom behavior
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.5, 20])
      .extent([[0, 0], [innerWidth, innerHeight]])
      .on('zoom', (event) => {
        setTransform(event.transform);
      });

    const selection = d3.select(canvas);
    selection.call(zoom);

    // Click handler
    const handleClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const scales = (canvas as any)._scales;
      const pointsData = (canvas as any)._data as VectorPoint[];
      if (!scales || !pointsData) return;

      // Transform coordinates
      const tx = (x - margin.left - transform.x) / transform.k;
      const ty = (y - margin.top - transform.y) / transform.k;

      // Find closest point
      let closestPoint: VectorPoint | null = null;
      let closestDist = Infinity;
      const threshold = 10 / transform.k; // Adjust for zoom

      for (const point of pointsData) {
        const px = scales.xScale(point.x);
        const py = scales.yScale(point.y);
        const dist = Math.sqrt((px - tx) ** 2 + (py - ty) ** 2);
        if (dist < threshold && dist < closestDist) {
          closestDist = dist;
          closestPoint = point;
        }
      }

      if (closestPoint && onPointClick) {
        onPointClick(closestPoint);
      }
    };

    // Hover handler
    const handleMouseMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const scales = (canvas as any)._scales;
      const pointsData = (canvas as any)._data as VectorPoint[];
      if (!scales || !pointsData) return;

      // Transform coordinates
      const tx = (x - margin.left - transform.x) / transform.k;
      const ty = (y - margin.top - transform.y) / transform.k;

      // Find closest point
      let closestPoint: VectorPoint | null = null;
      let closestDist = Infinity;
      const threshold = 15 / transform.k;

      for (const point of pointsData) {
        const px = scales.xScale(point.x);
        const py = scales.yScale(point.y);
        const dist = Math.sqrt((px - tx) ** 2 + (py - ty) ** 2);
        if (dist < threshold && dist < closestDist) {
          closestDist = dist;
          closestPoint = point;
        }
      }

      setHoveredPoint(closestPoint);
      onPointHover?.(closestPoint);
      canvas.style.cursor = closestPoint ? 'pointer' : 'default';
    };

    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('mousemove', handleMouseMove);

    // Double-click to reset zoom
    selection.on('dblclick.zoom', () => {
      selection.transition()
        .duration(500)
        .call(zoom.transform, d3.zoomIdentity);
    });

    return () => {
      canvas.removeEventListener('click', handleClick);
      canvas.removeEventListener('mousemove', handleMouseMove);
    };
  }, [useGPU, dimensions, transform, onPointClick, onPointHover]);

  // SVG rendering (fallback for smaller datasets or when GPU not available)
  useEffect(() => {
    if (useGPU || !svgRef.current || filteredData.length === 0) return;

    const svg = d3.select(svgRef.current);
    const { width, height: h } = dimensions;
    const margin = { top: 20, right: 20, bottom: 30, left: 40 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = h - margin.top - margin.bottom;

    // Clear previous content
    svg.selectAll('*').remove();

    // Calculate data extent
    const xExtent = d3.extent(filteredData, d => d.x) as [number, number];
    const yExtent = d3.extent(filteredData, d => d.y) as [number, number];

    // Add padding to extent
    const xPadding = (xExtent[1] - xExtent[0]) * 0.1 || 1;
    const yPadding = (yExtent[1] - yExtent[0]) * 0.1 || 1;

    // Create scales
    const xScale = d3.scaleLinear()
      .domain([xExtent[0] - xPadding, xExtent[1] + xPadding])
      .range([0, innerWidth]);

    const yScale = d3.scaleLinear()
      .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
      .range([innerHeight, 0]);

    // Create main group
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create clip path
    svg.append('defs').append('clipPath')
      .attr('id', 'scatter-clip')
      .append('rect')
      .attr('width', innerWidth)
      .attr('height', innerHeight);

    // Create plot area with clipping
    const plotArea = g.append('g')
      .attr('clip-path', 'url(#scatter-clip)');

    // Create zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 20])
      .extent([[0, 0], [innerWidth, innerHeight]])
      .on('zoom', (event) => {
        setTransform(event.transform);
        plotArea.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Draw axes
    const xAxis = d3.axisBottom(xScale).ticks(5);
    const yAxis = d3.axisLeft(yScale).ticks(5);

    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(xAxis)
      .selectAll('text')
      .style('font-size', '10px')
      .style('fill', '#666');

    g.append('g')
      .attr('class', 'y-axis')
      .call(yAxis)
      .selectAll('text')
      .style('font-size', '10px')
      .style('fill', '#666');

    // Draw points
    plotArea.selectAll('.point')
      .data(filteredData)
      .enter()
      .append('circle')
      .attr('class', 'point')
      .attr('cx', d => xScale(d.x))
      .attr('cy', d => yScale(d.y))
      .attr('r', d => getSize(d))
      .attr('fill', d => getColor(d))
      .attr('stroke', d => highlightIds?.has(d.id) ? '#E74C3C' : '#fff')
      .attr('stroke-width', d => highlightIds?.has(d.id) ? 3 : 1)
      .attr('opacity', 0.8)
      .style('cursor', 'pointer')
      .on('mouseover', function(event, d) {
        d3.select(this)
          .transition()
          .duration(100)
          .attr('r', getSize(d) * 1.5)
          .attr('opacity', 1);
        setHoveredPoint(d);
        onPointHover?.(d);
      })
      .on('mouseout', function(event, d) {
        d3.select(this)
          .transition()
          .duration(100)
          .attr('r', getSize(d))
          .attr('opacity', 0.8);
        setHoveredPoint(null);
        onPointHover?.(null);
      })
      .on('click', (event, d) => {
        event.stopPropagation();
        onPointClick?.(d);
      });

    // Add labels if enabled
    if (showLabels) {
      plotArea.selectAll('.label')
        .data(filteredData)
        .enter()
        .append('text')
        .attr('class', 'label')
        .attr('x', d => xScale(d.x) + 8)
        .attr('y', d => yScale(d.y) + 4)
        .text(d => d.name)
        .style('font-size', '9px')
        .style('fill', '#333')
        .style('pointer-events', 'none');
    }

    // Reset zoom on background click
    svg.on('dblclick.zoom', () => {
      svg.transition()
        .duration(500)
        .call(zoom.transform, d3.zoomIdentity);
    });

  }, [filteredData, dimensions, highlightIds, getColor, getSize, showLabels, onPointClick, onPointHover, useGPU]);

  if (data.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200 ${className}`}
        style={{ height }}
      >
        <div className="text-center text-gray-500">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-lg font-medium">No vector data</p>
          <p className="text-sm mt-1">Run a semantic search or select a project with embeddings</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* GPU Canvas (hidden if not using GPU) */}
      {useGPU && (
        <canvas
          ref={canvasRef}
          className="bg-white rounded-lg border border-gray-200"
          style={{ width: dimensions.width, height: dimensions.height }}
        />
      )}

      {/* SVG Canvas (hidden if using GPU) */}
      {!useGPU && (
        <svg
          ref={svgRef}
          width={dimensions.width}
          height={dimensions.height}
          className="bg-white rounded-lg border border-gray-200"
        />
      )}

      {/* Tooltip */}
      {hoveredPoint && (
        <div
          className="absolute pointer-events-none bg-white/95 backdrop-blur rounded-lg shadow-lg border border-gray-200 p-3 max-w-xs z-10"
          style={{
            left: '50%',
            bottom: 20,
            transform: 'translateX(-50%)'
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span
              className="px-1.5 py-0.5 text-xs rounded font-medium"
              style={{
                backgroundColor: `${getColor(hoveredPoint)}20`,
                color: getColor(hoveredPoint)
              }}
            >
              {hoveredPoint.nodeType}
            </span>
            {hoveredPoint.language && (
              <span
                className="px-1.5 py-0.5 text-xs rounded font-medium"
                style={{
                  backgroundColor: `${LANGUAGE_COLORS[hoveredPoint.language] || LANGUAGE_COLORS.default}20`,
                  color: LANGUAGE_COLORS[hoveredPoint.language] || LANGUAGE_COLORS.default
                }}
              >
                {hoveredPoint.language}
              </span>
            )}
            <span className="font-semibold text-gray-900 truncate">{hoveredPoint.name}</span>
          </div>
          <p className="text-xs text-gray-500 font-mono truncate">{hoveredPoint.qualifiedName}</p>
          <p className="text-xs text-gray-400 mt-1 truncate">
            {hoveredPoint.filePath}:{hoveredPoint.lineStart}
          </p>
          {hoveredPoint.score !== undefined && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-gray-500">Score:</span>
              <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full"
                  style={{ width: `${hoveredPoint.score * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-600">{(hoveredPoint.score * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}

      {/* Language Filter Panel (when language grouping is enabled) */}
      {/* Single language selection - only one language visible at a time */}
      {enableLanguageGrouping && languageGroups.length > 0 && (
        <div className="absolute top-4 left-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2">
          <p className="text-xs font-medium text-gray-600 mb-2">Language</p>
          <div className="flex flex-col gap-1">
            {languageGroups.map(group => {
              const isSelected = selectedLanguage === group.language;
              return (
                <button
                  key={group.language}
                  onClick={() => onLanguageSelect?.(group.language)}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-left transition-all ${
                    isSelected ? 'bg-blue-50 ring-1 ring-blue-500' : 'hover:bg-gray-100'
                  }`}
                >
                  <div
                    className="w-3 h-3 rounded-full border-2"
                    style={{
                      backgroundColor: isSelected ? group.color : 'transparent',
                      borderColor: group.color
                    }}
                  />
                  <span className="text-xs text-gray-700">{group.label}</span>
                  <span className="text-xs text-gray-400">({group.count})</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend (node types or score) */}
      {(colorBy === 'nodeType' || colorBy === 'language') && !enableLanguageGrouping && (
        <div className="absolute top-4 right-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2">
          <p className="text-xs font-medium text-gray-600 mb-2">
            {colorBy === 'language' ? 'Languages' : 'Node Types'}
          </p>
          <div className="flex flex-col gap-1">
            {Object.entries(colorBy === 'language' ? LANGUAGE_COLORS : NODE_TYPE_COLORS)
              .filter(([key]) => key !== 'default')
              .map(([type, color]) => (
                <div key={type} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-xs text-gray-600">{type}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Controls hint */}
      <div className="absolute bottom-4 left-4 text-xs text-gray-400">
        Scroll to zoom, drag to pan, double-click to reset
        {useGPU && <span className="ml-2 text-green-600">(GPU accelerated)</span>}
      </div>

      {/* Stats */}
      <div className="absolute top-4 right-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2">
        <p className="text-sm font-medium text-gray-700">
          {filteredData.length} / {data.length} points
        </p>
        {enableLanguageGrouping && selectedLanguage && (
          <p className="text-xs text-gray-500">
            Showing: {selectedLanguage}
          </p>
        )}
      </div>
    </div>
  );
}

export default VectorScatter;
