// 攝影大賽後端：零相依套件，只用 Node 內建模組。
// 資料存在 DATA_DIR（預設 ./data）：db.json + photos/*.jpg
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_PHOTOS = 2;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_THUMB_BYTES = 400 * 1024;
const MAX_JSON_BYTES = 10 * 1024;
const MAX_NAME_LENGTH = 12;
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;
const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- 資料 ----------

let db = { phase: 1, participants: [], photos: [], votes: {}, favorites: [] };
if (fs.existsSync(DB_FILE)) {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function getAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const file = path.join(DATA_DIR, 'admin-password.txt');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(6).toString('hex') + '\n', { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}
const ADMIN_PASSWORD = getAdminPassword();
const adminSessions = new Map(); // sha256(token) -> 到期時間

// ---------- 小工具 ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

function safeEqual(a, b) {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

// 名字比對用：全形半形、大小寫、空白都視為相同
function nameKey(name) {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

const isPin = (pin) => typeof pin === 'string' && /^\d{4,6}$/.test(pin);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 密碼猜錯太多次就暫時鎖住（4–6 位數字很好猜，一定要擋）
const fails = new Map(); // key -> { count, until }
function checkLock(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) {
    const mins = Math.ceil((f.until - Date.now()) / 60000);
    throw new HttpError(429, `密碼錯太多次了，請 ${mins} 分鐘後再試。`);
  }
}
function noteFail(key) {
  const f = fails.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) {
    f.until = Date.now() + LOCK_MS;
    f.count = 0;
  }
  fails.set(key, f);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      req.resume();
      return reject(new HttpError(413, '檔案太大了。'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, '檔案太大了。'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpError(400, '傳輸中斷了，請再試一次。')));
    req.on('aborted', () => reject(new HttpError(400, '傳輸中斷了，請再試一次。')));
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  try {
    const data = JSON.parse(buf.toString('utf8') || '{}');
    if (data && typeof data === 'object') return data;
  } catch {}
  throw new HttpError(400, '資料格式不對。');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const hash = sha256(token);
  return db.participants.find((p) => p.tokens.includes(hash)) || null;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, '請先登入。');
  return user;
}

function requireAdmin(req) {
  const hash = sha256(bearer(req) || '-');
  const until = adminSessions.get(hash);
  if (!until || until < Date.now()) {
    adminSessions.delete(hash);
    throw new HttpError(401, '請先輸入管理密碼。');
  }
}

function requirePhase(phase, message) {
  if (db.phase !== phase) throw new HttpError(409, message);
}

async function hashPin(pin, salt) {
  return (await scrypt(pin, salt, 32)).toString('hex');
}

function issueToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  user.tokens = [...user.tokens, sha256(token)].slice(-5); // 最多同時 5 支裝置
  return token;
}

function deletePhotoFiles(id) {
  for (const f of [`${id}.jpg`, `${id}_t.jpg`]) {
    fs.rmSync(path.join(PHOTO_DIR, f), { force: true });
  }
}

function removePhoto(id) {
  db.photos = db.photos.filter((p) => p.id !== id);
  db.favorites = db.favorites.filter((f) => f !== id);
  for (const [voter, photoId] of Object.entries(db.votes)) {
    if (photoId === id) delete db.votes[voter];
  }
  deletePhotoFiles(id);
}

function voteCounts() {
  const counts = Object.fromEntries(db.photos.map((p) => [p.id, 0]));
  const voters = new Set(db.participants.map((p) => p.id));
  for (const [voter, photoId] of Object.entries(db.votes)) {
    if (voters.has(voter) && photoId in counts) counts[photoId] += 1;
  }
  return counts;
}

function popularWinners(counts) {
  const max = Math.max(0, ...Object.values(counts));
  return max === 0 ? [] : Object.keys(counts).filter((id) => counts[id] === max);
}

// ---------- 對外的狀態（票數只有第 3 階段才會出現）----------

function publicState(me) {
  const names = Object.fromEntries(db.participants.map((p) => [p.id, p.name]));
  const state = {
    phase: db.phase,
    maxPhotos: MAX_PHOTOS,
    participants: db.participants.map((p) => ({
      id: p.id,
      name: p.name,
      attending: p.attending,
      photos: db.photos.filter((ph) => ph.ownerId === p.id).map((ph) => ({ id: ph.id, w: ph.w, h: ph.h })),
    })),
    me: me ? { id: me.id, name: me.name, attending: me.attending, vote: null } : null,
  };
  if (db.phase >= 2) {
    // 照片 id 是亂數，用 id 排序等於固定的隨機順序，不會讓先上傳的人佔便宜
    state.photos = [...db.photos]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((ph) => ({ id: ph.id, w: ph.w, h: ph.h, ownerId: ph.ownerId, ownerName: names[ph.ownerId] }));
    if (me) state.me.vote = db.votes[me.id] || null;
  }
  if (db.phase === 3) {
    const counts = voteCounts();
    for (const ph of state.photos) ph.votes = counts[ph.id];
    state.photos.sort((a, b) => b.votes - a.votes);
    state.result = { popular: popularWinners(counts), favorites: db.favorites };
  }
  return state;
}

function adminState() {
  const counts = voteCounts();
  const names = Object.fromEntries(db.participants.map((p) => [p.id, p.name]));
  return {
    phase: db.phase,
    participants: db.participants.map((p) => ({
      id: p.id,
      name: p.name,
      attending: p.attending,
      hasVoted: Boolean(db.votes[p.id]), // 只知道投了沒，不知道投給誰
      photoCount: db.photos.filter((ph) => ph.ownerId === p.id).length,
    })),
    photos: db.photos
      .map((ph) => ({
        id: ph.id,
        ownerName: names[ph.ownerId],
        votes: counts[ph.id],
        favorite: db.favorites.includes(ph.id),
      }))
      .sort((a, b) => b.votes - a.votes),
  };
}

// ---------- API ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/state$/, async (req, res) => {
  sendJson(res, 200, publicState(currentUser(req)));
});

route('POST', /^\/api\/register$/, async (req, res) => {
  const body = await readJson(req);
  requirePhase(1, '報名已經截止了，謝謝你。');
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, '請填名字。');
  if ([...name].length > MAX_NAME_LENGTH) throw new HttpError(400, `名字最多 ${MAX_NAME_LENGTH} 個字。`);
  if (!isPin(body.pin)) throw new HttpError(400, '密碼要是 4–6 位數字。');
  const key = nameKey(name);
  const taken = () => db.participants.some((p) => p.key === key);
  if (taken()) throw new HttpError(409, '這個名字已經有人報名了。如果是你，請切到「我報過了」登入；不是的話，換個名字試試。');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPin(body.pin, salt);
  if (taken()) throw new HttpError(409, '這個名字已經有人報名了。如果是你，請切到「我報過了」登入；不是的話，換個名字試試。');
  const user = {
    id: newId(),
    name,
    key,
    salt,
    hash,
    attending: body.attending !== false,
    createdAt: Date.now(),
    tokens: [],
  };
  const token = issueToken(user);
  db.participants.push(user);
  save();
  sendJson(res, 201, { token, state: publicState(user) });
});

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (!name || typeof body.pin !== 'string') throw new HttpError(400, '請填名字和密碼。');
  const key = nameKey(name);
  checkLock('user:' + key);
  const user = db.participants.find((p) => p.key === key);
  // 找不到人也照樣算一次雜湊，回應時間和訊息都不透露「有沒有這個名字」
  const hash = await hashPin(body.pin, user ? user.salt : 'no-such-user');
  if (!user || !safeEqual(hash, user.hash)) {
    noteFail('user:' + key);
    throw new HttpError(401, '名字或密碼不對，再試一次？');
  }
  fails.delete('user:' + key);
  const token = issueToken(user);
  save();
  sendJson(res, 200, { token, state: publicState(user) });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  const user = currentUser(req);
  if (user) {
    const hash = sha256(bearer(req));
    user.tokens = user.tokens.filter((t) => t !== hash);
    save();
  }
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/me\/attending$/, async (req, res) => {
  const user = requireUser(req);
  const body = await readJson(req);
  requirePhase(1, '現在不能改出席狀態了。');
  if (typeof body.attending !== 'boolean') throw new HttpError(400, '資料格式不對。');
  user.attending = body.attending;
  save();
  sendJson(res, 200, { state: publicState(user) });
});

// 上傳：body = 縮圖 JPEG 緊接著大圖 JPEG，?t= 是縮圖的位元組數
route('POST', /^\/api\/photos$/, async (req, res, url) => {
  const user = requireUser(req);
  const guard = () => {
    requirePhase(1, '上傳已經截止了。');
    if (db.photos.filter((p) => p.ownerId === user.id).length >= MAX_PHOTOS) {
      throw new HttpError(409, `每人最多 ${MAX_PHOTOS} 張，想換的話先刪掉一張。`);
    }
  };
  try {
    guard();
  } catch (err) {
    req.resume();
    throw err;
  }
  const buf = await readBody(req, MAX_UPLOAD_BYTES);
  guard(); // 傳輸期間狀態可能變了，再確認一次
  const thumbLen = Number(url.searchParams.get('t'));
  const w = Number(url.searchParams.get('w'));
  const h = Number(url.searchParams.get('h'));
  const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const okDim = (n) => Number.isInteger(n) && n > 0 && n <= 4000;
  if (!Number.isInteger(thumbLen) || thumbLen <= 0 || thumbLen > MAX_THUMB_BYTES || thumbLen >= buf.length) {
    throw new HttpError(400, '照片資料不完整，請再試一次。');
  }
  const thumb = buf.subarray(0, thumbLen);
  const full = buf.subarray(thumbLen);
  if (!isJpeg(thumb) || !isJpeg(full) || !okDim(w) || !okDim(h)) {
    throw new HttpError(400, '照片格式不對，請再試一次。');
  }
  const id = newId();
  fs.writeFileSync(path.join(PHOTO_DIR, `${id}_t.jpg`), thumb);
  fs.writeFileSync(path.join(PHOTO_DIR, `${id}.jpg`), full);
  db.photos.push({ id, ownerId: user.id, w, h, createdAt: Date.now() });
  save();
  sendJson(res, 201, { id, state: publicState(user) });
});

route('DELETE', /^\/api\/photos\/([a-f0-9]{16})$/, async (req, res, url, match) => {
  const user = requireUser(req);
  requirePhase(1, '投票開始後就不能改照片了。');
  const photo = db.photos.find((p) => p.id === match[1]);
  if (!photo || photo.ownerId !== user.id) throw new HttpError(404, '找不到這張照片。');
  removePhoto(photo.id);
  save();
  sendJson(res, 200, { state: publicState(user) });
});

route('POST', /^\/api\/vote$/, async (req, res) => {
  const user = requireUser(req);
  const body = await readJson(req);
  requirePhase(2, db.phase === 1 ? '投票還沒開始。' : '投票已經截止了。');
  const photo = db.photos.find((p) => p.id === body.photoId);
  if (!photo) throw new HttpError(404, '找不到這張照片。');
  if (photo.ownerId === user.id) throw new HttpError(403, '這張是你自己的作品，請投給別人的照片。');
  db.votes[user.id] = photo.id; // 每人一票，重投就是改投
  save();
  sendJson(res, 200, { state: publicState(user) });
});

// ----- 管理 -----

route('POST', /^\/api\/admin\/login$/, async (req, res) => {
  const body = await readJson(req);
  checkLock('admin');
  if (typeof body.password !== 'string' || !safeEqual(body.password, ADMIN_PASSWORD)) {
    noteFail('admin');
    throw new HttpError(401, '管理密碼不對。');
  }
  fails.delete('admin');
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(sha256(token), Date.now() + ADMIN_SESSION_MS);
  sendJson(res, 200, { token, state: adminState() });
});

route('GET', /^\/api\/admin\/state$/, async (req, res) => {
  requireAdmin(req);
  sendJson(res, 200, adminState());
});

route('POST', /^\/api\/admin\/phase$/, async (req, res) => {
  requireAdmin(req);
  const body = await readJson(req);
  if (![1, 2, 3].includes(body.phase)) throw new HttpError(400, '沒有這個階段。');
  db.phase = body.phase;
  save();
  sendJson(res, 200, adminState());
});

route('POST', /^\/api\/admin\/favorite$/, async (req, res) => {
  requireAdmin(req);
  const body = await readJson(req);
  if (!db.photos.some((p) => p.id === body.photoId)) throw new HttpError(404, '找不到這張照片。');
  db.favorites = db.favorites.filter((f) => f !== body.photoId);
  if (body.favorite) db.favorites.push(body.photoId);
  save();
  sendJson(res, 200, adminState());
});

route('DELETE', /^\/api\/admin\/participants\/([a-f0-9]{16})$/, async (req, res, url, match) => {
  requireAdmin(req);
  const user = db.participants.find((p) => p.id === match[1]);
  if (!user) throw new HttpError(404, '找不到這個人。');
  for (const ph of db.photos.filter((p) => p.ownerId === user.id)) removePhoto(ph.id);
  delete db.votes[user.id];
  db.participants = db.participants.filter((p) => p.id !== user.id);
  save();
  sendJson(res, 200, adminState());
});

// ---------- 靜態檔案 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const gzipCache = new Map();

function serveFile(req, res, file, cacheControl) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const compressible = type.startsWith('text/') || type.includes('svg');
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let hit = gzipCache.get(file);
    if (!hit || hit.etag !== etag) {
      hit = { etag, body: zlib.gzipSync(fs.readFileSync(file)) };
      gzipCache.set(file, hit);
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': hit.body.length });
    res.end(req.method === 'HEAD' ? undefined : hit.body);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

function serveStatic(req, res, pathname) {
  const photo = pathname.match(/^\/photos\/([a-f0-9]{16}(?:_t)?\.jpg)$/);
  if (photo) {
    return serveFile(req, res, path.join(PHOTO_DIR, photo[1]), 'public, max-age=31536000, immutable');
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  return serveFile(req, res, file, 'no-cache');
}

// ---------- 伺服器 ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: '網址不對。' });
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const match = r.method === req.method && url.pathname.match(r.pattern);
        if (match) return await r.handler(req, res, url, match);
      }
      throw new HttpError(404, '沒有這個功能。');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, decodeURIComponent(url.pathname))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('找不到這個頁面');
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: '伺服器出了點狀況，請稍後再試。' });
  }
});

server.listen(PORT, () => {
  console.log(`攝影大賽網站：http://localhost:${PORT}`);
  console.log(`管理面板：    http://localhost:${PORT}/#admin`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`管理密碼存在 ${path.join(DATA_DIR, 'admin-password.txt')}（也可以改用環境變數 ADMIN_PASSWORD 指定）`);
  }
});
