export type Role = 'admin' | 'operator' | 'viewer';
export type UserStatus = 'active' | 'suspended';
export type ScriptType = 'sls' | 'sh';
export type ScriptOs = 'default' | 'Ubuntu' | 'Debian' | 'Rocky Linux';
export type ScopeType = 'all' | 'department' | 'os' | 'minion';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
}

export interface ScopeInput {
  type: ScopeType;
  value?: string;
}

export interface SaltTarget {
  tgt: string;
  tgt_type: 'glob' | 'nodegroup' | 'grain';
  scopeKey: string;
}

export interface StreamMessage {
  minion: string;
  retcode: number;
  changes: unknown;
  comment: string;
}
