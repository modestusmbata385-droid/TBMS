require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { pool, initDb } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const IS_PROD = process.env.NODE_ENV === 'production';
const SUPERADMIN_PHONE = process.env.SUPERADMIN_PHONE || null; // namba ya simu itakayokuwa Super Admin moja kwa moja
const ADMIN_KEY = process.env.ADMIN_KEY || 'tbms2026';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
function setAuthCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Haujaingia.' });
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT id, role, full_name, phone, email FROM users WHERE id=$1', [payload.uid]);
    if (!rows[0]) return res.status(401).json({ error: 'Haujaingia.' });
    req.user = rows[0];
    next();
  } catch { res.status(401).json({ error: 'Haujaingia.' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Huna ruhusa.' });
    next();
  };
}
async function logAudit(userId, action, details) {
  try { await pool.query('INSERT INTO audit_logs (user_id, action, details) VALUES ($1,$2,$3)', [userId, action, details || null]); }
  catch (e) { console.error('audit error:', e.message); }
}
async function getDriverByUser(userId) {
  const r = await pool.query('SELECT * FROM drivers WHERE user_id=$1', [userId]);
  return r.rows[0];
}
async function getDefaultStationId() {
  const r = await pool.query('SELECT id FROM stations ORDER BY id LIMIT 1');
  return r.rows[0]?.id;
}

// ===================== AUTH =====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, phone, email, password, nationalId, licenseNumber, motorcycleReg, emergencyContact } = req.body;
    if (!fullName || !phone || !password) return res.status(400).json({ error: 'Jaza jina, simu na password.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password iwe angalau herufi 6.' });

    const existing = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (existing.rows.length) return res.status(400).json({ error: 'Namba ya simu tayari imesajiliwa.' });

    const hash = await bcrypt.hash(password, 10);
    const isSuperAdmin = SUPERADMIN_PHONE && phone === SUPERADMIN_PHONE;
    const role = isSuperAdmin ? 'super_admin' : 'driver';

    const userRes = await pool.query(
      'INSERT INTO users (role, full_name, phone, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [role, fullName, phone, email || null, hash]
    );
    const userId = userRes.rows[0].id;

    if (role === 'driver') {
      const stationId = await getDefaultStationId();
      await pool.query(
        'INSERT INTO drivers (user_id, station_id, national_id, license_number, motorcycle_reg, emergency_contact) VALUES ($1,$2,$3,$4,$5,$6)',
        [userId, stationId, nationalId || null, licenseNumber || null, motorcycleReg || null, emergencyContact || null]
      );
    }
    setAuthCookie(res, userId);
    await logAudit(userId, 'register', `${fullName} (${role})`);
    res.json({ ok: true, role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(400).json({ error: 'Namba au password si sahihi.' });
    }
    setAuthCookie(res, user.id);
    await logAudit(user.id, 'login', `${user.full_name}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server.' }); }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await logAudit(req.user.id, 'logout', req.user.full_name);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  let driver = null;
  if (req.user.role === 'driver') driver = await getDriverByUser(req.user.id);
  res.json({ user: req.user, driver });
});

// ===================== DRIVER: QUEUE =====================
async function getStationQueue(stationId) {
  const r = await pool.query(`
    SELECT q.id AS queue_entry_id, q.joined_at, d.id AS driver_id, d.driver_code, u.full_name, d.status,
      (ROW_NUMBER() OVER (ORDER BY q.joined_at ASC))::int AS position
    FROM queue_entries q
    JOIN drivers d ON d.id = q.driver_id
    JOIN users u ON u.id = d.user_id
    WHERE q.station_id=$1 AND q.status='waiting'
    ORDER BY q.joined_at ASC
  `, [stationId]);
  return r.rows;
}
function emitQueueUpdate(stationId) {
  getStationQueue(stationId).then(queue => io.to(`station-${stationId}`).emit('queue.updated', { stationId, queue }));
}

app.get('/api/queue', requireAuth, async (req, res) => {
  const stationId = await getDefaultStationId();
  const queue = await getStationQueue(stationId);
  res.json({ stationId, queue });
});

app.post('/api/queue/join', requireAuth, requireRole('driver'), async (req, res) => {
  const driver = await getDriverByUser(req.user.id);
  if (!driver) return res.status(404).json({ error: 'Driver haipo.' });
  if (driver.status === 'pending') return res.status(403).json({ error: 'Akaunti yako bado inasubiri uthibitisho.' });
  if (driver.status === 'suspended') return res.status(403).json({ error: 'Umesimamishwa kwa sasa.' });
  if (driver.status === 'banned') return res.status(403).json({ error: 'Umezuiwa kutumia mfumo.' });
  if (driver.status === 'on_trip' || driver.status === 'arrival_pending') return res.status(400).json({ error: 'Bado uko kwenye safari.' });

  const existing = await pool.query("SELECT id FROM queue_entries WHERE driver_id=$1 AND status='waiting'", [driver.id]);
  if (existing.rows[0]) return res.status(400).json({ error: 'Tayari upo kwenye foleni.' });

  await pool.query('INSERT INTO queue_entries (station_id, driver_id) VALUES ($1,$2)', [driver.station_id, driver.id]);
  await pool.query("UPDATE drivers SET status='active' WHERE id=$1", [driver.id]);
  await logAudit(req.user.id, 'queue_join', `Driver ${driver.driver_code || driver.id} amejiunga na foleni`);
  emitQueueUpdate(driver.station_id);
  res.json({ ok: true });
});

app.post('/api/queue/leave', requireAuth, requireRole('driver'), async (req, res) => {
  const driver = await getDriverByUser(req.user.id);
  await pool.query("UPDATE queue_entries SET status='removed' WHERE driver_id=$1 AND status='waiting'", [driver.id]);
  await logAudit(req.user.id, 'queue_leave', `Driver ${driver.driver_code || driver.id} ametoka kwenye foleni`);
  emitQueueUpdate(driver.station_id);
  res.json({ ok: true });
});

// ===================== TRIPS =====================
app.post('/api/trips/start', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const { driverId, destination } = req.body;
  const stationId = await getDefaultStationId();

  const qe = await pool.query("SELECT * FROM queue_entries WHERE driver_id=$1 AND status='waiting' ORDER BY joined_at ASC LIMIT 1", [driverId]);
  if (!qe.rows[0]) return res.status(400).json({ error: 'Driver hayupo kwenye foleni.' });

  const top = await getStationQueue(stationId);
  if (!top[0] || top[0].driver_id !== Number(driverId)) {
    return res.status(400).json({ error: 'Lazima uanzie na driver aliye #1 kwenye foleni (FIFO).' });
  }

  const leaderRow = await pool.query('SELECT id FROM leaders WHERE user_id=$1', [req.user.id]);
  const leaderId = leaderRow.rows[0]?.id || null;

  const tripCode = 'TRP-' + Date.now().toString().slice(-6);
  const trip = await pool.query(
    'INSERT INTO trips (trip_code, station_id, driver_id, leader_id, queue_entry_id, destination) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [tripCode, stationId, driverId, leaderId, qe.rows[0].id, destination || null]
  );
  await pool.query("UPDATE queue_entries SET status='assigned' WHERE id=$1", [qe.rows[0].id]);
  await pool.query("UPDATE drivers SET status='on_trip' WHERE id=$1", [driverId]);
  await logAudit(req.user.id, 'trip_start', `Trip ${tripCode} kwa driver #${driverId} -> ${destination || '-'}`);
  emitQueueUpdate(stationId);
  io.to(`station-${stationId}`).emit('trip.started', trip.rows[0]);
  res.json({ ok: true, trip: trip.rows[0] });
});

app.get('/api/trips/mine', requireAuth, requireRole('driver'), async (req, res) => {
  const driver = await getDriverByUser(req.user.id);
  const active = await pool.query("SELECT * FROM trips WHERE driver_id=$1 AND status IN ('on_trip','arrival_pending') ORDER BY started_at DESC LIMIT 1", [driver.id]);
  const history = await pool.query('SELECT * FROM trips WHERE driver_id=$1 ORDER BY started_at DESC LIMIT 50', [driver.id]);
  res.json({ active: active.rows[0] || null, history: history.rows });
});

app.post('/api/trips/:id/driver-departed', requireAuth, requireRole('driver'), async (req, res) => {
  const driver = await getDriverByUser(req.user.id);
  const r = await pool.query("UPDATE trips SET departed_at=now() WHERE id=$1 AND driver_id=$2 AND status='on_trip' AND departed_at IS NULL RETURNING *", [req.params.id, driver.id]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Trip haipo au tayari umeondoka.' });
  await logAudit(req.user.id, 'trip_departed', `Driver ameondoka: ${r.rows[0].trip_code}`);
  io.to(`station-${r.rows[0].station_id}`).emit('trip.departed', r.rows[0]);
  res.json({ ok: true });
});

app.post('/api/trips/:id/driver-arrived', requireAuth, requireRole('driver'), async (req, res) => {
  const driver = await getDriverByUser(req.user.id);
  const trip = (await pool.query("SELECT * FROM trips WHERE id=$1 AND driver_id=$2 AND status='on_trip'", [req.params.id, driver.id])).rows[0];
  if (!trip) return res.status(400).json({ error: 'Trip haipo au tayari imekamilika.' });

  await pool.query("UPDATE trips SET status='completed', driver_confirmed_at=now(), completed_at=now() WHERE id=$1", [trip.id]);
  await pool.query("UPDATE drivers SET status='active' WHERE id=$1", [driver.id]);
  await pool.query('INSERT INTO queue_entries (station_id, driver_id) VALUES ($1,$2)', [trip.station_id, driver.id]);
  await logAudit(req.user.id, 'trip_complete_self', `Driver amejiripoti kufika: ${trip.trip_code}`);
  emitQueueUpdate(trip.station_id);
  io.to(`station-${trip.station_id}`).emit('trip.completed', trip);
  res.json({ ok: true });
});

app.post('/api/trips/:id/leader-confirm', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const trip = (await pool.query('SELECT * FROM trips WHERE id=$1', [req.params.id])).rows[0];
  if (!trip) return res.status(404).json({ error: 'Trip haipo.' });

  if (trip.status === 'completed') {
    // Ilishakamilika (driver alijiripoti mwenyewe) - hii ni uthibitisho wa taarifa tu, si kizuizi
    await pool.query('UPDATE trips SET leader_confirmed_at=now() WHERE id=$1', [trip.id]);
    await logAudit(req.user.id, 'trip_ack', `Leader amethibitisha taarifa ya trip: ${trip.trip_code}`);
    return res.json({ ok: true, already: true });
  }
  if (trip.status !== 'on_trip') return res.status(400).json({ error: 'Trip haiko tayari kwa uthibitisho.' });

  // Leader anamalizia trip kwa niaba ya driver (mfano driver hajaripoti/hawezi kutumia simu)
  await pool.query("UPDATE trips SET status='completed', leader_confirmed_at=now(), completed_at=now() WHERE id=$1", [trip.id]);
  await pool.query("UPDATE drivers SET status='active' WHERE id=$1", [trip.driver_id]);
  await pool.query('INSERT INTO queue_entries (station_id, driver_id) VALUES ($1,$2)', [trip.station_id, trip.driver_id]);
  await logAudit(req.user.id, 'trip_complete_leader', `Leader amemaliza trip kwa niaba ya driver: ${trip.trip_code}`);
  emitQueueUpdate(trip.station_id);
  io.to(`station-${trip.station_id}`).emit('trip.completed', trip);
  res.json({ ok: true });
});

// ===================== LEADER DASHBOARD =====================
app.get('/api/leader/dashboard', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const stationId = await getDefaultStationId();
  const counts = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='active') AS ready,
      COUNT(*) FILTER (WHERE status='on_trip') AS on_trip,
      COUNT(*) FILTER (WHERE status='arrival_pending') AS arrival_pending,
      COUNT(*) FILTER (WHERE status='suspended') AS suspended,
      COUNT(*) FILTER (WHERE status='banned') AS banned,
      COUNT(*) AS total
    FROM drivers WHERE station_id=$1
  `, [stationId]);
  const queue = await getStationQueue(stationId);
  const pendingApproval = await pool.query(`
    SELECT d.id, d.national_id, d.license_number, d.motorcycle_reg, u.full_name, u.phone, d.created_at
    FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.status='pending' AND d.station_id=$1 ORDER BY d.created_at ASC
  `, [stationId]);
  const arrivalPendingTrips = await pool.query(`
    SELECT t.*, u.full_name, d.driver_code FROM trips t
    JOIN drivers d ON d.id=t.driver_id JOIN users u ON u.id=d.user_id
    WHERE t.status='on_trip' AND t.station_id=$1 ORDER BY t.started_at ASC
  `, [stationId]);
  const pendingAck = await pool.query(`
    SELECT t.*, u.full_name, d.driver_code FROM trips t
    JOIN drivers d ON d.id=t.driver_id JOIN users u ON u.id=d.user_id
    WHERE t.status='completed' AND t.leader_confirmed_at IS NULL AND t.station_id=$1
    ORDER BY t.completed_at DESC LIMIT 20
  `, [stationId]);
  res.json({ counts: counts.rows[0], queue, pendingApproval: pendingApproval.rows, arrivalPendingTrips: arrivalPendingTrips.rows, pendingAck: pendingAck.rows });
});

app.post('/api/leader/approve-driver/:driverId', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const stationId = await getDefaultStationId();
  const codeRes = await pool.query("SELECT COUNT(*)+1 AS n FROM drivers WHERE driver_code IS NOT NULL");
  const code = 'TB-' + String(codeRes.rows[0].n).padStart(5, '0');
  const r = await pool.query("UPDATE drivers SET status='active', driver_code=$1 WHERE id=$2 AND status='pending' RETURNING *", [code, req.params.driverId]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Driver haipo au tayari amethibitishwa.' });
  await logAudit(req.user.id, 'approve_driver', `Driver #${req.params.driverId} -> ${code}`);
  res.json({ ok: true, driverCode: code });
});

app.post('/api/leader/violations', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const { driverId, type, description } = req.body;
  const leaderRow = await pool.query('SELECT id FROM leaders WHERE user_id=$1', [req.user.id]);
  await pool.query('INSERT INTO violations (driver_id, leader_id, type, description) VALUES ($1,$2,$3,$4)', [driverId, leaderRow.rows[0]?.id || null, type, description || null]);
  await logAudit(req.user.id, 'violation', `Driver #${driverId}: ${type}`);
  res.json({ ok: true });
});

app.post('/api/leader/suspend', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const { driverId, reason, days, isBan } = req.body;
  const endAt = isBan ? null : new Date(Date.now() + Number(days || 1) * 86400000);
  await pool.query('INSERT INTO suspensions (driver_id, issued_by, reason, end_at, is_ban) VALUES ($1,$2,$3,$4,$5)', [driverId, req.user.id, reason || null, endAt, !!isBan]);
  await pool.query("UPDATE drivers SET status=$1, suspended_until=$2 WHERE id=$3", [isBan ? 'banned' : 'suspended', endAt, driverId]);
  await pool.query("UPDATE queue_entries SET status='removed' WHERE driver_id=$1 AND status='waiting'", [driverId]);
  await logAudit(req.user.id, isBan ? 'ban' : 'suspend', `Driver #${driverId}: ${reason || ''}`);
  const stationId = await getDefaultStationId();
  emitQueueUpdate(stationId);
  io.to(`station-${stationId}`).emit(isBan ? 'driver.banned' : 'driver.suspended', { driverId });
  res.json({ ok: true });
});

app.post('/api/leader/reactivate/:driverId', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  await pool.query("UPDATE drivers SET status='active', suspended_until=NULL WHERE id=$1", [req.params.driverId]);
  await logAudit(req.user.id, 'reactivate', `Driver #${req.params.driverId}`);
  res.json({ ok: true });
});

// ===================== SUPER ADMIN DASHBOARD =====================
app.get('/api/admin/dashboard', requireAuth, requireRole('super_admin'), async (req, res) => {
  const stations = await pool.query('SELECT COUNT(*) AS c FROM stations');
  const drivers = await pool.query('SELECT COUNT(*) AS c FROM drivers');
  const activeDrivers = await pool.query("SELECT COUNT(*) AS c FROM drivers WHERE status IN ('active','on_trip','arrival_pending')");
  const todayTrips = await pool.query("SELECT COUNT(*) AS c FROM trips WHERE started_at::date = now()::date");
  const suspensions = await pool.query("SELECT COUNT(*) AS c FROM drivers WHERE status IN ('suspended','banned')");
  res.json({
    stations: Number(stations.rows[0].c),
    totalDrivers: Number(drivers.rows[0].c),
    activeDrivers: Number(activeDrivers.rows[0].c),
    todayTrips: Number(todayTrips.rows[0].c),
    suspensions: Number(suspensions.rows[0].c)
  });
});

app.post('/api/admin/make-leader/:userId', requireAuth, requireRole('super_admin'), async (req, res) => {
  const stationId = await getDefaultStationId();
  await pool.query("UPDATE users SET role='leader' WHERE id=$1", [req.params.userId]);
  await pool.query('INSERT INTO leaders (user_id, station_id) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING', [req.params.userId, stationId]);
  await logAudit(req.user.id, 'make_leader', `User #${req.params.userId}`);
  res.json({ ok: true });
});

app.get('/api/admin/drivers', requireAuth, requireRole('super_admin', 'leader'), async (req, res) => {
  const r = await pool.query(`
    SELECT d.*, u.full_name, u.phone FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC
  `);
  res.json({ drivers: r.rows });
});

app.post('/api/admin/reset-password/:userId', requireAuth, requireRole('leader', 'super_admin'), async (req, res) => {
  const tempPassword = Math.random().toString(36).slice(-8);
  const hash = await bcrypt.hash(tempPassword, 10);
  const r = await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING full_name, phone', [hash, req.params.userId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Mtumiaji haipo.' });
  await logAudit(req.user.id, 'reset_password', `Amebadilisha password ya ${r.rows[0].full_name} (${r.rows[0].phone})`);
  res.json({ ok: true, tempPassword, name: r.rows[0].full_name, phone: r.rows[0].phone });
});

app.post('/api/admin/delete-driver/:driverId', requireAuth, requireRole('super_admin'), async (req, res) => {
  const d = await pool.query('SELECT user_id, driver_code FROM drivers WHERE id=$1', [req.params.driverId]);
  if (!d.rows[0]) return res.status(404).json({ error: 'Driver haipo.' });
  await pool.query('DELETE FROM users WHERE id=$1', [d.rows[0].user_id]);
  await logAudit(req.user.id, 'delete_driver', `Amefuta driver ${d.rows[0].driver_code || req.params.driverId}`);
  res.json({ ok: true });
});

// ---------- ADMIN VIEW (taarifa za usajili na shughuli) ----------
app.get('/admin', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('Huna ruhusa. Ongeza ?key=... kwenye link.');
  const users = await pool.query(`
    SELECT u.id, u.role, u.full_name, u.phone, u.email, u.created_at,
      d.status AS driver_status, d.driver_code
    FROM users u LEFT JOIN drivers d ON d.user_id=u.id
    ORDER BY u.created_at DESC
  `);
  const logs = await pool.query(`
    SELECT l.created_at, l.action, l.details, u.full_name, u.phone
    FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id
    ORDER BY l.created_at DESC LIMIT 300
  `);
  const fmt = d => d ? new Date(d).toLocaleString('sw-TZ') : '—';
  const userRows = users.rows.map(u => `<tr>
    <td>${u.id}</td><td>${u.full_name}</td><td>${u.phone}</td><td>${u.email || '-'}</td>
    <td><span class="badge">${u.role}</span></td><td>${u.driver_status || '-'}</td><td>${u.driver_code || '-'}</td><td>${fmt(u.created_at)}</td>
  </tr>`).join('');
  const logRows = logs.rows.map(l => `<tr><td>${fmt(l.created_at)}</td><td>${l.full_name || 'Mfumo'}${l.phone ? '<br><span class="small">' + l.phone + '</span>' : ''}</td><td>${l.action}</td><td>${l.details || ''}</td></tr>`).join('');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TBMS - Taarifa za Usajili na Shughuli</title>
  <style>
    body{background:#0e1b1a;color:#eaf2ef;font:14px Arial,sans-serif;padding:14px;margin:0}
    h2{margin:24px 0 12px}h2:first-child{margin-top:0}
    table{width:100%;border-collapse:collapse;background:#152624;border-radius:8px;overflow:hidden;margin-bottom:10px}
    th,td{padding:9px 7px;border-bottom:1px solid #2a423c;text-align:left;font-size:12.5px}
    th{background:#1d332f;color:#d9a441}
    .badge{padding:3px 9px;border-radius:20px;background:#1d332f;font-size:12px}
    .small{color:#8fa89f;font-size:11px}
    .wrap{overflow-x:auto}
    .count{color:#8fa89f;margin-bottom:10px}
  </style></head><body>
  <h2>👥 Watumiaji Wote (Drivers/Leaders/Admin)</h2>
  <p class="count">Jumla: ${users.rows.length}</p>
  <div class="wrap"><table><tr><th>ID</th><th>Jina</th><th>Simu</th><th>Email</th><th>Role</th><th>Driver Status</th><th>Driver Code</th><th>Alijisajili</th></tr>${userRows}</table></div>
  <h2>📶 Shughuli Zote (300 za mwisho)</h2>
  <div class="wrap"><table><tr><th>Muda</th><th>Mtumiaji</th><th>Kitendo</th><th>Maelezo</th></tr>${logRows}</table></div>
  </body></html>`);
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.on('join-station', (stationId) => socket.join(`station-${stationId}`));
});

// ---------- Fallback ----------
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Start ----------
initDb()
  .then(() => server.listen(PORT, () => console.log(`TBMS inaendesha kwenye port ${PORT}`)))
  .catch(err => { console.error('DB init error:', err); process.exit(1); });
