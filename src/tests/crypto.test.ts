import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-crypto-'));

test('API keys round-trip through encryption and are not stored in plain text', async () => {
  const { encrypt, decrypt, maskKey } = await import('../storage/crypto');
  const secret = 'sk-test-1234567890abcdef';
  const blob = encrypt(secret);
  assert.ok(!blob.includes(secret));
  assert.equal(decrypt(blob), secret);
  assert.notEqual(encrypt(secret), blob, 'random IV per encryption');
  assert.equal(maskKey(secret), 'sk-t…cdef');
  const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decrypt(tampered));
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'secret.key')));
});
