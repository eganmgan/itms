import { EventEmitter } from 'node:events';
import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import type { SaltTarget, ScopeInput, ScriptOs, StreamMessage } from '../types/index.js';
import { saltClient } from './saltClient.js';

interface ActiveRun {
  jid: string;
  expectedMinions: Set<string>;
  returns: Map<string, StreamMessage>;
  createdBy: string;
  fn: string;
  target: SaltTarget;
  emitter: EventEmitter;
  status: 'running' | 'done';
  timeout: NodeJS.Timeout;
}

interface ScriptVariantRow {
  os: ScriptOs;
  body: string;
}

const ALLOWED_FUN = new Set([
  'state.apply',
  'state.sls',
  'cmd.run',
  'cmd.script',
  'pkg.upgrade',
  'pkg.install',
  'pkg.list_upgrades',
  'grains.items',
]);

const SAFE_CMD_PREFIXES = [
  'apt ',
  'apt-get ',
  'dnf ',
  'yum ',
  'zypper ',
  'systemctl status salt-minion',
  'systemctl restart salt-minion',
  'systemctl is-active salt-minion',
  'uname ',
  'uptime',
  'whoami',
  'cat /etc/os-release',
  'df -h',
  'free -h',
  'echo ',
  'bash ',
  'sh ',
];

const DESTRUCTIVE_CMD_PATTERN = /(\brm\s+-rf\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\s+if=)/i;

const runLimiter = pLimit(env.MAX_CONCURRENT_RUNS);
const runs = new Map<string, ActiveRun>();
let eventsAttached = false;
let stopEvents: (() => void) | null = null;
const runWindow = new Map<string, number[]>();

function assertAllowedFun(fun: string) {
  if (!ALLOWED_FUN.has(fun)) {
    throw new Error(`Function is not allow-listed: ${fun}`);
  }
}

function validateSlsArg(arg?: string) {
  const value = (arg ?? '').trim();
  if (!value) {
    throw new Error('SLS run requires a state name argument');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error('SLS argument contains invalid characters');
  }
  return value;
}

function validatePkgArg(arg?: string) {
  const value = (arg ?? '').trim();
  if (!value) {
    return '';
  }
  if (!/^[a-zA-Z0-9+_.:@/-]+$/.test(value)) {
    throw new Error('Package argument contains invalid characters');
  }
  return value;
}

function validateCmdArg(arg?: string) {
  const value = (arg ?? '').trim();
  if (!value) {
    throw new Error('Command run requires a command argument');
  }
  if (value.length > 4000) {
    throw new Error('Command is too long');
  }

  const isMultiline = value.includes('\n');
  if (isMultiline) {
    return { fun: 'cmd.script', arg: [value], destructive: DESTRUCTIVE_CMD_PATTERN.test(value) };
  }

  const lower = value.toLowerCase();
  const safePrefix = SAFE_CMD_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!safePrefix) {
    throw new Error('Command is not in the approved command allow-list');
  }

  return { fun: 'cmd.run', arg: [value], destructive: DESTRUCTIVE_CMD_PATTERN.test(value) };
}

export function mapScopeToTarget(scope: ScopeInput): SaltTarget {
  switch (scope.type) {
    case 'all':
      return { tgt: '*', tgt_type: 'glob', scopeKey: 'all:*' };
    case 'department':
      if (!scope.value) {
        throw new Error('Department scope requires value');
      }
      return { tgt: scope.value, tgt_type: 'nodegroup', scopeKey: `department:${scope.value}` };
    case 'os':
      if (!scope.value) {
        throw new Error('OS scope requires value');
      }
      return { tgt: `os:${scope.value}`, tgt_type: 'grain', scopeKey: `os:${scope.value}` };
    case 'minion':
      if (!scope.value) {
        throw new Error('Minion scope requires value');
      }
      return { tgt: scope.value, tgt_type: 'glob', scopeKey: `minion:${scope.value}` };
    default:
      throw new Error('Unsupported scope');
  }
}

function checkRunRateLimit(userId: string) {
  const now = Date.now();
  const bucket = runWindow.get(userId) ?? [];
  const bounded = bucket.filter((ts) => now - ts < 60_000);
  if (bounded.length >= env.RUN_RATE_LIMIT_PER_MINUTE) {
    throw new Error('Run rate limit exceeded');
  }
  bounded.push(now);
  runWindow.set(userId, bounded);
}

async function resolveExpectedMinions(target: SaltTarget): Promise<string[]> {
  const ping = await saltClient.runLocal<boolean>({
    tgt: target.tgt,
    tgt_type: target.tgt_type,
    fun: 'test.ping',
  });

  return Object.entries(ping)
    .filter(([, ok]) => Boolean(ok))
    .map(([minion]) => minion);
}

async function dispatchScriptByOs(scriptId: number, target: SaltTarget): Promise<{ fn: string; arg: string[] }> {
  const scripts = await query<{ id: number; type: 'sls' | 'sh' }>('select id, type from scripts where id = $1', [scriptId]);
  const script = scripts[0];
  if (!script) {
    throw new Error('Script not found');
  }

  if (script.type === 'sls') {
    const variants = await query<ScriptVariantRow>(
      'select os, body from script_variants where script_id = $1 order by case when os = $2 then 0 else 1 end',
      [scriptId, 'default'],
    );
    const selected = variants[0]?.body;
    if (!selected) {
      throw new Error('Script has no variant body');
    }
    return { fn: 'state.apply', arg: [selected.trim()] };
  }

  const variants = await query<ScriptVariantRow>('select os, body from script_variants where script_id = $1', [scriptId]);
  const defaultBody = variants.find((v) => v.os === 'default')?.body ?? '';
  if (!defaultBody) {
    throw new Error('Shell script must include default variant');
  }

  const perOs = variants.filter((v) => v.os !== 'default');
  if (perOs.length === 0) {
    return { fn: 'cmd.run', arg: [defaultBody] };
  }

  const escapedCases = perOs
    .map((v) => {
      const os = v.os.replace(/'/g, "''");
      const body = v.body.replace(/'/g, "''");
      return `if [[ \"$os_family\" == '${os}' ]]; then cat <<'EOS'\n${body}\nEOS\nexit 0\nfi`;
    })
    .join('\n');

  const scriptBody = `os_family=$(grains.get os 2>/dev/null || echo default)\n${escapedCases}\ncat <<'EOS'\n${defaultBody}\nEOS`;

  return { fn: 'cmd.run', arg: [scriptBody] };
}

function summarizeRun(run: ActiveRun) {
  let succeeded = 0;
  let failed = 0;
  let changed = 0;

  for (const ret of run.returns.values()) {
    if (ret.retcode === 0) {
      succeeded += 1;
    } else {
      failed += 1;
    }

    if (ret.changes && typeof ret.changes === 'object' && Object.keys(ret.changes as object).length > 0) {
      changed += 1;
    }
  }

  return { succeeded, failed, changed };
}

async function finalizeRun(jid: string, status: 'done' | 'timeout') {
  const run = runs.get(jid);
  if (!run || run.status === 'done') {
    return;
  }

  run.status = 'done';
  clearTimeout(run.timeout);

  const summary = summarizeRun(run);
  run.emitter.emit('done', { ...summary, status });

  const minions = Array.from(run.expectedMinions);
  await query(
    `insert into jobs (jid, fn, scope_key, target_expr, minions, succeeded, failed, changed, status, started_at, finished_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)`,
    [
      run.jid,
      run.fn,
      run.target.scopeKey,
      `${run.target.tgt_type}:${run.target.tgt}`,
      minions,
      summary.succeeded,
      summary.failed,
      summary.changed,
      status,
      run.createdBy,
    ],
  );

  await query(
    `insert into audit (actor_id, action, detail, kind, created_at)
     values ($1, $2, $3::jsonb, $4, now())`,
    [
      run.createdBy,
      'run_completed',
      JSON.stringify({ jid: run.jid, summary, status, fn: run.fn, scope: run.target.scopeKey }),
      status === 'done' ? 'run' : 'run-fail',
    ],
  );
}

async function attachEventBus() {
  if (eventsAttached) {
    return;
  }

  stopEvents = await saltClient.subscribeEvents((event) => {
    const tag = event.tag ?? '';
    const match = /^salt\/job\/(.+)\/ret\/(.+)$/.exec(tag);
    if (!match) {
      return;
    }

    const jid = match[1];
    const minion = match[2];
    const run = runs.get(jid);
    if (!run || run.status === 'done') {
      return;
    }

    const data = event.data ?? {};
    const payload: StreamMessage = {
      minion,
      retcode: Number(data.retcode ?? 0),
      changes: data.return ?? {},
      comment: typeof data.fun === 'string' ? `Return from ${data.fun}` : 'Return received',
    };

    run.returns.set(minion, payload);
    run.emitter.emit('message', payload);

    const received = run.returns.size;
    const expected = run.expectedMinions.size;

    run.emitter.emit('progress', { received, expected });

    if (received >= expected && expected > 0) {
      void finalizeRun(jid, 'done');
    }
  });

  eventsAttached = true;
}

export function getRunEmitter(jid: string): EventEmitter | null {
  return runs.get(jid)?.emitter ?? null;
}

export async function startRun(input: {
  createdBy: string;
  fn: string;
  arg?: string;
  scope: ScopeInput;
  scriptId?: number;
  confirmed?: boolean;
}): Promise<{ jid: string }> {
  checkRunRateLimit(input.createdBy);

  const target = mapScopeToTarget(input.scope);
  await attachEventBus();

  const resolvePayload = async () => {
    if (input.scriptId) {
      return dispatchScriptByOs(input.scriptId, target);
    }

    let fn = input.fn;
    let arg: string[] = [];
    let destructive = false;

    if (fn === 'sls') {
      fn = 'state.apply';
      arg = [validateSlsArg(input.arg)];
    } else if (fn === 'cmd') {
      const cmd = validateCmdArg(input.arg);
      fn = cmd.fun;
      arg = cmd.arg;
      destructive = cmd.destructive;
    } else if (fn === 'pkg') {
      const pkgArg = validatePkgArg(input.arg);
      fn = pkgArg ? 'pkg.install' : 'pkg.upgrade';
      arg = pkgArg ? [pkgArg] : [];
    }

    if ((target.tgt === '*' || destructive) && !input.confirmed) {
      throw new Error('Wide-scope or destructive runs require confirmation');
    }

    assertAllowedFun(fn);
    return { fn, arg };
  };

  return runLimiter(async () => {
    const payload = await resolvePayload();
    const expectedMinions = await resolveExpectedMinions(target);

    const jid = await saltClient.runLocalAsync({
      tgt: target.tgt,
      tgt_type: target.tgt_type,
      fun: payload.fn,
      arg: payload.arg,
    });

    const emitter = new EventEmitter();
    const timeout = setTimeout(() => {
      void finalizeRun(jid, 'timeout');
    }, env.SALT_EVENTS_TIMEOUT_MS);

    runs.set(jid, {
      jid,
      createdBy: input.createdBy,
      fn: payload.fn,
      target,
      expectedMinions: new Set(expectedMinions),
      returns: new Map(),
      emitter,
      status: 'running',
      timeout,
    });

    await query(
      `insert into audit (actor_id, action, detail, kind, created_at)
       values ($1, $2, $3::jsonb, $4, now())`,
      [
        input.createdBy,
        'run_started',
        JSON.stringify({ jid, fn: payload.fn, scope: target.scopeKey, target: target.tgt, targetType: target.tgt_type }),
        'run',
      ],
    );

    return { jid };
  });
}

export async function shutdownRunManager() {
  if (stopEvents) {
    stopEvents();
  }
}
