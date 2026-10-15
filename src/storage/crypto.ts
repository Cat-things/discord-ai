import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

let cachedKey: Buffer | null = null;

/** 32-byte key from ENCRYPTION_KEY, or a random one persisted to data/secret.key on first run. */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  let secret = config.encryptionKey;
  if (!secret) {
    const file = path.join(config.dataDir, 'secret.key');
    if (fs.existsSync(file)) {
      secret = fs.readFileSync(file, 'utf8').trim();
    } else {
      fs.mkdirSync(config.dataDir, { recursive: true });
      secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  cachedKey = crypto.createHash('sha256').update(secret).digest();
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(blob: string): string {
  const [version, iv, tag, data] = blob.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Stored API key is corrupted.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function maskKey(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
