'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Badge, Card, Empty, Spinner, inputClass } from '@/components/ui';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
  actor: { id: string; fullName: string; role: string } | null;
}

export default function AuditLogsPage() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN']);
  const [action, setAction] = useState('');

  const logs = useQuery({
    queryKey: ['audit-logs', action],
    queryFn: () => {
      const q = new URLSearchParams({ pageSize: '100' });
      if (action) q.set('action', action);
      return api<{ rows: AuditRow[]; total: number }>(`/audit-logs?${q}`);
    },
    enabled: Boolean(user),
  });

  if (loading || !user) return <Spinner />;

  const tone = (a: string) =>
    a.includes('reset') || a.includes('disabled') || a.includes('revealed')
      ? 'danger'
      : a.includes('failed')
        ? 'warn'
        : 'neutral';

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Audit log</h1>
          <input
            placeholder="Filter by action, e.g. lead.completed"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className={`${inputClass} max-w-xs`}
          />
        </div>

        <Card>
          <p className="text-xs text-slate-500">
            Append-only. Entries cannot be edited or deleted by anyone, including a Super Admin —
            the database itself rejects the attempt.
          </p>
        </Card>

        {logs.isLoading && <Spinner />}
        {logs.data?.rows.length === 0 && <Empty>Nothing recorded for that filter.</Empty>}

        <div className="space-y-2">
          {logs.data?.rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={tone(r.action)}>{r.action}</Badge>
                  <span className="text-sm text-slate-600">
                    {r.actor?.fullName ?? 'System'}
                    {r.actor ? ` (${r.actor.role})` : ''}
                  </span>
                </div>
                <span className="text-xs text-slate-400">
                  {new Date(r.createdAt).toLocaleString()}
                  {r.ipAddress ? ` · ${r.ipAddress}` : ''}
                </span>
              </div>

              {Object.keys(r.metadata ?? {}).length > 0 && (
                <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600">
                  {JSON.stringify(r.metadata, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
