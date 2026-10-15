import { BrainrotGame } from './game.js';

const socket = io();
let token = localStorage.getItem('br_token') || null;
let game = null;
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('auth-msg').textContent = t; };

$('tab-login').onclick = () => { $('tab-login').classList.add('active'); $('tab-register').classList.remove('active'); $('login-form').classList.remove('hidden'); $('register-form').classList.add('hidden'); };
$('tab-register').onclick = () => { $('tab-register').classList.add('active'); $('tab-login').classList.remove('active'); $('register-form').classList.remove('hidden'); $('login-form').classList.add('hidden'); };
$('btn-register').onclick = async () => {
  const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('reg-id').value.trim(), nickname: $('reg-nick').value.trim(), password: $('reg-pw').value }) });
  const j = await r.json();
  msg(j.error || j.message);
  if (j.ok) { $('tab-login').click(); $('login-id').value = $('reg-id').value.trim(); }
};
async function doLogin() {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('login-id').value.trim(), password: $('login-pw').value }) });
  const j = await r.json();
  if (!j.ok) return msg(j.error);
  token = j.token;
  localStorage.setItem('br_token', token);
  enterGame();
}
$('btn-login').onclick = doLogin;
$('login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

function enterGame() {
  $('auth-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  socket.emit('auth', { token });
}
socket.on('auth:fail', () => { localStorage.removeItem('br_token'); location.reload(); });
socket.on('error:msg', (t) => alert(t));
socket.on('auth:ok', (d) => {
  if (game) game.dispose();
  game = new BrainrotGame({ canvas: $('game-canvas'), socket, user: d.user, plot: d.plot, snap: d.snap });
  game.start();
});
if (token) enterGame();
