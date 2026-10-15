import * as THREE from 'three';

// 폐교탈출: 8쪽 수집 → 정문 탈출, 귀신 회피 (1인칭 공포)
const Sfx = {
  ctx: null, master: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch (e) {}
  },
  tone(f, dur, type = 'sine', vol = 0.2, slide = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, vol = 0.3, freq = 1000) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t);
  },
  step() { this.noise(0.05, 0.06, 500); },
  heart(rate) { this.tone(55, 0.12, 'sine', 0.35, 40); setTimeout(() => this.tone(50, 0.1, 'sine', 0.3, 38), 60000 / rate / 2); },
  sting() { this.tone(800, 0.5, 'sawtooth', 0.2, 100); this.noise(0.4, 0.15, 3000); },
  pickup() { this.tone(700, 0.1, 'triangle', 0.25); setTimeout(() => this.tone(1050, 0.15, 'triangle', 0.25), 90); },
  scream() { this.noise(1.2, 0.7, 2500); this.tone(900, 1.0, 'sawtooth', 0.4, 120); },
  drone() {
    if (!this.ctx || this._drone) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 48; g.gain.value = 0.05;
    o.connect(g); g.connect(this.master); o.start();
    this._drone = true;
  },
};

export class HorrorGame {
  constructor({ canvas, token }) {
    this.canvas = canvas; this.token = token;
    this.disposed = false; this.over = false;
    this.keys = {};
    this.pos = new THREE.Vector3(0, 1.6, 40);
    this.yaw = Math.PI; this.pitch = 0;
    this.pages = 0; this.battery = 100; this.lightOn = true;
    this.stamina = 100;
    this.startT = 0; this.heartT = 0;
    this.colliders = [];
    this.papers = []; this.batteries = [];
    this.noise = 0; // 발소음 수치
    this.msgT = 0;
  }

  start() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020204);
    this.scene.fog = new THREE.Fog(0x020204, 4, 42);
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 200);
    this.scene.add(new THREE.HemisphereLight(0x223044, 0x050505, 0.5));
    // 손전등
    this.flash = new THREE.SpotLight(0xffe8c0, 2.2, 45, 0.5, 0.45, 1.2);
    this.scene.add(this.flash);
    this.flashTarget = new THREE.Object3D();
    this.scene.add(this.flashTarget);
    this.flash.target = this.flashTarget;

    this.buildSchool();
    this.spawnPickups();
    this.spawnMonster();
    this.bindInputs();
    this.startT = performance.now();
    Sfx.drone();
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  dispose() { this.disposed = true; Sfx._drone = false; }

  addBox(x, y, z, w, h, d, color, collide = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    this.scene.add(m);
    if (collide) { m.updateMatrixWorld(); this.colliders.push(new THREE.Box3().setFromObject(m)); }
    return m;
  }

  buildSchool() {
    const B = 50; // 반폭
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(B * 2 + 8, B * 2 + 8), new THREE.MeshLambertMaterial({ color: 0x2a2a30 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);
    const W = 0x4a4550, H = 5;
    // 외벽
    this.addBox(0, H / 2, -B, B * 2 + 4, H, 1, W);
    this.addBox(-B, H / 2, 0, 1, H, B * 2, W);
    this.addBox(B, H / 2, 0, 1, H, B * 2, W);
    // 남벽 (정문 구멍)
    this.addBox(-27.5, H / 2, B, 45, H, 1, W);
    this.addBox(27.5, H / 2, B, 45, H, 1, W);
    // 정문 (탈출구)
    this.exitDoor = new THREE.Mesh(new THREE.BoxGeometry(10, 4.6, 0.5), new THREE.MeshLambertMaterial({ color: 0x551111, emissive: 0x330000 }));
    this.exitDoor.position.set(0, 2.3, B); this.scene.add(this.exitDoor);
    // 내부 십자 복도 벽 (교실 4구역, 문 구멍)
    const wall = (x, z, w, d) => this.addBox(x, H / 2, z, w, H, d, 0x3a4048);
    // 가로벽 (z=-15, z=15) — 중앙/양옆 문
    for (const z of [-15, 15]) {
      wall(-32, z, 36, 1); wall(32, z, 36, 1); wall(0, z, 8, 1);
    }
    // 세로벽 (x=-15, x=15)
    for (const x of [-15, 15]) {
      wall(x, -32, 1, 36); wall(x, 32, 1, 36); wall(x, 0, 1, 8);
    }
    // 교실 책상들
    const deskC = 0x5a4632;
    const rooms = [[-32, -32], [32, -32], [-32, 32], [32, 32], [-32, 0], [32, 0], [0, -32], [0, 32]];
    for (const [rx, rz] of rooms) {
      for (let i = -1; i <= 1; i++) for (let j = 0; j < 2; j++) {
        this.addBox(rx + i * 5, 0.7, rz + (j - 0.5) * 6, 3, 1.4, 2, deskC);
      }
      // 칠판
      this.addBox(rx, 2.5, rz - 9.5, 8, 2, 0.3, 0x1a3a2a, false);
    }
    // 깜빡이는 복도등 4개
    this.lamps = [];
    for (const [x, z] of [[-25, 0], [25, 0], [0, -25], [0, 25]]) {
      const li = new THREE.PointLight(0xaaccff, 0.7, 30);
      li.position.set(x, 4.5, z); this.scene.add(li);
      const bulb = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, 0.6), new THREE.MeshBasicMaterial({ color: 0xaaccff }));
      bulb.position.set(x, 4.6, z); this.scene.add(bulb);
      this.lamps.push({ li, bulb, seed: Math.random() * 10 });
    }
    // 피 묻은 낙서
    const blood = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.6), new THREE.MeshBasicMaterial({ color: 0xaa0000, transparent: true, opacity: 0.75 }));
    blood.position.set(-14.4, 2, 0); blood.rotation.y = Math.PI / 2; this.scene.add(blood);
  }

  spawnPickups() {
    const spots = [[-32, -32], [32, -32], [-32, 32], [32, 32], [-32, 0], [32, 0], [0, -32], [0, 32]];
    // 8쪽: 각 구역 랜덤 1장
    for (const [rx, rz] of spots) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.9), new THREE.MeshBasicMaterial({ color: 0xf5f0dc, side: THREE.DoubleSide }));
      m.position.set(rx + (Math.random() - 0.5) * 10, 1.1, rz + (Math.random() - 0.5) * 10);
      m.rotation.y = Math.random() * 3;
      this.scene.add(m);
      this.papers.push({ mesh: m, taken: false });
    }
    // 배터리 5개
    for (let i = 0; i < 5; i++) {
      const spots2 = [[-25, 8], [25, -8], [-8, -25], [8, 25], [0, 0]];
      const [bx, bz] = spots2[i];
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 0.25), new THREE.MeshBasicMaterial({ color: 0x39ff6a }));
      m.position.set(bx + (Math.random() - 0.5) * 4, 0.5, bz + (Math.random() - 0.5) * 4);
      this.scene.add(m);
      this.batteries.push({ mesh: m, taken: false });
    }
  }

  spawnMonster() {
    const g = new THREE.Group();
    const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2.2, 8), black);
    body.position.y = 1.5; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), black);
    head.position.y = 2.8; g.add(head);
    const eyeM = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), eyeM);
      e.position.set(sx * 0.12, 2.85, -0.26); g.add(e);
    }
    const mkArm = (sx) => {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.6, 0.18), black);
      a.position.set(sx * 0.55, 1.5, 0); g.add(a); return a;
    };
    const armL = mkArm(-1), armR = mkArm(1);
    const glow = new THREE.PointLight(0xff0000, 0.5, 10);
    glow.position.y = 2.5; g.add(glow);
    g.position.set(0, 0, -40);
    this.scene.add(g);
    this.mon = { mesh: g, armL, armR, state: 'wander', target: new THREE.Vector3(0, 0, -20), loseT: 0, stepT: 0 };
  }

  bindInputs() {
    this.kd = (e) => {
      if (e.code === 'Enter' && e.type === 'keydown') { this.toggleChat(); return; }
      this.keys[e.code] = e.type === 'keydown';
      if (e.type !== 'keydown' || e.repeat) return;
      if (e.code === 'KeyE') this.interact();
      if (e.code === 'KeyF') { this.lightOn = !this.lightOn; }
    };
    this.ku = this.kd;
    addEventListener('keydown', this.kd); addEventListener('keyup', this.ku);
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.0023;
      this.pitch -= e.movementY * 0.0023;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch));
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this.canvas) { this.canvas.requestPointerLock(); }
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    document.getElementById('click-to-play').onclick = (e) => {
      if (e.target.id === 'btn-leave') return;
      Sfx.init();
      this.canvas.requestPointerLock();
      document.getElementById('click-to-play').style.display = 'none';
    };
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas)
        document.getElementById('click-to-play').style.display = 'flex';
    });
    document.getElementById('btn-leave').onclick = () => location.reload();
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => e.stopPropagation());
    document.getElementById('btn-again').onclick = () => location.reload();
    document.getElementById('btn-tolobby').onclick = () => location.reload();
    window.onresize = () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    };
  }
  toggleChat() {
    const inp = document.getElementById('chat-input');
    if (!inp) return;
    if (!this.chatOpen) { document.exitPointerLock(); inp.classList.remove('hidden'); inp.focus(); this.chatOpen = true; }
  }

  interact() {
    // 쪽지 줍기
    for (const p of this.papers) {
      if (p.taken) continue;
      if (p.mesh.position.distanceTo(new THREE.Vector3(this.pos.x, 0, this.pos.z)) < 2.5) {
        p.taken = true; this.scene.remove(p.mesh);
        this.pages++;
        Sfx.pickup(); Sfx.sting();
        this.showMsg(`📄 쪽지 ${this.pages} / 8 ${this.pages >= 8 ? '— 정문으로 도망쳐!' : ''}`);
        if (this.pages >= 8) {
          this.exitDoor.material.color.set(0x11aa33);
          this.exitDoor.material.emissive.set(0x0a5511);
        }
        this.updateTop();
        return;
      }
    }
    // 배터리
    for (const b of this.batteries) {
      if (b.taken) continue;
      if (b.mesh.position.distanceTo(new THREE.Vector3(this.pos.x, 0, this.pos.z)) < 2.5) {
        b.taken = true; this.scene.remove(b.mesh);
        this.battery = Math.min(100, this.battery + 45);
        Sfx.pickup(); this.showMsg('🔋 배터리 +45%');
        this.updateTop();
        return;
      }
    }
  }
  showMsg(t) {
    document.getElementById('msg').textContent = t;
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => document.getElementById('msg').textContent = '', 2600);
  }
  updateTop() {
    document.getElementById('pages').textContent = `📄 ${this.pages} / 8`;
    document.getElementById('battery').textContent = `🔦 ${Math.max(0, Math.round(this.battery))}%`;
  }

  collide(x, z) {
    const b = new THREE.Box3(new THREE.Vector3(x - 0.4, 0, z - 0.4), new THREE.Vector3(x + 0.4, 1.7, z + 0.4));
    for (const c of this.colliders) if (b.intersectsBox(c)) return true;
    return false;
  }
  los(ax, az, bx, bz) { // 시야 차단 검사
    const dir = new THREE.Vector3(bx - ax, 0, bz - az);
    const dist = dir.length();
    if (dist < 0.5) return true;
    dir.normalize();
    const rc = new THREE.Raycaster(new THREE.Vector3(ax, 1.6, az), dir, 0.1, dist);
    const hit = new THREE.Vector3();
    for (const c of this.colliders) {
      // 낮은 책상은 시야 가리지 않음
      if (c.max.y < 1.4) continue;
      if (rc.ray.intersectBox(c, hit) && hit.distanceTo(new THREE.Vector3(ax, 1.6, az)) < dist - 0.5) return false;
    }
    return true;
  }

  updateMonster(dt, time) {
    const m = this.mon, mp = m.mesh.position;
    const dx = this.pos.x - mp.x, dz = this.pos.z - mp.z;
    const dist = Math.hypot(dx, dz);
    const seen = dist < 30 && this.los(mp.x, mp.z, this.pos.x, this.pos.z);
    const heard = this.noise > 0.5 && dist < 18;
    if (m.state !== 'chase' && (dist < 6 || seen || heard)) {
      m.state = 'chase'; m.loseT = 0;
      Sfx.sting();
      this.showMsg('👁 봤다! 도망쳐!');
    }
    const speed = 4.0 + this.pages * 0.4; // 쪽지 많을수록 빠름
    if (m.state === 'chase') {
      if (dist > 34 || (!seen && !heard && dist > 10)) {
        m.loseT += dt;
        if (m.loseT > 4) { m.state = 'wander'; }
      } else m.loseT = 0;
      m.target.set(this.pos.x, 0, this.pos.z);
      const sp = Math.min(speed, 7.6);
      this.moveMonster(mp, m.target, sp, dt);
      if (dist < 1.7) { this.die(); return; }
    } else {
      if (mp.distanceTo(m.target) < 3) {
        m.target.set((Math.random() - 0.5) * 80, 0, (Math.random() - 0.5) * 80);
      }
      this.moveMonster(mp, m.target, 2.2, dt);
    }
    // 애니: 팔 흔들 + 고개
    m.armL.rotation.x = Math.sin(time * (m.state === 'chase' ? 9 : 3)) * 0.5;
    m.armR.rotation.x = -Math.sin(time * (m.state === 'chase' ? 9 : 3)) * 0.5;
    m.mesh.rotation.y = Math.atan2(-(m.target.x - mp.x), -(m.target.z - mp.z));
    return dist;
  }
  moveMonster(mp, target, sp, dt) {
    const dx = target.x - mp.x, dz = target.z - mp.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = mp.x + (dx / l) * sp * dt, nz = mp.z + (dz / l) * sp * dt;
    const probe = (x, z) => {
      const b = new THREE.Box3(new THREE.Vector3(x - 0.4, 0, z - 0.4), new THREE.Vector3(x + 0.4, 2.5, z + 0.4));
      for (const c of this.colliders) if (b.intersectsBox(c)) return true;
      return false;
    };
    if (!probe(nx, mp.z)) mp.x = nx;
    if (!probe(mp.x, nz)) mp.z = nz;
  }

  die() {
    if (this.over) return;
    this.over = true;
    Sfx.scream();
    this.drawScare();
    document.getElementById('jumpscare').classList.remove('hidden');
    const ms = Math.round(performance.now() - this.startT);
    fetch('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('hr_token') }, body: JSON.stringify({ win: false, timeMs: ms }) });
    setTimeout(() => {
      document.getElementById('jumpscare').classList.add('hidden');
      document.getElementById('end-title').textContent = '💀 잡혔다...';
      document.getElementById('end-title').style.color = '#c00';
      document.getElementById('end-sub').textContent = `버틴 시간 ${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')} · 쪽지 ${this.pages}/8`;
      document.getElementById('end-screen').classList.remove('hidden');
      document.exitPointerLock();
    }, 1500);
  }
  win() {
    if (this.over) return;
    this.over = true;
    const ms = Math.round(performance.now() - this.startT);
    Sfx.pickup();
    fetch('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('hr_token') }, body: JSON.stringify({ win: true, timeMs: ms }) });
    document.getElementById('end-title').textContent = '🎉 탈출 성공!';
    document.getElementById('end-title').style.color = '#7CFC00';
    document.getElementById('end-sub').textContent = `기록 ${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    document.getElementById('end-screen').classList.remove('hidden');
    document.exitPointerLock();
  }
  drawScare() {
    const cv = document.getElementById('scare-canvas');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 600, 600);
    ctx.fillStyle = '#cfc4b4';
    ctx.beginPath(); ctx.ellipse(300, 300, 170, 220, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(225, 240, 45, 70, 0.2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(375, 240, 45, 70, -0.2, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(225, 250, 12, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(375, 250, 12, 0, 7); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(300, 420, 70, 95, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#a00'; ctx.lineWidth = 6;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(150 + Math.random() * 300, 0);
      ctx.lineTo(150 + Math.random() * 300, 600); ctx.stroke();
    }
  }

  loop() {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = performance.now() / 1000;
    if (!this.over && document.pointerLockElement === this.canvas) {
      // 이동
      const sprint = (this.keys.ShiftLeft || this.keys.ShiftRight) && this.stamina > 1;
      const sp = sprint ? 8 : 4.6;
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const mv = new THREE.Vector3();
      if (this.keys.KeyW) mv.add(f); if (this.keys.KeyS) mv.sub(f);
      if (this.keys.KeyD) mv.add(r); if (this.keys.KeyA) mv.sub(r);
      const moving = mv.length() > 0;
      if (moving) {
        mv.normalize();
        const nx = this.pos.x + mv.x * sp * dt, nz = this.pos.z + mv.z * sp * dt;
        if (!this.collide(nx, this.pos.z)) this.pos.x = nx;
        if (!this.collide(this.pos.x, nz)) this.pos.z = nz;
        this.noise = sprint ? 1 : 0.3;
        if (sprint) this.stamina = Math.max(0, this.stamina - 22 * dt);
        this.stepT -= dt;
        if (this.stepT <= 0) { this.stepT = sprint ? 0.3 : 0.45; Sfx.step(); }
      } else {
        this.noise = Math.max(0, this.noise - dt * 2);
        this.stamina = Math.min(100, this.stamina + 14 * dt);
      }
      // 손전등 배터리
      if (this.lightOn && this.battery > 0) this.battery = Math.max(0, this.battery - dt * 1.1);
      // 탈출 체크
      if (this.pages >= 8 && Math.hypot(this.pos.x - 0, this.pos.z - 50) < 4) { this.win(); }
      // 괴물
      const dist = this.updateMonster(dt, time);
      // 심장박동 + 정적
      if (dist < 25) {
        const rate = 60 + (25 - dist) * 5;
        this.heartT -= dt;
        if (this.heartT <= 0) { this.heartT = 60 / rate; Sfx.heart(rate); }
        document.getElementById('static').style.opacity = Math.min(0.85, (25 - dist) / 25 * 0.9);
        document.getElementById('vignette').style.opacity = 0.4 + (25 - dist) / 25 * 0.6;
      } else {
        document.getElementById('static').style.opacity = 0;
        document.getElementById('vignette').style.opacity = 0.4;
      }
      // HUD
      document.getElementById('st-fill').style.width = this.stamina + '%';
      this.updateTop();
      // 상호작용 팁
      let tip = null;
      for (const p of this.papers) {
        if (!p.taken && p.mesh.position.distanceTo(new THREE.Vector3(this.pos.x, 0, this.pos.z)) < 2.5) { tip = 'E: 쪽지 줍기'; break; }
      }
      if (!tip) for (const b of this.batteries) {
        if (!b.taken && b.mesh.position.distanceTo(new THREE.Vector3(this.pos.x, 0, this.pos.z)) < 2.5) { tip = 'E: 배터리'; break; }
      }
      const tipEl = document.getElementById('interact-tip');
      if (tip) { tipEl.textContent = tip; tipEl.classList.remove('hidden'); } else tipEl.classList.add('hidden');
    }
    // 카메라 + 손전등
    this.camera.position.copy(this.pos);
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotation.y = this.yaw; this.camera.rotation.x = this.pitch;
    const flick = this.mon && this.mon.mesh.position.distanceTo(this.pos) < 12 ? (Math.random() < 0.25 ? 0.4 : 1.6) : 1.6;
    this.flash.intensity = (this.lightOn && this.battery > 0) ? 2.2 * flick : 0;
    const fd = new THREE.Vector3(); this.camera.getWorldDirection(fd);
    this.flash.position.copy(this.pos);
    this.flashTarget.position.copy(this.pos).addScaledVector(fd, 12);
    // 복도등 깜빡임
    for (const l of this.lamps) {
      const f = Math.sin(time * 13 + l.seed) > 0.86 ? 0.15 : 0.7;
      l.li.intensity = f;
      l.bulb.material.color.setScalar(0.4 + f);
    }
    // 쪽지 살짝 반짝임
    for (const p of this.papers) if (!p.taken) p.mesh.rotation.y += dt * 0.8;
    this.renderer.render(this.scene, this.camera);
  }
}
