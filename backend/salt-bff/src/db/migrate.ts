import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSqlDirectory(directory: string) {
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const fullPath = path.join(directory, file);
    const sql = await fs.readFile(fullPath, 'utf8');
    await db.query(sql);
    console.log(`Applied ${fullPath}`);
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, '../../../../');
  await runSqlDirectory(path.join(repoRoot, 'db/migrations'));
  await runSqlDirectory(path.join(repoRoot, 'db/seeds'));
  await db.end();
}

void main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
