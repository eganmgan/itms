import express from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { permissionsByRole, requireCapability } from '../middleware/rbac.js';
import { getRunEmitter, mapScopeToTarget, startRun } from '../services/runManager.js';
import { saltClient } from '../services/saltClient.js';
import type { ScopeInput } from '../types/index.js';

export const apiRouter = express.Router();

const runSchema = z.object({
  fn: z.enum(['sls', 'cmd', 'pkg']),
  scope: z.object({
    type: z.enum(['all', 'department', 'os', 'minion']),
    value: z.string().optional(),
  }),
  arg: z.string().optional(),
  scriptId: z.number().int().optional(),
  confirmed: z.boolean().optional(),
});

const scriptSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['sls', 'sh']),
  variants: z.array(
    z.object({
      os: z.enum(['default', 'Ubuntu', 'Debian', 'Rocky Linux']),
      body: z.string().min(1),
    }),
  ),
});

const scheduleSchema = z.object({
  name: z.string().min(1),
  scope: z.object({
    type: z.enum(['all', 'department', 'os', 'minion']),
    value: z.string().optional(),
  }),
  fn: z.string().min(1),
  arg: z.string().optional(),
  scriptId: z.number().int().optional(),
  cron: z.string().min(5),
  enabled: z.boolean().default(true),
});

function minionStateFromUpgrades(upgrades: Record<string, unknown>, rebootRequired: boolean) {
  const pending = Object.keys(upgrades || {}).length;
  if (rebootRequired) {
    return { state: 'reboot', pending };
  }
  if (pending > 0) {
    return { state: 'outdated', pending };
  }
  return { state: 'uptodate', pending };
}

async function collectMinions(scope?: ScopeInput) {
  try {
    const target = scope ? mapScopeToTarget(scope) : { tgt: '*', tgt_type: 'glob' as const, scopeKey: 'all:*' };
    const grains = await saltClient.runLocal<Record<string, unknown>>({
      tgt: target.tgt,
      tgt_type: target.tgt_type,
      fun: 'grains.items',
    });

    const upgrades = await saltClient.runLocal<Record<string, unknown>>({
      tgt: target.tgt,
      tgt_type: target.tgt_type,
      fun: 'pkg.list_upgrades',
    });

    const reboot = await saltClient.runLocal<string>({
      tgt: target.tgt,
      tgt_type: target.tgt_type,
      fun: 'cmd.run',
      arg: ['if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi'],
    });

    return Object.entries(grains).map(([id, grainObj]) => {
      const grain = (grainObj ?? {}) as Record<string, unknown>;
      const minionUpgrades = (upgrades[id] ?? {}) as Record<string, unknown>;
      const rebootRequired = String(reboot[id] ?? 'no').trim() === 'yes';
      const computed = minionStateFromUpgrades(minionUpgrades, rebootRequired);

      return {
        id,
        dept: String((grain.department as string) || (grain.dept as string) || 'unknown'),
        os: String(grain.os || ''),
        os_family: String(grain.os_family || ''),
        state: computed.state,
        pending: computed.pending,
        last_checkin: new Date().toISOString(),
      };
    });
  } catch (error) {
    console.error('collectMinions failed, returning empty list:', error);
    return [];
  }
}

async function collectKeys() {
  try {
    const result = await saltClient.command<Record<string, string[]>>({
      client: 'wheel',
      fun: 'key.list_all',
    });
    const payload = result[0] ?? {};

    return [
      ...(payload.minions_pre ?? []).map((id) => ({ id, state: 'pending' })),
      ...(payload.minions ?? []).map((id) => ({ id, state: 'accepted' })),
      ...(payload.minions_denied ?? []).map((id) => ({ id, state: 'denied' })),
      ...(payload.minions_rejected ?? []).map((id) => ({ id, state: 'denied' })),
    ];
  } catch (error) {
    console.error('collectKeys failed, returning empty list:', error);
    return [] as Array<{ id: string; state: 'pending' | 'accepted' | 'denied' }>;
  }
}

apiRouter.get('/session', async (req, res) => {
  const user = req.user!;
  res.json({ user, role: user.role, permissions: permissionsByRole(user.role) });
});

apiRouter.get('/keys', async (_req, res) => {
  const keys = await collectKeys();
  res.json(keys);
});

apiRouter.post('/keys/:id/:action', requireCapability('usersManage'), async (req, res) => {
  const action = z.enum(['accept', 'reject', 'delete']).parse(req.params.action);
  const id = req.params.id;
  const fun = action === 'accept' ? 'key.accept' : action === 'reject' ? 'key.reject' : 'key.delete';

  await saltClient.command({
    client: 'wheel',
    fun,
    match: id,
  });

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, `key_${action}`, JSON.stringify({ id }), 'config'],
  );

  res.json({ ok: true });
});

apiRouter.get('/minions', async (_req, res) => {
  const minions = await collectMinions();
  res.json(minions);
});

apiRouter.get('/minions/:id', async (req, res) => {
  try {
    const target = { tgt: req.params.id, tgt_type: 'glob' as const };

    const grains = await saltClient.runLocal<Record<string, unknown>>({
      tgt: target.tgt,
      tgt_type: target.tgt_type,
      fun: 'grains.items',
    });
    const upgrades = await saltClient.runLocal<Record<string, unknown>>({
      tgt: target.tgt,
      tgt_type: target.tgt_type,
      fun: 'pkg.list_upgrades',
    });

    res.json({ grains: grains[req.params.id] ?? {}, pendingPackages: upgrades[req.params.id] ?? {} });
  } catch (error) {
    console.error(`minion detail failed for ${req.params.id}:`, error);
    res.json({ grains: {}, pendingPackages: {} });
  }
});

apiRouter.get('/pillar/:id', async (req, res) => {
  try {
    const result = await saltClient.runLocal<Record<string, unknown>>({
      tgt: req.params.id,
      tgt_type: 'glob',
      fun: 'pillar.items',
    });

    res.json(result[req.params.id] ?? {});
  } catch (error) {
    console.error(`pillar lookup failed for ${req.params.id}:`, error);
    res.json({});
  }
});

apiRouter.get('/compliance', async (_req, res) => {
  const minions = await collectMinions();
  const byDeptMap = new Map<string, { total: number; uptodate: number; outdated: number; failed: number; reboot: number; pending: number }>();

  let up = 0;
  let outdated = 0;
  let failed = 0;
  let reboot = 0;
  let pending = 0;

  for (const m of minions) {
    if (!byDeptMap.has(m.dept)) {
      byDeptMap.set(m.dept, { total: 0, uptodate: 0, outdated: 0, failed: 0, reboot: 0, pending: 0 });
    }

    const row = byDeptMap.get(m.dept)!;
    row.total += 1;
    row.pending += m.pending;

    pending += m.pending;

    if (m.state === 'uptodate') {
      up += 1;
      row.uptodate += 1;
    } else if (m.state === 'outdated') {
      outdated += 1;
      row.outdated += 1;
    } else if (m.state === 'reboot') {
      reboot += 1;
      row.reboot += 1;
    } else {
      failed += 1;
      row.failed += 1;
    }
  }

  const total = minions.length || 1;
  const byDept = Array.from(byDeptMap.entries()).map(([dept, value]) => ({
    dept,
    ...value,
    pct: Math.round((value.uptodate / Math.max(1, value.total)) * 100),
  }));

  res.json({
    fleet: {
      pct: Math.round((up / total) * 100),
      up,
      outdated,
      reboot,
      failed,
      pending,
    },
    byDept,
  });
});

apiRouter.post('/runs', requireCapability('run'), async (req, res) => {
  try {
    const payload = runSchema.parse(req.body);
    const run = await startRun({
      createdBy: req.user!.id,
      fn: payload.fn,
      scope: payload.scope,
      arg: payload.arg,
      scriptId: payload.scriptId,
      confirmed: payload.confirmed,
    });

    res.status(202).json(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Run submission failed';
    res.status(400).json({ error: message });
  }
});

apiRouter.get('/runs/:jid/stream', async (req, res) => {
  const emitter = getRunEmitter(req.params.jid);
  if (!emitter) {
    res.status(404).json({ error: 'JID not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onMessage = (payload: unknown) => send('message', payload);
  const onProgress = (payload: unknown) => send('progress', payload);
  const onDone = (payload: unknown) => {
    send('done', payload);
    res.end();
  };

  emitter.on('message', onMessage);
  emitter.on('progress', onProgress);
  emitter.once('done', onDone);

  req.on('close', () => {
    emitter.off('message', onMessage);
    emitter.off('progress', onProgress);
    emitter.off('done', onDone);
  });
});

apiRouter.get('/jobs', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  const jobs = await query(
    `select jid, fn, scope_key, target_expr, minions, succeeded, failed, changed, status, started_at, finished_at, created_by
     from jobs
     order by started_at desc
     limit $1 offset $2`,
    [pageSize, offset],
  );

  res.json({ page, items: jobs });
});

apiRouter.get('/scripts', async (_req, res) => {
  const scripts = await query<{ id: number; name: string; type: string; created_by: string; updated_at: string }>(
    'select id, name, type, created_by, updated_at from scripts order by updated_at desc',
  );

  const variants = await query<{ id: number; script_id: number; os: string; body: string }>(
    'select id, script_id, os, body from script_variants order by script_id, os',
  );

  const byScript = new Map<number, Array<{ id: number; os: string; body: string }>>();
  for (const variant of variants) {
    const bucket = byScript.get(variant.script_id) ?? [];
    bucket.push({ id: variant.id, os: variant.os, body: variant.body });
    byScript.set(variant.script_id, bucket);
  }

  res.json(scripts.map((script) => ({ ...script, variants: byScript.get(script.id) ?? [] })));
});

apiRouter.post('/scripts', requireCapability('scriptAuthor'), async (req, res) => {
  try {
    const payload = scriptSchema.parse(req.body);

    const created = await query<{ id: number }>(
      `insert into scripts (name, type, created_by, updated_at)
       values ($1, $2, $3, now())
       returning id`,
      [payload.name, payload.type, req.user!.id],
    );

    for (const variant of payload.variants) {
      await query(
        'insert into script_variants (script_id, os, body) values ($1, $2, $3)',
        [created[0].id, variant.os, variant.body],
      );
    }

    await query(
      `insert into audit (actor_id, action, detail, kind, created_at)
       values ($1, $2, $3::jsonb, $4, now())`,
      [req.user!.id, 'script_created', JSON.stringify({ scriptId: created[0].id, name: payload.name }), 'config'],
    );

    res.status(201).json({ id: created[0].id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Script creation failed';
    res.status(400).json({ error: message });
  }
});

apiRouter.patch('/scripts/:id', requireCapability('scriptAuthor'), async (req, res) => {
  const payload = scriptSchema.partial().parse(req.body);
  const scriptId = Number(req.params.id);

  if (payload.name) {
    await query('update scripts set name = $1, updated_at = now() where id = $2', [payload.name, scriptId]);
  }

  if (payload.variants) {
    await query('delete from script_variants where script_id = $1', [scriptId]);
    for (const variant of payload.variants) {
      await query('insert into script_variants (script_id, os, body) values ($1, $2, $3)', [scriptId, variant.os, variant.body]);
    }
  }

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'script_updated', JSON.stringify({ scriptId }), 'config'],
  );

  res.json({ ok: true });
});

apiRouter.delete('/scripts/:id', requireCapability('delete'), async (req, res) => {
  const scriptId = Number(req.params.id);
  await query('delete from script_variants where script_id = $1', [scriptId]);
  await query('delete from scripts where id = $1', [scriptId]);

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'script_deleted', JSON.stringify({ scriptId }), 'config'],
  );

  res.json({ ok: true });
});

apiRouter.get('/schedules', async (_req, res) => {
  const rows = await query(
    `select id, name, scope_key, fn, arg, script_id, cron, enabled, next_run_at, created_by
     from schedules
     order by id desc`,
  );
  res.json(rows);
});

apiRouter.post('/schedules', requireCapability('windowManage'), async (req, res) => {
  const payload = scheduleSchema.parse(req.body);
  const target = mapScopeToTarget(payload.scope);

  const created = await query<{ id: number }>(
    `insert into schedules (name, scope_key, fn, arg, script_id, cron, enabled, next_run_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 day', $8)
     returning id`,
    [payload.name, target.scopeKey, payload.fn, payload.arg ?? null, payload.scriptId ?? null, payload.cron, payload.enabled, req.user!.id],
  );

  await saltClient.command({
    client: 'local',
    tgt: 'salt-master',
    tgt_type: 'glob',
    fun: 'schedule.add',
    arg: [payload.name, `function=${payload.fn}`, `job_args=${payload.arg ?? ''}`, `when=${payload.cron}`],
  });

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'schedule_created', JSON.stringify({ scheduleId: created[0].id, name: payload.name }), 'config'],
  );

  res.status(201).json({ id: created[0].id });
});

apiRouter.patch('/schedules/:id', requireCapability('windowManage'), async (req, res) => {
  const payload = scheduleSchema.partial().parse(req.body);
  const id = Number(req.params.id);

  const existing = await query<{ name: string }>('select name from schedules where id = $1 limit 1', [id]);
  if (!existing[0]) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }

  if (payload.enabled !== undefined) {
    await query('update schedules set enabled = $1 where id = $2', [payload.enabled, id]);
  }

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'schedule_updated', JSON.stringify({ id, payload }), 'config'],
  );

  res.json({ ok: true });
});

apiRouter.delete('/schedules/:id', requireCapability('delete'), async (req, res) => {
  const id = Number(req.params.id);
  const existing = await query<{ name: string }>('select name from schedules where id = $1', [id]);
  await query('delete from schedules where id = $1', [id]);

  const name = existing[0]?.name;
  if (name) {
    await saltClient.command({
      client: 'local',
      tgt: 'salt-master',
      tgt_type: 'glob',
      fun: 'schedule.delete',
      arg: [name],
    });
  }

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'schedule_deleted', JSON.stringify({ id }), 'config'],
  );

  res.json({ ok: true });
});

apiRouter.get('/users', requireCapability('usersManage'), async (_req, res) => {
  const users = await query('select id, name, email, role, status, last_active_at from users order by email');
  res.json(users);
});

apiRouter.post('/users', requireCapability('usersManage'), async (req, res) => {
  const payload = z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
      role: z.enum(['admin', 'operator', 'viewer']),
      status: z.enum(['active', 'suspended']).default('active'),
    })
    .parse(req.body);

  const created = await query<{ id: string }>(
    `insert into users (name, email, role, status, last_active_at)
     values ($1, $2, $3, $4, now())
     returning id`,
    [payload.name, payload.email.toLowerCase(), payload.role, payload.status],
  );

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'user_created', JSON.stringify({ id: created[0].id, email: payload.email }), 'config'],
  );

  res.status(201).json({ id: created[0].id });
});

apiRouter.patch('/users/:id', requireCapability('usersManage'), async (req, res) => {
  const id = req.params.id;
  const payload = z
    .object({
      name: z.string().min(1).optional(),
      role: z.enum(['admin', 'operator', 'viewer']).optional(),
      status: z.enum(['active', 'suspended']).optional(),
    })
    .parse(req.body);

  if (payload.name) {
    await query('update users set name = $1 where id = $2', [payload.name, id]);
  }
  if (payload.role) {
    await query('update users set role = $1 where id = $2', [payload.role, id]);
  }
  if (payload.status) {
    await query('update users set status = $1 where id = $2', [payload.status, id]);
  }

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'user_updated', JSON.stringify({ id, payload }), 'config'],
  );

  res.json({ ok: true });
});

apiRouter.delete('/users/:id', requireCapability('usersManage'), async (req, res) => {
  const id = req.params.id;
  await query('delete from users where id = $1', [id]);
  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [req.user!.id, 'user_deleted', JSON.stringify({ id }), 'config'],
  );
  res.json({ ok: true });
});

apiRouter.get('/audit', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = 30;
  const offset = (page - 1) * pageSize;

  const rows = await query(
    `select a.id, a.actor_id, u.email as actor_email, a.action, a.detail, a.kind, a.created_at
     from audit a
     left join users u on u.id = a.actor_id
     order by a.created_at desc
     limit $1 offset $2`,
    [pageSize, offset],
  );

  res.json({ page, items: rows });
});
