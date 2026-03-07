const { Client } = require('pg');
require('dotenv').config();

const ref = process.env.SUPABASE_URL.match(/https:\/\/(\w+)/)[1];

async function migrate() {
  const client = new Client({
    host: `aws-0-sa-east-1.pooler.supabase.com`,
    port: 6543,
    database: 'postgres',
    user: `postgres.${ref}`,
    password: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    await client.connect();
    console.log('Connected to Supabase PostgreSQL');

    const sqls = [
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'received'",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_me BOOLEAN DEFAULT false",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_details TEXT",
      "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0",
      "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_preview TEXT",
    ];

    for (const sql of sqls) {
      try {
        await client.query(sql);
        console.log('OK:', sql.substring(0, 70));
      } catch (e) {
        console.error('FAIL:', e.message);
      }
    }

    const { rows } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'messages' ORDER BY ordinal_position");
    console.log('\nMessages columns:', rows.map(r => r.column_name).join(', '));

    const { rows: cr } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' ORDER BY ordinal_position");
    console.log('Conversations columns:', cr.map(r => r.column_name).join(', '));

  } catch (e) {
    console.error('Connection error:', e.message);
  } finally {
    await client.end();
  }
}

migrate();
