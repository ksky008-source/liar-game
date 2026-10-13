// @ts-check
// 라이어게임 — 실시간 온라인 추리 게임 서버  (MADE BY KIMJIHUN)
// 의존성 없음 (Node.js 18+ 내장 모듈만). 실시간 동기화: Server-Sent Events.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORDS, PAIRS } = require('./words');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 8;
const MAX_DESC = 60;
const MAX_ROUNDS = 5;
/** 정답을 고르는 제한 시간(ms). 시험에서만 LIAR_GUESS_MS로 줄입니다. */
const GUESS_MS = Number(process.env.LIAR_GUESS_MS) || 60000;
const MAX_ROOMS = 500;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** @typedef {'normal'|'fool'|'spy'} Mode */
/** @typedef {'citizen'|'liar'|'fool'|'spy'} Role */
/** @type {Record<Mode, {name: string, min: number}>} */
const MODES = {
  normal: { name: '노멀모드', min: 4 },
  fool: { name: '바보모드', min: 4 },
  spy: { name: '스파이모드', min: 5 },
};

/**
 * @typedef {{pid: string, nick: string, tokenHash: string}} Player
 * @typedef {{pid: string, res: http.ServerResponse}} Client
 * @typedef {{seat: number, round: number, text: string}} Desc
 * @typedef {{winner: 'citizen'|'liar'|'fool', label: string, reason: string}} Outcome
 * @typedef {{
 *   n: number, mode: Mode, phase: 'desc'|'vote'|'revote'|'guess'|'end', size: number, rounds: number, orders: number[][],
 *   deadline: number|null, votes2: (number|null)[], tally2: number[]|null, ties2: number[]|null, auto: 'caught'|'missed'|null,
 *   category: string, word: string, foolWord: string|null, guessWords: string[],
 *   roles: Role[], turn: number, desc: Desc[], votes: (number|null)[],
 *   suspect: number|null, tally: number[]|null, ties: number[]|null,
 *   guess: string|null, outcome: Outcome|null
 * }} Game
 * @typedef {{
 *   code: string, mode: Mode, rounds: number, host: number, status: 'lobby'|'play',
 *   players: Player[], clients: Set<Client>, game: Game|null, touched: number
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** 토큰 원문은 저장하지 않고 SHA-256 해시만 보관합니다. @type {Map<string, {code: string, pid: string}>} */
const tokens = new Map();

class GameError extends Error {
  /** @param {string} msg @param {number} [status] */
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
/** @param {string} msg @param {number} [status] @returns {never} */
const fail = (msg, status) => { throw new GameError(msg, status); };
/** @param {number} n */
const rint = n => crypto.randomInt(n);
/** @param {string} t */
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
/** @param {unknown} s */
const cleanText = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
/** @param {string} s */
const len = s => [...s].length;
/** @param {string} s */
const squash = s => s.replace(/\s/g, '');
const PARTICLES = ['', '은', '는', '이', '가', '을', '를', '도', '야', '요', '랑', '와', '과', '의', '에', '로', '만'];
/** 설명에 제시어를 그대로 썼는지. 두 글자 이상은 포함 여부, 한 글자(배·말·춤 등)는 낱말 단위로만 판단합니다.
 * @param {string} text @param {string} word */
function saysWord(text, word) {
  const w = squash(word);
  if (len(w) >= 2) return squash(text).includes(w);
  return text.split(/[\s.,!?~·'"()\[\]]+/).some(t => PARTICLES.some(p => t === w + p));
}
/** @template T @param {T[]} a @returns {T[]} */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rint(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** @param {unknown} m @returns {Mode} */
function checkMode(m) {
  if (m === 'normal' || m === 'fool' || m === 'spy') return m;
  return fail('게임 모드를 골라 주세요.');
}
/** @param {unknown} raw */
function checkNick(raw) {
  const nick = cleanText(raw);
  if (!nick) fail('닉네임을 입력해 주세요.');
  if (len(nick) > 10) fail('닉네임은 10자 이하로 써 주세요.');
  return nick;
}
function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = Array.from({ length: 5 }, () => CODE_ABC[rint(CODE_ABC.length)]).join('');
    if (!rooms.has(c)) return c;
  }
  return fail('방을 만들 수 없어요. 잠시 후 다시 시도해 주세요.', 503);
}
/** @param {Room} room @param {string} nick */
function addPlayer(room, nick) {
  const pid = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashToken(token);
  room.players.push({ pid, nick, tokenHash });
  tokens.set(tokenHash, { code: room.code, pid });
  return token;
}
/** @param {unknown} token */
function auth(token) {
  const h = hashToken(String(token || ''));
  const t = tokens.get(h);
  if (!t) return fail('참가 정보가 없어요. 처음 화면에서 다시 들어와 주세요.', 401);
  const room = rooms.get(t.code);
  if (!room) { tokens.delete(h); return fail('방이 사라졌어요. 새 방을 만들어 주세요.', 410); }
  const seat = room.players.findIndex(p => p.pid === t.pid);
  if (seat < 0) { tokens.delete(h); return fail('이 방에서 나간 상태예요.', 410); }
  return { room, seat, player: room.players[seat] };
}
/** @param {Room} room */
const playing = room => room.status === 'play' && !!room.game && room.game.phase !== 'end';

// ---------------- 게임 로직 ----------------
/** @param {Room} room */
function startGame(room) {
  const rounds = room.rounds;
  const size = room.players.length, mode = room.mode;
  if (size > MAX_PLAYERS) fail(`최대 ${MAX_PLAYERS}명까지 할 수 있어요.`);
  if (size < MODES[mode].min) fail(`${MODES[mode].name}는 ${MODES[mode].min}명 이상이어야 시작할 수 있어요. (지금 ${size}명)`);

  let category, word, foolWord = null, guessWords;
  if (mode === 'fool') {
    const cat = PAIRS[rint(PAIRS.length)];
    const pair = cat.pairs[rint(cat.pairs.length)];
    const flip = rint(2) === 1;
    category = cat.name; word = flip ? pair[1] : pair[0]; foolWord = flip ? pair[0] : pair[1];
    guessWords = cat.pairs.flat();
  } else {
    const cat = WORDS[rint(WORDS.length)];
    category = cat.name; word = cat.words[rint(cat.words.length)]; guessWords = cat.words.slice();
  }
  /** @type {Role[]} */
  const roles = Array(size).fill('citizen');
  const order = shuffle([...Array(size).keys()]);
  if (mode === 'normal') roles[order[0]] = 'liar';
  if (mode === 'fool') roles[order[0]] = 'fool';
  if (mode === 'spy') { roles[order[0]] = 'liar'; roles[order[1]] = 'spy'; }

  room.game = {
    n: (room.game ? room.game.n : 0) + 1, mode, phase: 'desc', size, rounds,
    orders: Array.from({ length: rounds }, () => shuffle([...Array(size).keys()])),
    deadline: null, votes2: Array(size).fill(null), tally2: null, ties2: null, auto: null,
    category, word, foolWord, guessWords: shuffle(guessWords),
    roles, turn: 0, desc: [], votes: Array(size).fill(null),
    suspect: null, tally: null, ties: null, guess: null, outcome: null,
  };
  room.status = 'play';
}

/** 이 사람이 받은 제시어 (라이어는 null) @param {Game} g @param {number} seat */
function wordOf(g, seat) {
  const r = g.roles[seat];
  if (r === 'liar') return null;
  if (r === 'fool') return g.foolWord;
  return g.word;
}
/** 최종 추측을 하는 역할 @param {Game} g */
/** 지금 발표할 사람의 자리 @param {Game} g */
const speaker = g => g.orders[Math.floor(g.turn / g.size)][g.turn % g.size];
const guesserRole = g => (g.mode === 'fool' ? 'fool' : 'liar');

/** @param {Game} g @param {Outcome['winner']} winner @param {string} reason */
function endGame(g, winner, reason) {
  const label = winner === 'citizen' ? '시민 승리'
    : winner === 'fool' ? (g.suspect !== null && g.roles[g.suspect] === 'fool' ? '바보 역전승' : '바보 승리')
    : g.mode === 'spy' ? '라이어·스파이 진영 승리' : '라이어 승리';
  g.phase = 'end'; g.outcome = { winner, label, reason };
}

/** 지목된 사람이 정해진 뒤의 판정 @param {Game} g @param {number} suspect */
function judge(g, suspect) {
  g.suspect = suspect;
  const role = g.roles[suspect];
  if (role === guesserRole(g)) { g.phase = 'guess'; return; }
  if (g.mode === 'fool') endGame(g, 'fool', '바보가 아닌 사람이 지목돼서 바보가 이겼어요.');
  else if (g.mode === 'spy') endGame(g, 'liar', role === 'spy' ? '스파이가 지목됐어요. 라이어는 끝까지 숨었어요.' : '시민이 라이어로 잘못 지목됐어요.');
  else endGame(g, 'liar', '시민이 라이어로 잘못 지목됐어요.');
}

/** @param {(number|null)[]} votes @param {number} size @returns {{tally: number[], ties: number[]}} */
function count(votes, size) {
  const tally = Array(size).fill(0);
  votes.forEach(t => { if (t !== null) tally[t]++; });
  const max = Math.max(...tally);
  return { tally, ties: tally.map((v, i) => (v === max ? i : -1)).filter(i => i >= 0) };
}

/** 1차 투표 집계. 동률이면 동률 후보끼리 2차 투표를 합니다. @param {Game} g */
function finishVotes(g) {
  const { tally, ties } = count(g.votes, g.size);
  g.tally = tally; g.ties = ties;
  if (ties.length === 1) { judge(g, ties[0]); return; }
  g.phase = 'revote';
}

/** 2차 투표 집계. 또 동률이면: 동률 후보 중에 라이어(바보)가 있으면 맞힌 것으로 칩니다. @param {Game} g */
function finishRevote(g) {
  const { tally, ties } = count(g.votes2, g.size);
  g.tally2 = tally; g.ties2 = ties;
  if (ties.length === 1) { judge(g, ties[0]); return; }
  const hit = ties.find(i => g.roles[i] === guesserRole(g));
  g.auto = hit !== undefined ? 'caught' : 'missed';
  judge(g, hit !== undefined ? hit : ties[rint(ties.length)]);
}

/** @typedef {{room: Room, seat: number, player: Player}} Ctx */
/** @type {Record<string, (ctx: Ctx, body: any) => void>} */
const actions = {
  mode(ctx, body) {
    const { room, seat } = ctx;
    if (room.host !== seat) fail('모드는 방장만 바꿀 수 있어요.');
    if (playing(room)) fail('게임 중에는 모드를 바꿀 수 없어요.');
    room.mode = checkMode(body.mode);
  },
  rounds(ctx, body) {
    const { room, seat } = ctx;
    if (room.host !== seat) fail('라운드 수는 방장만 바꿀 수 있어요.');
    if (playing(room)) fail('게임 중에는 라운드 수를 바꿀 수 없어요.');
    const n = body.rounds;
    if (!Number.isInteger(n) || n < 1 || n > MAX_ROUNDS) fail(`라운드는 1~${MAX_ROUNDS}라운드 중에서 골라 주세요.`);
    room.rounds = n;
  },
  start(ctx) {
    const { room, seat } = ctx;
    if (room.host !== seat) fail('방장만 시작할 수 있어요.');
    if (playing(room)) fail('이미 게임이 진행 중이에요.');
    startGame(room);
  },
  describe(ctx, body) {
    const { room, seat } = ctx, g = room.game;
    if (!g || !playing(room) || g.phase !== 'desc') return fail('지금은 설명 단계가 아니에요.');
    if (speaker(g) !== seat) fail('아직 내 차례가 아니에요.');
    const text = cleanText(body.text);
    if (!text) fail('설명을 한 줄 써 주세요.');
    if (len(text) > MAX_DESC) fail(`설명은 ${MAX_DESC}자 이하로 써 주세요.`);
    const mine = wordOf(g, seat);
    if (mine && saysWord(text, mine)) fail('제시어를 그대로 쓰면 안 돼요. 돌려서 설명해 주세요.');
    g.desc.push({ seat, round: Math.floor(g.turn / g.size), text });
    g.turn++;
    if (g.turn >= g.size * g.rounds) g.phase = 'vote';
  },
  vote(ctx, body) {
    const { room, seat } = ctx, g = room.game;
    if (!g || !playing(room) || (g.phase !== 'vote' && g.phase !== 'revote')) return fail('지금은 투표 단계가 아니에요.');
    const second = g.phase === 'revote', arr = second ? g.votes2 : g.votes;
    if (arr[seat] !== null) fail('이미 투표했어요.');
    const t = body.target;
    if (!Number.isInteger(t) || t < 0 || t >= g.size) fail('투표할 사람을 골라 주세요.');
    if (t === seat) fail('자기 자신에게는 투표할 수 없어요.');
    if (second && !(g.ties || []).includes(t)) fail('2차 투표는 동률 후보 중에서만 고를 수 있어요.');
    arr[seat] = t;
    if (arr.every(v => v !== null)) (second ? finishRevote : finishVotes)(g);
  },
  guess(ctx, body) {
    const { room, seat } = ctx, g = room.game;
    if (!g || !playing(room) || g.phase !== 'guess') return fail('지금은 정답을 맞히는 단계가 아니에요.');
    if (seat !== g.suspect) fail('지목된 사람만 정답을 고를 수 있어요.');
    if (g.deadline !== null && Date.now() > g.deadline) fail('제한 시간이 지났어요.');
    const w = body.word;
    if (typeof w !== 'string' || !g.guessWords.includes(w)) fail('보기에서 제시어 하나를 골라 주세요.');
    g.guess = w;
    const right = w === g.word;
    if (g.mode === 'fool') endGame(g, right ? 'fool' : 'citizen', right ? '바보가 지목됐지만 시민들의 제시어를 맞혔어요.' : '바보를 찾아냈고, 바보가 시민의 제시어를 맞히지 못했어요.');
    else endGame(g, right ? 'liar' : 'citizen', right ? '라이어가 지목됐지만 제시어를 맞혔어요.' : '라이어를 찾아냈고, 라이어의 추측이 틀렸어요.');
  },
  lobby(ctx) {
    const { room, seat } = ctx;
    if (room.status !== 'play') return;
    if (playing(room) && room.host !== seat) fail('게임 중단은 방장만 할 수 있어요.');
    room.status = 'lobby';
  },
  leave(ctx) {
    const { room, seat, player } = ctx;
    if (playing(room)) fail('게임 중에는 나갈 수 없어요. 방장이 게임을 중단하거나 판이 끝난 뒤 나가 주세요.');
    room.players.splice(seat, 1);
    tokens.delete(player.tokenHash);
    for (const c of room.clients) if (c.pid === player.pid) { try { c.res.end(); } catch (e) { /* ignore */ } room.clients.delete(c); }
    room.status = 'lobby';
    if (!room.players.length) { deleteRoom(room); return; }
    if (room.host === seat) room.host = 0; else if (room.host > seat) room.host--;
  },
};
actions.restart = actions.start;

/** 정답 제한 시간 타이머: 방 상태가 바뀔 때마다 맞춰 줍니다. @type {Map<string, {g: Game, t: NodeJS.Timeout}>} */
const guessTimers = new Map();
/** @param {Room} room */
function syncTimer(room) {
  const g = room.game, cur = guessTimers.get(room.code);
  const want = room.status === 'play' && g && g.phase === 'guess' ? g : null;
  if (cur && cur.g !== want) { clearTimeout(cur.t); guessTimers.delete(room.code); }
  if (!want || (cur && cur.g === want)) return;
  want.deadline = Date.now() + GUESS_MS;
  const t = setTimeout(() => {
    guessTimers.delete(room.code);
    if (rooms.get(room.code) !== room || room.game !== want || room.status !== 'play' || want.phase !== 'guess') return;
    endGame(want, 'citizen', (want.mode === 'fool' ? '바보' : '라이어') + '가 제한 시간(' + Math.round(GUESS_MS / 1000) + '초) 안에 제시어를 고르지 못해서 졌어요.');
    broadcast(room);
  }, GUESS_MS);
  guessTimers.set(room.code, { g: want, t });
}

/** @param {Room} room */
function deleteRoom(room) {
  const tm = guessTimers.get(room.code); if (tm) { clearTimeout(tm.t); guessTimers.delete(room.code); }
  for (const p of room.players) tokens.delete(p.tokenHash);
  for (const c of room.clients) { try { c.res.end(); } catch (e) { /* ignore */ } }
  rooms.delete(room.code);
}

// ---------------- 개인별 화면 데이터: 본인에게 필요한 정보만 ----------------
/** @param {Room} room @param {number} seat */
function viewFor(room, seat) {
  const online = new Set([...room.clients].map(c => c.pid));
  /** @type {Record<string, any>} */
  const v = {
    code: room.code, me: seat, host: room.host, status: room.status, mode: room.mode, roundsSetting: room.rounds, maxRounds: MAX_ROUNDS,
    modes: MODES, maxPlayers: MAX_PLAYERS, maxDesc: MAX_DESC,
    players: room.players.map(p => ({ nick: p.nick, online: online.has(p.pid) })),
  };
  const g = room.game;
  v.rounds = room.rounds;
  if (room.status !== 'play' || !g) return v;
  const role = g.roles[seat];
  /** @type {Record<string, any>} */
  let card;
  if (role === 'liar') card = { role: 'liar' };
  else if (role === 'spy') card = { role: 'spy', word: g.word, liar: g.roles.indexOf('liar') };
  else card = { role: 'citizen', word: wordOf(g, seat) }; // 바보도 결과 전까지 '시민'으로 보입니다
  Object.assign(v, {
    n: g.n, mode: g.mode, phase: g.phase, size: g.size, category: g.category, card,
    turn: g.turn, turnSeat: g.phase === 'desc' ? speaker(g) : null, round: Math.min(Math.floor(g.turn / g.size), g.rounds - 1),
    rounds: g.rounds, orders: g.phase === 'desc' ? g.orders.slice(0, Math.floor(g.turn / g.size) + 1) : g.orders,
    desc: g.desc, voted: (g.phase === 'revote' ? g.votes2 : g.votes).map(x => x !== null),
    myVote: g.phase === 'revote' ? g.votes2[seat] : g.votes[seat],
  });
  if (g.phase === 'revote' || g.phase === 'guess' || g.phase === 'end') {
    Object.assign(v, { tally: g.tally, ties: g.ties, suspect: g.suspect, tally2: g.tally2, ties2: g.ties2, auto: g.auto });
    if (g.phase === 'guess' && seat === g.suspect) v.guessWords = g.guessWords;
    if (g.phase === 'guess') Object.assign(v, { guessDeadline: g.deadline, now: Date.now() });
  }
  if (g.phase === 'end' && g.outcome) {
    v.result = Object.assign({}, g.outcome, {
      roles: g.roles, word: g.word, foolWord: g.foolWord, votes: g.votes, votes2: g.ties && g.ties.length > 1 ? g.votes2 : null, guess: g.guess,
      words: g.roles.map((_, i) => wordOf(g, i)),
    });
  }
  return v;
}
/** @param {Room} room */
function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) {
    const seat = room.players.findIndex(p => p.pid === c.pid);
    if (seat < 0) continue;
    try { c.res.write(`data: ${JSON.stringify(viewFor(room, seat))}\n\n`); } catch (e) { /* ignore */ }
  }
}

// ---------------- 요청 제한 ----------------
const RATE_BURST = 150, RATE_PER_SEC = 25; // 같은 와이파이의 8명이 함께 써도 넉넉한 수준
/** @type {Map<string, {t: number, at: number}>} */
const buckets = new Map();
/** @param {string} ip */
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
/** @param {http.ServerResponse} res @param {number} status @param {object} obj */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
/** @param {http.IncomingMessage} req @returns {Promise<any>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 4096) { reject(new GameError('요청이 너무 커요.', 413)); req.destroy(); } });
    req.on('end', () => {
      try { const j = data ? JSON.parse(data) : {}; resolve(j && typeof j === 'object' ? j : {}); }
      catch (e) { reject(new GameError('잘못된 요청이에요.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      fs.createReadStream(INDEX).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { room, player } = auth(url.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      /** @type {Client} */
      const client = { pid: player.pid, res };
      room.clients.add(client);
      broadcast(room);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 20000);
      req.on('close', () => { clearInterval(ping); room.clients.delete(client); if (rooms.get(room.code) === room) broadcast(room); });
      return;
    }

    if (req.method !== 'POST') return send(res, 404, { error: '없는 주소예요.' });
    if (!rateOk(ip)) return send(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 해 주세요.' });
    const body = await readBody(req);

    if (url.pathname === '/api/create') {
      const nick = checkNick(body.nick);
      const mode = checkMode(body.mode);
      if (rooms.size >= MAX_ROOMS) fail('지금은 방이 너무 많아요. 잠시 후 다시 시도해 주세요.', 503);
      /** @type {Room} */
      const room = { code: newCode(), mode, rounds: 2, host: 0, status: 'lobby', players: [], clients: new Set(), game: null, touched: Date.now() };
      rooms.set(room.code, room);
      const token = addPlayer(room, nick);
      return send(res, 200, { token, code: room.code });
    }
    if (url.pathname === '/api/join') {
      const nick = checkNick(body.nick);
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 5) fail('초대 코드는 5자리예요.');
      const room = rooms.get(code);
      if (!room) return fail('그런 초대 코드의 방이 없어요. 코드를 다시 확인해 주세요.', 404);
      if (room.status === 'play') fail('게임이 진행 중인 방이에요. 판이 끝나고 방장이 대기실로 돌아오면 들어올 수 있어요.', 409);
      if (room.players.length >= MAX_PLAYERS) fail(`방이 가득 찼어요. (${MAX_PLAYERS}/${MAX_PLAYERS})`, 409);
      if (room.players.some(p => p.nick.toLowerCase() === nick.toLowerCase())) fail('같은 닉네임이 이미 방에 있어요. 다른 닉네임을 써 주세요.', 409);
      const token = addPlayer(room, nick);
      broadcast(room);
      return send(res, 200, { token, code });
    }
    if (url.pathname === '/api/action') {
      const ctx = auth(body.token);
      if (body.type === 'ping') return send(res, 200, { ok: true });
      const fn = Object.prototype.hasOwnProperty.call(actions, body.type) ? actions[body.type] : null;
      if (!fn) fail('알 수 없는 동작이에요.');
      else fn(ctx, body);
      if (rooms.get(ctx.room.code) === ctx.room) { syncTimer(ctx.room); broadcast(ctx.room); }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: '없는 주소예요.' });
  } catch (e) {
    if (e instanceof GameError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (!room.clients.size && now - room.touched > ROOM_IDLE_MS) deleteRoom(room);
  for (const [ip, b] of buckets) if (now - b.at > 60000) buckets.delete(ip);
}, 60000).unref();

if (require.main === module) server.listen(PORT, () => console.log(`라이어게임 서버 실행 중: http://localhost:${PORT}`));
module.exports = { server, rooms, tokens, MODES, saysWord };
