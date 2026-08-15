'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Card, Empty, Progress, Spinner, Stat } from '@/components/ui';

interface DashboardData {
  monthKey: string;
  leads: { today: number; month: number; target: number; remaining: number };
  deposits: { today: number; month: number; target: number; remaining: number; active: number; completed: number };
  depositAmount: { month: string; target: string; remaining: string };
  activeOffers: number;
  expiringSoon: number;
  overdueGameplay: number;
  managers: number;
  publishers: number;
  lowDataPools: Array<{ countryCode: string; available: number; demand: number; shortfall: number }>;
}

export default function AdminDashboard() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN', 'MANAGER']);

  const dashboard = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: () => api<DashboardData>('/reports/dashboard'),
    enabled: Boolean(user),
  });

  if (loading || !user) return <Spinner />;

  const d = dashboard.data;

  return (
    <Shell>
      <div className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-500">
            {user.role === 'SUPER_ADMIN' ? 'Everything' : 'Your team'} · {d?.monthKey ?? ''}
          </p>
        </div>

        {dashboard.isLoading && <Spinner />}

        {d && (
          <>
            {d.overdueGameplay > 0 && (
              <Alert tone="danger">
                <div className="flex items-center justify-between gap-3">
                  <span>{d.overdueGameplay} deposits have overdue gameplay</span>
                  <Link href="/admin/deposits?gameplay=OVERDUE" className="shrink-0 font-medium underline">
                    View
                  </Link>
                </div>
              </Alert>
            )}

            {d.lowDataPools.length > 0 && (
              <Alert tone="warn">
                <p className="font-medium">Test data running low</p>
                <ul className="mt-1 space-y-0.5">
                  {d.lowDataPools.map((p) => (
                    <li key={p.countryCode}>
                      {p.countryCode}: {p.available} available against {p.demand} still needed
                      {p.shortfall > 0 && ` — short by ${p.shortfall}`}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {user.role === 'SUPER_ADMIN' && <Stat label="Managers" value={d.managers} />}
              <Stat label="Publishers" value={d.publishers} />
              <Stat label="Active offers" value={d.activeOffers} sub={`${d.expiringSoon} expiring soon`} />
              <Stat
                label="Overdue gameplay"
                value={d.overdueGameplay}
                tone={d.overdueGameplay > 0 ? 'danger' : 'ok'}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Leads">
                <div className="space-y-3">
                  <Progress label="This month" completed={d.leads.month} target={d.leads.target} />
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Today</span>
                    <span className="font-medium tabular-nums text-slate-900">{d.leads.today}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Remaining</span>
                    <span className="font-medium tabular-nums text-slate-900">{d.leads.remaining}</span>
                  </div>
                </div>
              </Card>

              <Card title="Deposits">
                <div className="space-y-3">
                  <Progress label="This month" completed={d.deposits.month} target={d.deposits.target} />
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Amount</span>
                    <span className="font-medium tabular-nums text-slate-900">
                      ${d.depositAmount.month} / ${d.depositAmount.target}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>Active / completed</span>
                    <span className="font-medium tabular-nums text-slate-900">
                      {d.deposits.active} / {d.deposits.completed}
                    </span>
                  </div>
                </div>
              </Card>
            </div>

            {d.activeOffers === 0 && (
              <Empty>
                No active offers yet.{' '}
                <Link href="/admin/offers" className="font-medium text-brand-600 underline">
                  Create one
                </Link>
              </Empty>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
