import * as THREE from 'three';

// 브레인롯 훔치기 클라이언트 (3인칭, 벨트 수집 + 기지 보관 + 훔치기 + 찰싹)
const RARITY_COL = { common: '#9e9e9e', epic: '#9d4edd', legendary: '#f5a623', mythic: '#ff2e63', secret: '#00f5d4' };
function beltPos(t) { return { x: -45 + t * 90, z: 0 }; }
function plotBasePos(idx) {
  const a = (idx / 8) * Math.PI * 2 + Math.PI / 8;
  return { x: Math.cos(a) * 52, z: Math.sin(a) * 52 };
}
function slotPos(plotIdx, slot) {
  const home = plotBasePos(plotIdx);
  const cx = home.x * 0.82, cz = home.z * 0.82;
  const col = slot % 3, row = Math.floor(slot / 3);
  return { x: cx + (col - 1) * 4.2, z: cz + (row - 0.5) * 4.2 };
}
const PLOT_COLS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xec87bf];

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
  tone(f, dur, type = 'square', vol = 0.2) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
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
  slap() { this.noise(0.09, 0.35, 900); this.tone(180, 0.08, 'sine', 0.25, 90); },
  cash() { this.tone(900, 0.07, 'sine', 0.2); setTimeout(() => this.tone(1350, 0.1, 'sine', 0.2), 70); },
  pickup() { this.tone(600, 0.08, 'triangle', 0.22); setTimeout(() => this.tone(900, 0.1, 'triangle', 0.22), 80); },
  steal() { this.tone(300, 0.12, 'sawtooth', 0.2, 600); },
  lock() { this.tone(400, 0.15, 'square', 0.2, 200); },
  step() { this.noise(0.04, 0.04, 700); },
};

export class BrainrotGame {
  constructor({ canvas, socket, user, plot, snap }) {
    this.canvas = canvas; this.socket = socket;
    this.user = user; this.plot = plot;
    this.nick = user.nickname;
    this.cash = user.cash || 0;
    this.disposed = false;
    this.keys = {};
    this.pos = new THREE.Vector3(0, 1.6, 40);
    this.yaw = Math.PI; this.pitch = -0.18;
    this.hp = 100;
    this.carrying = null; // item id
    this.remotes = new Map(); // nick -> {mesh..., carrying(key|null), slapT, yaw, targetPos}
    this.items = new Map(); // id -> {mesh, plate, data:{key,t?/x/z, state...}}
    this.bases = []; // {idx, owner, lockUntil, pads:[mesh], dome, tag}
    this.punchT = 0; this.lastSlap = 0;
    this.knockV = new THREE.Vector3();
    this.netT = 0; this.stepT = 0; this.mmT = 0;
    this.chatOpen = false;
    this.lockCdTxt = '';
    this.applySnap(snap);
  }

  applySnap(snap) {
    if (!snap) return;
    this._snapBelt = snap.belt || [];
    this._snapLoose = snap.loose || [];
    this._snapCarried = snap.carried || [];
    this._snapBases = snap.bases || [];
    this._snapPlayers = snap.players || [];
  }

  start() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a2340);
    this.scene.fog = new THREE.Fog(0x1a2340, 60, 220);
    this.camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 500);
    this.scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x334422, 1.1));
    const moon = new THREE.DirectionalLight(0xbfd0ff, 1.0);
    moon.position.set(-60, 100, 30); moon.castShadow = true;
    moon.shadow.camera.left = -90; moon.shadow.camera.right = 90;
    moon.shadow.camera.top = 90; moon.shadow.camera.bottom = -90;
    this.scene.add(moon);

    this.buildWorld();
    this.me = this.makeAvatar(0x27ae60);
    this.scene.add(this.me.mesh);
    this.bindInputs();
    this.bindSocket();
    this.updateHUD();
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    // 도감 먼저 로드 후 스냅샷 복원 (이름/가격 표시용)
    fetch('/api/roster').then(r => r.json()).then(j => { this.roster = j.roster || []; }).catch(() => {}).finally(() => {
      this.restoreSnap();
      this.refreshSlots();
    });
    requestAnimationFrame(this.loop);
    this.log('🧠 벨트에서 브레인롯을 주워 기지에 모아! 남의 것도 훔칠 수 있어!', true);
  }
  dispose() { this.disposed = true; }

  // ============ 월드 ============
  addBox(x, y, z, w, h, d, color, collide = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    this.scene.add(m);
    if (collide) { m.updateMatrixWorld(); this.colliders.push(new THREE.Box3().setFromObject(m)); }
    return m;
  }
  buildWorld() {
    this.colliders = [];
    const g = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), new THREE.MeshLambertMaterial({ color: 0x2a4a3a }));
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true; this.scene.add(g);
    // 중앙 벨트 (빨간 카펫 + 화살표)
    const belt = new THREE.Mesh(new THREE.PlaneGeometry(96, 7), new THREE.MeshLambertMaterial({ color: 0x8a1a1a }));
    belt.rotation.x = -Math.PI / 2; belt.position.set(0, 0.06, 0); this.scene.add(belt);
    for (let x = -42; x <= 42; x += 6) {
      const ch = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), new THREE.MeshBasicMaterial({ color: 0xffd23f }));
      ch.rotation.x = -Math.PI / 2; ch.rotation.z = -Math.PI / 4; ch.position.set(x, 0.08, 0); this.scene.add(ch);
    }
    this.addBox(0, 2.5, -4.5, 100, 5, 0.6, 0x5a5a5a);
    this.addBox(0, 2.5, 4.5, 100, 5, 0.6, 0x5a5a5a);
    // 스폰 터널
    this.addBox(-48, 3, 0, 4, 6, 9, 0x222233);
    // 8개 기지 (원형 배치)
    for (let i = 0; i < 8; i++) {
      const home = plotBasePos(i);
      const col = PLOT_COLS[i];
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), new THREE.MeshLambertMaterial({ color: col }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(home.x, 0.04, home.z); floor.receiveShadow = true; this.scene.add(floor);
      // 뒷벽 + 주인 팻말
      const ang = Math.atan2(home.z, home.x);
      const wx = home.x + Math.cos(ang) * 11, wz = home.z + Math.sin(ang) * 11;
      const wall = this.addBox(wx, 3, wz, 22, 6, 1, 0x333344);
      wall.rotation.y = -ang + Math.PI / 2;
      const tag = this.makeText(`${i + 1}번 기지`, '#ffffff', 42);
      tag.position.set(wx, 7.5, wz); this.scene.add(tag);
      // 6개 패드
      const pads = [];
      for (let s = 0; s < 6; s++) {
        const sp = slotPos(i, s);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.25, 20),
          new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x333333 }));
        pad.position.set(sp.x, 0.13, sp.z); this.scene.add(pad);
        pads.push(pad);
      }
      // 잠금 돔
      const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.22, side: THREE.DoubleSide }));
      dome.position.set(home.x * 0.82, 0, home.z * 0.82); dome.visible = false; this.scene.add(dome);
      this.bases.push({ idx: i, owner: null, lockUntil: 0, pads, dome, tag, tagOwner: '' });
    }
    // 장식: 별, 가로등
    for (let i = 0; i < 40; i++) {
      const st = new THREE.Mesh(new THREE.SphereGeometry(0.3), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      const a = Math.random() * Math.PI * 2;
      st.position.set(Math.cos(a) * 200, 40 + Math.random() * 80, Math.sin(a) * 200);
      this.scene.add(st);
    }
  }
  makeText(text, color = '#ffffff', size = 30) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.scale.set(7, 1.3, 1);
    this.drawText(spr, text, color, size);
    return spr;
  }
  drawText(spr, text, color, size = 30) {
    const { canvas } = spr.material.map.image ? { canvas: spr.material.map.image } : {};
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 96);
    ctx.font = `bold ${size}px "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(text, 256, 60); ctx.fillStyle = color; ctx.fillText(text, 256, 60);
    spr.material.map.needsUpdate = true;
  }

  // ============ 로블록스식 아바타 ============
  makeAvatar(shirt = 0x27ae60) {
    const skin = new THREE.MeshLambertMaterial({ color: 0xf5cd30 });
    const shirtM = new THREE.MeshLambertMaterial({ color: shirt });
    const pantsM = new THREE.MeshLambertMaterial({ color: 0x2e8b57 });
    const root = new THREE.Group();
    const B = (w, h, d, m, x, y, z) => {
      const ms = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      ms.position.set(x, y, z); ms.castShadow = true; return ms;
    };
    root.add(B(0.5, 0.5, 0.3, pantsM, 0, 1.05, 0));
    const mkLeg = (sx) => {
      const hip = new THREE.Group(); hip.position.set(0.16 * sx, 0.8, 0); root.add(hip);
      hip.add(B(0.22, 0.8, 0.26, pantsM, 0, -0.4, 0));
      return { hip };
    };
    const legL = mkLeg(-1), legR = mkLeg(1);
    const torsoG = new THREE.Group(); torsoG.position.set(0, 1.3, 0); root.add(torsoG);
    torsoG.add(B(0.6, 0.7, 0.34, shirtM, 0, 0.35, 0));
    torsoG.add(B(0.4, 0.25, 0.02, skin, 0, 0.45, -0.18));
    const headG = new THREE.Group(); headG.position.set(0, 0.85, 0); torsoG.add(headG);
    const head = B(0.45, 0.42, 0.4, skin, 0, 0.2, 0); headG.add(head);
    headG.add(B(0.07, 0.09, 0.02, new THREE.MeshBasicMaterial({ color: 0x111111 }), -0.1, 0.22, -0.21));
    headG.add(B(0.07, 0.09, 0.02, new THREE.MeshBasicMaterial({ color: 0x111111 }), 0.1, 0.22, -0.21));
    headG.add(B(0.2, 0.05, 0.02, new THREE.MeshBasicMaterial({ color: 0x111111 }), 0, 0.05, -0.21));
    const mkArm = (sx) => {
      const sh = new THREE.Group(); sh.position.set(0.42 * sx, 0.55, 0); torsoG.add(sh);
      sh.add(B(0.2, 0.7, 0.24, skin, 0, -0.35, 0));
      return { sh };
    };
    const armL = mkArm(-1), armR = mkArm(1);
    this.scene.add(root);
    return { mesh: root, torsoG, headG, armL, armR, legL, legR, phase: Math.random() * 6, punchT: 0, speed: 0, lastPos: new THREE.Vector3() };
  }
  animateAvatar(r, dt, time, carrying) {
    const m = r.mesh;
    const dx = m.position.x - r.lastPos.x, dz = m.position.z - r.lastPos.z;
    const spd = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    r.speed += (spd - r.speed) * Math.min(1, dt * 8);
    r.lastPos.copy(m.position);
    const moving = r.speed > 0.8;
    if (moving) r.phase += dt * (5 + r.speed * 1.2);
    const sw = moving ? Math.sin(r.phase) * 0.6 : 0;
    r.legL.hip.rotation.x = sw; r.legR.hip.rotation.x = -sw;
    if (carrying) { // 머리 위로 들고 걷기
      r.armL.sh.rotation.x = 2.6; r.armR.sh.rotation.x = 2.6;
    } else if (r.punchT > 0) {
      r.punchT -= dt;
      r.armR.sh.rotation.x = 1.7; r.armL.sh.rotation.x = 0.4;
    } else {
      r.armL.sh.rotation.x = -sw * 0.7; r.armR.sh.rotation.x = sw * 0.7;
    }
    r.torsoG.position.y = 1.3 + (moving ? Math.abs(Math.cos(r.phase)) * 0.05 : Math.sin(time * 2) * 0.015);
    m.rotation.y = r.yaw || 0;
  }

  // ============ 브레인롯 메시 8종 ============
  makeBrainrot(key) {
    const g = new THREE.Group();
    const M = (c) => new THREE.MeshLambertMaterial({ color: c });
    const B = (w, h, d, m, x, y, z) => {
      const ms = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      ms.position.set(x, y, z); ms.castShadow = true; g.add(ms); return ms;
    };
    const skin = M(0xd9a066);
    if (key === 'noobini') {
      B(0.9, 0.5, 0.9, M(0xe0a75e), 0, 0.5, 0);
      B(0.95, 0.12, 0.95, M(0xc0392b), 0, 0.78, 0);
      B(0.5, 0.4, 0.5, skin, 0, 1.1, 0);
      B(0.08, 0.1, 0.05, M(0x111111), -0.12, 1.15, -0.26);
      B(0.08, 0.1, 0.05, M(0x111111), 0.12, 1.15, -0.26);
    } else if (key === 'tung') {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 1.6, 10), M(0x7a4a22));
      log.position.y = 0.9; log.castShadow = true; g.add(log);
      B(0.5, 0.18, 0.2, skin, 0, 1.35, -0.25);
      B(0.09, 0.12, 0.05, M(0x111111), -0.12, 1.0, -0.36);
      B(0.09, 0.12, 0.05, M(0x111111), 0.12, 1.0, -0.36);
      const bat = B(0.12, 0.12, 1.0, M(0x8a5a2a), 0.5, 0.9, -0.3); bat.rotation.y = 0.4;
    } else if (key === 'tralala') {
      B(1.6, 0.7, 0.7, M(0x5a7a9a), 0, 0.8, 0);
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 4), M(0x3a5a7a));
      fin.position.set(0, 1.4, 0.1); g.add(fin);
      B(0.5, 0.4, 0.5, M(0x5a7a9a), -1.0, 0.8, 0);
      for (let l = -1; l <= 1; l++) {
        B(0.16, 0.5, 0.16, skin, l * 0.4, 0.25, 0);
        B(0.2, 0.14, 0.4, M(0xeeeeee), l * 0.4, 0.05, -0.1);
      }
      B(0.1, 0.12, 0.05, M(0x111111), -0.15, 0.95, -0.4);
      B(0.1, 0.12, 0.05, M(0x111111), 0.15, 0.95, -0.4);
    } else if (key === 'cappuccino') {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.35, 1.0, 12), M(0xd9b98a));
      cup.position.y = 0.7; cup.castShadow = true; g.add(cup);
      const foam = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.2, 12), M(0x8a5a2a));
      foam.position.y = 1.25; g.add(foam);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.07, 8, 12, Math.PI), M(0xd9b98a));
      handle.position.set(0.45, 0.8, 0); handle.rotation.z = -Math.PI / 2; g.add(handle);
      B(0.5, 0.35, 0.45, skin, 0, 1.55, 0);
      B(0.5, 0.12, 0.1, M(0x222222), 0, 1.62, -0.2);
      B(0.14, 0.5, 0.14, skin, -0.15, 0.25, 0); B(0.14, 0.5, 0.14, skin, 0.15, 0.25, 0);
    } else if (key === 'ballerina') {
      B(0.4, 0.8, 0.35, skin, 0, 1.0, 0);
      const tutu = new THREE.Mesh(new THREE.ConeGeometry(0.8, 0.5, 12), M(0xff9ecf));
      tutu.position.y = 0.65; tutu.castShadow = true; g.add(tutu);
      B(0.3, 0.3, 0.3, skin, 0, 1.6, 0);
      B(0.12, 0.5, 0.12, skin, -0.1, 0.25, 0); B(0.12, 0.5, 0.12, skin, 0.1, 0.25, 0);
    } else if (key === 'bombardiro') {
      B(1.8, 0.6, 0.8, M(0x2e8b57), 0, 0.9, 0);
      B(0.7, 0.12, 2.6, M(0x888888), 0, 1.0, 0);
      B(0.6, 0.5, 0.6, M(0x2e8b57), 0.9, 1.1, 0);
      const prop = B(0.08, 0.9, 0.08, M(0x333333), 0, 0.9, -1.1);
      prop.rotation.x = 0.4;
      B(0.12, 0.14, 0.06, M(0xffffff), 0.75, 1.15, -0.31);
      B(0.12, 0.14, 0.06, M(0xffffff), 1.05, 1.15, -0.31);
    } else if (key === 'lirili') {
      B(0.9, 0.9, 1.1, M(0x4a8b3d), 0, 0.8, 0);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.9, 8), M(0x4a8b3d));
      trunk.position.set(0, 0.9, -0.85); trunk.rotation.x = 1.1; g.add(trunk);
      B(0.5, 0.4, 0.4, M(0x4a8b3d), 0, 1.45, 0.2);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        B(0.2, 0.5, 0.2, M(0x4a8b3d), sx * 0.35, 0.25, sz * 0.4);
        B(0.24, 0.1, 0.4, M(0xd9b98a), sx * 0.35, 0.05, sz * 0.4 - 0.05);
      }
    } else { // patapim
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.6, 8), M(0x6a4a2a));
      trunk.position.y = 0.8; trunk.castShadow = true; g.add(trunk);
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), M(0x2e8b57));
      leaf.position.y = 2.0; leaf.castShadow = true; g.add(leaf);
      B(0.4, 0.35, 0.2, skin, 0, 1.7, -0.7);
      B(0.08, 0.1, 0.05, M(0x111111), -0.1, 1.75, -0.82);
      B(0.08, 0.1, 0.05, M(0x111111), 0.1, 1.75, -0.82);
    }
    return g;
  }
  makePlate(text, color = '#ffffff') {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
    spr.scale.set(4.4, 0.85, 1);
    spr.userData = { canvas: cv, tex };
    this.drawPlate(spr, text, color);
    this.scene.add(spr);
    return spr;
  }
  drawPlate(spr, text, color) {
    const { canvas, tex } = spr.userData;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 96);
    ctx.font = 'bold 34px "Malgun Gothic", sans-serif';
    ctx.textAlign = 'center'; ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    const lines = String(text).split('\n');
    lines.forEach((ln, i) => {
      const y = lines.length > 1 ? 36 + i * 34 : 58;
      ctx.strokeText(ln, 256, y); ctx.fillStyle = i === 0 ? color : '#7CFC00'; ctx.fillText(ln, 256, y);
    });
    tex.needsUpdate = true;
  }

  restoreSnap() {
    for (const b of this._snapBelt || []) this.spawnBeltItem(b.id, b.key, b.t);
    for (const l of this._snapLoose || []) this.spawnLooseItem(l.id, l.key, l.x, l.z);
    for (const c of this._snapCarried || []) this.spawnCarriedItem(c.id, c.key, c.carrier);
    for (const bs of this._snapBases || []) this.syncBase(bs);
    for (const p of this._snapPlayers || []) {
      if (p.nickname === this.nick) continue;
      this.upsertRemote(p.nickname, p);
    }
    this.refreshSlots();
  }
  spawnBeltItem(id, key, t) {
    if (this.items.has(id)) return;
    const mesh = this.makeBrainrot(key);
    const plate = this.makePlate('', '#fff');
    const bp = beltPos(t);
    mesh.position.set(bp.x, 0, bp.z);
    this.scene.add(mesh);
    this.items.set(id, { mesh, plate, key, t, state: 'belt' });
    this.updateItemPlate(id);
  }
  spawnLooseItem(id, key, x, z) {
    if (this.items.has(id)) return;
    const mesh = this.makeBrainrot(key);
    const plate = this.makePlate('', '#fff');
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);
    this.items.set(id, { mesh, plate, key, x, z, state: 'loose' });
    this.updateItemPlate(id);
  }
  spawnCarriedItem(id, key, carrier) {
    if (this.items.has(id)) return;
    const mesh = this.makeBrainrot(key);
    const plate = this.makePlate('', '#fff');
    this.scene.add(mesh);
    this.items.set(id, { mesh, plate, key, carrier, state: 'carried' });
    this.updateItemPlate(id);
  }
  updateItemPlate(id) {
    const it = this.items.get(id);
    if (!it) return;
    const info = this.brainInfo(it.key);
    this.drawPlate(it.plate, `${info.name}\n$${info.income}/초 · $${info.cost}`, RARITY_COL[info.rarity] || '#fff');
  }
  brainInfo(key) {
    return (this.roster || []).find(r => r.key === key) || { name: key, income: 0, cost: 0, rarity: 'common' };
  }
  syncBase(bs) {
    const b = this.bases[bs.idx];
    if (!b) return;
    b.owner = bs.owner;
    b.lockUntil = bs.lockUntil || 0;
    b.tagOwner = bs.owner || '';
    this.drawText(b.tag, bs.owner ? `${bs.owner}의 기지` : `${bs.idx + 1}번 기지`, bs.owner ? '#00f5d4' : '#ffffff', 40);
    // 슬롯 위 아이템 배치
    for (const s of bs.slots || []) {
      let found = [...this.items.values()].find(i => i.key === s.key && i.state === 'base' && i.slot === s.slot);
      if (!found) {
        const mesh = this.makeBrainrot(s.key);
        const plate = this.makePlate('', '#fff');
        this.scene.add(mesh);
        found = { mesh, plate, key: s.key, state: 'base', slot: s.slot };
        this.items.set('base_' + bs.idx + '_' + s.slot + '_' + s.key, found);
        this.updateItemPlate('base_' + bs.idx + '_' + s.slot + '_' + s.key);
      }
      const sp = slotPos(bs.idx, s.slot);
      found.mesh.position.set(sp.x, 0.3, sp.z);
      found.plate.position.set(sp.x, 2.6, sp.z);
    }
  }
  refreshSlots() {
    const grid = document.getElementById('slots');
    if (!grid) return;
    const mine = [...this.items.values()].filter(i => i.state === 'base' && this.isMine(i));
    let html = '';
    for (let s = 0; s < 6; s++) {
      const it = mine.find(i => i.slot === s);
      if (it) {
        const info = this.brainInfo(it.key);
        html += `<div class="slot" style="border-color:${RARITY_COL[info.rarity]}"><b style="font-size:10px">${info.name.slice(0, 8)}</b><small>$${info.income}/s</small></div>`;
      } else html += `<div class="slot">빈칸</div>`;
    }
    grid.innerHTML = html;
  }
  isMine(it) {
    // 내 기지 슬롯 아이템 판정: 위치가 내 기지 근처
    const home = plotBasePos(this.plot);
    const p = it.mesh.position;
    return Math.hypot(p.x - home.x * 0.82, p.z - home.z * 0.82) < 12;
  }

  // ============ 입력 ============
  bindInputs() {
    this.kd = (e) => {
      if (e.code === 'Enter' && e.type === 'keydown') { this.toggleChat(); return; }
      this.keys[e.code] = e.type === 'keydown';
      if (e.type !== 'keydown' || e.repeat) return;
      if (e.code === 'KeyE') this.interact();
      if (e.code === 'KeyQ') this.socket.emit('item:drop');
    };
    this.ku = this.kd;
    addEventListener('keydown', this.kd); addEventListener('keyup', this.ku);
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.0025;
      this.pitch -= e.movementY * 0.002;
      this.pitch = Math.max(-1.0, Math.min(0.5, this.pitch));
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this.canvas) { this.canvas.requestPointerLock(); return; }
      if (e.button === 0) this.slap();
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

  // E: 줍기/보관/훔치기/잠금 (상황별)
  interact() {
    if (this.carrying) {
      const home = plotBasePos(this.plot);
      if (Math.hypot(this.pos.x - home.x, this.pos.z - home.z) < 12) {
        this.socket.emit('item:deposit');
        return;
      }
    }
    // 가까운 벨트/바닥 아이템
    let best = null, bd = 4;
    for (const [id, it] of this.items) {
      if (it.state !== 'belt' && it.state !== 'loose') continue;
      const p = it.mesh.position;
      const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
      if (d < bd) { bd = d; best = id; }
    }
    if (best && !this.carrying) {
      const it = this.items.get(best);
      if (it.state === 'loose') { this.socket.emit('item:claim', { id: best }); return; }
      const info = this.brainInfo(it.key);
      if (this.cash < info.cost) { this.feed(`💸 캐시 부족! ($${info.cost} 필요)`); return; }
      this.socket.emit('item:claim', { id: best });
      return;
    }
    // 남의 기지 아이템 훔치기
    let sb = null, sbd = 5;
    for (const [id, it] of this.items) {
      if (it.state !== 'base' || this.isMine(it)) continue;
      const p = it.mesh.position;
      const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
      if (d < sbd) { sbd = d; sb = id; }
    }
    if (sb && !this.carrying) { this.socket.emit('item:steal', { id: sb }); return; }
    // 내 기지 잠금
    const home = plotBasePos(this.plot);
    if (Math.hypot(this.pos.x - home.x, this.pos.z - home.z) < 12) {
      this.socket.emit('base:lock');
    }
  }

  slap() {
    const now = performance.now();
    if (now - this.lastSlap < 800) return;
    this.lastSlap = now;
    this.punchT = 0.3;
    Sfx.noise(0.06, 0.1, 3000);
    let best = null, bd = 3;
    for (const [n, r] of this.remotes) {
      const d = Math.hypot(r.mesh.position.x - this.pos.x, r.mesh.position.z - this.pos.z);
      if (d < bd) { bd = d; best = n; }
    }
    if (best) {
      this.socket.emit('player:slap', { target: best });
      Sfx.slap();
    }
  }

  // ============ 소켓 ============
  bindSocket() {
    const s = this.socket;
    s.on('belt:spawn', (d) => { if (d) this.spawnBeltItem(d.id, d.key, -0.05); });
    s.on('item:update', (d) => {
      if (!d) return;
      if (d.state === 'carried') {
        let it = this.items.get(d.id);
        if (!it) { // 모르는 아이템이면 생성
          this.spawnCarriedItem(d.id, d.key || 'noobini', d.carrier);
          it = this.items.get(d.id);
        } else { it.state = 'carried'; it.carrier = d.carrier; }
        if (d.carrier === this.nick) {
          this.carrying = d.id;
          Sfx.pickup();
          this.feed(`🤲 ${this.brainInfo(it.key).name} 획득! 기지에 보관해!`);
        } else if (this.carrying === d.id) {
          this.carrying = null; // 빼앗김/떨굼
        }
        this.refreshSlots(); this.updateHUD();
      } else if (d.state === 'base') {
        // 오래된 스냅샷 더미 제거
        for (const [k, v] of [...this.items]) {
          if (k.startsWith('base_')) { this.scene.remove(v.mesh); this.scene.remove(v.plate); this.items.delete(k); }
        }
        let it = this.items.get(d.id);
        if (!it) {
          const mesh = this.makeBrainrot(d.key || 'noobini');
          const plate = this.makePlate('', '#fff');
          this.scene.add(mesh);
          it = { mesh, plate, key: d.key || 'noobini', state: 'base', slot: d.slot || 0 };
          this.items.set(d.id, it);
          this.updateItemPlate(d.id);
        }
        it.state = 'base'; it.carrier = null; it.slot = d.slot || 0;
        const sp = slotPos(d.plot ?? this.plot, it.slot);
        it.mesh.position.set(sp.x, 0.3, sp.z);
        it.plate.position.set(sp.x, 2.6, sp.z);
        if (this.carrying === d.id) this.carrying = null;
        this.refreshSlots(); this.updateHUD();
      } else if (d.state === 'loose') {
        let it = this.items.get(d.id);
        if (!it) this.spawnLooseItem(d.id, d.key || 'noobini', d.x, d.z);
        else { it.state = 'loose'; it.carrier = null; it.mesh.position.set(d.x, 0, d.z); it.plate.position.set(d.x, 2.2, d.z); }
        if (this.carrying === d.id) this.carrying = null;
        this.updateHUD();
      }
    });
    s.on('me:cash', (d) => { if (d) { this.cash = d.cash; if (d.income !== undefined) this.serverIncome = d.income; this.updateHUD(); } });
    s.on('base:locked', (d) => {
      const b = this.bases[d.idx];
      if (b) { b.lockUntil = d.until; Sfx.lock(); this.feed(`🔒 ${d.idx + 1}번 기지 잠금!`); }
    });
    s.on('world:tick', (d) => {
      if (!d) return;
      for (const b of d.belt || []) {
        const it = this.items.get(b.id);
        if (it && it.state === 'belt') {
          it.t = b.t;
          const bp = beltPos(b.t);
          it.mesh.position.set(bp.x, 0, bp.z);
          it.plate.position.set(bp.x, 2.2, bp.z);
        }
      }
      for (const bb of d.bases || []) {
        const b = this.bases[bb.idx];
        if (b) b.lockUntil = bb.lockUntil || 0;
      }
    });
    s.on('room:players', () => {});
    s.on('player:joined', (d) => {
      if (d && d.nickname !== this.nick) this.feed(`▶ ${d.nickname} 입장!`);
    });
    s.on('player:move', (p) => {
      if (!p || p.nickname === this.nick) return;
      if (!this.remotes.has(p.nickname)) this.upsertRemote(p.nickname, p);
      const r = this.remotes.get(p.nickname);
      r.targetPos.set(p.pos.x, 0, p.pos.z); r.yaw = p.yaw;
      if (p.slapping) r.punchT = 0.25;
      if (p.carrying) r.carryKey = this.carryKeyOf(p.carrying);
    });
    s.on('player:left', (d) => {
      const r = this.remotes.get(d.nickname);
      if (r) { this.scene.remove(r.mesh); this.scene.remove(r.plate); this.remotes.delete(d.nickname); }
      this.feed(`◀ ${d.nickname} 퇴장`);
    });
    s.on('player:slapped', (d) => {
      if (!d) return;
      if (d.victim === this.nick) {
        const from = this.remotes.get(d.from);
        const dx = from ? this.pos.x - from.mesh.position.x : 0;
        const dz = from ? this.pos.z - from.mesh.position.z : 1;
        const l = Math.hypot(dx, dz) || 1;
        this.knockV.set(dx / l * 9, 0, dz / l * 9);
        this.dropCarry();
        Sfx.slap();
        this.feed(`👋 ${d.from}에게 맞았다!`);
      } else {
        const r = this.remotes.get(d.victim);
        if (r) r.punchT = 0.01;
        const a = this.remotes.get(d.from);
        if (a) a.punchT = 0.3;
      }
    });
    s.on('chat:msg', (d) => this.log(d.sys ? d.text : `${d.nickname}: ${d.text}`, d.sys));
    s.on('error:msg', (t) => this.feed(`⛔ ${t}`));
  }
  carryKeyOf(id) {
    const it = this.items.get(id);
    return it ? it.key : null;
  }
  upsertRemote(nick, p) {
    const r = this.makeAvatar(0x3498db);
    r.plate = this.makePlate(nick, '#ff7777');
    r.mesh.position.set(p.pos.x, 0, p.pos.z);
    r.lastPos.copy(r.mesh.position);
    this.scene.add(r.mesh);
    this.remotes.set(nick, r);
  }
  dropCarry() {
    if (!this.carrying) return;
    this.socket.emit('item:drop');
    this.carrying = null;
    this.updateHUD();
  }

  // ============ HUD ============
  updateHUD() {
    const now = performance.now();
    if (now - (this.hudT || 0) < 250 && this.hudInit) return; // 4Hz 제한
    this.hudT = now; this.hudInit = true;
    document.getElementById('cash').textContent = `💵 $${Math.floor(this.cash)}`;
    let inc = this.serverIncome;
    if (inc === undefined) {
      inc = 0;
      for (const it of this.items.values()) if (it.state === 'base' && this.isMine(it)) inc += this.brainInfo(it.key).income;
    }
    document.getElementById('income').textContent = `+$${inc}/초`;
    const carried = this.carrying ? this.items.get(this.carrying) : null;
    document.getElementById('carry').textContent = carried ? `🤲 ${this.brainInfo(carried.key).name}` : '🤲 빈 손';
    const b = this.bases[this.plot];
    const locked = b && b.lockUntil > Date.now();
    document.getElementById('baselock').textContent = locked ? `🔒 잠금 ${Math.ceil((b.lockUntil - Date.now()) / 1000)}초` : '🔓 기지 열림';
  }
  feed(t) {
    const d = document.createElement('div'); d.textContent = t;
    const kf = document.getElementById('killfeed'); kf.prepend(d);
    while (kf.children.length > 6) kf.lastChild.remove();
  }
  log(t, sys) {
    const d = document.createElement('div'); d.textContent = t;
    if (sys) d.style.color = '#00f5d4';
    const cl = document.getElementById('chat-log'); cl.appendChild(d);
    while (cl.children.length > 30) cl.firstChild.remove();
  }
  drawMinimap() {
    const c = document.getElementById('minimap'); if (!c) return;
    const ctx = c.getContext('2d');
    const to = (x, z) => [75 + (x / 140) * 150, 75 + (z / 140) * 150];
    ctx.fillStyle = '#101828'; ctx.fillRect(0, 0, 150, 150);
    ctx.fillStyle = '#8a1a1a'; ctx.fillRect(28, 71, 94, 8);
    for (let i = 0; i < 8; i++) {
      const h = plotBasePos(i);
      const [mx, mz] = to(h.x, h.z);
      ctx.fillStyle = i === this.plot ? '#00f5d4' : '#555577';
      ctx.fillRect(mx - 4, mz - 4, 8, 8);
    }
    for (const [, r] of this.remotes) {
      const [mx, mz] = to(r.mesh.position.x, r.mesh.position.z);
      ctx.fillStyle = '#ff5555'; ctx.fillRect(mx - 2, mz - 2, 4, 4);
    }
    const [px, pz] = to(this.pos.x, this.pos.z);
    ctx.fillStyle = '#00ff00'; ctx.beginPath(); ctx.arc(px, pz, 4, 0, 7); ctx.fill();
  }

  // ============ 메인 루프 ============
  loop() {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = performance.now() / 1000;
    const locked = document.pointerLockElement === this.canvas;

    // 이동
    if (locked) {
      const sp = 7;
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const mv = new THREE.Vector3();
      if (this.keys.KeyW) mv.add(f); if (this.keys.KeyS) mv.sub(f);
      if (this.keys.KeyD) mv.add(r); if (this.keys.KeyA) mv.sub(r);
      if (mv.length() > 0) {
        mv.normalize().multiplyScalar(sp * dt);
        const nx = this.pos.x + mv.x, nz = this.pos.z + mv.z;
        if (Math.abs(nx) < 68 && Math.abs(nz) < 68) { this.pos.x = nx; this.pos.z = nz; }
        this.me.yaw = Math.atan2(-mv.x, -mv.z);
      }
      // 넉백 감쇠
      if (this.knockV.length() > 0.1) {
        this.pos.x += this.knockV.x * dt; this.pos.z += this.knockV.z * dt;
        this.knockV.multiplyScalar(1 - Math.min(1, dt * 4));
      }
      if (this.keys.Space) this.pos.y = 1.6; // 점프 없음 (고정)
      // 발소리
      if (mv.length() > 0) { this.stepT -= dt; if (this.stepT <= 0) { this.stepT = 0.4; Sfx.step(); } }
    }
    // 3인칭 카메라
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const cd = 5.2, ch = 2.6 + this.pitch * -2;
    this.camera.position.set(this.pos.x - fx * cd, this.pos.y + ch, this.pos.z - fz * cd);
    this.camera.lookAt(this.pos.x, 1.4, this.pos.z);
    this.me.mesh.position.set(this.pos.x, 0, this.pos.z);
    this.animateAvatar(this.me, dt, time, !!this.carrying);

    // 들고 있는 것 머리 위
    if (this.carrying) {
      const it = this.items.get(this.carrying);
      if (it) {
        it.mesh.position.set(this.pos.x, 2.6, this.pos.z);
        it.mesh.rotation.y += dt * 1.5;
        it.plate.position.set(this.pos.x, 3.8, this.pos.z);
      } else this.carrying = null;
    }

    // 원격 보간 + 들고 있는 것 표시
    for (const [n, r] of this.remotes) {
      r.mesh.position.x += (r.targetPos.x - r.mesh.position.x) * 0.2;
      r.mesh.position.z += (r.targetPos.z - r.mesh.position.z) * 0.2;
      this.animateAvatar(r, dt, time, !!r.carryKey);
      if (r.plate) r.plate.position.set(r.mesh.position.x, 2.4, r.mesh.position.z);
      if (r.carryKey && !r.carryMesh) {
        r.carryMesh = this.makeBrainrot(r.carryKey);
        this.scene.add(r.carryMesh);
      }
      if (r.carryMesh) {
        if (!r.carryKey) { this.scene.remove(r.carryMesh); r.carryMesh = null; }
        else { r.carryMesh.position.set(r.mesh.position.x, 2.6, r.mesh.position.z); r.carryMesh.rotation.y += dt; }
      }
    }
    // carryKey 해제 감지
    for (const [, r] of this.remotes) {
      if (!r.carryKey && r.carryMesh) { this.scene.remove(r.carryMesh); r.carryMesh = null; }
    }

    // 상호작용 팁
    const tip = document.getElementById('interact-tip');
    if (tip) {
      let t = null;
      if (!this.carrying) {
        for (const [, it] of this.items) {
          if (it.state !== 'belt' && it.state !== 'loose') continue;
          if (it.mesh.position.distanceTo(new THREE.Vector3(this.pos.x, 0, this.pos.z)) < 4) {
            const info = this.brainInfo(it.key);
            t = it.state === 'belt' ? `E: $${info.cost}에 구매 (${info.name})` : `E: 줍기 (${info.name})`;
            break;
          }
        }
        if (!t) {
          for (const [, it] of this.items) {
            if (it.state !== 'base' || this.isMine(it)) continue;
            if (it.mesh.position.distanceTo(new THREE.Vector3(this.pos.x, 0, this.pos.z)) < 5) { t = `E: 훔치기! (${this.brainInfo(it.key).name})`; break; }
          }
        }
      } else {
        const home = plotBasePos(this.plot);
        if (Math.hypot(this.pos.x - home.x, this.pos.z - home.z) < 12) t = 'E: 기지에 보관 (Q: 버리기)';
      }
      if (!t) {
        const home = plotBasePos(this.plot);
        if (Math.hypot(this.pos.x - home.x, this.pos.z - home.z) < 12) t = 'E: 기지 잠금 (20초)';
      }
      if (t) { tip.textContent = t; tip.classList.remove('hidden'); } else tip.classList.add('hidden');
    }
    // 잠금 경고
    const lk = document.getElementById('locktip');
    if (lk) {
      const b = this.bases[this.plot];
      const anyLocked = this.bases.some(x => x.lockUntil > Date.now());
      if (anyLocked) {
        const left = Math.max(...this.bases.map(x => x.lockUntil - Date.now()));
        lk.textContent = `🔒 잠긴 기지 있음 (${Math.ceil(left / 1000)}초)`;
        lk.classList.remove('hidden');
      } else lk.classList.add('hidden');
    }
    this.updateHUD();

    // 전송 20Hz
    this.netT += dt;
    if (this.netT > 0.05) {
      this.netT = 0;
      this.socket.emit('player:state', { pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z }, yaw: this.me.yaw || 0, slapping: this.punchT > 0 });
    }
    this.drawMinimap();
    this.renderer.render(this.scene, this.camera);
  }
}
