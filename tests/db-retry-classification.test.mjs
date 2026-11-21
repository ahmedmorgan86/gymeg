import {test} from 'node:test';
import assert from 'node:assert/strict';

// Regression: the withScope/db.batch retry classifier must only retry
// transient connection failures. In particular a statement_timeout cancel
// (SQLSTATE 57014) - whose message contains "statement timeout" - must NOT be
// retried, because retrying doubles an intentionally bounded read.
const {isTransientConnectionError} = await import('../app/lib/database.ts');

const sqlstate = (code, message) => Object.assign(new Error(message), { code });

test('statement_timeout (57014) is never retried despite its message wording', () => {
  assert.equal(isTransientConnectionError(sqlstate('57014', 'canceling statement due to statement timeout')), false);
  assert.equal(isTransientConnectionError(sqlstate('57014', 'canceling statement due to user request')), false);
});

test('no other SQLSTATE is retried', () => {
  assert.equal(isTransientConnectionError(sqlstate('25006', 'cannot execute INSERT in a read-only transaction')), false);
  assert.equal(isTransientConnectionError(sqlstate('53300', 'sorry, too many clients already')), false);
  assert.equal(isTransientConnectionError(sqlstate('40P01', 'deadlock detected')), false);
});

test('server-restart and connection-exception SQLSTATEs are retried', () => {
  for (const code of ['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006']) {
    assert.equal(isTransientConnectionError(sqlstate(code, 'connection failure')), true, code);
  }
});

test('Node-level socket failures (no SQLSTATE) are retried', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']) {
    assert.equal(isTransientConnectionError(Object.assign(new Error('socket'), { code })), true, code);
  }
  assert.equal(isTransientConnectionError(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isTransientConnectionError(new Error('Connection lost')), true);
});

test('unrelated failures are not retried', () => {
  assert.equal(isTransientConnectionError(new Error('503 Service Unavailable')), false);
  assert.equal(isTransientConnectionError(new Error('timeout of 45000ms exceeded')), false);
  assert.equal(isTransientConnectionError(null), false);
  assert.equal(isTransientConnectionError('ECONNRESET'), false);
});
