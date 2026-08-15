'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Button, Card, Field, Spinner, inputClass } from '@/components/ui';

const EDITABLE = [
  {
    key: 'offer_default_duration_days',
    label: 'Default offer length (days)',
    help: 'New offers expire this many days after they start. Existing offers are unaffected.',
  },
  {
    key: 'task_session_ttl_minutes',
    label: 'Task timeout (minutes)',
    help: 'How long a publisher can hold a reserved identity before it returns to the pool.',
  },
  {
    key: 'reservation_ttl_minutes',
    label: 'Reservation timeout (minutes)',
    help: 'Safety net for abandoned reservations.',
  },
  {
    key: 'low_data_threshold_default',
    label: 'Low data warning at',
    help: 'Warn when a country pool falls to this many available records.',
  },
  {
    key: 'offer_expiry_warning_days',
    label: 'Offer expiry warning (days)',
    help: 'How far ahead to warn that an offer is about to expire.',
  },
] as const;

export default function SettingsPage() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN']);
  const qc = useQueryClient();
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Record<string, unknown>>('/settings'),
    enabled: Boolean(user),
  });

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) =>
      api('/settings', { method: 'PATCH', body: { key, value } }),
    onSuccess: (_data, variables) => {
      setSaved(variables.key);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      setTimeout(() => setSaved(null), 2000);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Settings</h1>

        {error && <Alert tone="danger">{error}</Alert>}

        <Card title="System">
          {settings.isLoading && <Spinner />}

          <div className="space-y-4">
            {EDITABLE.map((s) => {
              const current = String(settings.data?.[s.key] ?? '');
              const value = values[s.key] ?? current;

              return (
                <div key={s.key} className="border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                  <Field label={s.label}>
                    <div className="flex gap-2">
                      <input
                        inputMode="numeric"
                        value={value}
                        onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                        className={inputClass}
                      />
                      <Button
                        variant="secondary"
                        disabled={value === current || save.isPending}
                        onClick={() => save.mutate({ key: s.key, value: Number(value) })}
                      >
                        {saved === s.key ? 'Saved' : 'Save'}
                      </Button>
                    </div>
                  </Field>
                  <p className="mt-1 text-xs text-slate-500">{s.help}</p>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Timezone">
          <p className="text-sm">
            All months, days and targets use{' '}
            <span className="font-medium">{String(settings.data?.app_timezone ?? 'Asia/Kolkata')}</span>.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Changing this shifts which month past activity falls into, so it is deliberately not
            editable here. Ask for a migration if it genuinely needs to change.
          </p>
        </Card>
      </div>
    </Shell>
  );
}
