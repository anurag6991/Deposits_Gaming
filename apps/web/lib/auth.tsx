'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, bootstrapSession, setAccessToken } from './api';

export type Role = 'SUPER_ADMIN' | 'MANAGER' | 'PUBLISHER';

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  managerId: string | null;
  mustChangePassword: boolean;
  manager?: { id: string; fullName: string } | null;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const loadUser = useCallback(async () => {
    try {
      setUser(await api<CurrentUser>('/auth/me'));
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // On first load the access token is gone (memory only), so recover the
    // session from the refresh cookie before deciding whether to show login.
    void (async () => {
      const restored = await bootstrapSession();
      if (restored) await loadUser();
      setLoading(false);
    })();
  }, [loadUser]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api<{ accessToken: string; user: CurrentUser }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setAccessToken(result.accessToken);
      setUser(result.user);
      return result.user;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setAccessToken(null);
      setUser(null);
      router.push('/login');
    }
  }, [router]);

  const value = useMemo(
    () => ({ user, loading, login, logout, refreshUser: loadUser }),
    [user, loading, login, logout, loadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/**
 * Redirects anyone who should not be on the page.
 *
 * Presentation only. The API enforces the same rules server-side; this exists so
 * a publisher does not see an admin shell flash before the request fails.
 */
export function useRequireAuth(allowed?: Role[]) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (user.mustChangePassword) {
      router.replace('/change-password');
      return;
    }
    if (allowed && !allowed.includes(user.role)) {
      router.replace(user.role === 'PUBLISHER' ? '/' : '/admin');
    }
  }, [user, loading, allowed, router]);

  return { user, loading };
}
