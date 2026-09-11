import test from 'node:test';
import assert from 'node:assert/strict';
import { imageExtension, validateDownloadedPayload } from '../lib/media.mjs';

test('image payload detection uses file signatures', () => {
  assert.equal(imageExtension(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')), 'png');
  assert.equal(imageExtension(Buffer.from('ffd8ffe000104a464946', 'hex')), 'jpg');
  assert.equal(imageExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
});

test('JSON media errors are rejected even when HTTP status was successful', () => {
  const payload = Buffer.from('{"code":90002006,"message":"Cover No Exist","data":null}');
  assert.throws(
    () => validateDownloadedPayload(payload, { kind: 'image', contentType: 'application/json' }),
    /Cover No Exist/,
  );
});

test('attachments reject HTML but accept ordinary text payloads', () => {
  assert.throws(
    () => validateDownloadedPayload(Buffer.from('<html>login</html>'), { kind: 'file', contentType: 'text/html' }),
    /HTML response/,
  );
  assert.doesNotThrow(() => validateDownloadedPayload(
    Buffer.from('ATTACHMENT-TEXT-4E71\n'),
    { kind: 'file', contentType: 'text/plain' },
  ));
});
