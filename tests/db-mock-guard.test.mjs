import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  }
});

const {getPool} = await import('../app/lib/database.ts');

const env = {...process.env};
const restore = () => {
  for (const key of ['NODE_ENV', 'GYMOS_ALLOW_DB_MOCK', 'DATABASE_URL']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
};

test('A4: the mock database pool is unreachable in production even when explicitly opted in', () => {
  try {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    process.env.GYMOS_ALLOW_DB_MOCK = '1';
    assert.throws(() => getPool(), /DATABASE_URL is required/);
  } finally {
    restore();
  }
});

test('A4: the mock pool still serves explicit test runs outside production', async () => {
  try {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    const pool = getPool();
    const result = await pool.query('SELECT 1');
    assert.deepEqual(result.rows, []);
  } finally {
    restore();
  }
});
