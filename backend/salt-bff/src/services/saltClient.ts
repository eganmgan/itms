import { env } from '../config/env.js';

interface SaltLoginResponse {
  return: Array<{ token: string; expire: number; perms: string[] }>;
}

interface SaltCommandResponse<T = unknown> {
  return: T[];
}

interface SaltEventPayload {
  tag?: string;
  data?: Record<string, unknown>;
}

export class SaltClient {
  private token: string | null = null;
  private tokenExpireEpoch = 0;

  private async postCommandWithToken(token: string, body: Record<string, unknown>) {
    return fetch(`${env.SALT_API_URL}/`, {
      method: 'POST',
      signal: AbortSignal.timeout(env.SALT_HTTP_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': token,
      },
      body: JSON.stringify(body),
    });
  }

  private async ensureToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now < this.tokenExpireEpoch - 60) {
      return this.token;
    }

    const response = await fetch(`${env.SALT_API_URL}/login`, {
      method: 'POST',
      signal: AbortSignal.timeout(env.SALT_HTTP_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: env.SALT_API_USER,
        password: env.SALT_API_PASSWORD,
        eauth: env.SALT_EAUTH,
      }),
    });

    if (!response.ok) {
      throw new Error(`Salt login failed: ${response.status}`);
    }

    const payload = (await response.json()) as SaltLoginResponse;
    const auth = payload.return?.[0];
    if (!auth?.token) {
      throw new Error('Salt login did not return a token');
    }

    this.token = auth.token;
    this.tokenExpireEpoch = auth.expire;
    return this.token;
  }

  async command<T = unknown>(body: Record<string, unknown>): Promise<T[]> {
    let token = await this.ensureToken();
    let response = await this.postCommandWithToken(token, body);

    if (response.status === 401) {
      // Token can become invalid server-side before local expiry; force re-login once.
      this.token = null;
      this.tokenExpireEpoch = 0;
      token = await this.ensureToken();
      response = await this.postCommandWithToken(token, body);
    }

    if (!response.ok) {
      const body = await response.text();
      const snippet = body.slice(0, 300);
      throw new Error(`Salt command failed: ${response.status}${snippet ? ` - ${snippet}` : ''}`);
    }

    const payload = (await response.json()) as SaltCommandResponse<T>;
    return payload.return ?? [];
  }

  async runLocalAsync(args: {
    tgt: string;
    tgt_type: 'glob' | 'nodegroup' | 'grain';
    fun: string;
    arg?: string[];
  }): Promise<string> {
    const result = await this.command<{ jid: string }>({
      client: 'local_async',
      tgt: args.tgt,
      tgt_type: args.tgt_type,
      fun: args.fun,
      arg: args.arg ?? [],
    });

    const jid = result[0]?.jid;
    if (!jid) {
      throw new Error('Salt async run did not return a jid');
    }

    return jid;
  }

  async runLocal<T = unknown>(args: {
    tgt: string;
    tgt_type: 'glob' | 'nodegroup' | 'grain';
    fun: string;
    arg?: string[];
  }): Promise<Record<string, T>> {
    const result = await this.command<Record<string, T>>({
      client: 'local',
      tgt: args.tgt,
      tgt_type: args.tgt_type,
      fun: args.fun,
      arg: args.arg ?? [],
    });

    return result[0] ?? {};
  }

  async subscribeEvents(onEvent: (event: SaltEventPayload) => void): Promise<() => void> {
    const token = await this.ensureToken();
    const response = await fetch(`${env.SALT_API_URL}/events`, {
      headers: {
        'X-Auth-Token': token,
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Salt event stream failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let running = true;
    let buffer = '';

    const loop = async () => {
      try {
        while (running) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data:')) {
              continue;
            }
            const json = line.slice(5).trim();
            if (!json) {
              continue;
            }
            try {
              const parsed = JSON.parse(json) as SaltEventPayload;
              onEvent(parsed);
            } catch {
              // Ignore malformed event payloads.
            }
          }
        }
      } catch (error) {
        if (running) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Salt event stream disconnected: ${message}`);
        }
      }
    };

    void loop();

    return () => {
      running = false;
      void reader.cancel();
    };
  }
}

export const saltClient = new SaltClient();
