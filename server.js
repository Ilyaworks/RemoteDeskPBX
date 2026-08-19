const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Постоянное хранилище ──────────────────────────────────────────────────
// DATABASE_URL задан (напр. Neon Postgres) → пишем в Postgres (переживает рестарты).
// Не задан → JSON-файлы в data/ (для локальной разработки; на Render эфемерно).
const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function initStore() {
  if (USE_PG) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL)');
    console.log('  Storage: Postgres (DATABASE_URL) — данные переживают рестарты');
  } else {
    console.log('  Storage: локальные JSON-файлы (data/) — на Render эфемерно');
  }
}

// key: 'sessions' | 'employees' | 'config'
async function getKV(key, def) {
  if (USE_PG) {
    const r = await pool.query('SELECT value FROM kv WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : def;
  }
  const p = path.join(DATA_DIR, key + '.json');
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

async function setKV(key, value) {
  if (USE_PG) {
    await pool.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(value)],
    );
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, key + '.json'), JSON.stringify(value, null, 2));
}

const DEFAULT_CONFIG = { adminPassword: 'admin123' };
async function getConfig() { return (await getKV('config', DEFAULT_CONFIG)) || DEFAULT_CONFIG; }
async function setConfig(cfg) { await setKV('config', cfg); }

async function requireAdmin(req, res, next) {
  try {
    const cfg = await getConfig();
    if (req.headers.authorization !== `Bearer ${cfg.adminPassword}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  } catch (e) {
    console.error('requireAdmin error:', e);
    res.status(500).json({ error: 'Storage error' });
  }
}

const rooms = new Map();
const roomCodes = new Set();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 9; i++) code += Math.floor(Math.random() * 10).toString();
  } while (roomCodes.has(code));
  roomCodes.add(code);
  return code;
}

const pendingMessages = new Map();

function getPending(role, code) {
  const key = `${role}:${code}`;
  if (!pendingMessages.has(key)) pendingMessages.set(key, []);
  return pendingMessages.get(key);
}

function addMessage(role, code, msg) {
  const arr = getPending(role, code);
  arr.push(msg);
}

app.post('/register', async (req, res) => {
  const code = generateCode();
  rooms.set(code, { host: null, viewers: [] });
  const id = crypto.randomUUID();
  // Логирование сессии — best-effort: сбой хранилища не должен ломать подключение.
  try {
    const sessions = await getKV('sessions', []);
    sessions.push({ id, code, employee: null, employeeName: null, startTime: new Date().toISOString(), endTime: null, duration: null, durationSeconds: null });
    await setKV('sessions', sessions);
  } catch (e) { console.error('session log (register) failed:', e.message); }
  addMessage('host', code, { type: 'code', code });
  res.json({ type: 'code', code });
});

app.post('/join', async (req, res) => {
  const { code, employeeLogin, employeeName } = req.body;
  if (!code || !rooms.has(code)) return res.json({ type: 'error', msg: 'Неверный код' });
  if (employeeLogin || employeeName) {
    try {
      const sessions = await getKV('sessions', []);
      const session = sessions.find(s => s.code === code && !s.endTime);
      if (session) {
        session.employee = employeeLogin || session.employee;
        session.employeeName = employeeName || session.employeeName;
        await setKV('sessions', sessions);
      }
    } catch (e) { console.error('session update (join) failed:', e.message); }
  }
  addMessage('host', code, { type: 'viewer-joined' });
  res.json({ type: 'ok' });
});

app.post('/signal', (req, res) => {
  const { code, type, sdp, candidate, role } = req.body;
  if (!code || !rooms.has(code)) return res.json({ type: 'error', msg: 'Invalid room' });
  addMessage(role === 'host' ? 'viewer' : 'host', code, { type, sdp, candidate, role });
  res.json({ type: 'ok' });
});

app.get('/poll/:role/:code', (req, res) => {
  const { role, code } = req.params;
  const msgs = getPending(role, code);
  if (msgs.length > 0) return res.json(msgs.shift());
  const key = `${role}:${code}`;
  let waited = 0;
  const interval = setInterval(() => {
    waited += 1000;
    if (pendingMessages.has(key) && pendingMessages.get(key).length > 0) {
      clearInterval(interval);
      res.json(pendingMessages.get(key).shift());
    } else if (waited >= 25000) {
      clearInterval(interval);
      res.json({ type: 'timeout' });
    }
  }, 1000);
  req.on('close', () => clearInterval(interval));
});

app.post('/disconnect', async (req, res) => {
  const { code } = req.body;
  if (code && rooms.has(code)) {
    addMessage('viewer', code, { type: 'host-disconnected' });
    addMessage('host', code, { type: 'host-disconnected' });
    rooms.delete(code);
    roomCodes.delete(code);
    try {
      const sessions = await getKV('sessions', []);
      const session = sessions.find(s => s.code === code && !s.endTime);
      if (session) {
        session.endTime = new Date().toISOString();
        const diffMs = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
        session.durationSeconds = Math.round(diffMs / 1000);
        session.duration = Math.round(diffMs / 60000);
        await setKV('sessions', sessions);
      }
    } catch (e) { console.error('session end (disconnect) failed:', e.message); }
  }
  res.json({ type: 'ok' });
});

app.post('/auth/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.json({ type: 'error', msg: 'Введите логин и пароль' });
  try {
    const employees = await getKV('employees', []);
    const emp = employees.find(e => e.login === login && e.password === password && e.active !== false);
    if (!emp) return res.json({ type: 'error', msg: 'Неверный логин или пароль' });
    res.json({ type: 'ok', employee: { login: emp.login, name: emp.name } });
  } catch (e) {
    console.error('/auth/login error:', e);
    res.status(500).json({ type: 'error', msg: 'Ошибка сервера, попробуйте ещё раз' });
  }
});

// Admin API
app.post('/admin/change-password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const cfg = await getConfig();
    if (currentPassword !== cfg.adminPassword) return res.json({ type: 'error', msg: 'Текущий пароль неверен' });
    if (!newPassword || newPassword.length < 4) return res.json({ type: 'error', msg: 'Новый пароль должен быть минимум 4 символа' });
    cfg.adminPassword = newPassword;
    await setConfig(cfg);
    res.json({ type: 'ok', msg: 'Пароль изменён' });
  } catch (e) { console.error('change-password error:', e); res.status(500).json({ type: 'error', msg: 'Ошибка сервера' }); }
});

app.get('/admin/employees', requireAdmin, async (req, res) => {
  try { res.json(await getKV('employees', [])); }
  catch (e) { console.error('get employees error:', e); res.status(500).json({ error: 'Storage error' }); }
});

app.post('/admin/employees', requireAdmin, async (req, res) => {
  try {
    const { login, password, name } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
    const employees = await getKV('employees', []);
    if (employees.find(e => e.login === login)) return res.status(400).json({ error: 'Login already exists' });
    employees.push({ login, password, name: name || login, active: true, createdAt: new Date().toISOString() });
    await setKV('employees', employees);
    res.json({ type: 'ok' });
  } catch (e) { console.error('add employee error:', e); res.status(500).json({ error: 'Storage error' }); }
});

app.delete('/admin/employees/:login', requireAdmin, async (req, res) => {
  try {
    let employees = await getKV('employees', []);
    employees = employees.filter(e => e.login !== req.params.login);
    await setKV('employees', employees);
    res.json({ type: 'ok' });
  } catch (e) { console.error('delete employee error:', e); res.status(500).json({ error: 'Storage error' }); }
});

app.get('/admin/sessions', requireAdmin, async (req, res) => {
  try {
    let sessions = await getKV('sessions', []);
    const { employee } = req.query;
    if (employee) sessions = sessions.filter(s => s.employeeName === employee || s.employee === employee);
    res.json(sessions);
  } catch (e) { console.error('get sessions error:', e); res.status(500).json({ error: 'Storage error' }); }
});

// Admin web page
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RemoteDeskPBX Admin</title>
  <style>
    :root {
      --green: #00BB20; --green-hover: #06A81F; --green-dark: #049A1B;
      --navy: #262C44; --indigo: #4E4963;
      --heading: #2F2F36; --text: #3A3A42; --muted: #8A8A94;
      --app-bg: #FAFAFA; --card: #FFFFFF; --subtle: #F5F6FA; --border: #E6E7EE;
      --green-tint: #ECF8EE; --lavender: #F0F1FF; --peach: #FFF5F1;
      --danger: #E5484D; --danger-tint: #FDECEC; --warning: #E8A800;
      --font: 'Montserrat','Segoe UI',Roboto,Arial,sans-serif;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); padding: 24px; background: var(--app-bg); color: var(--text); }
    h1 { color: var(--navy); margin-bottom: 20px; font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
    h2 { color: var(--heading); font-size: 18px; font-weight: 600; margin-bottom: 15px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(38,44,68,0.06), 0 1px 2px rgba(38,44,68,0.04); }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .btn { padding: 9px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; font-family: var(--font); transition: background .15s ease, opacity .15s ease; }
    .btn:hover { opacity: 0.92; }
    .btn-primary { background: var(--green); color: #fff; }
    .btn-primary:hover { background: var(--green-hover); opacity: 1; }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-success { background: var(--green); color: #fff; }
    .btn-success:hover { background: var(--green-hover); opacity: 1; }
    .btn-warning { background: var(--peach); color: var(--warning); border: 1px solid var(--warning); }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    input { padding: 9px 13px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: var(--font); color: var(--heading); background: #fff; outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
    input:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(0,187,32,0.12); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 11px 13px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: var(--subtle); font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.03em; }
    tr:hover td { background: var(--lavender); }
    .login-form { max-width: 340px; margin: 110px auto; }
    .login-form h2 { text-align: center; margin-bottom: 24px; color: var(--navy); }
    .login-form input { width: 100%; margin-bottom: 12px; }
    .login-form .btn { width: 100%; padding: 13px; font-size: 16px; }
    .error { color: var(--danger); background: var(--danger-tint); padding: 10px 14px; border-radius: 8px; margin-bottom: 15px; font-size: 13px; }
    .success { color: var(--green-dark); background: var(--green-tint); padding: 10px 14px; border-radius: 8px; margin-bottom: 15px; font-size: 13px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
    .tab { padding: 12px 22px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; font-weight: 600; color: var(--muted); transition: color .15s ease; }
    .tab:hover { color: var(--heading); }
    .tab.active { color: var(--green-dark); border-bottom-color: var(--green); }
    .inline-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
    .inline-form input { flex: 1; min-width: 120px; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge-active { background: var(--green-tint); color: var(--green-dark); }
    .badge-inactive { background: var(--danger-tint); color: var(--danger); }
    .duration-format { font-family: 'Cascadia Code',Consolas,monospace; font-size: 12px; color: var(--indigo); }
    .employee-link { color: var(--green-dark); cursor: pointer; text-decoration: none; font-weight: 600; }
    .employee-link:hover { text-decoration: underline; }
    .empty-state { text-align: center; padding: 40px; color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    let token = '', employees = [], sessions = [], currentTab = 'employees', filterEmployee = '';

    function fmt(s) { if (!s && s!==0) return '...'; const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), s2=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s2).padStart(2,'0'); }
    function dt(iso) { return iso ? new Date(iso).toLocaleString('ru-RU') : '-'; }

    function showPage() { document.getElementById('app').innerHTML = '<div class="login-form card"><h2>🔐 RemoteDeskPBX Админ-панель</h2><div id="login-error" class="error" style="display:none"></div><input type="password" id="admin-pass" placeholder="Пароль администратора" onkeydown="if(event.key===\\'Enter\\') login()"><button class="btn btn-primary" onclick="login()">Войти</button></div>'; }

    async function login() {
      const pass = document.getElementById('admin-pass').value;
      if (!pass) { document.getElementById('login-error').innerHTML='Введите пароль'; document.getElementById('login-error').style.display='block'; return; }
      token = 'Bearer ' + pass;
      try {
        const empRes = await fetch('/admin/employees', { headers: { Authorization: token } });
        if (empRes.status === 401) { document.getElementById('login-error').textContent='Неверный пароль'; document.getElementById('login-error').style.display='block'; return; }
        employees = await empRes.json();
        sessions = await (await fetch('/admin/sessions', { headers: { Authorization: token } })).json();
        sessionStorage.setItem('rdpbx_admin_token', token);
        showDashboard();
      } catch(e) { document.getElementById('login-error').innerHTML='Ошибка: '+e.message; document.getElementById('login-error').style.display='block'; }
    }

    async function initAuth() {
      const saved = sessionStorage.getItem('rdpbx_admin_token');
      if (!saved) { showPage(); return; }
      token = saved;
      try {
        const r = await fetch('/admin/employees', { headers: { Authorization: token } });
        if (!r.ok) { sessionStorage.removeItem('rdpbx_admin_token'); token=''; showPage(); return; }
        employees = await r.json();
        sessions = await (await fetch('/admin/sessions', { headers: { Authorization: token } })).json();
        showDashboard();
      } catch(e) { sessionStorage.removeItem('rdpbx_admin_token'); token=''; showPage(); }
    }

    function logout() {
      sessionStorage.removeItem('rdpbx_admin_token');
      token=''; employees=[]; sessions=[]; filterEmployee='';
      showPage();
    }

    function showDashboard() {
      document.getElementById('app').innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px"><h1 style="margin:0">🛠️ RemoteDeskPBX Админ-панель</h1><button class="btn btn-danger btn-sm" onclick="logout()">Выйти</button></div><div class="tabs"><div class="tab '+(currentTab==='employees'?'active':'')+'" onclick="switchTab(\\'employees\\')">👥 Сотрудники</div><div class="tab '+(currentTab==='sessions'?'active':'')+'" onclick="switchTab(\\'sessions\\')">📊 Сессии</div><div class="tab '+(currentTab==='settings'?'active':'')+'" onclick="switchTab(\\'settings\\')">⚙️ Настройки</div></div><div id="tab-content"></div>';
      renderTab();
    }

    function switchTab(t) { currentTab=t; showDashboard(); }

    function renderTab() {
      const c = document.getElementById('tab-content');
      if (currentTab==='employees') renderEmployees(c);
      else if (currentTab==='sessions') renderSessions(c);
      else renderSettings(c);
    }

    function renderEmployees(c) {
      c.innerHTML = '<div class="card"><div class="card-header"><h2>👥 Сотрудники ('+employees.length+')</h2></div><div class="inline-form"><input id="new-login" placeholder="Логин"><input id="new-pass" type="password" placeholder="Пароль"><input id="new-name" placeholder="Имя"><button class="btn btn-success" onclick="addEmployee()">➕ Добавить</button></div><table><thead><tr><th>Логин</th><th>Имя</th><th>Статус</th><th>Создан</th><th>Сессии</th><th></th></tr></thead><tbody>'+employees.map(e=>{const es=sessions.filter(s=>s.employee===e.login||s.employeeName===e.login); return '<tr><td>'+e.login+'</td><td>'+(e.name||e.login)+'</td><td><span class="badge '+(e.active!==false?'badge-active':'badge-inactive')+'">'+(e.active!==false?'Активен':'Неактивен')+'</span></td><td>'+(e.createdAt?dt(e.createdAt):'-')+'</td><td><a class="employee-link" onclick="filterByEmployee(\\''+e.login+'\\')">'+es.length+' сессий &rarr;</a></td><td><button class="btn btn-danger btn-sm" onclick="deleteEmployee(\\''+e.login+'\\')">Удалить</button></td></tr>';}).join('')+(employees.length===0?'<tr><td colspan="6" class="empty-state">Нет сотрудников</td></tr>':'')+'</tbody></table></div>';
    }

    function renderSessions(c) {
      c.innerHTML = '<div class="card"><div class="card-header"><h2>📊 Сессии'+(filterEmployee?' сотрудника "'+filterEmployee+'"':'')+' ('+sessions.length+')</h2><div>'+(filterEmployee?'<button class="btn btn-warning btn-sm" onclick="clearFilter()">✕ Сбросить</button>':'')+'</div></div><table><thead><tr><th>Код</th><th>Сотрудник</th><th>Добавочный</th><th>Начало</th><th>Конец</th><th>Длительность</th></tr></thead><tbody>'+sessions.slice().reverse().map(s=>{const d=s.durationSeconds!==null?fmt(s.durationSeconds):(s.endTime?'-':'🟢 Активна'); return '<tr><td style="font-family:monospace">'+(s.code||'-')+'</td><td>'+(s.employeeName||s.employee||'-')+'</td><td style="font-family:monospace">'+(s.employee||'-')+'</td><td>'+dt(s.startTime)+'</td><td>'+dt(s.endTime)+'</td><td><span class="duration-format">'+d+'</span></td></tr>';}).join('')+(sessions.length===0?'<tr><td colspan="6" class="empty-state">Нет сессий</td></tr>':'')+'</tbody></table></div>';
    }

    function renderSettings(c) {
      c.innerHTML = '<div class="card"><div class="card-header"><h2>⚙️ Настройки</h2></div><div id="settings-msg"></div><div style="max-width:400px"><label style="font-weight:500;display:block;margin-bottom:8px;color:#555">Смена пароля администратора</label><div style="display:flex;flex-direction:column;gap:10px"><input id="cur-pass" type="password" placeholder="Текущий пароль"><input id="new-pass-admin" type="password" placeholder="Новый пароль (мин. 4 символа)"><button class="btn btn-primary" onclick="changePassword()">Сменить пароль</button></div></div></div>';
    }

    function filterByEmployee(n) { filterEmployee=n; currentTab='sessions'; loadData(); }
    function clearFilter() { filterEmployee=''; loadData(); }

    async function loadData() {
      const r = await fetch('/admin/sessions'+(filterEmployee?'?employee='+encodeURIComponent(filterEmployee):''), { headers: { Authorization: token } });
      sessions = await r.json();
      showDashboard();
    }

    async function addEmployee() {
      const login = document.getElementById('new-login').value.trim(), password = document.getElementById('new-pass').value.trim(), name = document.getElementById('new-name').value.trim()||login;
      if (!login||!password) { alert('Заполните логин и пароль'); return; }
      const r = await fetch('/admin/employees', { method:'POST', headers: { 'Content-Type':'application/json', Authorization: token }, body: JSON.stringify({login,password,name}) });
      if (!r.ok) { const d=await r.json(); alert(d.error||'Ошибка'); return; }
      document.getElementById('new-login').value=''; document.getElementById('new-pass').value=''; document.getElementById('new-name').value='';
      employees = await (await fetch('/admin/employees', {headers:{Authorization:token}})).json();
      renderTab();
    }

    async function deleteEmployee(login) {
      if (!confirm('Удалить сотрудника '+login+'?')) return;
      await fetch('/admin/employees/'+login, { method:'DELETE', headers:{Authorization:token} });
      employees = await (await fetch('/admin/employees', {headers:{Authorization:token}})).json();
      renderTab();
    }

    async function changePassword() {
      const a=document.getElementById('cur-pass').value, b=document.getElementById('new-pass-admin').value;
      if (!a||!b) { alert('Заполните оба поля'); return; }
      const r=await (await fetch('/admin/change-password', { method:'POST', headers:{'Content-Type':'application/json',Authorization:token}, body:JSON.stringify({currentPassword:a,newPassword:b}) })).json();
      document.getElementById('settings-msg').innerHTML=r.type==='ok'?'<div class="success">✅ Пароль изменён</div>':'<div class="error">❌ '+(r.msg||'Ошибка')+'</div>';
      if (r.type==='ok') { token='Bearer '+b; sessionStorage.setItem('rdpbx_admin_token', token); document.getElementById('cur-pass').value=''; document.getElementById('new-pass-admin').value=''; }
    }

    initAuth();
  </script>
</body>
</html>`);
});

app.get('/', (req, res) => {
  res.json({ ok: true, time: Date.now(), uptime: process.uptime(), server: 'express-v2', storage: USE_PG ? 'pg' : 'files' });
});

// Инициализация хранилища, затем старт сервера (сервер поднимается в любом случае).
initStore()
  .then(() => {
    if (!USE_PG) {
      ['sessions', 'employees'].forEach(k => {
        const p = path.join(DATA_DIR, k + '.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
      });
    }
  })
  .catch(e => console.error('initStore error (сервер всё равно стартует):', e.message))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('  RemoteDeskPBX SERVER v2 (Express) on port ' + PORT + ' /admin');
    });
  });