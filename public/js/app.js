import { HorrorGame } from './game.js';

let token = localStorage.getItem('hr_token') || null;
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
  localStorage.setItem('hr_token', token);
  enterGame();
}
$('btn-login').onclick = doLogin;
$('login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function loadRank() {
  try {
    const j = await (await fetch('/api/rank')).json();
    const fmt = (ms) => ms ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : '-';
    $('rank-list').innerHTML = '<b>🏆 탈출 랭킹</b><br>' + (j.rank.map((r, i) => `${i + 1}. ${r.nickname} — ${r.escapes}회 탈출 (최고 ${fmt(r.bestMs)})`).join('<br>') || '아직 기록 없음');
  } catch {}
}
loadRank();

function enterGame() {
  $('auth-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  if (game) game.dispose();
  game = new HorrorGame({ canvas: $('game-canvas'), token });
  game.start();
}
if (token) enterGame();
