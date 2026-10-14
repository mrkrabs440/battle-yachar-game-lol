import * as THREE from 'three';

// GTA풍 오픈월드 난투: 3인칭, 주먹/칼, 운전, 시민NPC
const CAR_SPAWNS = [
  { x: -30, z: -30 }, { x: 30, z: 30 }, { x: -30, z: 30 }, { x: 30, z: -30 },
  { x: 0, z: -60 }, { x: 0, z: 60 }, { x: -60, z: 0 }, { x: 60, z: 0 },
];
const CAR_COLORS = [0xc0392b, 0x2980b9, 0xf1c40f, 0x27ae60, 0x8e44ad, 0xe67e22, 0xecf0f1, 0x34495e];

const Sfx = {
  ctx: null, master: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);
    } catch (e) {}
  },
  tone(f, dur, type = 'square', vol = 0.2, slide = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, vol = 0.3, freq = 2000) {
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
  punch() { this.noise(0.1, 0.35, 600); this.tone(120, 0.08, 'sine', 0.25, 60); },
  swing() { this.noise(0.08, 0.12, 4000); },
  stab() { this.noise(0.07, 0.25, 5000); this.tone(800, 0.05, 'sawtooth', 0.15, 300); },
  cash() { this.tone(900, 0.07, 'sine', 0.2); setTimeout(() => this.tone(1350, 0.1, 'sine', 0.2), 70); },
  hurt() { this.noise(0.15, 0.3, 500); },
  kill() { this.tone(700, 0.08, 'sine', 0.25); setTimeout(() => this.tone(1050, 0.12, 'sine', 0.28), 90); },
  thud() { this.noise(0.2, 0.35, 300); },
  beep() { this.tone(1000, 0.07, 'sine', 0.15); },
};

export class WorldGame {
  constructor({ canvas, socket, room, nick }) {
    this.canvas = canvas; this.socket = socket;
    this.room = room; this.nick = nick;
    this.team = 'solo:' + nick;
    this.disposed = false;
    this.keys = {};
    this.pos = new THREE.Vector3(0, 1.6, 0);
    this.yaw = 0; this.pitch = -0.15;
    this.hp = 100; this.alive = true;
    this.wi = 0; // 0 주먹 / 1 칼
    this.cash = 0; this.kills = 0; this.deaths = 0;
    this.wanted = 0; this.wantT = 0;
    this.attackCd = 0; this.punchN = 0; this.lastPunchSeen = new Map();
    this.remotes = new Map();
    this.peds = [];
    this.cars = [];
    this.driving = null; this.carSpeed = 0;
    this.colliders = [];
    this.runCd = new Map();
    this.netTimer = 0;
    this.vy = 0; this.blocking = false;
    this.comboN = 0; this.comboT = 0; this.kickCd = 0;
  }

  start() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffc98a); // 밝은 석양
    this.scene.fog = new THREE.Fog(0xffc98a, 70, 340);
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 600);
    this.scene.add(new THREE.HemisphereLight(0xffe8c3, 0x556655, 1.5));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xffd9a0, 1.4);
    sun.position.set(-80, 120, 40); sun.castShadow = true;
    sun.shadow.camera.left = -130; sun.shadow.camera.right = 130;
    sun.shadow.camera.top = 130; sun.shadow.camera.bottom = -130;
    this.scene.add(sun);

    this.buildCity();
    this.buildCars();
    this.me = this.makeSoldier('me');
    this.scene.add(this.me.mesh);
    this.spawnMe();
    this.spawnPeds();
    this.bindInputs();
    this.bindSocket();
    this.updateHUD();
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    this.log(`🌆 ${this.room.name} 입장! 차를 타고 패밀리를 노려라`, true);
  }
  dispose() { this.disposed = true; }

  // ============ 도시 ============
  addBox(x, y, z, w, h, d, color, collide = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    this.scene.add(m);
    if (collide) { m.updateMatrixWorld(); this.colliders.push(new THREE.Box3().setFromObject(m)); }
    return m;
  }
  buildCity() {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshLambertMaterial({ color: 0x3d5a3d }));
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true; this.scene.add(g);
    // 도로 격자
    const roadM = new THREE.MeshLambertMaterial({ color: 0x2c2c30 });
    for (const c of [-60, -20, 20, 60]) {
      for (const o of [-100, -60, -20, 20, 60, 100]) {
        const r1 = new THREE.Mesh(new THREE.PlaneGeometry(10, 36), roadM);
        r1.rotation.x = -Math.PI / 2; r1.position.set(c, 0.05, o); this.scene.add(r1);
        const r2 = new THREE.Mesh(new THREE.PlaneGeometry(36, 10), roadM);
        r2.rotation.x = -Math.PI / 2; r2.position.set(o, 0.05, c); this.scene.add(r2);
      }
    }
    // 건물 블록
    const cols = [0x8a7a6a, 0x6a7a8a, 0x9a6a5a, 0x7a8a6a, 0xa08a5a, 0x5a6a7a];
    let bi = 0;
    for (let bx = -80; bx <= 80; bx += 40) {
      for (let bz = -80; bz <= 80; bz += 40) {
        if (Math.abs(bx) % 60 < 20 && Math.abs(bz) % 60 < 20) continue; // 도로
        if (Math.random() < 0.15) { // 공원
          this.addTree(bx + 8, bz + 5); this.addTree(bx - 6, bz - 8);
          continue;
        }
        const w = 14 + Math.random() * 8, d = 14 + Math.random() * 8, h = 10 + Math.random() * 30;
        this.addBox(bx, h / 2, bz, w, h, d, cols[bi++ % cols.length]);
        this.addBox(bx, h + 0.5, bz, w + 1, 1, d + 1, 0x444444); // 옥상
        // 창문 (발광 strip)
        for (let wy = 4; wy < h - 1; wy += 4) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 1.2, d + 0.2), new THREE.MeshBasicMaterial({ color: 0xffe28a }));
          win.position.set(bx, wy, bz); this.scene.add(win);
        }
      }
    }
    // 가로등 + 야자 + 소품
    for (let i = -100; i <= 100; i += 20) {
      this.addLamp(i, -14); this.addLamp(i, 14); this.addLamp(-14, i); this.addLamp(14, i);
    }
    for (let i = 0; i < 12; i++) this.addPalm((Math.random() - 0.5) * 200, (Math.random() - 0.5) * 200);
    for (let i = 0; i < 10; i++) this.addBox((Math.random() - 0.5) * 180, 0.6, (Math.random() - 0.5) * 180, 2, 1.2, 2, 0xd35400); // 박스
  }
  addTree(x, z) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 4), new THREE.MeshLambertMaterial({ color: 0x5a3d1e }));
    t.position.set(x, 2, z); t.castShadow = true; this.scene.add(t);
    const l = new THREE.Mesh(new THREE.SphereGeometry(2.4), new THREE.MeshLambertMaterial({ color: 0x2d6a2d }));
    l.position.set(x, 5.5, z); l.castShadow = true; this.scene.add(l);
    t.updateMatrixWorld(); this.colliders.push(new THREE.Box3().setFromObject(t));
  }
  addPalm(x, z) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 7), new THREE.MeshLambertMaterial({ color: 0x7a5c30 }));
    t.position.set(x, 3.5, z); t.castShadow = true; this.scene.add(t);
  }
  addLamp(x, z) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 7), new THREE.MeshLambertMaterial({ color: 0x333333 }));
    p.position.set(x, 3.5, z); this.scene.add(p);
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.35), new THREE.MeshBasicMaterial({ color: 0xffe28a }));
    b.position.set(x, 7.1, z); this.scene.add(b);
    p.updateMatrixWorld(); this.colliders.push(new THREE.Box3().setFromObject(p));
  }

  // ============ 차량 ============
  buildCarMesh(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.9, 4.4), new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.85; body.castShadow = true; g.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 2.2), new THREE.MeshLambertMaterial({ color: 0x223344 }));
    cab.position.set(0, 1.6, -0.2); cab.castShadow = true; g.add(cab);
    const wg = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10);
    const wm = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const wheels = [];
    for (const [x, z] of [[-1, 1.4], [1, 1.4], [-1, -1.4], [1, -1.4]]) {
      const w = new THREE.Mesh(wg, wm);
      w.rotation.z = Math.PI / 2; w.position.set(x, 0.42, z); g.add(w); wheels.push(w);
    }
    return { g, wheels };
  }
  buildCars() {
    CAR_SPAWNS.forEach((s, i) => {
      const { g, wheels } = this.buildCarMesh(CAR_COLORS[i % CAR_COLORS.length]);
      const yaw = (i % 4) * Math.PI / 2;
      g.position.set(s.x, 0, s.z); g.rotation.y = yaw;
      this.scene.add(g);
      this.cars.push({ idx: i, mesh: g, wheels, x: s.x, z: s.z, yaw, driver: null });
      const col = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2, 4.6), new THREE.MeshBasicMaterial({ visible: false }));
      col.position.set(s.x, 1, s.z); col.rotation.y = yaw; col.updateMatrixWorld();
      this.scene.add(col);
      this.cars[i].colBox = new THREE.Box3().setFromObject(col); this.scene.remove(col);
      this.colliders.push(this.cars[i].colBox);
    });
  }
  refreshCarCollider(i) {
    const c = this.cars[i];
    c.colBox.setFromCenterAndSize(new THREE.Vector3(c.x, 1, c.z), new THREE.Vector3(4.6, 2, 4.6));
  }

  // ============ 병사 (자신+타인+시민 공용) ============
  makeSoldier(kind, opt = {}) {
    const uni = opt.shirt || (kind === 'me' ? 0x27ae60 : kind === 'ped' ? 0x777777 : 0x2e4a68);
    const pants = opt.pants !== undefined ? opt.pants : 0x2c3e50;
    const skin = new THREE.MeshLambertMaterial({ color: 0xd9a066 });
    const uniM = new THREE.MeshLambertMaterial({ color: uni });
    const pantsM = new THREE.MeshLambertMaterial({ color: pants });
    const darkM = new THREE.MeshLambertMaterial({ color: 0x191919 });
    const shoeM = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
    const hairM = new THREE.MeshLambertMaterial({ color: opt.hair !== undefined ? opt.hair : 0x1a1a1a });
    const root = new THREE.Group();
    const B = (w, h, d, m, x, y, z) => {
      const ms = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      ms.position.set(x, y, z); ms.castShadow = true; return ms;
    };
    root.add(B(0.32, 0.2, 0.2, pantsM, 0, 0.95, 0)); // 골반 (바지)
    const mkLeg = (sx) => {
      const hip = new THREE.Group(); hip.position.set(0.11 * sx, 0.88, 0); root.add(hip);
      hip.add(B(0.14, 0.42, 0.15, pantsM, 0, -0.21, 0)); // 허벅지 바지
      const knee = new THREE.Group(); knee.position.set(0, -0.42, 0); hip.add(knee);
      knee.add(B(0.12, 0.36, 0.13, pantsM, 0, -0.18, 0));
      knee.add(B(0.15, 0.11, 0.3, shoeM, 0, -0.4, -0.04)); // 운동화
      return { hip, knee };
    };
    const legL = mkLeg(-1), legR = mkLeg(1);
    const torsoG = new THREE.Group(); torsoG.position.set(0, 1.05, 0); root.add(torsoG);
    torsoG.add(B(0.38, 0.58, 0.24, uniM, 0, 0.3, 0)); // 슬림 상체
    torsoG.add(B(0.06, 0.5, 0.02, darkM, 0, 0.3, -0.13)); // 지퍼선
    const headG = new THREE.Group(); headG.position.set(0, 0.68, 0); torsoG.add(headG);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), skin);
    head.position.y = 0.08; head.castShadow = true; headG.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.148, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairM);
    hair.position.y = 0.095; headG.add(hair); // 헤어
    headG.add(B(0.1, 0.05, 0.02, darkM, 0, 0.09, -0.13)); // 눈썹/선글라스선
    const mkArm = (sx) => {
      const sh = new THREE.Group(); sh.position.set(0.27 * sx, 0.52, 0); torsoG.add(sh);
      sh.add(B(0.11, 0.32, 0.12, uniM, 0, -0.16, 0));
      const el = new THREE.Group(); el.position.set(0, -0.32, 0); sh.add(el);
      el.add(B(0.1, 0.3, 0.11, uniM, 0, -0.15, 0));
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), skin);
      hand.position.set(0, -0.32, 0); el.add(hand);
      return { sh, el };
    };
    const armL = mkArm(-1), armR = mkArm(1);
    // 손 무기: 주먹(없음) / 칼
    const knife = new THREE.Group();
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.4), new THREE.MeshLambertMaterial({ color: 0xcccccc }));
    bl.position.set(0, -0.32, -0.25); armR.el.add(bl);
    knife.visible = false;
    return {
      mesh: root, torsoG, headG, armL, armR, legL, legR, knife,
      mats: [uniM],
      targetPos: new THREE.Vector3(), lastPos: new THREE.Vector3(),
      yaw: 0, headPitch: 0, targetPitch: 0, hp: 100, alive: true,
      blocking: false, airborne: false,
      phase: Math.random() * 6, punchT: 0, deadT: 0, speed: 0, airborne: false,
    };
  }
  makePlate(nickname, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
    spr.scale.set(1.7, 0.42, 1);
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${nickname.length > 8 ? 24 : 30}px "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center'; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(nickname, 128, 32); ctx.fillStyle = color; ctx.fillText(nickname, 128, 32);
    tex.needsUpdate = true;
    this.scene.add(spr);
    return spr;
  }

  animateSoldier(r, dt, time, punching = false) {
    const m = r.mesh;
    if (!r.alive) {
      if (r.deadT > 0) {
        r.deadT -= dt;
        m.rotation.x += ((-Math.PI / 2) - m.rotation.x) * Math.min(1, dt * 7);
        if (r.deadT <= 0) m.visible = false;
      }
      return;
    }
    m.rotation.x += (0 - m.rotation.x) * Math.min(1, dt * 10);
    const dx = m.position.x - r.lastPos.x, dz = m.position.z - r.lastPos.z;
    const spd = dt > 0 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;
    r.speed += (spd - r.speed) * Math.min(1, dt * 8);
    r.lastPos.copy(m.position);
    const moving = r.speed > 0.8;
    if (moving) r.phase += dt * (4 + r.speed * 1.1);
    const sw = moving ? Math.sin(r.phase) * Math.min(0.7, 0.3 + r.speed * 0.06) : 0;
    r.legL.hip.rotation.x = sw; r.legR.hip.rotation.x = -sw;
    r.legL.knee.rotation.x = moving ? -(Math.max(0, -Math.sin(r.phase)) * 1.0) - 0.05 : -0.05;
    r.legR.knee.rotation.x = moving ? -(Math.max(0, Math.sin(r.phase)) * 1.0) - 0.05 : -0.05;
    // 공중 자세 (히스테리시스)
    if (!r.airborne && m.position.y > 0.3) r.airborne = true;
    else if (r.airborne && m.position.y < 0.12) r.airborne = false;
    if (r.airborne) {
      r.legL.hip.rotation.x = -0.5; r.legR.hip.rotation.x = -0.25;
      r.legL.knee.rotation.x = -1.3; r.legR.knee.rotation.x = -1.1;
    }
    const breathe = Math.sin(time * 2 + r.phase) * 0.03;
    if (r.blocking) { // 막기: 양팔 교차 가드
      r.armL.sh.rotation.x = 1.1; r.armR.sh.rotation.x = 1.1;
      r.armL.sh.rotation.z = 0.7; r.armR.sh.rotation.z = -0.7;
      r.armL.el.rotation.x = -1.4; r.armR.el.rotation.x = -1.4;
    } else if (punching || r.punchT > 0) { // 펀치: 오른팔 전방 스트레이트
      if (r.punchT > 0) r.punchT -= dt;
      r.armR.sh.rotation.x = 1.5; r.armR.el.rotation.x = -0.1;
      r.armL.sh.rotation.x = 0.6 + breathe; r.armL.el.rotation.x = -0.9;
    } else {
      r.armL.sh.rotation.x = 0.25 + sw * 0.4 + breathe;
      r.armR.sh.rotation.x = 0.25 - sw * 0.4 + breathe;
      r.armL.el.rotation.x = -0.5; r.armR.el.rotation.x = -0.5;
    }
    r.armL.sh.rotation.z = 0.15; r.armR.sh.rotation.z = -0.15;
    r.torsoG.rotation.x = moving ? -0.09 : -0.02 + breathe * 0.4;
    r.torsoG.position.y = 1.05 + (moving ? Math.abs(Math.cos(r.phase)) * 0.045 : breathe * 0.5);
    r.headG.rotation.x = r.headPitch * 0.4;
    m.rotation.y = r.yaw || 0;
  }

  spawnMe() {
    const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 40;
    this.pos.set(Math.cos(a) * r, 1.6, Math.sin(a) * r);
    this.hp = 100; this.alive = true;
    this.me.mesh.visible = true; this.me.mesh.rotation.x = 0;
    this.me.deadT = 0;
  }
  spawnPeds() {
    const shirts = [0xc0392b, 0x2980b9, 0xf1c40f, 0x8e44ad, 0xe67e22, 0x1abc9c, 0xecf0f1, 0xfd79a8];
    const hairs = [0x1a1a1a, 0x4a2c0a, 0x777777, 0x8a5a00];
    for (let i = 0; i < 8; i++) {
      const r = this.makeSoldier('ped', { shirt: shirts[i % shirts.length], pants: 0x34495e, hair: hairs[i % hairs.length] });
      r.isPed = true;
      r.hp = 30; r.alive = true;
      r.mesh.position.set((Math.random() - 0.5) * 160, 0, (Math.random() - 0.5) * 160);
      r.lastPos.copy(r.mesh.position);
      r.targetPos = r.mesh.position.clone();
      r.fleeT = 0;
      this.scene.add(r.mesh);
      this.peds.push(r);
    }
  }

  // ============ 입력 ============
  bindInputs() {
    this.kd = (e) => {
      if (e.code === 'Enter' && e.type === 'keydown') { this.toggleChat(); return; }
      this.keys[e.code] = e.type === 'keydown';
      if (e.code === 'KeyF') this.blocking = e.type === 'keydown' && this.driving === null && this.alive;
      if (e.type !== 'keydown' || e.repeat) return;
      if (e.code === 'Digit1') { this.wi = 0; Sfx.beep(); this.updateHUD(); }
      if (e.code === 'Digit2') { this.wi = 1; Sfx.beep(); this.updateHUD(); }
      if (e.code === 'KeyG') this.kickAttack();
      if (e.code === 'KeyE') this.tryCar();
    };
    this.ku = this.kd;
    addEventListener('keydown', this.kd); addEventListener('keyup', this.ku);
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.0025;
      this.pitch -= e.movementY * 0.002;
      this.pitch = Math.max(-1.1, Math.min(0.6, this.pitch));
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this.canvas) { this.canvas.requestPointerLock(); return; }
      if (e.button === 0) this.tryAttack();
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
    document.getElementById('btn-leave').onclick = () => { this.socket.emit('room:leave'); location.reload(); };
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) this.socket.emit('chat:msg', { text: v });
        e.target.value = ''; e.target.classList.add('hidden'); this.chatOpen = false;
        this.canvas.requestPointerLock();
      }
    });
    window.onresize = () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    };
  }
  toggleChat() {
    const inp = document.getElementById('chat-input');
    if (!this.chatOpen) { document.exitPointerLock(); inp.classList.remove('hidden'); inp.focus(); this.chatOpen = true; }
  }

  // ============ 전투 ============
  tryAttack() {
    if (!this.alive || this.driving !== null || this.blocking) return;
    const now = performance.now();
    const cd = this.wi === 0 ? 450 : 650;
    if (now - (this.lastAtk || 0) < cd) return;
    this.lastAtk = now;
    this.punchN++;
    this.me.punchT = 0.28;
    const range = this.wi === 0 ? 2.3 : 2.7, dmg = this.wi === 0 ? 12 : 35;
    if (this.wi === 0) Sfx.swing(); else Sfx.stab();
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const origin = this.pos.clone();
    let best = null, bestD = range, bestKind = null;
    const consider = (name, pos, kind, ref) => {
      const to = new THREE.Vector3(pos.x - origin.x, 0, pos.z - origin.z);
      const d = to.length();
      if (d < bestD && fwd.angleTo(to.normalize()) < 0.65) { bestD = d; best = name; bestKind = kind; ref && (this._ref = ref); }
    };
    for (const [n, r] of this.remotes) {
      if (!r.alive) continue;
      if (r.driving != null) continue; // 차 탄 적 패스
      consider(n, r.mesh.position, 'remote', r);
    }
    for (let i = 0; i < this.peds.length; i++) {
      const pd = this.peds[i];
      if (pd.alive) consider('ped' + i, pd.mesh.position, 'ped', pd);
    }
    if (best) {
      const now2 = performance.now();
      this.comboN = (now2 - this.comboT < 2500) ? this.comboN + 1 : 1;
      this.comboT = now2;
      const third = this.comboN >= 3;
      if (third) this.comboN = 0;
      const finalDmg = Math.round(dmg * (third ? 1.5 : 1));
      Sfx.punch();
      this.showHit();
      if (third) this.feed('🥊 3연타 강타!');
      else if (this.comboN === 2) this.feed('🥊 2연타!');
      if (bestKind === 'ped') {
        const pd = this._ref;
        pd.hp -= finalDmg; pd.fleeT = 6;
        if (third) this.knockback(pd.mesh.position, this.pos, 1.6);
        if (pd.hp <= 0 && pd.alive) {
          pd.alive = false; pd.deadT = 1.2;
          this.cash += 50; this.kills++;
          this.wanted = Math.min(5, this.wanted + 1); this.wantT = 20;
          this.feed(`👊 ${this.nick} → 시민 (+$50)`);
          Sfx.cash();
          setTimeout(() => {
            if (this.disposed) return;
            pd.hp = 30; pd.alive = true; pd.mesh.visible = true; pd.mesh.rotation.x = 0;
            pd.mesh.position.set((Math.random() - 0.5) * 160, 0, (Math.random() - 0.5) * 160);
          }, 8000);
        }
        this.updateHUD();
      } else {
        const r = this._ref;
        if (r.isBot) {
          r.hp -= finalDmg;
          if (third) this.knockback(r.mesh.position, this.pos, 1.6);
          if (r.hp <= 0 && r.alive) {
            r.alive = false; r.deadT = 1.2;
            this.cash += 100; this.kills++; Sfx.kill();
            this.feed(`👊 ${this.nick} [${this.wi === 0 ? '주먹' : '칼'}] → ${best}`);
            setTimeout(() => { if (this.disposed) return; r.hp = 100; r.alive = true; r.mesh.visible = true; r.mesh.rotation.x = 0; }, 2000);
          }
        } else {
          this.socket.emit('player:hit', { target: best, damage: finalDmg, weapon: this.wi === 0 ? '주먹👊' : '칼🔪' });
        }
      }
    }
  }
  knockback(targetPos, fromPos, dist) {
    const dx = targetPos.x - fromPos.x, dz = targetPos.z - fromPos.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = targetPos.x + (dx / l) * dist, nz = targetPos.z + (dz / l) * dist;
    if (!this.collide(nx, targetPos.z, 0.4)) targetPos.x = nx;
    if (!this.collide(targetPos.x, nz, 0.4)) targetPos.z = nz;
  }
  // 강킥 (F): 긴 리치 + 넉백
  kickAttack() {
    if (!this.alive || this.driving !== null || this.blocking) return;
    const now = performance.now();
    if (now - this.kickCd < 1100) return;
    this.kickCd = now;
    this.punchN++;
    this.me.punchT = 0.3;
    Sfx.swing();
    const range = 2.9, dmg = 20;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const origin = this.pos.clone();
    let best = null, bestD = range, bestKind = null;
    const consider = (name, pos, kind, ref) => {
      const to = new THREE.Vector3(pos.x - origin.x, 0, pos.z - origin.z);
      const d = to.length();
      if (d < bestD && fwd.angleTo(to.normalize()) < 0.7) { bestD = d; best = name; bestKind = kind; ref && (this._ref = ref); }
    };
    for (const [n, r] of this.remotes) {
      if (!r.alive) continue;
      if (r.driving != null) continue;
      consider(n, r.mesh.position, 'remote', r);
    }
    for (let i = 0; i < this.peds.length; i++) {
      const pd = this.peds[i];
      if (pd.alive) consider('ped' + i, pd.mesh.position, 'ped', pd);
    }
    if (!best) return;
    Sfx.punch(); this.showHit();
    if (bestKind === 'ped') {
      const pd = this._ref;
      pd.hp -= dmg; pd.fleeT = 6;
      this.knockback(pd.mesh.position, this.pos, 2.2);
      if (pd.hp <= 0 && pd.alive) {
        pd.alive = false; pd.deadT = 1.2;
        this.cash += 50; this.kills++;
        this.wanted = Math.min(5, this.wanted + 1); this.wantT = 20;
        this.feed(`🦵 ${this.nick} → 시민 (+$50)`); Sfx.cash();
        setTimeout(() => {
          if (this.disposed) return;
          pd.hp = 30; pd.alive = true; pd.mesh.visible = true; pd.mesh.rotation.x = 0;
          pd.mesh.position.set((Math.random() - 0.5) * 160, 0, (Math.random() - 0.5) * 160);
        }, 8000);
      }
      this.updateHUD();
    } else {
      const r = this._ref;
      if (r.isBot) {
        r.hp -= dmg;
        this.knockback(r.mesh.position, this.pos, 2.2);
        if (r.hp <= 0 && r.alive) {
          r.alive = false; r.deadT = 1.2;
          this.cash += 100; this.kills++; Sfx.kill();
          this.feed(`🦵 ${this.nick} → ${best}`);
          setTimeout(() => { if (this.disposed) return; r.hp = 100; r.alive = true; r.mesh.visible = true; r.mesh.rotation.x = 0; }, 2000);
        }
      } else {
        this.socket.emit('player:hit', { target: best, damage: dmg, weapon: '강킥🦵' });
      }
    }
  }
  showHit() { const h = document.getElementById('hitmarker'); h.textContent = '✕'; h.style.opacity = 1; setTimeout(() => h.style.opacity = 0, 120); }

  onDeath(killer) {
    if (!this.alive) return;
    this.alive = false; this.blocking = false;
    if (this.driving !== null) this.exitCar();
    document.getElementById('death-by').textContent = killer ? `🔫 ${killer} 에게 당함` : '';
    document.getElementById('respawn-overlay').classList.remove('hidden');
    setTimeout(() => {
      if (this.disposed) return;
      this.spawnMe();
      document.getElementById('respawn-overlay').classList.add('hidden');
      this.updateHUD();
    }, 2000);
  }

  // ============ 차량 ============
  nearCar() {
    let bi = null, bd = 4;
    this.cars.forEach((c, i) => {
      if (c.driver) return;
      const d = Math.hypot(c.x - this.pos.x, c.z - this.pos.z);
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  }
  tryCar() {
    if (!this.alive) return;
    if (this.driving !== null) { this.exitCar(); return; }
    const i = this.nearCar();
    if (i !== null) this.socket.emit('car:take', { idx: i });
  }
  exitCar() {
    const i = this.driving;
    if (i === null) return;
    const c = this.cars[i];
    this.socket.emit('car:leave', { idx: i });
    c.driver = null;
    this.driving = null; this.carSpeed = 0;
    this.me.mesh.visible = true;
    this.pos.set(c.x + 2.5, 1.6, c.z);
    document.getElementById('speed').classList.add('hidden');
    this.updateHUD();
  }
  collide(x, z, half = 0.5) {
    const box = new THREE.Box3(new THREE.Vector3(x - half, 0, z - half), new THREE.Vector3(x + half, 1.7, z + half));
    for (const c of this.colliders) if (box.intersectsBox(c)) return true;
    return false;
  }
  updateDrive(dt) {
    const c = this.cars[this.driving];
    if (!c) { this.driving = null; return; }
    const acc = this.keys.KeyW ? 14 : 0, brk = this.keys.KeyS ? -10 : 0;
    this.carSpeed += (acc + brk) * dt;
    this.carSpeed -= this.carSpeed * 1.2 * dt;
    this.carSpeed = Math.max(-8, Math.min(24, this.carSpeed));
    if (Math.abs(this.carSpeed) > 0.5) {
      const steer = ((this.keys.KeyA ? 1 : 0) - (this.keys.KeyD ? 1 : 0)) * 1.4 * Math.sign(this.carSpeed);
      c.yaw += steer * dt * Math.min(1, Math.abs(this.carSpeed) / 8);
    }
    const nx = c.x - Math.sin(c.yaw) * this.carSpeed * dt;
    const nz = c.z - Math.cos(c.yaw) * this.carSpeed * dt;
    const probe = new THREE.Box3(new THREE.Vector3(nx - 1.1, 0, nz - 1.1), new THREE.Vector3(nx + 1.1, 1.7, nz + 1.1));
    let hit = Math.abs(nx) > 115 || Math.abs(nz) > 115;
    if (!hit) for (const b of this.colliders) { if (b === c.colBox) continue; if (probe.intersectsBox(b)) { hit = true; break; } }
    if (hit) { this.carSpeed *= -0.3; Sfx.thud(); }
    else { c.x = nx; c.z = nz; }
    c.mesh.position.set(c.x, 0, c.z); c.mesh.rotation.y = c.yaw;
    c.wheels.forEach(w => w.rotation.x += this.carSpeed * dt * 2);
    this.refreshCarCol(c);
    this.pos.set(c.x, 1.6, c.z); this.yaw = c.yaw;
    document.getElementById('speed').textContent = `${Math.abs(Math.round(this.carSpeed * 4))} km/h`;
    // 치어박기
    if (Math.abs(this.carSpeed) > 6) {
      const now = performance.now();
      for (const [n, r] of this.remotes) {
        if (!r.alive) continue;
        if (Math.hypot(r.mesh.position.x - c.x, r.mesh.position.z - c.z) < 2.3 && (now - (this.runCd.get(n) || 0)) > 800) {
          this.runCd.set(n, now);
          if (r.isBot) {
            r.hp -= 60;
            if (r.hp <= 0 && r.alive) { r.alive = false; r.deadT = 1.2; this.cash += 100; this.kills++; this.feed(`🚗 ${this.nick} → ${n}`); setTimeout(() => { if (this.disposed) return; r.hp = 100; r.alive = true; r.mesh.visible = true; r.mesh.rotation.x = 0; }, 2000); }
          } else this.socket.emit('player:hit', { target: n, damage: 55, weapon: '차량🚗' });
        }
      }
    }
  }
  refreshCarCol(c) {
    c.colBox.setFromCenterAndSize(new THREE.Vector3(c.x, 1, c.z), new THREE.Vector3(4.6, 2, 4.6));
  }

  // ============ 소켓 ============
  bindSocket() {
    const s = this.socket;
    ['room:players', 'player:move', 'player:killed', 'player:damaged', 'player:respawned', 'player:left', 'chat:msg', 'car:taken', 'car:free', 'car:state', 'cars:sync'].forEach(e => s.off(e));
    s.on('cars:sync', (d) => {
      if (!d || !d.holders) return;
      for (const [ci, who] of Object.entries(d.holders)) {
        const c = this.cars[+ci];
        if (c) c.driver = who;
      }
    });
    s.on('room:players', (list) => {
      const seen = new Set();
      list.forEach(p => {
        if (p.nickname === this.nick) { this.hp = p.hp; if (!p.alive && this.alive) this.onDeath(null); return; }
        seen.add(p.nickname);
        if (!this.remotes.has(p.nickname)) {
          const r = this.makeSoldier('foe');
          r.isBot = false;
          r.plate = this.makePlate(p.nickname, '#ff7777');
          r.mesh.position.set(p.pos.x, 0, p.pos.z); r.lastPos.copy(r.mesh.position);
          this.scene.add(r.mesh);
          this.remotes.set(p.nickname, r);
        }
        const r = this.remotes.get(p.nickname);
        r.targetPos.set(p.pos.x, p.fy || 0, p.pos.z); r.yaw = p.yaw;
        r.targetPitch = p.pitch || 0; r.wi = p.wi || 0; r.blocking = !!p.blocking;
        r.knife.visible = r.wi === 1;
        if (p.punch !== (r.lastPunch || 0)) { r.lastPunch = p.punch; r.punchT = 0.28; }
        this.setAlive(r, p.alive, p.hp);
      });
      for (const [k, r] of [...this.remotes]) {
        if (r.isBot || r.isPed) continue;
        if (!seen.has(k)) { this.scene.remove(r.mesh); this.scene.remove(r.plate); this.remotes.delete(k); }
      }
    });
    s.on('player:move', (p) => {
      if (!p || p.nickname === this.nick) return;
      if (!this.remotes.has(p.nickname)) {
        const r = this.makeSoldier('foe');
        r.isBot = false;
        r.plate = this.makePlate(p.nickname, '#ff7777');
        r.mesh.position.set(p.pos.x, 0, p.pos.z); r.lastPos.copy(r.mesh.position);
        this.scene.add(r.mesh);
        this.remotes.set(p.nickname, r);
      }
      const r = this.remotes.get(p.nickname);
      r.targetPos.set(p.pos.x, p.fy || 0, p.pos.z); r.yaw = p.yaw;
      r.targetPitch = p.pitch || 0; r.wi = p.wi || 0; r.blocking = !!p.blocking;
      r.knife.visible = r.wi === 1;
      if (p.punch !== (r.lastPunch || 0)) { r.lastPunch = p.punch; r.punchT = 0.28; }
      if (p.driving !== undefined) r.driving = p.driving;
      this.setAlive(r, p.alive, p.hp);
    });
    s.on('player:killed', (d) => {
      this.feed(`☠ ${d.killer} [${d.weapon || ''}] → ${d.victim}`);
      if (d.victim === this.nick) { this.deaths++; this.onDeath(d.killer); }
      if (d.killer === this.nick) { this.kills++; this.cash += 100; Sfx.kill(); this.updateHUD(); }
    });
    s.on('player:damaged', (d) => {
      if (!d) return;
      if (d.target === this.nick) { this.hp = d.hp; this.updateHUD(); Sfx.hurt(); }
    });
    s.on('player:respawned', (d) => {
      if (d.nickname === this.nick) { this.spawnMe(); document.getElementById('respawn-overlay').classList.add('hidden'); this.updateHUD(); }
      else { const r = this.remotes.get(d.nickname); if (r) { r.hp = 100; this.setAlive(r, true, 100); } }
    });
    s.on('player:left', (d) => {
      const r = this.remotes.get(d.nickname);
      if (r) { this.scene.remove(r.mesh); this.scene.remove(r.plate); this.remotes.delete(d.nickname); }
      this.feed(`◀ ${d.nickname} 퇴장`);
    });
    s.on('car:taken', (d) => {
      const c = this.cars[d.idx]; if (!c) return;
      if (d.by === this.nick) {
        c.driver = this.nick; this.driving = d.idx; this.carSpeed = 0;
        this.blocking = false;
        this.me.mesh.visible = false;
        document.getElementById('speed').classList.remove('hidden');
        this.feed('🚗 운전 시작! (E 하차)');
      } else c.driver = d.by;
      this.updateHUD();
    });
    s.on('car:free', (d) => {
      const c = this.cars[d.idx]; if (c) c.driver = null;
    });
    s.on('car:state', (d) => {
      const c = this.cars[d.idx]; if (!c) return;
      c.x = d.x; c.z = d.z; c.yaw = d.yaw;
      c.mesh.position.set(c.x, 0, c.z); c.mesh.rotation.y = c.yaw;
      this.refreshCarCol(c);
    });
    s.on('chat:msg', (d) => this.log(d.sys ? d.text : `${d.nickname}: ${d.text}`, d.sys));
  }
  setAlive(r, alive, hp) {
    r.hp = hp;
    if (alive) { r.deadT = 0; r.mesh.visible = true; r.mesh.rotation.x = 0; }
    else if (r.alive && !alive) { r.deadT = 1.5; }
    else if (!alive && r.deadT <= 0) r.mesh.visible = false;
    r.alive = alive;
  }

  // ============ HUD ============
  updateHUD() {
    document.getElementById('weapon-name').textContent = this.blocking ? '🛡 방어중' : this.wi === 0 ? '👊 주먹' : '🔪 칼';
    document.getElementById('hp-fill').style.width = Math.max(0, this.hp) + '%';
    document.getElementById('hp-text').textContent = Math.max(0, Math.round(this.hp));
    document.getElementById('cash').textContent = `💵 $${this.cash} · ${this.kills}킬`;
    let st = '';
    for (let i = 0; i < 5; i++) st += i < this.wanted ? '★' : '☆';
    document.getElementById('wanted').textContent = st;
    document.getElementById('match-info').textContent = `${this.room.name} · ${this.kills}킬`;
  }
  feed(t) {
    const d = document.createElement('div'); d.textContent = t;
    const kf = document.getElementById('killfeed'); kf.prepend(d);
    while (kf.children.length > 6) kf.lastChild.remove();
  }
  log(t, sys) {
    const d = document.createElement('div'); d.textContent = t;
    if (sys) d.style.color = '#c77dff';
    const cl = document.getElementById('chat-log'); cl.appendChild(d);
    while (cl.children.length > 30) cl.firstChild.remove();
  }
  drawMinimap() {
    const c = document.getElementById('minimap'); if (!c) return;
    const ctx = c.getContext('2d');
    const to = (x, z) => [80 + (x / 240) * 160, 80 + (z / 240) * 160];
    ctx.fillStyle = '#10200f'; ctx.fillRect(0, 0, 160, 160);
    ctx.strokeStyle = '#333'; ctx.strokeRect(20, 20, 120, 120);
    this.cars.forEach(car => {
      const [mx, mz] = to(car.x, car.z);
      ctx.fillStyle = car.driver ? '#ff0000' : '#ffdd00';
      ctx.fillRect(mx - 2, mz - 2, 4, 4);
    });
    for (const [, r] of this.remotes) {
      if (!r.alive) continue;
      const [mx, mz] = to(r.mesh.position.x, r.mesh.position.z);
      ctx.fillStyle = '#ff4444'; ctx.fillRect(mx - 2, mz - 2, 4, 4);
    }
    const [px, pz] = to(this.pos.x, this.pos.z);
    ctx.fillStyle = '#00ff00'; ctx.beginPath(); ctx.arc(px, pz, 4, 0, 7); ctx.fill();
  }

  // ============ 메인 루프 ============
  loop() {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const now = performance.now(), time = now / 1000;
    const locked = document.pointerLockElement === this.canvas;

    // 이동 (3인칭 카메라 기준)
    this.isMoving = false;
    if (this.alive && locked && this.driving === null) {
      const spBase = (this.keys.ShiftLeft || this.keys.ShiftRight) ? 8 : 5;
      const sp = this.blocking ? spBase * 0.55 : spBase;
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const mv = new THREE.Vector3();
      if (this.keys.KeyW) mv.add(f); if (this.keys.KeyS) mv.sub(f);
      if (this.keys.KeyD) mv.add(r); if (this.keys.KeyA) mv.sub(r);
      this.isMoving = mv.length() > 0;
      if (this.isMoving) {
        mv.normalize();
        const step = mv.multiplyScalar(sp * dt);
        if (!this.collide(this.pos.x + step.x, this.pos.z)) this.pos.x += step.x;
        if (!this.collide(this.pos.x, this.pos.z + step.z)) this.pos.z += step.z;
        this.pos.x = Math.max(-115, Math.min(115, this.pos.x));
        this.pos.z = Math.max(-115, Math.min(115, this.pos.z));
        // 이동 방향으로 몸 회전 (정지면 카메라 방향)
        this.me.yaw = Math.atan2(-step.x, -step.z);
      } else {
        this.me.yaw = this.yaw;
      }
    }
    if (this.driving !== null && this.alive && locked) this.updateDrive(dt);

    // 점프/중력 (Space)
    if (this.alive && locked && this.driving === null) {
      if (this.keys.Space && this.pos.y <= 1.61) { this.vy = 5.2; Sfx.beep(); }
      this.vy -= 14 * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= 1.6) { this.pos.y = 1.6; this.vy = 0; }
    }

    // 카메라 (3인칭)
    if (this.driving !== null) {
      const c = this.cars[this.driving];
      const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
      this.camera.position.set(c.x - fx * 8, 3.4, c.z - fz * 8);
      this.camera.lookAt(c.x, 1.4, c.z);
    } else {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const cd = 4.6, ch = 2.3 + this.pitch * -1.5;
      this.camera.position.set(this.pos.x - fx * cd, this.pos.y + ch, this.pos.z - fz * cd);
      this.camera.lookAt(this.pos.x, this.pos.y - 0.2, this.pos.z);
    }

    // 자신 애니
    if (this.driving === null) {
      this.me.mesh.position.set(this.pos.x, 0, this.pos.z);
      this.me.headPitch = this.pitch;
      this.me.knife.visible = this.wi === 1;
      this.animateSoldier(this.me, dt, time, this.me.punchT > 0);
    }

    // 원격 보간+애니
    for (const [, r] of this.remotes) {
      if (r.isBot) continue;
      if (r.alive) {
        r.mesh.position.x += (r.targetPos.x - r.mesh.position.x) * 0.25;
        r.mesh.position.z += (r.targetPos.z - r.mesh.position.z) * 0.25;
        r.mesh.position.y += (r.targetPos.y - r.mesh.position.y) * Math.min(1, dt * 14);
      }
      if (r.driving !== null && r.driving !== undefined) {
        const c = this.cars[r.driving];
        r.mesh.visible = false;
        if (c && r.plate) {
          r.plate.position.set(c.x, 2.6, c.z);
          r.plate.visible = true;
        }
      } else {
        this.animateSoldier(r, dt, time, false);
        if (r.plate) {
          r.plate.position.set(r.mesh.position.x, 2.35, r.mesh.position.z);
          r.plate.visible = r.mesh.visible;
        }
      }
    }

    // 시민 AI
    for (const pd of this.peds) {
      if (!pd.alive) { this.animateSoldier(pd, dt, time); continue; }
      if (pd.fleeT > 0) {
        pd.fleeT -= dt;
        const away = pd.mesh.position.clone().sub(this.pos); away.y = 0;
        if (away.length() < 25) {
          away.normalize();
          const nx = pd.mesh.position.x + away.x * dt * 6, nz = pd.mesh.position.z + away.z * dt * 6;
          if (!this.collide(nx, nz, 0.4)) { pd.mesh.position.x = nx; pd.mesh.position.z = nz; }
          pd.yaw = Math.atan2(-away.x, -away.z);
          pd.targetPos.copy(pd.mesh.position);
        }
      } else {
        pd.wt = (pd.wt || 0) - dt;
        if (pd.wt <= 0) {
          pd.wt = 3 + Math.random() * 4;
          pd.targetPos.set((Math.random() - 0.5) * 180, 0, (Math.random() - 0.5) * 180);
        }
        const dir = pd.targetPos.clone().sub(pd.mesh.position); dir.y = 0;
        if (dir.length() > 2) {
          dir.normalize();
          const nx = pd.mesh.position.x + dir.x * dt * 2, nz = pd.mesh.position.z + dir.z * dt * 2;
          if (!this.collide(nx, nz, 0.4)) { pd.mesh.position.x = nx; pd.mesh.position.z = nz; }
          pd.yaw = Math.atan2(-dir.x, -dir.z);
        }
      }
      this.animateSoldier(pd, dt, time);
    }

    // 상호작용 팁
    const tip = document.getElementById('interact-tip');
    if (this.alive && this.driving === null && this.nearCar() !== null) { tip.textContent = 'E: 차량 탑승'; tip.classList.remove('hidden'); }
    else if (this.driving !== null) { tip.textContent = 'E: 하차 · WASD 운전'; tip.classList.remove('hidden'); }
    else tip.classList.add('hidden');

    // 수배 감소
    if (this.wanted > 0) {
      this.wantT -= dt;
      if (this.wantT <= 0) { this.wanted--; this.wantT = 20; this.updateHUD(); }
    }

    // 전송
    this.netTimer += dt;
    if (this.netTimer > 0.05) {
      this.netTimer = 0;
      const pkt = { pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z }, yaw: this.me?.yaw ?? this.yaw, pitch: this.pitch, wi: this.wi, punch: this.punchN, driving: this.driving, blocking: this.blocking && this.driving === null, fy: this.pos.y - 1.6 };
      if (this.driving !== null) {
        const c = this.cars[this.driving];
        pkt.car = { idx: this.driving, x: c.x, z: c.z, yaw: c.yaw };
      }
      this.socket.emit('player:state', pkt);
    }
    this.drawMinimap();
    this.renderer.render(this.scene, this.camera);
  }
}
