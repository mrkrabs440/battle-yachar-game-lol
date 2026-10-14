import { WorldGame } from './world.js';

const socket = io();
let myNick = localStorage.getItem('ow_nick') || '';
let game = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (myNick) $('nick-input').value = myNick;
$('btn-go').onclick = () => {
  const v = $('nick-input').value.trim();
  if (v.length < 2) return alert('닉네임 2~12자!');
  myNick = v.slice(0, 12);
  localStorage.setItem('ow_nick', myNick);
  $('nick-screen').classList.add('hidden');
  $('lobby-screen').classList.remove('hidden');
  $('my-nick').textContent = '👤 ' + myNick;
  loadRooms();
};
$('nick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-go').click(); });

async function loadRooms() {
  const j = await (await fetch('/api/rooms')).json();
  const list = j.rooms || [];
  $('room-list').innerHTML = list.length ? list.map(r =>
    `<div class="room"><div class="info"><b>${esc(r.name)}</b><br><span style="color:#9fb2c5">${r.playerCount}/${r.maxPlayers}명</span></div><button data-j="${r.id}">입장</button></div>`
  ).join('') : '<p style="color:#7d8ea0">방이 없습니다. 만들어보세요!</p>';
  document.querySelectorAll('[data-j]').forEach(b => b.onclick = () => joinRoom(b.dataset.j));
}
$('btn-refresh').onclick = loadRooms;
$('btn-create').onclick = () => $('create-panel').classList.toggle('hidden');
$('btn-do-create').onclick = async () => {
  const name = $('room-name').value.trim() || `${myNick}의 난투장`;
  const j = await (await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
  joinRoom(j.room.id);
};
function joinRoom(id) { socket.emit('room:join', { roomId: id, nickname: myNick }); }

socket.on('lobby:update', (d) => { if (!$('lobby-screen').classList.contains('hidden')) loadRooms(); });
socket.on('error:msg', (t) => alert(t));
socket.on('room:joined', (d) => {
  $('lobby-screen').classList.add('hidden');
  $('nick-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  myNick = d.you;
  localStorage.setItem('ow_nick', myNick);
  if (game) game.dispose();
  game = new WorldGame({ canvas: $('game-canvas'), socket, room: d.room, nick: myNick });
  game.start();
});
