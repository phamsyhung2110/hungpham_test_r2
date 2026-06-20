const { Client } = require('pg');
const redis = require('redis');

async function main() {
  if (process.env.FORCE_FAIL === 'true') {
    console.error('FORCE_FAIL=true — deliberate failure to prove teardown still runs');
    process.exit(1);
  }

  // PostgreSQL: write and read back a record
  const pg = new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'testdb',
  });
  await pg.connect();
  await pg.query(`
    CREATE TABLE IF NOT EXISTS test_records (
      id SERIAL PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const insert = await pg.query(
    "INSERT INTO test_records (value) VALUES ($1) RETURNING id",
    ['hello-postgres']
  );
  const id = insert.rows[0].id;
  const select = await pg.query('SELECT value FROM test_records WHERE id = $1', [id]);
  console.log(`PostgreSQL: wrote and read back "${select.rows[0].value}" (id=${id})`);
  await pg.end();

  // Redis: write and read back a key
  const client = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    },
  });
  client.on('error', (err) => { throw err; });
  await client.connect();
  await client.set('test-key', 'hello-redis');
  const val = await client.get('test-key');
  console.log(`Redis: wrote and read back "${val}"`);
  await client.disconnect();

  console.log('All integration tests passed.');
}

main().catch((err) => {
  console.error('Integration test failed:', err.message);
  process.exit(1);
});
