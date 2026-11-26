import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4100),
  DATABASE_URL: z.string().min(1),
  SALT_API_URL: z.string().url(),
  SALT_API_USER: z.string().min(1),
  SALT_API_PASSWORD: z.string().min(1),
  SALT_EAUTH: z.string().default('pam'),
  SALT_HTTP_TIMEOUT_MS: z.coerce.number().default(3000),
  SALT_EVENTS_TIMEOUT_MS: z.coerce.number().default(180000),
  RUN_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(30),
  MAX_CONCURRENT_RUNS: z.coerce.number().default(6),
});

export const env = schema.parse(process.env);
