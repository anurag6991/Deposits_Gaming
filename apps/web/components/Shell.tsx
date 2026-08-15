'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth, type Role } from '@/lib/auth';

/**
 * The application shell.
 *
 * Publishers get a bottom tab bar, because they work on a phone one-handed and
 * a hamburger menu costs a tap on every navigation. Admins get a sidebar on
 * desktop and the same tab bar on mobile.
 *
 * The link list is derived from role. This is presentation only — every route it
 * hides is also refused by the API.
 */

interface NavItem {
  href: string;
  label: string;
  roles: Role[];
}

const PUBLISHER_NAV: NavItem[] = [
  { href: '/', label: 'Home', roles: ['PUBLISHER'] },
  { href: '/work', label: 'Work', roles: ['PUBLISHER'] },
  { href: '/deposits', label: 'Deposits', roles: ['PUBLISHER'] },
  { href: '/withdrawals', label: 'Withdrawals', roles: ['PUBLISHER'] },
  { href: '/advances', label: 'Advances', roles: ['PUBLISHER'] },
];

const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/offers', label: 'Offers', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/managers', label: 'Managers', roles: ['SUPER_ADMIN'] },
  { href: '/admin/publishers', label: 'Publishers', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/test-data', label: 'Test Data', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/deposits', label: 'Deposits', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/advances', label: 'Advances', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/reports', label: 'Reports', roles: ['SUPER_ADMIN', 'MANAGER'] },
  { href: '/admin/audit-logs', label: 'Audit Log', roles: ['SUPER_ADMIN'] },
  { href: '/admin/settings', label: 'Settings', roles: ['SUPER_ADMIN'] },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const pathname = usePathname();

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ unread: number }>('/notifications'),
    refetchInterval: 60_000,
    enabled: Boolean(user),
  });

  if (!user) return <>{children}</>;

  const isPublisher = user.role === 'PUBLISHER';
  const nav = (isPublisher ? PUBLISHER_NAV : ADMIN_NAV).filter((i) => i.roles.includes(user.role));

  const active = (href: string) =>
    href === '/' || href === '/admin' ? pathname === href : pathname.startsWith(href);

  return (
    <div className="min-h-screen md:flex">
      {!isPublisher && (
        <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white md:block">
          <div className="border-b border-slate-100 px-4 py-4">
            <p className="text-sm font-semibold">Deposits Gaming</p>
            <p className="mt-0.5 truncate text-xs text-slate-500">{user.fullName}</p>
            <p className="text-xs text-slate-400">
              {user.role === 'SUPER_ADMIN' ? 'Super Admin' : 'Manager'}
            </p>
          </div>
          <nav className="p-2">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm ${
                  active(item.href)
                    ? 'bg-brand-50 font-medium text-brand-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="p-2">
            <button
              onClick={() => void logout()}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </aside>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <span className="text-sm font-semibold">Deposits Gaming</span>
          <div className="flex items-center gap-3">
            {(notifications?.unread ?? 0) > 0 && (
              <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-medium text-white">
                {notifications?.unread}
              </span>
            )}
            <button onClick={() => void logout()} className="text-sm text-slate-500">
              Sign out
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl px-4 py-5 pb-24 md:pb-8">{children}</main>
      </div>

      {/* Bottom tabs on mobile for every role. */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-slate-200 bg-white md:hidden">
        {nav.slice(0, 5).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 px-1 py-3 text-center text-xs ${
              active(item.href) ? 'font-semibold text-brand-700' : 'text-slate-500'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
