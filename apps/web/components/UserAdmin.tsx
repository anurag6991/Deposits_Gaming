'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from './Shell';
import { Alert, Badge, Button, Card, Empty, Field, inputClass, Spinner } from './ui';

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: 'SUPER_ADMIN' | 'MANAGER' | 'PUBLISHER';
  status: 'ACTIVE' | 'DISABLED';
  phone: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  manager: { id: string; fullName: string } | null;
}

export function UserAdmin({ role, title }: { role: 'PUBLISHER' | 'MANAGER'; title: string }) {
  const { user, loading } = useRequireAuth(
    role === 'MANAGER' ? ['SUPER_ADMIN'] : ['SUPER_ADMIN', 'MANAGER'],
  );
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const users = useQuery({
    queryKey: ['users', role],
    queryFn: () => api<UserRow[]>(`/users?role=${role}`),
    enabled: Boolean(user),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'DISABLED' }) =>
      api(`/users/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">{title}</h1>
          <Button onClick={() => setCreating(true)}>Add {role === 'MANAGER' ? 'manager' : 'publisher'}</Button>
        </div>

        {users.isLoading && <Spinner />}
        {users.data?.length === 0 && <Empty>None yet.</Empty>}

        <div className="space-y-2">
          {users.data?.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="min-w-0">
                <p className="font-medium">{u.fullName}</p>
                <p className="truncate text-xs text-slate-500">
                  {u.email}
                  {u.manager ? ` · ${u.manager.fullName}` : ''}
                </p>
                <p className="text-xs text-slate-400">
                  {u.lastLoginAt
                    ? `Last seen ${new Date(u.lastLoginAt).toLocaleDateString()}`
                    : 'Never signed in'}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {u.mustChangePassword && <Badge tone="warn">Password not set</Badge>}
                <Badge tone={u.status === 'ACTIVE' ? 'ok' : 'neutral'}>{u.status}</Badge>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setStatus.mutate({
                      id: u.id,
                      status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                    })
                  }
                >
                  {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                </Button>
              </div>
            </div>
          ))}
        </div>

        <Card>
          <p className="text-xs text-slate-500">
            Disabling an account stops new logins and new work immediately. Nothing is deleted —
            past leads, deposits and reports stay visible and attributed.
          </p>
        </Card>
      </div>

      {creating && (
        <CreateUserModal
          role={role}
          canChooseManager={user.role === 'SUPER_ADMIN' && role === 'PUBLISHER'}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}
    </Shell>
  );
}

function CreateUserModal({
  role,
  canChooseManager,
  onClose,
  onDone,
}: {
  role: 'PUBLISHER' | 'MANAGER';
  canChooseManager: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [managerId, setManagerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const managers = useQuery({
    queryKey: ['users', 'MANAGER'],
    queryFn: () => api<UserRow[]>('/users?role=MANAGER&status=ACTIVE'),
    enabled: canChooseManager,
  });

  const create = useMutation({
    mutationFn: () =>
      api('/users', {
        method: 'POST',
        body: {
          email,
          fullName,
          password,
          role,
          managerId: canChooseManager && managerId ? managerId : undefined,
        },
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
      } else setError('Could not create the account.');
    },
  });

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">
          Add {role === 'MANAGER' ? 'manager' : 'publisher'}
        </h2>

        <div className="mt-3 space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}

          <Field label="Full name" error={fields.fullName}>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
          </Field>

          <Field label="Email" error={fields.email}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </Field>

          <Field label="Temporary password" error={fields.password}>
            <input value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          </Field>

          {canChooseManager && (
            <Field label="Assign to manager" error={fields.managerId}>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)} className={inputClass}>
                <option value="">Choose…</option>
                {managers.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.fullName}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <p className="text-xs text-slate-500">
            They must change this password the first time they sign in. Give it to them directly —
            it is never emailed.
          </p>

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!fullName || !email || password.length < 12 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

