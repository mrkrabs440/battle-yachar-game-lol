// GTA풍 오픈월드 맞짱 서버 (회원가입/DB 없음, 닉네임만, 방당 최대 15인)
const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const MAXP = 15;

const rooms = new Map();   // id -> {id,name,createdAt,order:[],cars:{}}
const players = new Map(); // socketId -> {nickname,roomId,hp,alive,kills,deaths,cash,pos,yaw,driving}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pub = (r) => ({ id: r.id, name: r.name, playerCount: r.order.length, maxPlayers: MAXP, createdAt: r.createdAt });
app.get('/api/rooms', (req, res) => res.json({ ok: true, rooms: [...rooms.values()].map(pub) }));
app.post('/api/rooms', (req, res) => {
  let { name } = req.body || {};
  name = String(name || '난투장').slice(0, 20);
  const id = uuidv4().slice(0, 8);
  rooms.set(id, { id, name, createdAt: Date.now(), order: [], cars: {} });
  io.emit('lobby:update', { rooms: [...rooms.values()].map(pub) });
  res.json({ ok: true, room: pub(rooms.get(id)) });
});

function roomPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return room.order.map(sid => {
    const p = players.get(sid);
    return p ? { nickname: p.nickname, hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths, pos: p.pos, yaw: p.yaw, pitch: p.pitch || 0, wi: p.wi || 0, punch: p.punch || 0, driving: p.driving ?? null, blocking: !!p.blocking } : null;
  }).filter(Boolean);
}

io.on('connection', (socket) => {
  socket.on('room:join', (d) => {
    const room = d && d.roomId && rooms.get(d.roomId);
    let nick = String((d && d.nickname) || '').trim().slice(0, 12);
    if (!room) return socket.emit('error:msg', '방이 없습니다. 새로고침하세요.');
    if (nick.length < 2) return socket.emit('error:msg', '닉네임 2~12자 입력!');
    if (room.order.length >= MAXP) return socket.emit('error:msg', '15인 만원!');
    const taken = new Set(room.order.map(sid => players.get(sid)).filter(Boolean).map(p => p.nickname));
    if (taken.has(nick)) { let i = 2; while (taken.has(`${nick}(${i})`)) i++; nick = `${nick}(${i})`; }
    // 중복 입장 정리 (같은 소켓이 이미 있으면 제거 후 재등록)
    room.order = room.order.filter(sid => sid !== socket.id);
    const old = players.get(socket.id);
    if (old && old.roomId && old.roomId !== room.id) {
      const prev = rooms.get(old.roomId);
      if (prev) prev.order = prev.order.filter(sid => sid !== socket.id);
    }
    players.set(socket.id, { nickname: nick, roomId: room.id, hp: 100, alive: true, kills: 0, deaths: 0, cash: 0, pos: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, wi: 0, punch: 0, driving: null });
    room.order.push(socket.id);
    socket.join('room_' + room.id);
    socket.emit('room:joined', { room: pub(room), you: nick });
    const holders = {};
    for (const [ci, holder] of Object.entries(room.cars)) {
      const hp = players.get(holder);
      if (hp) holders[ci] = hp.nickname;
    }
    socket.emit('cars:sync', { holders });
    io.to('room_' + room.id).emit('room:players', roomPlayers(room.id));
    io.to('room_' + room.id).emit('chat:msg', { sys: true, text: `▶ ${nick} 입장 (${room.order.length}/${MAXP})` });
    io.emit('lobby:update', { rooms: [...rooms.values()].map(pub) });
  });

  socket.on('room:leave', () => leave(socket));
  function leave(sock) {
    const p = players.get(sock.id);
    if (!p || !p.roomId) return;
    const room = rooms.get(p.roomId);
    if (room) {
      room.order = room.order.filter(id => id !== sock.id);
      for (const [ci, holder] of Object.entries(room.cars)) if (holder === sock.id) { delete room.cars[ci]; io.to('room_' + room.id).emit('car:free', { idx: +ci }); }
      sock.leave('room_' + room.id);
      io.to('room_' + room.id).emit('player:left', { nickname: p.nickname });
      io.to('room_' + room.id).emit('room:players', roomPlayers(room.id));
      io.emit('lobby:update', { rooms: [...rooms.values()].map(pub) });
    }
    players.delete(sock.id);
  }

  socket.on('player:state', (d) => {
    const p = players.get(socket.id);
    if (!p || !p.roomId || !d || !d.pos) return;
    p.pos = d.pos; p.yaw = d.yaw; p.pitch = d.pitch || 0; p.wi = d.wi || 0; p.punch = d.punch || 0;
    p.driving = d.driving ?? null; p.blocking = !!d.blocking; p.fy = d.fy || 0;
    if (d.car) socket.to('room_' + p.roomId).emit('car:state', { idx: d.car.idx, x: d.car.x, z: d.car.z, yaw: d.car.yaw, by: p.nickname });
    socket.to('room_' + p.roomId).emit('player:move', { nickname: p.nickname, pos: d.pos, yaw: d.yaw, pitch: d.pitch || 0, wi: d.wi || 0, hp: p.hp, alive: p.alive, punch: d.punch || 0, driving: p.driving, blocking: p.blocking, fy: p.fy });
  });

  socket.on('car:take', (d) => {
    const p = players.get(socket.id);
    if (!p || !p.roomId || !d || d.idx === undefined) return;
    const room = rooms.get(p.roomId);
    if (!room || room.cars[d.idx]) return socket.emit('error:msg', '이미 탄 차!');
    room.cars[d.idx] = socket.id;
    p.driving = d.idx;
    io.to('room_' + room.id).emit('car:taken', { idx: d.idx, by: p.nickname });
  });
  socket.on('car:leave', (d) => {
    const p = players.get(socket.id);
    if (!p || !p.roomId) return;
    const room = rooms.get(p.roomId);
    const idx = d && d.idx !== undefined ? d.idx : p.driving;
    if (room && idx !== null && idx !== undefined && room.cars[idx] === socket.id) {
      delete room.cars[idx];
      io.to('room_' + room.id).emit('car:free', { idx });
    }
    p.driving = null;
  });

  socket.on('player:hit', (d) => {
    const { target, damage, weapon } = d || {};
    if (!target || !damage) return;
    const me = players.get(socket.id);
    if (!me || !me.roomId) return;
    const room = rooms.get(me.roomId);
    if (!room) return;
    const t = [...players.values()].find(pl => pl.roomId === me.roomId && pl.nickname === target && pl.alive);
    if (!t || t.nickname === me.nickname) return;
    let dd = Math.min(100, damage);
    if (t.blocking) dd = Math.round(dd * 0.3); // 막기 감경
    t.hp -= dd;
    if (t.hp <= 0) {
      t.hp = 0; t.alive = false; t.deaths++; me.kills++; me.cash += 100;
      io.to('room_' + room.id).emit('player:killed', { killer: me.nickname, victim: t.nickname, weapon });
      io.to('room_' + room.id).emit('room:players', roomPlayers(room.id));
      setTimeout(() => {
        if (!rooms.get(room.id)) return;
        t.hp = 100; t.alive = true;
        io.to('room_' + room.id).emit('player:respawned', { nickname: t.nickname });
        io.to('room_' + room.id).emit('room:players', roomPlayers(room.id));
      }, 2000);
    } else {
      io.to('room_' + room.id).emit('player:damaged', { target: t.nickname, hp: t.hp, attacker: me.nickname });
    }
  });

  socket.on('chat:msg', (d) => {
    const p = players.get(socket.id);
    if (!p || !p.roomId || !d) return;
    const text = String(d.text || '').slice(0, 100);
    if (!text) return;
    io.to('room_' + p.roomId).emit('chat:msg', { nickname: p.nickname, text });
  });

  socket.on('disconnect', () => leave(socket));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`OPENWORLD 서버: http://localhost:${PORT}`));
