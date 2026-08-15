'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Badge, Button, Card, Empty, Field, inputClass, Spinner, Stat } from '@/components/ui';

/**
 * Test data: pool health and the import wizard.
 *
 * The wizard is upload → preview → confirm. The preview step exists so a bad
 * file is caught before it reaches the pool: a publisher discovering a broken
 * record mid-task wastes the task and the record.
 */

interface PoolStat {
  countryCode: string;
  available: number;
  reserved: number;
  used: number;
  disabled: number;
  total: number;
}

interface ImportPreview {
  batchId: string;
  headers: string[];
  mapping: Record<string, string>;
  report: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    errors: Array<{ rowNumber: number; field: string; message: string; value?: string }>;
    sample: Array<Record<string, unknown>>;
  };
}

export default function TestDataPage() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN', 'MANAGER']);
  const qc = useQueryClient();

  const [country, setCountry] = useState('US');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const stats = useQuery({
    queryKey: ['pool-stats'],
    queryFn: () => api<PoolStat[]>('/test-data/stats'),
    enabled: Boolean(user),
  });

  const startPreview = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('file', file as File);
      form.append('countryCode', country);
      return api<ImportPreview>('/test-data/imports', { method: 'POST', form });
    },
    onSuccess: (data) => {
      setPreview(data);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not read that file.'),
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('file', file as File);
      return api<{ imported: number }>(`/test-data/imports/${preview?.batchId}/confirm`, {
        method: 'POST',
        form,
      });
    },
    onSuccess: (result) => {
      setDone(`Imported ${result.imported} records.`);
      setPreview(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      void qc.invalidateQueries({ queryKey: ['pool-stats'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Import failed.'),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Test data</h1>

        {done && <Alert tone="ok">{done}</Alert>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.data?.map((s) => (
            <Stat
              key={s.countryCode}
              label={s.countryCode}
              value={s.available}
              sub={`${s.used} used · ${s.total} total`}
              tone={s.available < 20 ? 'warn' : 'default'}
            />
          ))}
        </div>

        {stats.data?.length === 0 && (
          <Empty>No test data uploaded yet. Import a CSV or XLSX below.</Empty>
        )}

        <Card title="Import records">
          <div className="space-y-3">
            {error && <Alert tone="danger">{error}</Alert>}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Country for this file">
                <select value={country} onChange={(e) => setCountry(e.target.value)} className={inputClass}>
                  {['US', 'GB', 'CA', 'AU', 'DE', 'IN', 'NZ', 'IE', 'ZA'].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="CSV or XLSX file">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.xlsx,.xls,.tsv"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setPreview(null);
                    setDone(null);
                  }}
                  className="w-full text-sm"
                />
              </Field>
            </div>

            <p className="text-xs text-slate-500">
              Column names are detected automatically — first name, last name, email, phone,
              address, city, state, postal code. Anything unrecognised is kept alongside the record.
              Every record in this file is filed under {country}.
            </p>

            {!preview && (
              <Button disabled={!file || startPreview.isPending} onClick={() => startPreview.mutate()}>
                {startPreview.isPending ? 'Checking…' : 'Check file'}
              </Button>
            )}
          </div>
        </Card>

        {preview && (
          <Card title="Preview — nothing has been imported yet">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Rows" value={preview.report.totalRows} />
                <Stat label="Valid" value={preview.report.validRows} tone="ok" />
                <Stat
                  label="Invalid"
                  value={preview.report.invalidRows}
                  tone={preview.report.invalidRows > 0 ? 'danger' : 'default'}
                />
                <Stat
                  label="Duplicates"
                  value={preview.report.duplicateRows}
                  tone={preview.report.duplicateRows > 0 ? 'warn' : 'default'}
                />
              </div>

              <div>
                <p className="mb-1 text-sm font-medium">Detected columns</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(preview.mapping).map(([header, field]) => (
                    <Badge key={header} tone={field === 'extra' ? 'neutral' : 'info'}>
                      {header} → {field}
                    </Badge>
                  ))}
                </div>
              </div>

              {preview.report.errors.length > 0 && (
                <div>
                  <p className="mb-1 text-sm font-medium">Problems (first 10)</p>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-2 py-1.5">Row</th>
                          <th className="px-2 py-1.5">Field</th>
                          <th className="px-2 py-1.5">Problem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.report.errors.slice(0, 10).map((e, i) => (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 tabular-nums">{e.rowNumber}</td>
                            <td className="px-2 py-1.5">{e.field}</td>
                            <td className="px-2 py-1.5 text-slate-600">
                              {e.message}
                              {e.value ? ` (${e.value})` : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    These rows will be skipped. Everything valid still imports.
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setPreview(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={preview.report.validRows === 0 || confirm.isPending}
                  onClick={() => confirm.mutate()}
                >
                  {confirm.isPending
                    ? 'Importing…'
                    : `Import ${preview.report.validRows} records`}
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </Shell>
  );
}
