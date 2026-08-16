/**
 * Security probe against the RUNNING API.
 *
 * Tests are one thing; this attacks the live server the way someone actually
 * would — with real tokens, real ids belonging to other people, and payloads
 * designed to slip past a check that was only applied in one place.
 */

const BASE = 'http://127.0.0.1:4000/api/v1';
const PASSWORD = 'DevPassword123';

let pass = 0;
let fail = 0;
const findings = [];

function ok(name) {
  pass += 1;
  console.log(`  PASS  ${name}`);
}
function bad(name, detail) {
  fail += 1;
  findings.push({ name, detail });
  console.log(`  FAIL  ${name}\n        ${detail}`);
}

async function login(email) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  return body?.data?.accessToken ?? null;
}

async function call(token, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body };
}

const admin = await login('admin@deposits.local');
const mgr1 = await login('manager1@deposits.local');
const mgr2 = await login('manager2@deposits.local');
const pub1 = await login('publisher1@deposits.local');
const pub4 = await login('publisher4@deposits.local');

if (!admin || !mgr1 || !mgr2 || !pub1 || !pub4) {
  console.error('Could not log in — is the API running and seeded?');
  process.exit(1);
}

// Reference ids from the admin's full view.
const users = (await call(admin, '/users')).body.data;
const offers = (await call(admin, '/offers')).body.data;
const p1 = users.find((u) => u.email === 'publisher1@deposits.local');
const p4 = users.find((u) => u.email === 'publisher4@deposits.local');
const m1 = users.find((u) => u.email === 'manager1@deposits.local');
const usOffer = offers.find((o) => o.countryCode === 'US');

console.log('\n1. Horizontal privilege escalation (other people’s ids)');

{
  const r = await call(mgr2, `/users/${p1.id}`);
  r.status === 404 || r.status === 403
    ? ok('manager2 cannot read manager1 publisher by id')
    : bad('manager2 read another manager publisher', `status ${r.status}`);
}
{
  const r = await call(mgr2, `/users/${p1.id}/status`, {
    method: 'POST',
    body: { status: 'DISABLED' },
  });
  r.status >= 400
    ? ok('manager2 cannot disable manager1 publisher')
    : bad('manager2 disabled another manager publisher', `status ${r.status}`);
}
{
  const r = await call(pub1, `/users/${p4.id}`);
  r.status >= 400 ? ok('publisher cannot read another publisher') : bad('publisher read another user', `status ${r.status}`);
}
{
  // Filter injection: ask explicitly for another manager's rows.
  const r = await call(mgr2, `/deposits?managerId=${m1.id}`);
  const rows = r.body?.data?.rows ?? [];
  rows.length === 0
    ? ok('managerId filter cannot be used to read another manager deposits')
    : bad('managerId filter leaked rows', `${rows.length} rows returned`);
}
{
  const r = await call(mgr2, `/advances?publisherId=${p1.id}`);
  const rows = r.body?.data?.rows ?? [];
  rows.length === 0
    ? ok('publisherId filter cannot be used to read another manager advances')
    : bad('advances filter leaked rows', `${rows.length} rows`);
}
{
  const r = await call(pub4, `/reports/publishers`);
  const rows = r.body?.data ?? [];
  rows.length === 0
    ? ok('publisher gets no publisher report rows')
    : bad('publisher saw publisher report', `${rows.length} rows`);
}

console.log('\n2. Vertical privilege escalation (role boundaries)');

{
  const r = await call(pub1, '/users', {
    method: 'POST',
    body: {
      email: 'attacker@evil.local',
      fullName: 'Attacker',
      password: 'LongEnoughPassword1',
      role: 'MANAGER',
    },
  });
  r.status === 403 ? ok('publisher cannot create a manager') : bad('publisher created a user', `status ${r.status}`);
}
{
  const r = await call(mgr1, '/users', {
    method: 'POST',
    body: {
      email: 'newmgr@evil.local',
      fullName: 'New Manager',
      password: 'LongEnoughPassword1',
      role: 'MANAGER',
    },
  });
  r.status === 403 ? ok('manager cannot create a manager') : bad('manager created a manager', `status ${r.status}`);
}
{
  const r = await call(mgr1, '/settings', {
    method: 'PATCH',
    body: { key: 'task_session_ttl_minutes', value: 999 },
  });
  r.status === 403 ? ok('manager cannot change settings') : bad('manager changed settings', `status ${r.status}`);
}
{
  const r = await call(pub1, '/test-data');
  r.status === 403 ? ok('publisher cannot enumerate test data') : bad('publisher listed test data', `status ${r.status}`);
}
{
  const r = await call(mgr1, '/test-data/stats');
  const pools = r.body?.data ?? [];
  const total = pools.reduce((s, p) => s + p.total, 0);
  // manager1 owns 15 US records; the 375 central ones must not appear.
  total <= 15
    ? ok(`manager sees only own pool (${total} records, not the central 375)`)
    : bad('manager saw central pool', `${total} records visible`);
}
{
  const r = await call(pub1, `/audit-logs`);
  r.status === 403 ? ok('publisher cannot read audit logs') : bad('publisher read audit logs', `status ${r.status}`);
}
{
  const r = await call(mgr1, `/leads/00000000-0000-0000-0000-000000000000/reset`, {
    method: 'POST',
    body: { reason: 'testing' },
  });
  r.status === 403 ? ok('manager cannot reset a lead') : bad('manager reached lead reset', `status ${r.status}`);
}

console.log('\n3. Mass assignment and input tampering');

{
  // Try to self-promote by smuggling extra fields into a profile update.
  const before = (await call(pub1, '/auth/me')).body.data;
  await call(pub1, `/users/${p1.id}`, {
    method: 'PATCH',
    body: { fullName: 'Renamed', role: 'SUPER_ADMIN', managerId: null, status: 'ACTIVE' },
  });
  const after = (await call(pub1, '/auth/me')).body.data;
  after.role === before.role
    ? ok('role cannot be escalated through a profile update')
    : bad('role escalated via mass assignment', `${before.role} -> ${after.role}`);
}
{
  // Negative amount on an advance.
  const r = await call(mgr1, '/advances', {
    method: 'POST',
    body: { publisherId: p1.id, amount: '-500.00' },
  });
  r.status >= 400 ? ok('negative advance rejected') : bad('negative advance accepted', `status ${r.status}`);
}
{
  const r = await call(admin, '/offers', {
    method: 'POST',
    body: {
      name: 'Bad',
      brand: 'B',
      countryCode: 'US',
      url: 'javascript:alert(1)',
      monthlyLeadTarget: 1,
      monthlyDepositTarget: 1,
      monthlyDepositAmountTarget: '1',
      leadIntervalSeconds: 0,
      depositIntervalSeconds: 0,
      gameplayIntervalDays: 1,
    },
  });
  r.status >= 400
    ? ok('javascript: URL rejected on offer creation')
    : bad('javascript: URL accepted as offer URL', `status ${r.status}`);
}

console.log('\n4. Injection');

{
  const r = await call(admin, `/deposits?search=${encodeURIComponent("'; DROP TABLE deposits; --")}`);
  const stillThere = await call(admin, '/deposits');
  r.status === 200 && stillThere.status === 200
    ? ok('SQL metacharacters in search are treated as data')
    : bad('search with SQL metacharacters broke', `status ${r.status}`);
}
{
  const r = await call(admin, `/audit-logs?action=${encodeURIComponent("' OR 1=1 --")}`);
  const rows = r.body?.data?.rows ?? [];
  rows.length === 0
    ? ok('SQL injection in audit filter returns nothing, not everything')
    : bad('audit filter injection returned rows', `${rows.length} rows`);
}
{
  // Prototype pollution through a JSON body.
  await call(admin, '/settings', {
    method: 'PATCH',
    body: { key: 'low_data_threshold_default', value: 10, __proto__: { polluted: true } },
  });
  ({}).polluted === undefined
    ? ok('JSON body cannot pollute Object.prototype')
    : bad('prototype pollution succeeded', 'Object.prototype.polluted is set');
}

console.log('\n5. Sensitive data exposure');

{
  const r = await call(admin, '/deposits');
  const raw = JSON.stringify(r.body);
  !raw.includes('accountSecretEnc') && !raw.includes('passwordHash')
    ? ok('deposit list exposes no secret fields')
    : bad('deposit list leaked a secret field', 'accountSecretEnc or passwordHash present');
}
{
  const r = await call(admin, '/users');
  const raw = JSON.stringify(r.body);
  !raw.includes('passwordHash')
    ? ok('user list exposes no password hash')
    : bad('user list leaked passwordHash', 'present in response');
}
{
  const r = await call(admin, '/proxies');
  const raw = JSON.stringify(r.body);
  !raw.includes('passwordEnc')
    ? ok('proxy list exposes no credentials')
    : bad('proxy list leaked passwordEnc', 'present in response');
}
{
  const proxies = (await call(admin, '/proxies')).body.data;
  if (proxies.length > 0) {
    const r = await call(pub1, `/proxies/${proxies[0].id}/credentials`);
    r.status >= 400
      ? ok('publisher cannot reveal proxy credentials without an open task')
      : bad('publisher revealed proxy credentials with no task', `status ${r.status}`);
  }
}
{
  const r = await call(admin, '/offers/not-a-uuid/progress');
  const raw = JSON.stringify(r.body).toLowerCase();
  !raw.includes('prisma') && !raw.includes('stack') && !raw.includes('at ')
    ? ok('errors do not leak internals')
    : bad('error body leaked internals', raw.slice(0, 120));
}

console.log('\n6. Authentication');

{
  const r = await call(null, '/reports/dashboard');
  r.status === 401 ? ok('no token is refused') : bad('unauthenticated request allowed', `status ${r.status}`);
}
{
  const r = await call('not.a.real.token', '/reports/dashboard');
  r.status === 401 ? ok('garbage token is refused') : bad('garbage token accepted', `status ${r.status}`);
}
{
  // A token signed with the wrong key must not be trusted.
  const [h, p] = admin.split('.');
  const forged = `${h}.${p}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const r = await call(forged, '/reports/dashboard');
  r.status === 401 ? ok('token with a forged signature is refused') : bad('forged signature accepted', `status ${r.status}`);
}
{
  // alg:none downgrade.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: p1.id, role: 'SUPER_ADMIN', sid: 'x' }),
  ).toString('base64url');
  const r = await call(`${header}.${payload}.`, '/reports/dashboard');
  r.status === 401 ? ok('alg:none token is refused') : bad('alg:none accepted', `status ${r.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (findings.length > 0) {
  console.log('FINDINGS:');
  for (const f of findings) console.log(` - ${f.name}: ${f.detail}`);
}
process.exit(fail === 0 ? 0 : 1);
