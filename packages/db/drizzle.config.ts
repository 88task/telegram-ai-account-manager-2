import 'dotenv/config';
import { databaseConnectionOptions } from './src/configuration';
import { defineConfig } from 'drizzle-kit';

const connection = databaseConnectionOptions();
if (!connection.connectionString) throw new Error('DATABASE_URL is required for db:push');
const url = new URL(connection.connectionString);
if (url.search) throw new Error('db:push requires a standard PostgreSQL URL without non-TLS query parameters');

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: connection.ssl,
  },
});
