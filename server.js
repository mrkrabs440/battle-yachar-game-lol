// 폐교탈출 공포게임 서버 (회원가입/로그인/탈출기록 저장)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3003;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => { try { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); } catch {} };
let users = readJson(USERS_FILE, []);
const sessions = new Map(Object.entries(readJson(path.join(DATA_DIR, 'sessions.json'), {})));
const saveSessions = () => writeJson(path.join(DATA_DIR, 'sessions.json'), Object.fromEntries(sessions));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', async (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password || !nickname) return res.status(400).json({ error: '아이디, 비밀번호, 닉네임을 모두 입력하세요.' });
  if (username.length < 3 || password.length < 4) return res.status(400).json({ error: '아이디 3자 이상, 비밀번호 4자 이상' });
  if (users.find(u => u.username === username)) return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
  if (users.find(u => u.nickname === nickname)) return res.status(409).json({ error: '이미 존재하는 닉네임입니다.' });
  users.push({ id: uuidv4(), username, nickname, passwordHash: await bcrypt.hash(password, 10), escapes: 0, deaths: 0, bestMs: 0, createdAt: Date.now() });
  writeJson(USERS_FILE, users);
  res.json({ ok: true, message: '회원가입 성공! 로그인하세요.' });
});
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = users.find(x => x.username === username);
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
  for (const [tok, uid] of sessions) if (uid === u.id) sessions.delete(tok);
  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  sessions.set(token, u.id); saveSessions();
  const { passwordHash, ...safe } = u;
  res.json({ ok: true, token, user: safe });
});
function needAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const u = users.find(x => x.id === sessions.get(h.startsWith('Bearer ') ? h.slice(7) : null));
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = u; next();
}
app.get('/api/me', needAuth, (req, res) => {
  const { passwordHash, ...safe } = req.user;
  res.json({ ok: true, user: safe });
});
// 탈출/사망 기록 저장
app.post('/api/record', needAuth, (req, res) => {
  const { win, timeMs } = req.body || {};
  const u = req.user;
  if (win) {
    u.escapes = (u.escapes || 0) + 1;
    if (!u.bestMs || timeMs < u.bestMs) u.bestMs = timeMs;
  } else u.deaths = (u.deaths || 0) + 1;
  writeJson(USERS_FILE, users);
  const { passwordHash, ...safe } = u;
  res.json({ ok: true, user: safe });
});
app.get('/api/rank', (req, res) => {
  const board = users.map(u => ({ nickname: u.nickname, escapes: u.escapes || 0, bestMs: u.bestMs || 0 }))
    .sort((a, b) => b.escapes - a.escapes || (a.bestMs || 1e15) - (b.bestMs || 1e15)).slice(0, 10);
  res.json({ ok: true, rank: board });
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`HORROR 서버: http://localhost:${PORT}`));
