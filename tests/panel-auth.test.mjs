import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelAuth } from '../packages/web/dist/panel-auth.js';

test('panel fails closed, authenticates requests, and rejects cross-site writes', t => {
  const previous = [process.env.PANEL_USERNAME, process.env.PANEL_PASSWORD, process.env.PANEL_ORIGIN];
  delete process.env.PANEL_ORIGIN;
  t.after(() => { ['PANEL_USERNAME', 'PANEL_PASSWORD', 'PANEL_ORIGIN'].forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]); });
  const run = (headers = {}, method = 'GET') => {
    let result = 200;
    panelAuth({ method, get: key => headers[key] }, { setHeader() {}, status(code) { result = code; return this; }, json() {} }, () => {});
    return result;
  };
  delete process.env.PANEL_USERNAME; delete process.env.PANEL_PASSWORD;
  assert.equal(run(), 503);
  process.env.PANEL_USERNAME = 'test'; process.env.PANEL_PASSWORD = 'synthetic-long-password';
  assert.equal(run(), 401);
  assert.equal(run({ authorization: 'Basic invalid' }), 401);
  const headers = { authorization: 'Basic ' + Buffer.from('test:synthetic-long-password').toString('base64'), host: 'panel.example' };
  assert.equal(run(headers), 200);
  assert.equal(run({ ...headers, origin: 'https://attacker.example' }, 'POST'), 403);
  assert.equal(run({ ...headers, 'sec-fetch-site': 'cross-site' }, 'DELETE'), 403);
  assert.equal(run({ ...headers, origin: 'https://panel.example' }, 'POST'), 200);
  process.env.PANEL_ORIGIN = 'https://public.example';
  assert.equal(run({ ...headers, origin: 'https://public.example' }, 'POST'), 200);
  assert.equal(run({ ...headers, origin: 'http://public.example' }, 'POST'), 403);
  assert.equal(run({ ...headers, origin: 'malformed' }, 'POST'), 403);
});
