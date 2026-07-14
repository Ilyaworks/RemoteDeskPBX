const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const DATA_DIR = path.join(__dirname, 'data');

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ============ DATA STORE ============
function readJSON(file) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ============ ROOMS (in-memory) ============
const rooms = new Map(); // code -> { host, viewers: [], signals: [] }
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

// ============ POLLING ============
const pendingMessages = new Map(); // `${role}:${code}` -> messages[]

function getPending(role, code) {
  const key = `${role}:${code}`;
  if (!pendingMessages.has(key)) pendingMessages.set(key, []);
  return pendingMessages.get(key);
}

function addMessage(role, code, msg) {
  const arr = getPending(role, code);
  arr.push(msg);
}

// ============ REGISTER (Client shares screen) ============
app.post('/register', (req, res) => {
  const code = generateCode();
  rooms.set(code, { host: null, viewers: [], signals: [] });
  console.log(`✅ Client registered: ${code}`);
  
  // Start session tracking
  const sessions = readJSON('sessions.json');
  sessions.push({
    id: crypto.randomUUID(),
    code,
    employee: null,
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
  });
  writeJSON('sessions.json', sessions);

  addMessage('host', code, { type: 'code', code });
  res.json({ type: 'code', code });
});

// ============ JOIN (Employee connects) ============
app.post('/join', (req, res) => {
  const { code } = req.body;
  if (!code || !rooms.has(code)) {
    return res.json({ type: 'error', msg: 'Неверный код' });
  }
  
  const room = rooms.get(code);
  // Notify host that viewer joined
  addMessage('host', code, { type: 'viewer-joined' });

  res.json({ type: 'ok' });
});

// ============ SIGNALING ============
app.post('/signal', (req, res) => {
  const { code, type, sdp, candidate, role } = req.body;
  if (!code || !rooms.has(code)) {
    return res.json({ type: 'error', msg: 'Invalid room' });
  }

  const targetRole = role === 'host' ? 'viewer' : 'host';
  addMessage(targetRole, code, { type, sdp, candidate, role });
  res.json({ type: 'ok' });
});

// ============ POLL ============
app.get('/poll/:role/:code', (req, res) => {
  const { role, code } = req.params;
  const msgs = getPending(role, code);
  
  if (msgs.length > 0) {
    const msg = msgs.shift();
    return res.json(msg);
  }
  
  // Long poll: wait up to 15s
  const key = `${role}:${code}`;
  
  // Check every second
  let waited = 0;
  const interval = setInterval(() => {
    waited += 1000;
    if (pendingMessages.has(key) && pendingMessages.get(key).length > 0) {
      clearInterval(interval);
      const msg = pendingMessages.get(key).shift();
      res.json(msg);
    } else if (waited >= 15000) {
      clearInterval(interval);
      res.json({ type: 'timeout' });
    }
  }, 1000);
  
  req.on('close', () => clearInterval(interval));
});

// ============ DISCONNECT ============
app.post('/disconnect', (req, res) => {
  const { code } = req.body;
  if (code && rooms.has(code)) {
    addMessage('viewer', code, { type: 'host-disconnected' });
    addMessage('host', code, { type: 'host-disconnected' });
    rooms.delete(code);
    roomCodes.delete(code);
    console.log(`❌ Room ${code} closed`);

    // End session
    const sessions = readJSON('sessions.json');
    const session = sessions.find(s => s.code === code && !s.endTime);
    if (session) {
      session.endTime = new Date().toISOString();
      session.duration = Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 60000);
      writeJSON('sessions.json', sessions);
    }
  }
  res.json({ type: 'ok' });
});

// ============ AUTH ============
app.post('/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.json({ type: 'error', msg: 'Введите логин и пароль' });
  }
  
  const employees = readJSON('employees.json');
  const emp = employees.find(e => e.login === login && e.password === password && e.active !== false);
  if (!emp) {
    return res.json({ type: 'error', msg: 'Неверный логин или пароль' });
  }
  
  res.json({ type: 'ok', employee: { login: emp.login, name: emp.name } });
});

// ============ ADMIN ============
const ADMIN_PASSWORD = 'admin123'; // Change this!

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Admin: list employees
app.get('/admin/employees', requireAdmin, (req, res) => {
  const employees = readJSON('employees.json');
  res.json(employees);
});

// Admin: add employee
app.post('/admin/employees', requireAdmin, (req, res) => {
  const { login, password, name } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Login and password required' });
  }
  
  const employees = readJSON('employees.json');
  if (employees.find(e => e.login === login)) {
    return res.status(400).json({ error: 'Login already exists' });
  }
  
  employees.push({ login, password, name: name || login, active: true, createdAt: new Date().toISOString() });
  writeJSON('employees.json', employees);
  res.json({ type: 'ok' });
});

// Admin: delete employee
app.delete('/admin/employees/:login', requireAdmin, (req, res) => {
  let employees = readJSON('employees.json');
  employees = employees.filter(e => e.login !== req.params.login);
  writeJSON('employees.json', employees);
  res.json({ type: 'ok' });
});

// Admin: list sessions
app.get('/admin/sessions', requireAdmin, (req, res) => {
  const sessions = readJSON('sessions.json');
  res.json(sessions);
});

// Admin: list screenshots for a session
app.get('/admin/sessions/:id/screenshots', requireAdmin, (req, res) => {
  const sessionId = req.params.id;
  const dir = path.join(SCREENSHOTS_DIR, sessionId);
  if (!fs.existsSync(dir)) return res.json([]);
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
  const screenshots = files.map(f => ({
    filename: f,
    url: `/screenshots/${sessionId}/${f}`,
    time: f.replace('.jpg', ''),
  }));
  res.json(screenshots);
});

// Serve screenshots
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// ============ SESSION SCREENSHOTS (auto, every 30s) ============
// Employee sends screenshot via this endpoint
app.post('/screenshot', (req, res) => {
  const { sessionId, image, timestamp } = req.body;
  if (!sessionId || !image) return res.json({ type: 'error' });
  
  const dir = path.join(SCREENSHOTS_DIR, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const base64Data = image.replace(/^data:image\/jpeg;base64,/, '');
  const filename = `${timestamp || Date.now()}.jpg`;
  fs.writeFileSync(path.join(dir, filename), base64Data, 'base64');
  
  res.json({ type: 'ok' });
});

// ============ ADMIN WEB PAGE ============
app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RemoteDeskPBX Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial; padding: 20px; background: #f5f5f5; }
    h1 { color: #1a73e8; margin-bottom: 20px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    input, button { padding: 10px; margin: 5px; border: 1px solid #ddd; border-radius: 4px; }
    button { background: #1a73e8; color: white; border: none; cursor: pointer; }
    button.danger { background: #ea4335; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; font-size: 13px; }
    th { background: #f0f0f0; }
    .login-form { max-width: 300px; margin: 100px auto; }
    .login-form h2 { margin-bottom: 20px; }
    .error { color: #ea4335; margin-bottom: 10px; }
    .tab { display: inline-block; padding: 10px 20px; cursor: pointer; background: #e0e0e0; border-radius: 4px 4px 0 0; }
    .tab.active { background: white; font-weight: bold; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    img.screenshot { max-width: 200px; margin: 5px; border-radius: 4px; cursor: pointer; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; }
    .modal img { max-width: 90%; max-height: 90%; margin: 5% auto; display: block; }
    .modal .close { position: absolute; top: 20px; right: 30px; color: white; font-size: 40px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    let token = '';
    let employees = [];
    let sessions = [];

    function showLogin() {
      document.getElementById('app').innerHTML = \`
        <div class="login-form card">
          <h2>🔐 Админ-панель</h2>
          <div id="login-error" class="error"></div>
          <input type="password" id="admin-pass" placeholder="Пароль администратора" style="width:100%">
          <button onclick="login()" style="width:100%">Войти</button>
        </div>
      \`;
    }

    function login() {
      const pass = document.getElementById('admin-pass').value;
      if (!pass) { document.getElementById('login-error').textContent = 'Введите пароль'; return; }
      token = 'Bearer ' + pass;
      loadData();
    }

    async function loadData() {
      try {
        const [empRes, sesRes] = await Promise.all([
          fetch('/admin/employees', { headers: { Authorization: token } }),
          fetch('/admin/sessions', { headers: { Authorization: token } })
        ]);
        if (empRes.status === 401 || sesRes.status === 401) {
          document.getElementById('login-error').textContent = 'Неверный пароль';
          return;
        }
        employees = await empRes.json();
        sessions = await sesRes.json();
        showDashboard();
      } catch(e) { document.getElementById('login-error').textContent = 'Ошибка загрузки: ' + e.message; }
    }

    let currentTab = 'employees';

    function showDashboard() {
      const html = \`
        <h1>🛠️ RemoteDeskPBX Админ-панель</h1>
        <div>
          <span class="tab \${currentTab==='employees'?'active':''}" onclick="switchTab('employees')">👥 Сотрудники</span>
          <span class="tab \${currentTab==='sessions'?'active':''}" onclick="switchTab('sessions')">📊 Сессии</span>
        </div>
        <div id="tab-employees" class="tab-content \${currentTab==='employees'?'active':''}">
          <div class="card">
            <h3>👥 Сотрудники</h3>
            <div style="margin:10px 0">
              <input id="new-login" placeholder="Логин">
              <input id="new-pass" type="password" placeholder="Пароль">
              <input id="new-name" placeholder="Имя">
              <button onclick="addEmployee()">➕ Добавить</button>
            </div>
            <table>
              <tr><th>Логин</th><th>Имя</th><th>Активен</th><th>Создан</th><th></th></tr>
              \${employees.map(e => \`<tr>
                <td>\${e.login}</td>
                <td>\${e.name || e.login}</td>
                <td>\${e.active !== false ? '✅' : '❌'}</td>
                <td>\${e.createdAt ? new Date(e.createdAt).toLocaleString() : '-'}</td>
                <td><button class="danger" onclick="deleteEmployee('\${e.login}')">Удалить</button></td>
              </tr>\`).join('')}
            </table>
          </div>
        </div>
        <div id="tab-sessions" class="tab-content \${currentTab==='sessions'?'active':''}">
          <div class="card">
            <h3>📊 Сессии</h3>
            <table>
              <tr><th>Код</th><th>Начало</th><th>Конец</th><th>Длительность (мин)</th><th>Скриншоты</th></tr>
              \${sessions.slice().reverse().map(s => \`<tr>
                <td>\${s.code}</td>
                <td>\${new Date(s.startTime).toLocaleString()}</td>
                <td>\${s.endTime ? new Date(s.endTime).toLocaleString() : 'Активна'}</td>
                <td>\${s.duration !== null ? s.duration + ' мин' : '...'}</td>
                <td><button onclick="showScreenshots('\${s.id}')">📸 \${s.id ? 'Смотреть' : '-'}</button></td>
              </tr>\`).join('')}
            </table>
          </div>
        </div>
        <div id="screenshot-modal" class="modal" onclick="this.style.display='none'">
          <span class="close">&times;</span>
          <img id="modal-img" src="">
        </div>
      \`;
      document.getElementById('app').innerHTML = html;
    }

    function switchTab(tab) {
      currentTab = tab;
      showDashboard();
    }

    async function addEmployee() {
      const login = document.getElementById('new-login').value;
      const password = document.getElementById('new-pass').value;
      const name = document.getElementById('new-name').value || login;
      if (!login || !password) { alert('Заполните логин и пароль'); return; }
      await fetch('/admin/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ login, password, name })
      });
      loadData();
    }

    async function deleteEmployee(login) {
      if (!confirm('Удалить сотрудника ' + login + '?')) return;
      await fetch('/admin/employees/' + login, {
        method: 'DELETE',
        headers: { Authorization: token }
      });
      loadData();
    }

    async function showScreenshots(sessionId) {
      if (!sessionId) { alert('ID сессии не найден'); return; }
      const res = await fetch('/admin/sessions/' + sessionId + '/screenshots', { headers: { Authorization: token } });
      const shots = await res.json();
      if (shots.length === 0) { alert('Нет скриншотов для этой сессии'); return; }
      
      const modal = document.getElementById('screenshot-modal');
      const img = document.getElementById('modal-img');
      let idx = 0;
      
      function show() {
        img.src = shots[idx].url;
        modal.style.display = 'block';
      }
      
      modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
      };
      
      document.onkeydown = (e) => {
        if (modal.style.display !== 'block') return;
        if (e.key === 'ArrowRight' && idx < shots.length - 1) { idx++; show(); }
        if (e.key === 'ArrowLeft' && idx > 0) { idx--; show(); }
        if (e.key === 'Escape') modal.style.display = 'none';
      };
      
      show();
    }

    showLogin();
  </script>
</body>
</html>
  `);
});

// ============ STATIC FILES FOR DEVELOPERS ============
// Create empty data files if not exist
['sessions.json', 'employees.json'].forEach(f => {
  const p = path.join(DATA_DIR, f);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('════════════════════════════════════════');
  console.log('  RemoteDeskPBX SERVER (HTTP)');
  console.log('  Port: ' + PORT);
  console.log('  Admin: http://localhost:' + PORT + '/admin');
  console.log('  Password: ' + ADMIN_PASSWORD);
  console.log('════════════════════════════════════════');
});