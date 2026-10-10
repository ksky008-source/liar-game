// 라이어 테이블 — 4인 온라인 라이어게임 서버
// 의존성 없음 (Node.js 18+ 내장 모듈만 사용). 실시간 동기화는 Server-Sent Events.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_DESC = 60;
const MAX_ROOMS = 500;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // 3시간 동안 아무 일 없으면 방 삭제
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CATS = [
  { name: '장소', words: ['학교', '병원', '공항', '해수욕장', '영화관', '도서관', '놀이공원', '편의점', '찜질방', '수영장', '경찰서', '동물원', '캠핑장', '지하철역', '미용실', '노래방', '박물관', '시장'] },
  { name: '음식', words: ['김치찌개', '떡볶이', '치킨', '피자', '짜장면', '삼겹살', '초밥', '라면', '비빔밥', '햄버거', '냉면', '김밥', '순대', '붕어빵', '마라탕', '갈비탕', '아이스크림', '돈가스'] },
  { name: '동물', words: ['고양이', '강아지', '호랑이', '기린', '펭귄', '코끼리', '원숭이', '토끼', '돌고래', '판다', '거북이', '사자', '하마', '다람쥐', '캥거루', '부엉이', '악어', '고래'] },
  { name: '물건', words: ['우산', '냉장고', '칫솔', '안경', '휴대폰', '시계', '의자', '가위', '거울', '베개', '지갑', '이어폰', '선풍기', '리모컨', '볼펜', '열쇠', '텀블러', '손전등'] },
  { name: '취미', words: ['탁구', '낚시', '등산', '요리', '독서', '사진 찍기', '그림 그리기', '게임', '캠핑', '뜨개질', '노래', '자전거', '볼링', '수영', '바둑', '영화 감상', '춤', '퍼즐'] },
  { name: '직업', words: ['의사', '소방관', '요리사', '선생님', '경찰관', '택배기사', '가수', '유튜버', '변호사', '미용사', '농부', '비행기 조종사', '프로그래머', '간호사', '운동선수', '기자', '목수', '은행원'] },
];

// ---------------- 상태 (서버 메모리) ----------------
const rooms = new Map();   // code -> room
const tokens = new Map();  // token -> { code, pid }

class GameError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new GameError(msg, status); };
const rint = n => crypto.randomInt(n);
const newToken = () => crypto.randomBytes(24).toString('base64url');
const cleanText = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
const len = s => [...s].length;

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = Array.from({ length: 5 }, () => CODE_ABC[rint(CODE_ABC.length)]).join('');
    if (!rooms.has(c)) return c;
  }
  fail('방을 만들 수 없어요. 잠시 후 다시 시도해 주세요.', 503);
}

function checkNick(raw) {
  const nick = cleanText(raw);
  if (!nick) fail('닉네임을 입력해 주세요.');
  if (len(nick) > 10) fail('닉네임은 10자 이하로 써 주세요.');
  return nick;
}

function addPlayer(room, nick) {
  const pid = crypto.randomBytes(8).toString('hex');
  const token = newToken();
  room.players.push({ pid, nick, token });
  tokens.set(token, { code: room.code, pid });
  return token;
}

function auth(token) {
  const t = tokens.get(String(token || ''));
  if (!t) fail('참가 정보가 없어요. 처음 화면에서 다시 들어와 주세요.', 401);
  const room = rooms.get(t.code);
  if (!room) { tokens.delete(token); fail('방이 사라졌어요. 새 방을 만들어 주세요.', 410); }
  const seat = room.players.findIndex(p => p.pid === t.pid);
  if (seat < 0) { tokens.delete(token); fail('이 방에서 나간 상태예요.', 410); }
  return { room, seat, player: room.players[seat] };
}

// ---------------- 게임 로직 ----------------
function startGame(room) {
  const cat = rint(CATS.length);
  room.game = {
    n: (room.game ? room.game.n : 0) + 1,
    phase: 'desc',
    cat,
    word: rint(CATS[cat].words.length),
    liar: rint(4),
    turn: 0,               // 0..7 (2라운드 × 4명)
    desc: [],              // {seat, round, text}
    votes: [null, null, null, null],
    suspect: null, tally: null, ties: null,
    guess: null, result: null,
  };
  room.status = 'play';
}

function finishVotes(g) {
  const tally = [0, 0, 0, 0];
  g.votes.forEach(t => { tally[t]++; });
  const max = Math.max(...tally);
  const ties = [0, 1, 2, 3].filter(i => tally[i] === max);
  g.tally = tally; g.ties = ties;
  g.suspect = ties[rint(ties.length)];
  if (g.suspect === g.liar) g.phase = 'claim';
  else endGame(g, 'liar', '시민이 라이어로 잘못 지목됐어요.');
}

function endGame(g, winner, reason) { g.phase = 'end'; g.result = { winner, reason }; }

const actions = {
  start(ctx) {
    const { room, seat } = ctx;
    if (room.host !== seat) fail('방장만 시작할 수 있어요.');
    if (room.status === 'play' && room.game.phase !== 'end') fail('이미 게임이 진행 중이에요.');
    if (room.players.length !== 4) fail('4명이 모두 들어와야 시작할 수 있어요.');
    startGame(room);
  },
  describe(ctx, body) {
    const { room, seat } = ctx, g = room.game;
    if (room.status !== 'play' || g.phase !== 'desc') fail('지금은 설명 단계가 아니에요.');
    if (g.turn % 4 !== seat) fail('아직 내 차례가 아니에요.');
    const text = cleanText(body.text);
    if (!text) fail('설명을 한 줄 써 주세요.');
    if (len(text) > MAX_DESC) fail(`설명은 ${MAX_DESC}자 이하로 써 주세요.`);
    if (seat !== g.liar) {
      const w = CATS[g.cat].words[g.word].replace(/\s/g, '');
      if (text.replace(/\s/g, '').includes(w)) fail('제시어를 그대로 쓰면 안 돼요. 돌려서 설명해 주세요.');
    }
    g.desc.push({ seat, round: g.turn >> 2, text });
    g.turn++;
    if (g.turn >= 8) g.phase = 'vote';
  },
  vote(ctx, body) {
    const { room, seat } = ctx, g = room.game;
    if (room.status !== 'play' || g.phase !== 'vote') fail('지금은 투표 단계가 아니에요.');
    if (g.votes[seat] !== null) fail('이미 투표했어요.');
    const t = body.target;
    if (!Number.isInteger(t) || t < 0 || t > 3) fail('투표할 사람을 골라 주세요.');
    if (t === seat) fail('자기 자신에게는 투표할 수 없어요.');
    g.votes[seat] = t;
    if (g.votes.every(v => v !== null)) finishVotes(g);
  },
  guess(ctx, body) {
    const { room, seat } = ctx, g = room.game;
    if (room.status !== 'play' || g.phase !== 'claim') fail('지금은 정답을 맞히는 단계가 아니에요.');
    if (seat !== g.liar) fail('라이어만 정답을 고를 수 있어요.');
    const w = body.word;
    if (!Number.isInteger(w) || w < 0 || w >= CATS[g.cat].words.length) fail('제시어 하나를 골라 주세요.');
    g.guess = w;
    if (w === g.word) endGame(g, 'liar', '라이어가 지목됐지만 제시어를 맞혔어요.');
    else endGame(g, 'citizen', '라이어를 찾아냈고, 라이어의 추측이 틀렸어요.');
  },
  lobby(ctx) {
    const { room, seat } = ctx;
    if (room.status !== 'play') return;
    if (room.game.phase !== 'end' && room.host !== seat) fail('게임 중단은 방장만 할 수 있어요.');
    room.status = 'lobby';
  },
  leave(ctx) {
    const { room, seat, player } = ctx;
    if (room.status === 'play' && room.game.phase !== 'end') fail('게임 중에는 나갈 수 없어요. 방장이 게임을 중단하거나 판이 끝난 뒤 나가 주세요.');
    room.players.splice(seat, 1);
    tokens.delete(player.token);
    for (const c of room.clients) if (c.pid === player.pid) { try { c.res.end(); } catch (e) {} room.clients.delete(c); }
    room.status = 'lobby';
    if (!room.players.length) { deleteRoom(room); return; }
    if (room.host === seat) room.host = 0; else if (room.host > seat) room.host--;
  },
};
actions.restart = actions.start;

function deleteRoom(room) {
  for (const p of room.players) tokens.delete(p.token);
  for (const c of room.clients) { try { c.res.end(); } catch (e) {} }
  rooms.delete(room.code);
}

// ---------------- 개인별 화면 데이터 (비밀 정보는 필요한 사람에게만) ----------------
function viewFor(room, seat) {
  const online = new Set([...room.clients].map(c => c.pid));
  const v = {
    code: room.code, me: seat, host: room.host, status: room.status, maxDesc: MAX_DESC,
    players: room.players.map(p => ({ nick: p.nick, online: online.has(p.pid) })),
  };
  const g = room.game;
  if (room.status !== 'play' || !g) return v;
  const cat = CATS[g.cat];
  Object.assign(v, {
    n: g.n, phase: g.phase, category: cat.name,
    card: seat === g.liar ? { liar: true } : { liar: false, word: cat.words[g.word] },
    turn: g.turn, turnSeat: g.phase === 'desc' ? g.turn % 4 : null, round: g.turn >> 2,
    desc: g.desc,
    voted: g.votes.map(x => x !== null),          // 누가 투표했는지만 (누구에게는 비공개)
    myVote: g.votes[seat],
  });
  if (g.phase === 'claim' || g.phase === 'end') {
    Object.assign(v, { tally: g.tally, ties: g.ties, suspect: g.suspect });
    if (g.phase === 'claim' && seat === g.liar) v.words = cat.words; // 라이어의 마지막 기회용 보기
  }
  if (g.phase === 'end') {
    v.result = Object.assign({}, g.result, {
      liar: g.liar, word: cat.words[g.word], votes: g.votes,
      guess: g.guess === null ? null : cat.words[g.guess],
    });
  }
  return v;
}

function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) {
    const seat = room.players.findIndex(p => p.pid === c.pid);
    if (seat < 0) continue;
    try { c.res.write(`data: ${JSON.stringify(viewFor(room, seat))}\n\n`); } catch (e) {}
  }
}

// ---------------- 요청 제한 (도배 방지) ----------------
const buckets = new Map();
const RATE_BURST = 120, RATE_PER_SEC = 20; // 같은 와이파이의 4명이 함께 써도 넉넉한 수준
function rateOk(ip) {
  if (process.env.LIAR_NO_RATE_LIMIT === '1') return true;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { t: RATE_BURST, at: now }; buckets.set(ip, b); }
  b.t = Math.min(RATE_BURST, b.t + (now - b.at) / 1000 * RATE_PER_SEC); b.at = now;
  if (b.t < 1) return false;
  b.t -= 1; return true;
}

// ---------------- HTTP ----------------
const INDEX = path.join(__dirname, 'index.html');
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 4096) { reject(new GameError('요청이 너무 커요.', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new GameError('잘못된 요청이에요.')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { room, seat, player } = auth(url.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const client = { pid: player.pid, res };
      room.clients.add(client);
      broadcast(room);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(ping); room.clients.delete(client); if (rooms.get(room.code) === room) broadcast(room); });
      return;
    }

    if (req.method !== 'POST') return send(res, 404, { error: '없는 주소예요.' });
    if (!rateOk(ip)) return send(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 해 주세요.' });
    const body = await readBody(req);

    if (url.pathname === '/api/create') {
      const nick = checkNick(body.nick);
      if (rooms.size >= MAX_ROOMS) fail('지금은 방이 너무 많아요. 잠시 후 다시 시도해 주세요.', 503);
      const room = { code: newCode(), host: 0, status: 'lobby', players: [], clients: new Set(), game: null, touched: Date.now() };
      rooms.set(room.code, room);
      const token = addPlayer(room, nick);
      return send(res, 200, { token, code: room.code });
    }
    if (url.pathname === '/api/join') {
      const nick = checkNick(body.nick);
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 5) fail('초대 코드는 5자리예요.');
      const room = rooms.get(code);
      if (!room) fail('그런 초대 코드의 방이 없어요. 코드를 다시 확인해 주세요.', 404);
      if (room.status === 'play' && room.game.phase !== 'end') fail('이미 게임이 진행 중인 방이에요.', 409);
      if (room.players.length >= 4) fail('방이 가득 찼어요. (4/4)', 409);
      if (room.players.some(p => p.nick.toLowerCase() === nick.toLowerCase())) fail('같은 닉네임이 이미 방에 있어요. 다른 닉네임을 써 주세요.', 409);
      const token = addPlayer(room, nick);
      broadcast(room);
      return send(res, 200, { token, code });
    }
    if (url.pathname === '/api/action') {
      const ctx = auth(body.token);
      if (body.type === 'ping') return send(res, 200, { ok: true });
      const fn = actions[body.type];
      if (!fn) fail('알 수 없는 동작이에요.');
      fn(ctx, body);
      if (rooms.get(ctx.room.code) === ctx.room) broadcast(ctx.room);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: '없는 주소예요.' });
  } catch (e) {
    if (e instanceof GameError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

// 오래 비어 있는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (!room.clients.size && now - room.touched > ROOM_IDLE_MS) deleteRoom(room);
  for (const [ip, b] of buckets) if (now - b.at > 60000) buckets.delete(ip);
}, 60000).unref();

if (require.main === module) server.listen(PORT, () => console.log(`라이어 테이블 서버 실행 중: http://localhost:${PORT}`));
module.exports = { server, rooms, CATS };
