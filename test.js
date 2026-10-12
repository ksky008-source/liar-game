// @ts-nocheck
// 라이어게임 자동 테스트 — 실제 서버를 띄우고 4~8명의 클라이언트(HTTP + 실시간 SSE)로 모든 모드를 검증합니다.
// 실행: npm test
'use strict';
process.env.LIAR_NO_RATE_LIMIT = '1';
const assert = require('assert');
const http = require('http');
const { server, rooms, tokens } = require('./server');

let BASE;
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
function listen(token) {
  const c = { view: null, raw: [] };
  http.get(BASE + '/api/events?token=' + encodeURIComponent(token), res => {
    c.res = res; let buf = '';
    res.on('data', ch => {
      buf += ch; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data: '));
        if (line) { c.raw.push(line.slice(6)); c.view = JSON.parse(line.slice(6)); }
      }
    });
  });
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, label) { for (let i = 0; i < 500; i++) { try { if (f()) return; } catch (e) { /* retry */ } await sleep(10); } throw new Error('시간 초과: ' + label); }
const act = (token, type, extra) => req('POST', '/api/action', Object.assign({ token, type }, extra));
let checks = 0;
async function expectErr(p, re, label, quiet) {
  const r = await p;
  assert.ok(r.status >= 400 && re.test(r.body.error), label + ' → ' + JSON.stringify(r));
  checks++; if (!quiet) console.log('  ✓ ' + label + ': ' + r.body.error);
}
const NICKS = ['지훈', '민수', '서연', '하준', '지우', '도윤', '서아', '예준', '추가'];

async function makeRoom(mode, size) {
  const host = await req('POST', '/api/create', { nick: NICKS[0], mode });
  assert.strictEqual(host.status, 200, JSON.stringify(host));
  const toks = [host.body.token];
  for (let i = 1; i < size; i++) {
    const r = await req('POST', '/api/join', { code: host.body.code, nick: NICKS[i] });
    assert.strictEqual(r.status, 200, JSON.stringify(r)); toks.push(r.body.token);
  }
  const cl = toks.map(listen);
  await until(() => cl.every(c => c.view && c.view.players.length === size && c.view.players.every(p => p.online)), 'lobby');
  return { code: host.body.code, toks, cl };
}
function close(R) { R.cl.forEach(c => c.res && c.res.destroy()); }

/** 객체 안 어딘가에 정확히 이 문자열 값이 있는지 (부분 일치 아님: '말' ⊂ '얼룩말' 같은 오탐 방지) */
function hasValue(o, w) {
  if (typeof o === 'string') return o === w;
  if (o && typeof o === 'object') return Object.values(o).some(x => hasValue(x, w));
  return false;
}
/** 비밀 정보가 본인 외에게 새지 않는지 점검 */
function checkSecrecy(R, mode) {
  const V = R.cl.map(c => c.view);
  const size = V.length;
  const room = rooms.get(R.code), g = room.game;
  for (let i = 0; i < size; i++) {
    const v = V[i], role = g.roles[i], s = JSON.stringify(v);
    assert.ok(!('result' in v) && !('roles' in v) && !('tally' in v), '결과 전 비공개 필드 없음');
    if (role === 'liar') { assert.deepStrictEqual(v.card, { role: 'liar' }); assert.ok(!hasValue(v, g.word), '라이어에게 제시어 미전송'); }
    if (role === 'fool') {
      assert.strictEqual(v.card.role, 'citizen', '바보는 자신을 시민으로 봄');
      assert.strictEqual(v.card.word, g.foolWord); assert.ok(!hasValue(v, g.word), '바보에게 시민 제시어 미전송');
    }
    if (role === 'citizen') {
      assert.strictEqual(v.card.word, g.word);
      if (g.foolWord) assert.ok(!hasValue(v, g.foolWord), '시민에게 바보 제시어 미전송');
      assert.ok(!('liar' in v.card), '시민은 라이어를 모름');
    }
    if (role === 'spy') { assert.strictEqual(v.card.word, g.word); assert.strictEqual(v.card.liar, g.roles.indexOf('liar')); }
    if (mode === 'spy' && role !== 'spy') assert.ok(!s.includes('"role":"spy"') && !('liar' in v.card && role !== 'spy'), '스파이 정체 비공개');
  }
  // 모든 실시간 메시지 전체에서도 확인
  for (let i = 0; i < size; i++) { // 이번 판의 모든 실시간 메시지에서도 확인 (지난 판 결과에는 지난 정답이 공개되므로 제외)
    const msgs = R.cl[i].raw.map(m => JSON.parse(m)).filter(m => m.n === g.n);
    if (g.roles[i] === 'liar') assert.ok(msgs.every(m => !hasValue(m, g.word)), '라이어 메시지에 정답 없음');
    if (g.roles[i] === 'fool') assert.ok(msgs.every(m => !hasValue(m, g.word)), '바보 메시지에 시민 정답 없음');
    if (g.roles[i] === 'citizen' && g.foolWord) assert.ok(msgs.every(m => !hasValue(m, g.foolWord)), '시민 메시지에 바보 제시어 없음');
  }
  checks++;
}

async function playDescriptions(R) {
  const size = R.toks.length, g = rooms.get(R.code).game, rounds = g.rounds;
  assert.strictEqual(R.cl[0].view.rounds, rounds);
  assert.strictEqual(R.cl[0].view.orders.length, 1, '시작할 때는 1라운드 순서만 공개');
  const spoken = [];
  const notMe = (R.cl[0].view.turnSeat + 1) % size;
  await expectErr(act(R.toks[notMe], 'describe', { text: '새치기' }), /차례/, '차례 아닌 제출', true);
  const cit = g.roles.indexOf('citizen');
  for (let k = 0; k < size * rounds; k++) {
    const s = R.cl[0].view.turnSeat;
    assert.strictEqual(s, g.orders[Math.floor(k / size)][k % size]);
    assert.ok(R.cl.every(c => c.view.turnSeat === s), '모두에게 같은 발표자');
    assert.strictEqual(R.cl[0].view.orders.length, Math.floor(k / size) + 1, '지난·현재 라운드 순서만 공개');
    if (s === cit) await expectErr(act(R.toks[s], 'describe', { text: '정답은 ' + g.word }), /제시어/, '설명에 제시어 포함', true);
    const r = await act(R.toks[s], 'describe', { text: `${s + 1}번 ${Math.floor(k / size) + 1}라운드 설명` });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    spoken.push(s);
    await until(() => R.cl.every(c => c.view.desc.length === k + 1), 'desc ' + k);
  }
  await until(() => R.cl.every(c => c.view.phase === 'vote'), 'vote phase');
  for (let r = 0; r < rounds; r++) assert.deepStrictEqual([...spoken.slice(r * size, (r + 1) * size)].sort(), [...Array(size).keys()], r + 1 + '라운드: 모두 한 번씩 발표');
  assert.deepStrictEqual(R.cl[0].view.orders, g.orders);
  return g.orders;
}

async function vote(R, plan) {
  const size = plan.length;
  await expectErr(act(R.toks[0], 'vote', { target: 0 }), /자기 자신/, '자기 자신 투표', true);
  for (let i = 0; i < size; i++) {
    assert.strictEqual((await act(R.toks[i], 'vote', { target: plan[i] })).status, 200);
    if (i === 0) await expectErr(act(R.toks[0], 'vote', { target: plan[0] }), /이미/, '중복 투표', true);
    if (i < size - 1) {
      await until(() => R.cl.every(c => c.view.voted.filter(Boolean).length === i + 1), 'voted ' + i);
      R.cl.forEach((c, j) => { assert.ok(!('tally' in c.view)); assert.strictEqual(c.view.myVote, j <= i ? plan[j] : null); });
    }
  }
  await until(() => R.cl.every(c => ['tiebreak', 'guess', 'end'].includes(c.view.phase)), 'tally');
}

/** 한 판을 처음부터 끝까지. target: 'guesser'(라이어/바보 지목) | 'other' | 'tie'; guess: 'right'|'wrong' */
async function playRound(R, mode, n, target, guess, rounds) {
  const size = R.toks.length;
  assert.strictEqual((await act(R.toks[0], 'rounds', { rounds })).status, 200);
  await until(() => R.cl.every(c => c.view.roundsSetting === rounds), 'rounds sync');
  let tieLog = 0;
  assert.strictEqual((await act(R.toks[0], 'start')).status, 200);
  await until(() => R.cl.every(c => c.view.n === n && c.view.phase === 'desc'), 'start');
  const g = rooms.get(R.code).game;
  const count = r => g.roles.filter(x => x === r).length;
  if (mode === 'normal') assert.ok(count('liar') === 1 && count('citizen') === size - 1);
  if (mode === 'fool') assert.ok(count('fool') === 1 && count('citizen') === size - 1 && g.foolWord && g.foolWord !== g.word);
  if (mode === 'spy') assert.ok(count('liar') === 1 && count('spy') === 1 && count('citizen') === size - 2);
  checkSecrecy(R, mode);
  await playDescriptions(R);

  const guesser = g.roles.indexOf(mode === 'fool' ? 'fool' : 'liar');
  const other = mode === 'spy' && target === 'spy' ? g.roles.indexOf('spy') : g.roles.indexOf('citizen');
  let plan;
  if (target === 'tie2') plan = [...Array(size).keys()].map(i => (i === 0 ? 1 : i === 1 ? 0 : i % 2 === 0 ? 0 : 1));
  else if (target === 'tie') plan = [...Array(size).keys()].map(i => (i % 2 === 0 ? (i + 1) % size : i - 1)).map((t, i) => (t === i ? (i + 1) % size : t));
  else { const tg = target === 'guesser' ? guesser : other; plan = [...Array(size).keys()].map(i => (i === tg ? (tg + 1) % size : tg)); }
  await vote(R, plan);
  let T = R.cl[0].view;
  if (T.phase === 'tiebreak') {
    assert.ok(T.ties.length > 1 && !T.ties.includes(T.breaker) === (T.ties.length < size), '최종 투표자는 후보가 아닌 사람(가능하면)');
    assert.ok(R.cl.every(c => c.view.breaker === T.breaker && c.view.suspect === null));
    const nb = (T.breaker + 1) % size;
    await expectErr(act(R.toks[nb], 'tiebreak', { target: T.ties[0] }), /최종 투표자만/, '최종 투표자 아닌 사람의 결정', true);
    await expectErr(act(R.toks[T.breaker], 'tiebreak', { target: T.breaker }), /동률 후보/, '자기 자신 선택', true);
    const nonCand = [...Array(size).keys()].find(i => !T.ties.includes(i));
    if (nonCand !== undefined) await expectErr(act(R.toks[T.breaker], 'tiebreak', { target: nonCand }), /동률 후보/, '후보가 아닌 사람 선택', true);
    await expectErr(act(R.toks[T.breaker], 'tiebreak', { target: 'x' }), /동률 후보/, '잘못된 선택', true);
    const pickable = T.ties.filter(i => i !== T.breaker);
    const choose = pickable.includes(guesser) ? guesser : pickable[0];
    assert.strictEqual((await act(R.toks[T.breaker], 'tiebreak', { target: choose })).status, 200);
    await until(() => R.cl.every(c => ['guess', 'end'].includes(c.view.phase)), 'tiebreak done');
    T = R.cl[0].view;
    assert.strictEqual(T.suspect, choose); tieLog = 1;
  }
  assert.ok(T.ties.includes(T.suspect));
  assert.ok(R.cl.every(c => c.view.suspect === T.suspect));

  if (T.suspect === guesser) {
    assert.strictEqual(T.phase, 'guess');
    assert.ok(R.cl[guesser].view.guessWords && R.cl.every((c, i) => i === guesser || !c.view.guessWords), '추측 보기는 지목된 사람에게만');
    assert.ok(R.cl[guesser].view.guessWords.includes(g.word));
    assert.ok(R.cl.every(c => !c.view.result));
    await expectErr(act(R.toks[(guesser + 1) % size], 'guess', { word: g.word }), /지목된 사람만/, '지목 안 된 사람의 추측', true);
    const pick = guess === 'right' ? g.word : g.guessWords.find(w => w !== g.word);
    assert.strictEqual((await act(R.toks[guesser], 'guess', { word: pick })).status, 200);
  }
  await until(() => R.cl.every(c => c.view.phase === 'end'), 'end');
  const res = R.cl[0].view.result;
  assert.deepStrictEqual(res.roles, g.roles); assert.strictEqual(res.word, g.word); assert.deepStrictEqual(res.votes, plan);

  let expect;
  const caught = T.suspect === guesser;
  if (mode === 'fool') expect = caught ? (guess === 'right' ? ['fool', '바보 역전승'] : ['citizen', '시민 승리']) : ['fool', '바보 승리'];
  else {
    const team = mode === 'spy' ? '라이어·스파이 진영 승리' : '라이어 승리';
    expect = caught ? (guess === 'right' ? ['liar', team] : ['citizen', '시민 승리']) : ['liar', team];
  }
  assert.strictEqual(res.winner, expect[0]); assert.strictEqual(res.label, expect[1]);
  checks++;
  return { size, label: res.label, reason: res.reason, suspectRole: g.roles[T.suspect], tally: T.tally, ties: T.ties.length, tieLog, rounds };
}

(async () => {
  await new Promise(r => server.listen(0, r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  const page = await new Promise(r => http.get(BASE + '/', res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => r({ s: res.statusCode, d })); }));
  assert.strictEqual(page.s, 200);
  assert.ok(page.d.includes('<title>라이어게임</title>') && page.d.includes('content="KIMJIHUN"') && page.d.includes('KIMJIHUN</span>') && !/SECRET LIAR/i.test(page.d));
  assert.ok(page.d.includes('Copyright © 2026 KIMJIHUN') && page.d.includes('placeholder="닉네임을 입력해주세요."') && !page.d.includes('예: 지훈'));
  console.log('✓ 메인 페이지: 제목 "라이어게임", 제작자 KIMJIHUN, Copyright © 2026 표기, 닉네임 안내 문구');

  console.log('\n[방 생성·참가·인원 검증]');
  await expectErr(req('POST', '/api/create', { nick: '지훈' }), /모드/, '모드 없이 방 생성');
  await expectErr(req('POST', '/api/create', { nick: '', mode: 'normal' }), /닉네임/, '빈 닉네임');
  await expectErr(req('POST', '/api/join', { code: 'ZZZZZ', nick: '민수' }), /없어요/, '잘못된 초대 코드');
  const R8 = await makeRoom('normal', 8);
  await expectErr(req('POST', '/api/join', { code: R8.code, nick: '아홉째' }), /가득/, '9번째 입장');
  await expectErr(req('POST', '/api/join', { code: R8.code, nick: '서연' }), /가득|같은 닉네임/, '가득 찬 방 입장');
  await expectErr(act(R8.toks[3], 'start'), /방장/, '방장 아닌 사람이 시작');
  await expectErr(act(R8.toks[3], 'mode', { mode: 'spy' }), /방장/, '방장 아닌 사람이 모드 변경');
  await expectErr(act(R8.toks[3], 'rounds', { rounds: 3 }), /방장/, '방장 아닌 사람이 라운드 변경');
  for (const bad of [0, 6, 2.5, '3', null]) await expectErr(act(R8.toks[0], 'rounds', { rounds: bad }), /1~5라운드/, '잘못된 라운드 수 ' + JSON.stringify(bad));
  assert.strictEqual(R8.cl[0].view.roundsSetting, 2, '기본 2라운드');
  await expectErr(act('가짜토큰', 'start'), /참가 정보/, '가짜 인증 정보');
  const stored = JSON.stringify([...rooms.values()].map(r => r.players));
  assert.ok(R8.toks.every(t => !stored.includes(t)) && R8.toks.every(t => !tokens.has(t)), '토큰 원문 미저장');
  console.log('  ✓ 서버에는 토큰 원문이 아니라 SHA-256 해시만 저장');
  close(R8);

  const R3 = await makeRoom('normal', 3);
  await expectErr(act(R3.toks[0], 'start'), /4명 이상/, '노멀모드 3명 시작');
  await act(R3.toks[0], 'mode', { mode: 'fool' });
  await expectErr(act(R3.toks[0], 'start'), /4명 이상/, '바보모드 3명 시작');
  close(R3);
  const R4s = await makeRoom('spy', 4);
  await expectErr(act(R4s.toks[0], 'start'), /스파이모드는 5명 이상/, '스파이모드 4명 시작 거부(서버)');
  assert.strictEqual((await act(R4s.toks[0], 'mode', { mode: 'normal' })).status, 200);
  await until(() => R4s.cl.every(c => c.view.mode === 'normal'), 'mode sync');
  console.log('  ✓ 방장이 대기실에서 모드 변경 → 모두에게 실시간 반영');
  assert.strictEqual((await act(R4s.toks[0], 'start')).status, 200);
  await expectErr(req('POST', '/api/join', { code: R4s.code, nick: '지각생' }), /진행 중/, '게임 시작 후 중간 참가');
  await expectErr(act(R4s.toks[2], 'leave'), /게임 중/, '게임 중 나가기');
  await expectErr(act(R4s.toks[2], 'lobby'), /방장/, '방장 아닌 사람의 게임 중단');
  await expectErr(act(R4s.toks[0], 'mode', { mode: 'spy' }), /게임 중/, '게임 중 모드 변경');
  assert.strictEqual((await act(R4s.toks[0], 'lobby')).status, 200);
  close(R4s);

  const summary = [];
  const run = async (mode, sizes, scen) => {
    for (const size of sizes) {
      const R = await makeRoom(mode, size);
      let n = 0;
      for (const [target, guess] of scen(size)) {
        const rounds = (n + size) % 5 + 1; // 1~5라운드를 골고루
        const r = await playRound(R, mode, ++n, target, guess, rounds);
        summary.push(`${mode.padEnd(6)} ${size}명 ${r.rounds}라운드 · ${(target + (guess ? '/' + guess : '')).padEnd(14)} → ${r.label} (지목: ${r.suspectRole}${r.ties > 1 ? ', 동률 ' + r.ties + '명 → 최종 투표자 결정' : ''})`);
      }
      // 새로고침(재접속) 확인
      R.cl[1].res.destroy();
      await until(() => !R.cl[0].view.players[1].online, 'offline');
      R.cl[1] = listen(R.toks[1]);
      await until(() => R.cl[1].view && R.cl[1].view.phase === 'end' && R.cl[0].view.players[1].online, 'rejoin');
      close(R);
    }
  };
  console.log('\n[모드별 전체 게임 진행]');
  await run('normal', [4, 5, 6, 7, 8], s => (s === 4 ? [['guesser', 'right'], ['guesser', 'wrong'], ['other'], ['tie', 'wrong']] : s === 8 ? [['guesser', 'wrong'], ['tie', 'right']] : [['guesser', 'wrong']]));
  await run('normal', [6], () => [['tie2', 'wrong'], ['tie2', 'right']]);
  await run('fool', [4, 5, 6, 7, 8], s => (s === 4 ? [['guesser', 'right'], ['guesser', 'wrong'], ['other']] : s === 8 ? [['other'], ['tie', 'wrong']] : [['guesser', 'wrong']]));
  await run('spy', [5, 6, 7, 8], s => (s === 5 ? [['guesser', 'right'], ['guesser', 'wrong'], ['other'], ['spy']] : s === 8 ? [['guesser', 'wrong'], ['tie', 'right']] : [['other']]));
  summary.forEach(l => console.log('  ✓ ' + l));
  console.log(`\n✓ 각 판마다: 역할 수 확인, 비밀 정보 비공개 확인, 라운드별 무작위 발표 순서·동률 최종 투표, 차례·제시어·중복 투표·자기 투표 거부, 투표 완료 전 집계 비공개, 결과 공개`);
  console.log('✓ 매 인원마다 연결 끊김 → 재접속 후 같은 자리 복귀');
  console.log(`\n모든 테스트 통과 · 총 ${summary.length}판, 검증 ${checks}건`);
  process.exit(0);
})().catch(e => { console.error('실패:', e); process.exit(1); });
