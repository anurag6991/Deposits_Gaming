'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Badge, Button, Card, Empty, Progress, Spinner, inputClass } from '@/components/ui';

interface OfferReport {
  offerId: string;
  name: string;
  brand: string;
  countryCode: string;
  status: string;
  expired: boolean;
  leads: { completed: number; target: number };
  deposits: { completed: number; target: number };
  amount: { completed: string; target: string };
}

interface PublisherReport {
  publisherId: string;
  fullName: string;
  status: string;
  manager: string | null;
  leads: number;
  deposits: number;
  depositAmount: string;
  advance: string;
  overdueGameplay: number;
}

/** Builds a CSV client-side from data already on screen. No extra endpoint. */
function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0] as object);
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN', 'MANAGER']);
  const [month, setMonth] = useState('');

  const q = month ? `?monthKey=${month}` : '';

  const offers = useQuery({
    queryKey: ['report-offers', month],
    queryFn: () => api<OfferReport[]>(`/reports/offers${q}`),
    enabled: Boolean(user),
  });

  const publishers = useQuery({
    queryKey: ['report-publishers', month],
    queryFn: () => api<PublisherReport[]>(`/reports/publishers${q}`),
    enabled: Boolean(user),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Reports</h1>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={`${inputClass} max-w-[180px]`}
          />
        </div>

        <Card
          title="By offer"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                downloadCsv(
                  `offers-${month || 'current'}.csv`,
                  (offers.data ?? []).map((o) => ({
                    Offer: o.name,
                    Brand: o.brand,
                    Country: o.countryCode,
                    Status: o.status,
                    Leads: o.leads.completed,
                    'Lead target': o.leads.target,
                    Deposits: o.deposits.completed,
                    'Deposit target': o.deposits.target,
                    Amount: o.amount.completed,
                    'Amount target': o.amount.target,
                  })),
                )
              }
            >
              Export CSV
            </Button>
          }
        >
          {offers.isLoading && <Spinner />}
          {offers.data?.length === 0 && <Empty>No offers.</Empty>}

          <div className="space-y-3">
            {offers.data?.map((o) => (
              <div key={o.offerId} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{o.name}</p>
                    <p className="text-xs text-slate-500">
                      {o.brand} · {o.countryCode}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Badge tone={o.status === 'ACTIVE' ? 'ok' : 'neutral'}>{o.status}</Badge>
                    {o.expired && <Badge tone="danger">Expired</Badge>}
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Progress label="Leads" completed={o.leads.completed} target={o.leads.target} />
                  <Progress label="Deposits" completed={o.deposits.completed} target={o.deposits.target} />
                  <div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Amount</span>
                      <span className="font-medium tabular-nums">
                        ${o.amount.completed} / ${o.amount.target}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{
                          width: `${Math.min(100, (Number(o.amount.completed) / Math.max(1, Number(o.amount.target))) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="By publisher"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                downloadCsv(
                  `publishers-${month || 'current'}.csv`,
                  (publishers.data ?? []).map((p) => ({
                    Publisher: p.fullName,
                    Manager: p.manager ?? '',
                    Status: p.status,
                    Leads: p.leads,
                    Deposits: p.deposits,
                    'Deposit amount': p.depositAmount,
                    Advance: p.advance,
                    'Overdue gameplay': p.overdueGameplay,
                  })),
                )
              }
            >
              Export CSV
            </Button>
          }
        >
          {publishers.isLoading && <Spinner />}
          {publishers.data?.length === 0 && <Empty>No publishers.</Empty>}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2">Publisher</th>
                  <th className="py-2">Manager</th>
                  <th className="py-2 text-right">Leads</th>
                  <th className="py-2 text-right">Deposits</th>
                  <th className="py-2 text-right">Amount</th>
                  <th className="py-2 text-right">Advance</th>
                  <th className="py-2 text-right">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {publishers.data?.map((p) => (
                  <tr key={p.publisherId} className="border-t border-slate-100">
                    <td className="py-2 font-medium">{p.fullName}</td>
                    <td className="py-2 text-slate-600">{p.manager ?? '—'}</td>
                    <td className="py-2 text-right tabular-nums">{p.leads}</td>
                    <td className="py-2 text-right tabular-nums">{p.deposits}</td>
                    <td className="py-2 text-right tabular-nums">${p.depositAmount}</td>
                    <td className="py-2 text-right tabular-nums">${p.advance}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${p.overdueGameplay > 0 ? 'font-medium text-red-600' : ''}`}
                    >
                      {p.overdueGameplay}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Shell>
  );
}
