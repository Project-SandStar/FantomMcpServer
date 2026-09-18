/**
 * Type definitions for usage tracking
 */

/**
 * Event recorded when a tool is called
 */
export interface ToolEvent {
  toolName: string;
  timestamp: Date;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
  sessionId?: string;
}

/**
 * Event recorded when a search is performed
 */
export interface SearchEvent {
  query: string;
  source: 'fantom' | 'haxall' | 'local-docs' | 'code' | 'unified' | 'versioned-api';
  resultCount: number;
  timestamp: Date;
  sessionId?: string;
}

/**
 * A recent search event with timestamp
 */
export interface RecentSearch {
  query: string;
  source: string;
  resultCount: number;
  timestamp: string;
}

/**
 * Aggregated usage statistics for a time period
 */
export interface UsageStats {
  totalToolCalls: number;
  totalSearches: number;
  toolUsage: Record<string, number>;
  topSearches: Array<{ query: string; count: number }>;
  recentSearches: RecentSearch[];
  periodStart: string;
  periodEnd: string;
}
