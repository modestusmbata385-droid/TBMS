
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN, credentials: true } : undefined
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c search_path=tbms,public',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});


const SCHEMA_SQL = `

CREATE TABLE IF NOT EXISTS stations (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(40) UNIQUE NOT NULL,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(160) NOT NULL,
  phone VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(180),
  password_hash TEXT NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'driver'
    CHECK (role IN ('driver','leader','super_admin')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  driver_code VARCHAR(40) UNIQUE NOT NULL,
  national_id VARCHAR(80),
  license_number VARCHAR(80),
  motorcycle_reg VARCHAR(80),
  emergency_contact VARCHAR(80),
  status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','banned')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready','assigned','on_trip','arrival_pending','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  UNIQUE (station_id, driver_id, status)
);

CREATE INDEX IF NOT EXISTS idx_queue_station_status_joined
  ON queue_entries(station_id, status, joined_at);

CREATE TABLE IF NOT EXISTS trips (
  id BIGSERIAL PRIMARY KEY,
  trip_code VARCHAR(50) UNIQUE NOT NULL,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  driver_id BIGINT NOT NULL REFERENCES drivers(id),
  leader_id BIGINT REFERENCES users(id),
  destination VARCHAR(200),
  trip_type VARCHAR(30) NOT NULL DEFAULT 'normal',
  status VARCHAR(30) NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned','departed','arrival_pending','completed','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  departed_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trips_driver_status
  ON trips(driver_id, status);

CREATE TABLE IF NOT EXISTS violations (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  recorded_by BIGINT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  amount NUMERIC(12,2) NOT NULL,
  type VARCHAR(40) NOT NULL DEFAULT 'system_fee',
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  reference VARCHAR(120) UNIQUE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contributions (
  id BIGSERIAL PRIMARY KEY,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  station_id BIGINT NOT NULL REFERENCES stations(id),
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'paid',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(60),
  entity_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(80) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO stations (name, code, address)
VALUES ('Toangoma Station', 'TOANGOMA-01', 'Toangoma, Dar es Salaam')
ON CONFLICT (code) DO NOTHING;

INSERT INTO system_settings(key, value)
VALUES
  ('system_open', 'true'::jsonb),
  ('working_hours', '{"monday":["06:00","23:00"],"tuesday":["06:00","23:00"],"wednesday":["06:00","23:00"],"thursday":["06:00","23:00"],"friday":["06:00","23:00"],"saturday":["06:00","00:00"],"sunday":["07:00","22:00"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

`;

async function initSchema() {
  await pool.query('CREATE SCHEMA IF NOT EXISTS tbms');
  const marker = await pool.query(`SELECT to_regclass('tbms.schema_version') AS t`);
  let version = 0;
  if (marker.rows[0].t) {
    const v = await pool.query('SELECT version FROM schema_version LIMIT 1');
    version = v.rows[0]?.version || 0;
  }
  if (version < 2) {
    console.log('[migration] Inaanzisha upya schema ya tbms (v1 -> v2)...');
    await pool.query('DROP SCHEMA IF EXISTS tbms CASCADE');
    await pool.query('CREATE SCHEMA tbms');
  }
  await pool.query(SCHEMA_SQL);
  await pool.query('CREATE TABLE IF NOT EXISTS schema_version (version INT)');
  await pool.query('DELETE FROM schema_version');
  await pool.query('INSERT INTO schema_version(version) VALUES (2)');
  console.log('[migration] Schema ya tbms (v2) iko tayari.');
}

async function runSeed() {
  const bcryptLib = require('bcryptjs');
  const password = await bcryptLib.hash('ChangeMe123!', 12);
  const station = await pool.query("SELECT id FROM stations WHERE code='TOANGOMA-01' LIMIT 1");
  const stationId = station.rows[0].id;
  const superAdminPhone = process.env.SUPERADMIN_PHONE || '0789888535';

  const accounts = [
    ['Super Admin', superAdminPhone, 'super_admin', 'TB-ADMIN'],
    ['Joseph', '0789000001', 'leader', 'TB-LEADER'],
    ['Salum Ally', '0789000012', 'driver', 'TB-0012'],
    ['Musa Abdallah', '0789000038', 'driver', 'TB-0038'],
    ['Hassan Juma', '0789000051', 'driver', 'TB-0051']
  ];

  for (const [name, phone, role, code] of accounts) {
    const u = await pool.query(
      `INSERT INTO users(full_name,phone,password_hash,role)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(phone) DO UPDATE SET full_name=EXCLUDED.full_name
       RETURNING id`, [name, phone, password, role]
    );
    const userId = u.rows[0].id;
    if (role === 'driver') {
      await pool.query(
        `INSERT INTO drivers(user_id,station_id,driver_code,status,motorcycle_reg,license_number)
         VALUES($1,$2,$3,'active',$4,$5)
         ON CONFLICT(user_id) DO UPDATE SET status='active'`,
        [userId, stationId, code, 'MC-1234', 'DL-8877']
      );
    }
  }
  console.log(`[seed] Tayari. Super Admin: ${superAdminPhone} / password: ChangeMe123!`);
}

const PORT = Number(process.env.PORT || 10000);
const STATION_ID = Number(process.env.STATION_ID || 1);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, stationId: STATION_ID }, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('tbms_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

async function auth(req, res, next) {
  try {
    const token = req.cookies.tbms_token ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Hujaingia kwenye mfumo.' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session imekwisha. Ingia tena.' });
  }
}

function roles(...allowed) {
  return (req, res, next) => allowed.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Huna ruhusa ya kufanya kitendo hiki.' });
}

async function audit(userId, action, entityType, entityId, metadata={}) {
  await pool.query(
    `INSERT INTO audit_logs(user_id,action,entity_type,entity_id,metadata)
     VALUES($1,$2,$3,$4,$5)`,
    [userId, action, entityType, entityId || null, metadata]
  );
}

async function getDriverByUser(userId) {
  const r = await pool.query(
    `SELECT d.*, u.full_name, u.phone, u.email, u.role
     FROM drivers d JOIN users u ON u.id=d.user_id
     WHERE d.user_id=$1`, [userId]
  );
  return r.rows[0] || null;
}

async function getQueue(stationId=STATION_ID) {
  const r = await pool.query(
    `SELECT q.id AS queue_id, q.joined_at, d.id AS driver_id, d.user_id,
            d.driver_code, d.status AS driver_status, u.full_name, u.phone,
            ROW_NUMBER() OVER (ORDER BY q.joined_at, q.id)::int AS position
     FROM queue_entries q
     JOIN drivers d ON d.id=q.driver_id
     JOIN users u ON u.id=d.user_id
     WHERE q.station_id=$1 AND q.status='ready'
     ORDER BY q.joined_at, q.id`, [stationId]
  );
  return r.rows;
}

function emitQueue() {
  io.to(`station:${STATION_ID}`).emit('queue.updated');
}

function emitTrip(event, data={}) {
  io.to(`station:${STATION_ID}`).emit(event, data);
}

// Health / system
app.get('/health', async (req,res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok:true, service:'toangoma-tbms', time:new Date().toISOString() });
  } catch {
    res.status(503).json({ ok:false, error:'Database unavailable' });
  }
});

app.get('/api/system/status', async (req,res) => {
  const r = await pool.query(`SELECT value FROM system_settings WHERE key='system_open'`);
  res.json({ open: r.rows[0]?.value ?? true });
});

// Auth
app.post('/api/auth/register', async (req,res) => {
  const { full_name, phone, email, national_id, license_number, motorcycle_reg, emergency_contact, password } = req.body;
  if (!full_name || !phone || !password || !national_id || !license_number || !motorcycle_reg) {
    return res.status(400).json({ error:'Jaza taarifa zote muhimu.' });
  }
  if (String(password).length < 6) return res.status(400).json({ error:'Nenosiri liwe angalau herufi 6.' });

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const exists = await c.query('SELECT 1 FROM users WHERE phone=$1', [phone.trim()]);
    if (exists.rowCount) throw Object.assign(new Error('Namba hii tayari imesajiliwa.'), { status:409 });

    const hash = await bcrypt.hash(password, 12);
    const u = await c.query(
      `INSERT INTO users(full_name,phone,email,password_hash,role)
       VALUES($1,$2,$3,$4,'driver') RETURNING id,full_name,phone,email,role`,
      [full_name.trim(), phone.trim(), email || null, hash]
    );
    const user = u.rows[0];
    const code = 'TB-' + String(user.id).padStart(5,'0');

    await c.query(
      `INSERT INTO drivers(user_id,station_id,driver_code,national_id,license_number,motorcycle_reg,emergency_contact,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [user.id, STATION_ID, code, national_id, license_number, motorcycle_reg, emergency_contact || null]
    );
    await c.query('COMMIT');
    await audit(user.id, 'driver.registered', 'driver', user.id);
    res.status(201).json({ message:'Usajili umekamilika. Akaunti inasubiri uthibitisho wa Leader.', driver_code:code });
  } catch(e) {
    await c.query('ROLLBACK');
    res.status(e.status || 500).json({ error:e.status ? e.message : 'Usajili umeshindikana.' });
  } finally { c.release(); }
});

app.post('/api/auth/login', async (req,res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error:'Weka namba ya simu na nenosiri.' });

  const r = await pool.query(
    `SELECT u.*, d.id AS driver_id, d.driver_code, d.status AS driver_status,
            d.station_id, d.national_id, d.license_number, d.motorcycle_reg, d.emergency_contact
     FROM users u LEFT JOIN drivers d ON d.user_id=u.id
     WHERE u.phone=$1 LIMIT 1`, [String(phone).trim()]
  );
  const u = r.rows[0];
  if (!u || !u.is_active) return res.status(401).json({ error:'Akaunti haipo au imezimwa.' });
  if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error:'Namba au nenosiri si sahihi.' });

  setAuthCookie(res, sign(u));
  res.json({ user:{id:u.id,full_name:u.full_name,phone:u.phone,email:u.email,role:u.role},
    driver:u.driver_id ? {
      id:u.driver_id,user_id:u.id,driver_code:u.driver_code,status:u.driver_status,
      station_id:u.station_id,national_id:u.national_id,license_number:u.license_number,
      motorcycle_reg:u.motorcycle_reg,emergency_contact:u.emergency_contact,full_name:u.full_name,phone:u.phone
    } : null
  });
});

app.post('/api/auth/logout', (req,res) => {
  res.clearCookie('tbms_token');
  res.json({ ok:true });
});

app.get('/api/me', auth, async (req,res) => {
  const r = await pool.query(`SELECT id,full_name,phone,email,role FROM users WHERE id=$1`, [req.user.id]);
  if (!r.rowCount) return res.status(404).json({error:'User not found'});
  res.json({ user:r.rows[0], driver:await getDriverByUser(req.user.id) });
});

// Queue
app.get('/api/queue', auth, async (req,res) => {
  const driver = await getDriverByUser(req.user.id);
  const stationId = driver?.station_id || STATION_ID;
  res.json({ queue: await getQueue(stationId) });
});

app.post('/api/queue/join', auth, roles('driver'), async (req,res) => {
  const driver = await getDriverByUser(req.user.id);
  if (!driver) return res.status(404).json({error:'Dereva hajapatikana.'});
  if (driver.status !== 'active') return res.status(400).json({error:'Akaunti yako hairuhusiwi kuingia foleni.'});

  const system = await pool.query(`SELECT value FROM system_settings WHERE key='system_open'`);
  if (system.rows[0] && system.rows[0].value === false) return res.status(403).json({error:'Mfumo umefungwa kwa sasa.'});

  const active = await pool.query(
    `SELECT 1 FROM queue_entries WHERE station_id=$1 AND driver_id=$2
     AND status IN ('ready','assigned','on_trip','arrival_pending') LIMIT 1`,
    [driver.station_id, driver.id]
  );
  if (active.rowCount) return res.status(409).json({error:'Tayari upo kwenye foleni/safari.'});

  await pool.query(`INSERT INTO queue_entries(station_id,driver_id,status) VALUES($1,$2,'ready')`, [driver.station_id,driver.id]);
  await audit(req.user.id,'queue.join','driver',driver.id);
  emitQueue();
  res.json({ok:true});
});

app.post('/api/queue/leave', auth, roles('driver'), async (req,res) => {
  const driver = await getDriverByUser(req.user.id);
  if (!driver) return res.status(404).json({error:'Dereva hajapatikana.'});
  const r = await pool.query(
    `UPDATE queue_entries SET status='left',left_at=NOW()
     WHERE station_id=$1 AND driver_id=$2 AND status='ready' RETURNING id`,
    [driver.station_id,driver.id]
  );
  if (!r.rowCount) return res.status(400).json({error:'Hupo kwenye foleni.'});
  await audit(req.user.id,'queue.leave','queue_entry',r.rows[0].id);
  emitQueue();
  res.json({ok:true});
});

// Driver trips
app.get('/api/trips/mine', auth, roles('driver'), async (req,res) => {
  const driver = await getDriverByUser(req.user.id);
  const active = await pool.query(
    `SELECT * FROM trips WHERE driver_id=$1 AND status IN ('assigned','departed','arrival_pending')
     ORDER BY started_at DESC LIMIT 1`, [driver.id]
  );
  const history = await pool.query(
    `SELECT * FROM trips WHERE driver_id=$1 ORDER BY started_at DESC LIMIT 50`, [driver.id]
  );
  res.json({ active:active.rows[0] || null, trips:history.rows });
});

// Leader assigns trip to a specific driver.
app.post('/api/trips/start', auth, roles('leader','super_admin'), async (req,res) => {
  const { driverId, destination, tripType='normal' } = req.body;
  if (!driverId) return res.status(400).json({error:'driverId inahitajika.'});

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const d = await c.query(`SELECT * FROM drivers WHERE id=$1 AND station_id=$2 FOR UPDATE`, [driverId,STATION_ID]);
    if (!d.rowCount) throw Object.assign(new Error('Dereva hajapatikana.'),{status:404});
    if (d.rows[0].status !== 'active') throw Object.assign(new Error('Dereva hayuko active.'),{status:400});

    const active = await c.query(
      `SELECT 1 FROM trips WHERE driver_id=$1 AND status IN ('assigned','departed','arrival_pending')`,
      [driverId]
    );
    if (active.rowCount) throw Object.assign(new Error('Dereva tayari ana safari.'),{status:409});

    const tripCode = 'TRIP-' + new Date().toISOString().replace(/\D/g,'').slice(0,14) + '-' + crypto.randomBytes(2).toString('hex');
    const t = await c.query(
      `INSERT INTO trips(trip_code,station_id,driver_id,leader_id,destination,trip_type,status)
       VALUES($1,$2,$3,$4,$5,$6,'assigned') RETURNING *`,
      [tripCode,STATION_ID,driverId,req.user.id,destination || 'Mbagala',tripType]
    );

    // Remove driver from ready queue while assigned/on trip.
    await c.query(
      `UPDATE queue_entries SET status='assigned'
       WHERE station_id=$1 AND driver_id=$2 AND status='ready'`,
      [STATION_ID,driverId]
    );
    await c.query('COMMIT');
    await audit(req.user.id,'trip.started','trip',t.rows[0].id,{driverId});
    emitQueue();
    emitTrip('trip.started',{tripId:t.rows[0].id,driverId});
    res.status(201).json({ trip:t.rows[0] });
  } catch(e) {
    await c.query('ROLLBACK');
    res.status(e.status || 500).json({error:e.status ? e.message : 'Safari haikuanza.'});
  } finally { c.release(); }
});

app.post('/api/trips/:id/driver-departed', auth, roles('driver'), async (req,res) => {
  const driver = await getDriverByUser(req.user.id);
  const r = await pool.query(
    `UPDATE trips SET status='departed',departed_at=NOW()
     WHERE id=$1 AND driver_id=$2 AND status='assigned' RETURNING *`,
    [req.params.id,driver.id]
  );
  if (!r.rowCount) return res.status(400).json({error:'Safari haipo au tayari imeondoka.'});
  await pool.query(`UPDATE queue_entries SET status='on_trip' WHERE driver_id=$1 AND status='assigned'`,[driver.id]);
  await audit(req.user.id,'trip.departed','trip',r.rows[0].id);
  emitQueue(); emitTrip('trip.departed',{tripId:r.rows[0].id,driverId:driver.id});
  res.json({trip:r.rows[0]});
});

app.post('/api/trips/:id/driver-arrived', auth, roles('driver'), async (req,res) => {
  const driver = await getDriverByUser(req.user.id);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `UPDATE trips SET status='arrival_pending',arrived_at=NOW()
       WHERE id=$1 AND driver_id=$2 AND status='departed' RETURNING *`,
      [req.params.id,driver.id]
    );
    if (!r.rowCount) throw Object.assign(new Error('Safari lazima iwe imeondoka kwanza.'),{status:400});
    await c.query(`UPDATE queue_entries SET status='arrival_pending' WHERE driver_id=$1 AND status='on_trip'`,[driver.id]);
    await c.query('COMMIT');
    await audit(req.user.id,'trip.arrival_requested','trip',r.rows[0].id);
    emitQueue(); emitTrip('trip.arrival_requested',{tripId:r.rows[0].id,driverId:driver.id});
    res.json({trip:r.rows[0]});
  } catch(e) {
    await c.query('ROLLBACK');
    res.status(e.status||500).json({error:e.status?e.message:'Imeshindikana kuripoti kufika.'});
  } finally { c.release(); }
});

// Leader confirms arrival; driver is appended to END of queue.
app.post('/api/trips/:id/leader-confirm', auth, roles('leader','super_admin'), async (req,res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const t = await c.query(
      `SELECT * FROM trips WHERE id=$1 AND station_id=$2 AND status='arrival_pending' FOR UPDATE`,
      [req.params.id,STATION_ID]
    );
    if (!t.rowCount) throw Object.assign(new Error('Hakuna safari inayosubiri uthibitisho.'),{status:404});
    const trip=t.rows[0];

    await c.query(`UPDATE trips SET status='completed',completed_at=NOW() WHERE id=$1`,[trip.id]);
    await c.query(`UPDATE queue_entries SET status='left',left_at=NOW()
                   WHERE station_id=$1 AND driver_id=$2
                   AND status='arrival_pending'`,[STATION_ID,trip.driver_id]);
    // New queue entry is inserted NOW(), guaranteeing END of FIFO queue.
    await c.query(`INSERT INTO queue_entries(station_id,driver_id,status) VALUES($1,$2,'ready')`,
      [STATION_ID,trip.driver_id]);
    await c.query('COMMIT');

    await audit(req.user.id,'trip.completed','trip',trip.id,{driverId:trip.driver_id,returnedToQueue:true});
    emitQueue(); emitTrip('trip.completed',{tripId:trip.id,driverId:trip.driver_id});
    res.json({ok:true,message:'Dereva amethibitishwa na amerudishwa mwisho wa foleni.'});
  } catch(e) {
    await c.query('ROLLBACK');
    res.status(e.status||500).json({error:e.status?e.message:'Imeshindikana kuthibitisha kufika.'});
  } finally { c.release(); }
});

// Leader dashboard
app.get('/api/leader/dashboard', auth, roles('leader','super_admin'), async (req,res) => {
  const queue = await getQueue(STATION_ID);
  const pendingAck = await pool.query(
    `SELECT t.*,d.driver_code,u.full_name FROM trips t
     JOIN drivers d ON d.id=t.driver_id JOIN users u ON u.id=d.user_id
     WHERE t.station_id=$1 AND t.status='arrival_pending' ORDER BY t.arrived_at`,
    [STATION_ID]
  );
  const pendingApproval = await pool.query(
    `SELECT d.*,u.full_name,u.phone FROM drivers d JOIN users u ON u.id=d.user_id
     WHERE d.station_id=$1 AND d.status='pending' ORDER BY d.joined_at`, [STATION_ID]
  );
  const counts = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE status='active')::int total,
      COUNT(*) FILTER (WHERE status='active' AND id IN (
        SELECT driver_id FROM queue_entries WHERE station_id=$1 AND status='ready'
      ))::int ready,
      COUNT(*) FILTER (WHERE id IN (
        SELECT driver_id FROM trips WHERE station_id=$1 AND status IN ('assigned','departed')
      ))::int on_trip,
      COUNT(*) FILTER (WHERE status='suspended')::int suspended,
      COUNT(*) FILTER (WHERE status='banned')::int banned
     FROM drivers WHERE station_id=$1`, [STATION_ID]
  );
  res.json({
    counts:counts.rows[0],
    queue,
    pendingAck:pendingAck.rows,
    arrivalPendingTrips:pendingAck.rows,
    pendingApproval:pendingApproval.rows
  });
});

app.post('/api/leader/approve-driver/:driverId', auth, roles('leader','super_admin'), async (req,res) => {
  const r = await pool.query(
    `UPDATE drivers SET status='active',updated_at=NOW()
     WHERE id=$1 AND station_id=$2 AND status='pending' RETURNING *`,
    [req.params.driverId,STATION_ID]
  );
  if (!r.rowCount) return res.status(404).json({error:'Dereva wa pending hakupatikana.'});
  await audit(req.user.id,'driver.approved','driver',r.rows[0].id);
  res.json({ok:true,driver:r.rows[0]});
});

app.post('/api/leader/suspend', auth, roles('leader','super_admin'), async (req,res) => {
  const {driverId, reason} = req.body;
  const r = await pool.query(
    `UPDATE drivers SET status='suspended',updated_at=NOW()
     WHERE id=$1 AND station_id=$2 RETURNING *`, [driverId,STATION_ID]
  );
  if (!r.rowCount) return res.status(404).json({error:'Dereva hakupatikana.'});
  await audit(req.user.id,'driver.suspended','driver',driverId,{reason:reason||null});
  emitQueue();
  res.json({ok:true});
});

app.post('/api/leader/violations', auth, roles('leader','super_admin'), async (req,res) => {
  const {driverId,reason} = req.body;
  if (!driverId || !reason) return res.status(400).json({error:'driverId na reason vinahitajika.'});
  const r=await pool.query(
    `INSERT INTO violations(station_id,driver_id,recorded_by,reason)
     VALUES($1,$2,$3,$4) RETURNING *`,[STATION_ID,driverId,req.user.id,reason]
  );
  await audit(req.user.id,'violation.recorded','violation',r.rows[0].id,{driverId});
  res.status(201).json({violation:r.rows[0]});
});

// Admin
app.get('/api/admin/dashboard', auth, roles('super_admin'), async (req,res) => {
  const [stations,drivers,active,today,suspended] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int n FROM stations WHERE is_active=true`),
    pool.query(`SELECT COUNT(*)::int n FROM drivers`),
    pool.query(`SELECT COUNT(*)::int n FROM drivers WHERE status='active'`),
    pool.query(`SELECT COUNT(*)::int n FROM trips WHERE station_id=$1 AND started_at::date=CURRENT_DATE`,[STATION_ID]),
    pool.query(`SELECT COUNT(*)::int n FROM drivers WHERE status='suspended'`)
  ]);
  res.json({
    stations:stations.rows[0].n,totalDrivers:drivers.rows[0].n,
    activeDrivers:active.rows[0].n,todayTrips:today.rows[0].n,
    suspensions:suspended.rows[0].n
  });
});

app.get('/api/admin/drivers', auth, roles('super_admin'), async (req,res) => {
  const r=await pool.query(
    `SELECT d.*,u.full_name,u.phone,u.email,u.role,u.id AS user_id
     FROM drivers d JOIN users u ON u.id=d.user_id
     WHERE d.station_id=$1 ORDER BY d.joined_at DESC`,[STATION_ID]
  );
  res.json({drivers:r.rows});
});

app.post('/api/admin/make-leader/:userId', auth, roles('super_admin'), async (req,res) => {
  const r=await pool.query(
    `UPDATE users SET role='leader',updated_at=NOW() WHERE id=$1 RETURNING id,full_name,phone,role`,
    [req.params.userId]
  );
  if(!r.rowCount)return res.status(404).json({error:'Mtumiaji hakupatikana.'});
  await audit(req.user.id,'user.role_changed','user',r.rows[0].id,{role:'leader'});
  res.json({user:r.rows[0]});
});

app.post('/api/admin/reset-password/:userId', auth, roles('super_admin'), async (req,res) => {
  const tempPassword = crypto.randomBytes(5).toString('hex');
  const hash=await bcrypt.hash(tempPassword,12);
  const r=await pool.query(
    `UPDATE users SET password_hash=$1,updated_at=NOW()
     WHERE id=$2 RETURNING full_name AS name,phone`,[hash,req.params.userId]
  );
  if(!r.rowCount)return res.status(404).json({error:'Mtumiaji hakupatikana.'});
  await audit(req.user.id,'user.password_reset','user',req.params.userId);
  res.json({name:r.rows[0].name,phone:r.rows[0].phone,tempPassword});
});

app.post('/api/admin/delete-driver/:driverId', auth, roles('super_admin'), async (req,res) => {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const d=await c.query(`SELECT user_id FROM drivers WHERE id=$1`,[req.params.driverId]);
    if(!d.rowCount)throw Object.assign(new Error('Dereva hakupatikana.'),{status:404});
    await c.query(`DELETE FROM users WHERE id=$1`,[d.rows[0].user_id]);
    await c.query('COMMIT');
    await audit(req.user.id,'driver.deleted','driver',req.params.driverId);
    emitQueue();
    res.json({ok:true});
  }catch(e){
    await c.query('ROLLBACK');
    res.status(e.status||500).json({error:e.status?e.message:'Deletion imeshindikana.'});
  }finally{c.release();}
});

// Basic reports / payments data for future UI expansion
app.get('/api/reports/summary', auth, roles('leader','super_admin'), async (req,res) => {
  const [trips,violations,payments,contributions]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int n FROM trips WHERE station_id=$1 AND started_at::date=CURRENT_DATE`,[STATION_ID]),
    pool.query(`SELECT COUNT(*)::int n FROM violations WHERE station_id=$1 AND created_at::date=CURRENT_DATE`,[STATION_ID]),
    pool.query(`SELECT COALESCE(SUM(amount),0) n FROM payments WHERE station_id=$1 AND status='paid' AND created_at::date=CURRENT_DATE`,[STATION_ID]),
    pool.query(`SELECT COALESCE(SUM(amount),0) n FROM contributions WHERE station_id=$1 AND status='paid' AND created_at::date=CURRENT_DATE`,[STATION_ID])
  ]);
  res.json({
    trips:trips.rows[0].n,violations:violations.rows[0].n,
    payments:Number(payments.rows[0].n),contributions:Number(contributions.rows[0].n)
  });
});

app.get('/api/payments/mine', auth, async (req,res) => {
  const r=await pool.query(
    `SELECT * FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[req.user.id]
  );
  res.json({payments:r.rows});
});

app.get('/api/contributions/mine', auth, roles('driver'), async (req,res) => {
  const d=await getDriverByUser(req.user.id);
  const r=await pool.query(
    `SELECT * FROM contributions WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 50`,[d.id]
  );
  res.json({contributions:r.rows});
});

// Socket.IO
io.use((socket,next)=>{
  try{
    const token=socket.handshake.auth?.token ||
      (socket.handshake.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tbms_token='))?.split('=')[1];
    if(!token)return next(new Error('Unauthorized'));
    socket.user=jwt.verify(token,JWT_SECRET);
    next();
  }catch{next(new Error('Unauthorized'))}
});

io.on('connection',(socket)=>{
  socket.on('join-station',(stationId=STATION_ID)=>{
    socket.join(`station:${Number(stationId)}`);
  });
});

app.get('/__debug', (req, res) => {
  try {
    const fs = require('fs');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.json({ sizeBytes: html.length, first200: html.slice(0, 200), title: (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || null });
  } catch (e) { res.json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>{
  if(req.path.startsWith('/api/') || req.path==='/health') return res.status(404).json({error:'Endpoint haipo.'});
  res.sendFile(path.join(__dirname,'public','index.html'));
});

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:'Server error.'});
});

initSchema()
  .then(() => runSeed())
  .then(() => server.listen(PORT, () => console.log(`Toangoma TBMS running on port ${PORT}`)))
  .catch(err => { console.error('Startup error:', err); process.exit(1); });
