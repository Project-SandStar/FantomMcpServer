'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getApiBase } from '../lib/api';

// ============================================
// Types
// ============================================

export type UserRole = 'admin' | 'user';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  lastLogin?: string;
}

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthenticatedUser | null;
  username: string | null;
  role: UserRole | null;
  error: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  getAuthHeader: () => string;
  refreshUser: () => Promise<void>;
}

// ============================================
// Context
// ============================================

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ============================================
// Storage Keys
// ============================================

const STORAGE_KEYS = {
  USERNAME: 'admin_user',
  PASSWORD: 'admin_pass',
};

/**
 * Dev-mode-only automation sign-in for browser agents that cannot type into
 * password fields (jev-browser). A URL fragment `#auth=<base64 of user:pass>`
 * seeds the same stored credentials the login form would write, but only when
 * BOTH hold:
 *   - the dashboard is served from the developer's own machine
 *     (localhost / 127.0.0.1), and
 *   - the server reports `devMode: true` on /health, which it does only while
 *     the marker file `config/dev-mode` exists on that host
 *     (src/config/devMode.ts).
 * Nothing is bypassed: the credentials still have to pass /admin/users/me
 * before anything renders, exactly as after a form login. The fragment never
 * leaves the browser (fragments are not sent to servers) and is removed from
 * the URL as soon as it is read, whether or not it was honoured.
 */
async function consumeAuthFragment(): Promise<void> {
  if (typeof window === 'undefined') return;
  const m = /^#auth=([A-Za-z0-9+/=_-]+)$/.exec(window.location.hash);
  if (!m) return;
  // Strip first so the fragment never survives a reload or lands in history.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  const host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;

  let devMode = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${getApiBase()}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (r.ok) devMode = (await r.json())?.devMode === true;
  } catch {
    devMode = false;
  }
  if (!devMode) return;

  try {
    const decoded = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const sep = decoded.indexOf(':');
    if (sep > 0) {
      localStorage.setItem(STORAGE_KEYS.USERNAME, decoded.substring(0, sep));
      localStorage.setItem(STORAGE_KEYS.PASSWORD, decoded.substring(sep + 1));
    }
  } catch {
    // malformed fragment: ignore, fall through to the login screen
  }
}

// ============================================
// Provider
// ============================================

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Get stored credentials from localStorage
   */
  const getStoredCredentials = useCallback(() => {
    if (typeof window === 'undefined') return null;

    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

    if (username && password) {
      return { username, password };
    }
    return null;
  }, []);

  /**
   * Generate Basic Auth header from stored credentials
   */
  const getAuthHeader = useCallback((): string => {
    const creds = getStoredCredentials();
    if (!creds) return '';
    return 'Basic ' + btoa(`${creds.username}:${creds.password}`);
  }, [getStoredCredentials]);

  /**
   * Verify credentials by calling /admin/users/me
   */
  const verifyCredentials = useCallback(async (): Promise<AuthenticatedUser | null> => {
    const creds = getStoredCredentials();
    if (!creds) return null;

    try {
      const apiBase = getApiBase();
      // Add timeout to prevent hanging forever
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${apiBase}/admin/users/me`, {
        headers: {
          'Authorization': 'Basic ' + btoa(`${creds.username}:${creds.password}`),
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const userData = await response.json();
        return userData as AuthenticatedUser;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[Auth] Verification timed out');
      } else {
        console.error('[Auth] Failed to verify credentials:', err);
      }
    }

    return null;
  }, [getStoredCredentials]);

  /**
   * Store credentials in localStorage
   */
  const storeCredentials = useCallback((username: string, password: string) => {
    localStorage.setItem(STORAGE_KEYS.USERNAME, username);
    localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
  }, []);

  /**
   * Clear stored credentials
   */
  const clearCredentials = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.USERNAME);
    localStorage.removeItem(STORAGE_KEYS.PASSWORD);
  }, []);

  /**
   * Refresh user data
   */
  const refreshUser = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const userData = await verifyCredentials();

    if (userData) {
      setUser(userData);
      setIsAuthenticated(true);
    } else {
      setUser(null);
      setIsAuthenticated(false);
    }

    setIsLoading(false);
  }, [verifyCredentials]);

  /**
   * Login with username and password
   */
  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const apiBase = getApiBase();
      // Add timeout to prevent hanging forever
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${apiBase}/admin/users/me`, {
        headers: {
          'Authorization': 'Basic ' + btoa(`${username}:${password}`),
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const userData = await response.json();
        storeCredentials(username, password);
        setUser(userData as AuthenticatedUser);
        setIsAuthenticated(true);
        setIsLoading(false);
        return true;
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Invalid credentials' }));
        setError(errorData.error || 'Authentication failed');
        setIsAuthenticated(false);
        setUser(null);
        setIsLoading(false);
        return false;
      }
    } catch (err) {
      console.error('[Auth] Login error:', err);
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Connection timed out - server may be unavailable');
      } else {
        setError('Failed to connect to server');
      }
      setIsAuthenticated(false);
      setUser(null);
      setIsLoading(false);
      return false;
    }
  }, [storeCredentials]);

  /**
   * Logout - clear credentials and state
   */
  const logout = useCallback(() => {
    clearCredentials();
    setUser(null);
    setIsAuthenticated(false);
    setError(null);
  }, [clearCredentials]);

  /**
   * On mount, verify stored credentials
   */
  useEffect(() => {
    const initAuth = async () => {
      // Dev-mode fragment sign-in (no-op unless the URL carries #auth=).
      await consumeAuthFragment();
      const userData = await verifyCredentials();

      if (userData) {
        setUser(userData);
        setIsAuthenticated(true);
      } else {
        // Clear invalid credentials
        clearCredentials();
        setIsAuthenticated(false);
        setUser(null);
      }

      setIsLoading(false);
    };

    initAuth();
  }, [verifyCredentials, clearCredentials]);

  const value: AuthContextType = {
    isAuthenticated,
    isLoading,
    user,
    username: user?.username ?? null,
    role: user?.role ?? null,
    error,
    login,
    logout,
    getAuthHeader,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// ============================================
// Hook
// ============================================

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
