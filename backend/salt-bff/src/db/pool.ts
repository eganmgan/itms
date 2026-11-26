import { Pool, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';

export const db = new Pool({
  connectionString: env.DATABASE_URL,
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}
