'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Badge, Card, Empty, Spinner, inputClass } from '@/components/ui';

interface DepositRow {
  id: string;
  depositedAt: string;
  amount: string;
  method: string;
  status: 'ACTIVE' | 'COMPLETED';
  currentBalance: string;
  accountName: string;
  accountEmail: string;
  lastGameplayAt: string | null;
  nextGameplayDueAt: string | null;
  overdue: boolean;
  offer: { id: string; name: string; brand: string; countryCode: string };
  publisher: { id: string; fullName: string };
  manager: { id: string; fullName: string };
}

function AdminDepositsScreen() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN', 'MANAGER']);
  const params = useSearchParams();

  const [gameplay, setGameplay] = useState(params.get('gameplay') ?? '');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState('');

  const deposits = useQuery({
    queryKey: ['admin-deposits', gameplay, status, search, month],
    queryFn: () => {
      const q = new URLSearchParams();
      if (gameplay) q.set('gameplay', gameplay);
      if (status) q.set('status', status);
      if (search) q.set('search', search);
      if (month) q.set('monthKey', month);
      q.set('pageSize', '100');
      return api<{ rows: DepositRow[]; total: number }>(`/deposits?${q}`);
    },
    enabled: Boolean(user),
  });

  if (loading || !user) return <Spinner />;

  const totalAmount = deposits.data?.rows.reduce((sum, r) => sum + Number(r.amount), 0) ?? 0;

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Deposits</h1>
          <p className="text-sm text-slate-500">
            {deposits.data?.total ?? 0} shown · ${totalAmount.toFixed(2)}
          </p>
        </div>

        <Card>
          <div className="grid gap-2 sm:grid-cols-4">
            <input
              placeholder="Search account, offer, brand"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={inputClass}
            />
            <select value={gameplay} onChange={(e) => setGameplay(e.target.value)} className={inputClass}>
              <option value="">Any gameplay</option>
              <option value="OVERDUE">Overdue</option>
              <option value="DUE">Due soon</option>
              <option value="OK">OK</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
              <option value="">Any status</option>
              <option value="ACTIVE">Active</option>
              <option value="COMPLETED">Completed</option>
            </select>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className={inputClass}
            />
          </div>
        </Card>

        {deposits.isLoading && <Spinner />}
        {deposits.data?.rows.length === 0 && <Empty>No deposits match those filters.</Empty>}

        {/* Table on desktop, cards on mobile — a 12-column table is unusable on a phone. */}
        <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Offer</th>
                <th className="px-3 py-2">Publisher</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Gameplay</th>
              </tr>
            </thead>
            <tbody>
              {deposits.data?.rows.map((d) => (
                <tr key={d.id} className={`border-b border-slate-100 ${d.overdue ? 'bg-red-50' : ''}`}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                    {new Date(d.depositedAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{d.offer.name}</span>
                    <span className="block text-xs text-slate-500">
                      {d.offer.brand} · {d.offer.countryCode}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{d.publisher.fullName}</td>
                  <td className="px-3 py-2">
                    <span className="block truncate">{d.accountName}</span>
                    <span className="block truncate text-xs text-slate-500">{d.accountEmail}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">${d.amount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">${d.currentBalance}</td>
                  <td className="px-3 py-2">
                    <Badge tone={d.status === 'ACTIVE' ? 'info' : 'neutral'}>{d.status}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {d.overdue ? (
                      <Badge tone="danger">Overdue</Badge>
                    ) : d.nextGameplayDueAt ? (
                      <span className="text-xs text-slate-600">
                        {new Date(d.nextGameplayDueAt).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 md:hidden">
          {deposits.data?.rows.map((d) => (
            <div
              key={d.id}
              className={`rounded-xl border bg-white p-3 ${d.overdue ? 'border-red-300' : 'border-slate-200'}`}
            >
              <div className="flex justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.offer.name}</p>
                  <p className="text-xs text-slate-500">
                    {d.publisher.fullName} · {new Date(d.depositedAt).toLocaleDateString()}
                  </p>
                </div>
                <p className="shrink-0 font-semibold tabular-nums">${d.amount}</p>
              </div>
              <div className="mt-2 flex gap-2">
                <Badge tone={d.status === 'ACTIVE' ? 'info' : 'neutral'}>{d.status}</Badge>
                {d.overdue && <Badge tone="danger">Overdue</Badge>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

export default function AdminDepositsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <AdminDepositsScreen />
    </Suspense>
  );
}
