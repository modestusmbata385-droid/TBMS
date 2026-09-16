const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', -- open/closed/maintenance/emergency_lockdown
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'driver', -- super_admin / leader / driver
      full_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL,
      driver_code TEXT UNIQUE, -- TB-00001
      national_id TEXT,
      license_number TEXT,
      motorcycle_reg TEXT,
      emergency_contact TEXT,
      photo_url TEXT,
      motorcycle_photo_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- pending/active/on_trip/arrival_pending/suspended/banned/offline
      suspended_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS leaders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      id SERIAL PRIMARY KEY,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'waiting', -- waiting/assigned/completed/removed
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      trip_code TEXT UNIQUE,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      leader_id INTEGER REFERENCES leaders(id) ON DELETE SET NULL,
      queue_entry_id INTEGER REFERENCES queue_entries(id) ON DELETE SET NULL,
      destination TEXT,
      status TEXT NOT NULL DEFAULT 'on_trip', -- on_trip/arrival_pending/completed/cancelled
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      driver_confirmed_at TIMESTAMPTZ,
      leader_confirmed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS violations (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      leader_id INTEGER REFERENCES leaders(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS suspensions (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      start_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      end_at TIMESTAMPTZ, -- NULL = ban ya kudumu
      is_ban BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      type TEXT NOT NULL DEFAULT 'system_access', -- system_access/contribution
      reference TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending', -- pending/success/failed
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS contributions (
      id SERIAL PRIMARY KEY,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      target_amount NUMERIC NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS contribution_payments (
      id SERIAL PRIMARY KEY,
      contribution_id INTEGER NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS voice_reports (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      audio_url TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', -- pending/resolved/escalated
      response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      station_id INTEGER REFERENCES stations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      priority TEXT DEFAULT 'normal',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS station_operating_hours (
      id SERIAL PRIMARY KEY,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL, -- 0=Sunday..6=Saturday
      open_time TIME,
      close_time TIME,
      UNIQUE(station_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Kituo cha kwanza: Toangoma - kiundwe kikiwa hakipo
  const existing = await pool.query('SELECT id FROM stations LIMIT 1');
  if (!existing.rows[0]) {
    await pool.query("INSERT INTO stations (name, code) VALUES ('Toangoma', 'TOANGOMA')");
  }
}

module.exports = { pool, initDb };
