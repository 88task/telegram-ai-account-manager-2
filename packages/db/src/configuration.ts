import crypto from 'node:crypto';

export function encryptionKey(): Buffer {
  const hex = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('SESSION_ENCRYPTION_KEY must be 64 hexadecimal characters');
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

export function defaultOperatingMode(): 'manual' | 'draft' | 'auto_pilot' {
  const mode = process.env.DEFAULT_OPERATING_MODE ?? process.env.OPERATING_MODE ?? 'draft';
  return mode === 'manual' || mode === 'draft' || mode === 'auto_pilot' ? mode : 'draft';
}


/** Shared by runtime queries and Drizzle migrations so neither can bypass TLS. */
export function databaseConnectionOptions() {
  let connectionString = process.env.DATABASE_URL || '';
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      // node-postgres URL SSL options otherwise replace the explicit TLS policy.
      for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
      connectionString = url.toString();
    } catch { /* The database driver reports malformed connection strings. */ }
  }
  return {
    connectionString,
    ssl: {
      rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
      ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n') } : {}),
    },
  };
}
