// 브레인롯 훔치기 서버 (회원가입/로그인/데이터저장, 단일 월드 최대 8인)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3002;
const MAXP = 8;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => { try { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); } catch {} };

// ---------- 브레인롯 도감 ----------
const ROSTER = [
  { key: 'noobini', name: 'Noobini Pizzanini', rarity: 'common', income: 1, cost: 50, w: 30 },
  { key: 'tung', name: 'Tung Tung Sahur', rarity: 'common', income: 2, cost: 100, w: 25 },
  { key: 'tralala', name: 'Tralalero Tralala', rarity: 'epic', income: 10, cost: 600, w: 18 },
  { key: 'cappuccino', name: 'Cappuccino Assassino', rarity: 'legendary', income: 25, cost: 1500, w: 12 },
  { key: 'ballerina', name: 'Ballerina Cappuccina', rarity: 'legendary', income: 30, cost: 1800, w: 7 },
  { key: 'bombardiro', name: 'Bombardiro Crocodilo', rarity: 'mythic', income: 70, cost: 4500, w: 4 },
  { key: 'lirili', name: 'Lirili Larila', rarity: 'mythic', income: 90, cost: 6000, w: 3 },
  { key: 'patapim', name: 'Brr Brr Patapim', rarity: 'secret', income: 250, cost: 20000, w: 1 },
];
const RARITY_COL = { common: '#9e9e9e', epic: '#9d4edd', legendary: '#f5a623', mythic: '#ff2e63', secret: '#00f5d4' };
function rollBrainrot() {
  const tot = ROSTER.reduce((a, b) => a + b.w, 0);
  let r = Math.random() * tot;
  for (const b of ROSTER) { r -= b.w; if (r <= 0) return b; }
  return ROSTER[0];
}

// ---------- 저장소 ----------
let users = readJson(USERS_FILE, []);
const sessions = new Map(Object.entries(readJson(SESS_FILE, {})));
let dirtyUsers = false;
function saveUsers() { dirtyUsers = true; writeJson(USERS_FILE, users); }
function saveSessions() { writeJson(SESS_FILE, Object.fromEntries(sessions)); }
setInterval(() => { if (dirtyUsers) { dirtyUsers = false; writeJson(USERS_FILE, users); } }, 15000);
function getUser(id) { return users.find(u => u.id === id); }

// ---------- 월드 상태 (인메모리) ----------
// item: {id, key, name, rarity, income, state:'belt'|'carried'|'base'|'loose', t(벨트위치), carrier, owner, slot, x, z}
const items = new Map();
let itemSeq = 1;
// plot 8개: {idx, owner(userId)|null, lockUntil, lockCdUntil}
const plots = Array.from({ length: 8 }, (_, i) => ({ idx: i, owner: null, lockUntil: 0, lockCdUntil: 0 }));
const players = new Map(); // socketId -> {userId, nickname, plot, carrying, pos, yaw, hp...}
const SLOTS = 6;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 인증 + 데이터 ----------
app.post('/api/register', async (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password || !nickname) return res.status(400).json({ error: '아이디, 비밀번호, 닉네임을 모두 입력하세요.' });
  if (username.length < 3 || password.length < 4) return res.status(400).json({ error: '아이디 3자 이상, 비밀번호 4자 이상' });
  if (users.find(u => u.username === username)) return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
  if (users.find(u => u.nickname === nickname)) return res.status(409).json({ error: '이미 존재하는 닉네임입니다.' });
  const u = { id: uuidv4(), username, nickname, passwordHash: await bcrypt.hash(password, 10), cash: 300, brainrots: [], totalEarned: 0, steals: 0, createdAt: Date.now() };
  users.push(u); saveUsers();
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
app.get('/api/me', (req, res) => {
  const h = req.headers.authorization || '';
  const u = getUser(sessions.get(h.startsWith('Bearer ') ? h.slice(7) : null));
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const { passwordHash, ...safe } = u;
  res.json({ ok: true, user: safe });
});
app.get('/api/roster', (req, res) => res.json({ ok: true, roster: ROSTER.map(({ w, ...r }) => r) }));

// ---------- 월드 스냅샷 ----------
function snap() {
  return {
    belt: [...items.values()].filter(i => i.state === 'belt').map(({ id, key, t }) => ({ id, key, t })),
    loose: [...items.values()].filter(i => i.state === 'loose').map(({ id, key, x, z }) => ({ id, key, x, z })),
    carried: [...items.values()].filter(i => i.state === 'carried').map(({ id, key, carrier }) => ({ id, key, carrier })),
    bases: plots.map(p => ({ idx: p.idx, owner: p.owner ? (getUser(p.owner) || {}).nickname || null : null, lockUntil: p.lockUntil, slots: [...items.values()].filter(i => i.state === 'base' && i.owner === p.owner && p.owner).map(i => ({ id: i.key, key: i.key, slot: i.slot })) })),
    players: [...players.values()].map(p => ({ nickname: p.nickname, plot: p.plot, pos: p.pos, yaw: p.yaw, carrying: p.carrying })),
  };
}
function emitState() { io.emit('world:tick', { belt: snap().belt, bases: snap().bases.map(b => ({ idx: b.idx, owner: b.owner, lockUntil: b.lockUntil })) }); }

// ---------- 1초 틱: 벨트 이동 + 수익 + 저장 ----------
let tickN = 0;
setInterval(() => {
  tickN++;
  const now = Date.now();
  for (const it of items.values()) {
    if (it.state === 'belt') {
      it.t += 0.045; // 벨트 속도
      if (it.t > 1.05) items.delete(it.id); // 끝까지 가면 소멸
    }
  }
  if ([...items.values()].filter(i => i.state === 'belt').length < 7 && Math.random() < 0.5) {
    const b = rollBrainrot();
    const id = 'b' + (itemSeq++);
    items.set(id, { id, key: b.key, name: b.name, rarity: b.rarity, income: b.income, cost: b.cost, state: 'belt', t: -0.05 });
    io.emit('belt:spawn', { id, key: b.key });
  }
  for (const it of items.values()) {
    if (it.state === 'base' && it.owner) {
      const u = getUser(it.owner);
      if (u) { u.cash += it.income; u.totalEarned += it.income; dirtyUsers = true; }
    }
  }
  io.emit('world:tick', { belt: [...items.values()].filter(i => i.state === 'belt').map(({ id, key, t }) => ({ id, key, t })), bases: plots.map(p => ({ idx: p.idx, lockUntil: p.lockUntil })) });
  // 5초마다 개인 캐시/수익 푸시
  if (tickN % 5 === 0) {
    for (const [sid, p] of players) {
      const u = getUser(p.userId);
      if (!u) continue;
      const income = [...items.values()].filter(i => i.state === 'base' && i.owner === u.id).reduce((a, i) => a + i.income, 0);
      io.to(sid).emit('me:cash', { cash: u.cash, income });
    }
  }
}, 1000);

// ---------- 소켓 ----------
io.on('connection', (socket) => {
  socket.on('auth', (d) => {
    const u = getUser(sessions.get(d && d.token));
    if (!u) return socket.emit('auth:fail');
    if (players.size >= MAXP) return socket.emit('error:msg', '서버 만원! (8/8)');
    // 빈 플롯 배정 (내 플롯이 비어있으면 재사용)
    let plot = plots.find(p => p.owner === u.id);
    if (!plot) plot = plots.find(p => !p.owner || ![...players.values()].some(pl => pl.plot === p.idx));
    if (!plot) return socket.emit('error:msg', '빈 기지가 없습니다.');
    plot.owner = u.id;
    // 저장된 브레인롯을 기지 슬롯에 복원 (최대 6개, 초과분 자동판매)
    const mine = [...items.values()].filter(i => i.owner === u.id);
    for (const m of mine) items.delete(m.id);
    const keep = (u.brainrots || []).slice(0, SLOTS);
    const sold = (u.brainrots || []).slice(SLOTS);
    let bonus = 0;
    for (const s of sold) bonus += Math.floor((s.cost || 0) / 2);
    if (bonus) { u.cash += bonus; }
    keep.forEach((b, i) => {
      const id = 'b' + (itemSeq++);
      items.set(id, { id, key: b.key, name: b.name, rarity: b.rarity, income: b.income, cost: b.cost, state: 'base', owner: u.id, slot: i });
    });
    players.set(socket.id, { userId: u.id, nickname: u.nickname, plot: plot.idx, carrying: null, pos: { x: 0, y: 1.6, z: 40 }, yaw: 0 });
    const { passwordHash, ...safe } = u;
    socket.emit('auth:ok', { user: safe, plot: plot.idx, snap: snap() });
    socket.broadcast.emit('player:joined', { nickname: u.nickname, plot: plot.idx });
    socket.broadcast.emit('chat:msg', { sys: true, text: `▶ ${u.nickname} 입장!` });
  });

  function me() { return players.get(socket.id); }
  function myUser() { const p = me(); return p && getUser(p.userId); }

  socket.on('player:state', (d) => {
    const p = me();
    if (!p || !d || !d.pos || !isFinite(d.pos.x + d.pos.y + d.pos.z)) return;
    p.pos = { x: Math.max(-70, Math.min(70, d.pos.x)), y: d.pos.y, z: Math.max(-70, Math.min(70, d.pos.z)) };
    p.yaw = d.yaw || 0;
    socket.broadcast.emit('player:move', { nickname: p.nickname, pos: p.pos, yaw: p.yaw, carrying: p.carrying, slapping: !!d.slapping });
  });

  // 벨트/바닥 줍기 (구매)
  socket.on('item:claim', (d) => {
    const p = me(), u = myUser();
    if (!p || !u || !d || p.carrying) return;
    const it = items.get(d.id);
    if (!it || (it.state !== 'belt' && it.state !== 'loose')) return;
    const px = p.pos.x, pz = p.pos.z;
    const ix = it.state === 'belt' ? beltPos(it.t).x : it.x;
    const iz = it.state === 'belt' ? beltPos(it.t).z : it.z;
    if (Math.hypot(px - ix, pz - iz) > 4) return;
    const price = it.state === 'belt' ? it.cost : 0;
    if (u.cash < price) { socket.emit('error:msg', '캐시 부족!'); return; }
    u.cash -= price;
    it.state = 'carried'; it.carrier = p.nickname;
    p.carrying = it.id;
    saveUsers();
    io.emit('item:update', { id: it.id, key: it.key, state: 'carried', carrier: p.nickname });
    socket.emit('me:cash', { cash: u.cash });
  });

  // 내 기지에 보관
  socket.on('item:deposit', () => {
    const p = me(), u = myUser();
    if (!p || !u || !p.carrying) return;
    const it = items.get(p.carrying);
    if (!it || it.state !== 'carried' || it.carrier !== p.nickname) { p.carrying = null; return; }
    const plot = plots[p.plot];
    const home = plotBasePos(p.plot);
    if (Math.hypot(p.pos.x - home.x, p.pos.z - home.z) > 12) return;
    const used = [...items.values()].filter(i => i.state === 'base' && i.owner === u.id).map(i => i.slot);
    const slot = [0, 1, 2, 3, 4, 5].find(s => !used.includes(s));
    if (slot === undefined) { socket.emit('error:msg', '기지 가득참!'); return; }
    it.state = 'base'; it.owner = u.id; it.slot = slot; it.carrier = null;
    u.brainrots = [...items.values()].filter(i => i.state === 'base' && i.owner === u.id)
      .map(i => ({ key: i.key, name: i.name, rarity: i.rarity, income: i.income, cost: i.cost, slot: i.slot }));
    p.carrying = null;
    saveUsers();
    io.emit('item:update', { id: it.id, key: it.key, state: 'base', owner: u.nickname, slot, plot: p.plot });
    socket.emit('chat:msg', { sys: true, text: `📦 ${it.name} 보관! (+$${it.income}/초)` });
  });

  // 남의 기지에서 훔치기
  socket.on('item:steal', (d) => {
    const p = me(), u = myUser();
    if (!p || !u || !d || p.carrying) return;
    const it = items.get(d.id);
    if (!it || it.state !== 'base' || it.owner === u.id) return;
    const ownerPlot = plots.find(pl => pl.owner === it.owner);
    if (ownerPlot && ownerPlot.lockUntil > Date.now()) { socket.emit('error:msg', '🔒 잠긴 기지!'); return; }
    const home = ownerPlot ? plotBasePos(ownerPlot.idx) : null;
    if (home && Math.hypot(p.pos.x - home.x, p.pos.z - home.z) > 12) return;
    // 원래 주인 기록에서 제거
    const ou = getUser(it.owner);
    if (ou) { ou.brainrots = (ou.brainrots || []).filter(b => !(b.key === it.key && b.slot === it.slot)); }
    it.state = 'carried'; it.carrier = p.nickname; it.stolen = true;
    p.carrying = it.id;
    u.steals = (u.steals || 0) + 1;
    saveUsers();
    io.emit('item:update', { id: it.id, key: it.key, state: 'carried', carrier: p.nickname });
    io.emit('chat:msg', { sys: true, text: `🥷 ${p.nickname}이(가) ${it.name} 훔치는 중!` });
  });

  // 내려놓기 (Q)
  socket.on('item:drop', () => {
    const p = me();
    if (!p || !p.carrying) return;
    const it = items.get(p.carrying);
    p.carrying = null;
    if (!it || it.state !== 'carried') return;
    it.state = 'loose'; it.carrier = null; it.x = p.pos.x; it.z = p.pos.z;
    io.emit('item:update', { id: it.id, key: it.key, state: 'loose', x: it.x, z: it.z });
  });

  // 찰싹 (때리면 넉백+들고 있던 것 떨굼)
  const slapCd = new Map();
  socket.on('player:slap', (d) => {
    const p = me();
    if (!p || !d || !d.target) return;
    const now = Date.now();
    if (slapCd.get(socket.id) && now - slapCd.get(socket.id) < 800) return;
    slapCd.set(socket.id, now);
    const targetEntry = [...players.entries()].find(([, v]) => v.nickname === d.target);
    if (!targetEntry) return;
    const tp = targetEntry[1];
    const dist = Math.hypot((tp.pos?.x || 0) - p.pos.x, (tp.pos?.z || 0) - p.pos.z);
    if (dist > 4) return;
    // 들고 있던 것 떨구기
    if (tp.carrying) {
      const it = items.get(tp.carrying);
      tp.carrying = null;
      if (it && it.state === 'carried') {
        it.state = 'loose'; it.carrier = null; it.x = tp.pos.x; it.z = tp.pos.z;
        io.emit('item:update', { id: it.id, key: it.key, state: 'loose', x: it.x, z: it.z });
      }
    }
    io.emit('player:slapped', { victim: d.target, from: p.nickname });
  });

  // 기지 잠금 (E, 내 기지 근처, 쿨 60초, 20초 잠금)
  socket.on('base:lock', () => {
    const p = me();
    if (!p) return;
    const plot = plots[p.plot];
    if (!plot || plot.owner !== p.userId) return;
    const home = plotBasePos(p.plot);
    if (Math.hypot(p.pos.x - home.x, p.pos.z - home.z) > 12) return;
    const now = Date.now();
    if (plot.lockCdUntil > now) { socket.emit('error:msg', `잠금 쿨다운 ${Math.ceil((plot.lockCdUntil - now) / 1000)}초`); return; }
    if (plot.lockUntil > now) return;
    plot.lockUntil = now + 20000;
    plot.lockCdUntil = now + 60000;
    io.emit('base:locked', { idx: plot.idx, until: plot.lockUntil });
  });

  socket.on('chat:msg', (d) => {
    const p = me();
    if (!p || !d) return;
    const text = String(d.text || '').slice(0, 100);
    if (!text) return;
    io.emit('chat:msg', { nickname: p.nickname, text });
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      if (p.carrying) { // 들고 있던 건 바닥에 떨굼
        const it = items.get(p.carrying);
        if (it && it.state === 'carried') { it.state = 'loose'; it.carrier = null; it.x = p.pos.x; it.z = p.pos.z; io.emit('item:update', { id: it.id, key: it.key, state: 'loose', x: it.x, z: it.z }); }
      }
      players.delete(socket.id);
      socket.broadcast.emit('player:left', { nickname: p.nickname });
    }
  });
});

// ---------- 맵 좌표 (클라와 공유) ----------
function beltPos(t) { return { x: -45 + t * 90, z: 0 }; } // x -45→45 직선 벨트
function plotBasePos(idx) {
  const a = (idx / 8) * Math.PI * 2 + Math.PI / 8;
  return { x: Math.cos(a) * 52, z: Math.sin(a) * 52 };
}
app.get('/api/layout', (req, res) => {
  res.json({ ok: true, plots: plots.map((p, i) => ({ idx: i, ...plotBasePos(i) })), belt: { x1: -45, x2: 45, z: 0 }, colors: RARITY_COL });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`BRAINROT 서버: http://localhost:${PORT}`));
