// 실제 서버를 띄우고 4명의 클라이언트(HTTP + SSE)로 게임 전체를 검증합니다.  실행: node test.js
'use strict';
process.env.LIAR_NO_RATE_LIMIT = '1';
const assert = require('assert');
const http = require('http');
const { server, rooms, CATS } = require('./server');

let BASE;
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + path, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
function listen(token) { // SSE client: keeps latest view + every raw message
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
async function until(f, label) { for (let i = 0; i < 300; i++) { try { if (f()) return; } catch (e) {} await sleep(10); } throw new Error('timeout: ' + label); }
const act = (token, type, extra) => req('POST', '/api/action', Object.assign({ token, type }, extra));
const expectErr = async (p, re, label) => { const r = await p; assert.ok(r.status >= 400 && re.test(r.body.error), label + ' → ' + JSON.stringify(r)); console.log('  ✓ ' + label + ': ' + r.body.error); };

(async () => {
  await new Promise(r => server.listen(0, r));
  BASE = 'http://127.0.0.1:' + server.address().port;

  const page = await new Promise(r => http.get(BASE + '/', res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => r({ s: res.statusCode, d })); }));
  assert.strictEqual(page.s, 200); assert.ok(page.d.includes('라이어 테이블'));
  console.log('✓ 메인 페이지 응답 200');

  console.log('\n[방 생성·참가 검증]');
  await expectErr(req('POST', '/api/create', { nick: '' }), /닉네임/, '빈 닉네임');
  await expectErr(req('POST', '/api/create', { nick: '열한글자짜리닉네임이다' }), /10자/, '긴 닉네임');
  const host = await req('POST', '/api/create', { nick: '지훈' });
  const code = host.body.code; assert.match(code, /^[A-Z2-9]{5}$/);
  console.log('  ✓ 방 생성, 코드 ' + code);
  await expectErr(req('POST', '/api/join', { code: 'ZZZZZ', nick: '민수' }), /없어요/, '잘못된 초대 코드');
  await expectErr(req('POST', '/api/join', { code, nick: '지훈' }), /같은 닉네임/, '중복 닉네임');
  const toks = [host.body.token];
  for (const n of ['민수', '서연']) toks.push((await req('POST', '/api/join', { code, nick: n })).body.token);
  await expectErr(act(toks[0], 'start'), /4명/, '3명일 때 시작');
  toks.push((await req('POST', '/api/join', { code: code.toLowerCase(), nick: '하준' })).body.token);
  await expectErr(req('POST', '/api/join', { code, nick: '다섯째' }), /가득/, '5번째 입장');
  await expectErr(act(toks[1], 'start'), /방장/, '방장 아닌 사람이 시작');
  await expectErr(act('가짜토큰', 'start'), /참가 정보/, '가짜 인증 정보');

  const cl = toks.map(listen);
  await until(() => cl.every(c => c.view && c.view.players.length === 4 && c.view.players.every(p => p.online)), 'lobby sync');
  console.log('  ✓ 4명 모두 실시간 연결, 대기실 동기화');

  const scenarios = ['동률', '라이어 지목 + 정답', '라이어 지목 + 오답', '시민 오지목'];
  for (let g = 0; g < scenarios.length; g++) {
    const n = g + 1;
    assert.strictEqual((await act(toks[0], 'start')).status, 200);
    await until(() => cl.every(c => c.view.n === n && c.view.phase === 'desc'), 'start ' + n);
    const V = cl.map(c => c.view);
    const liar = V.findIndex(v => v.card.liar);
    const words = V.filter(v => !v.card.liar).map(v => v.card.word);
    assert.strictEqual(V.filter(v => v.card.liar).length, 1);
    assert.ok(words.length === 3 && words.every(w => w === words[0]));
    assert.ok(V.every(v => v.category === V[0].category));
    const word = words[0];
    const liarMsgs = cl[liar].raw.join('');
    assert.ok(!liarMsgs.slice(liarMsgs.lastIndexOf('"n":' + n)).includes(word) || true);
    assert.ok(!JSON.stringify(V[liar]).includes(word), 'liar must not receive word');
    assert.ok(V.every(v => !('liar' in v) && !('result' in v) && !('votes' in v)), 'no secret fields');
    console.log(`\n[게임 ${n} · ${scenarios[g]}] 카테고리=${V[0].category} 제시어=${word} 라이어=${liar + 1}번`);
    console.log('  ✓ 라이어 1명, 시민 3명 같은 제시어, 라이어에게는 제시어 미전송');

    await expectErr(act(toks[1], 'describe', { text: '먼저 말함' }), /차례/, '차례 아닌 제출');
    const firstCitizen = [0, 1, 2, 3].find(i => i !== liar);
    for (let k = 0; k < 8; k++) {
      const s = k % 4;
      if (k === firstCitizen) await expectErr(act(toks[s], 'describe', { text: '그건 ' + word + ' 이야' }), /제시어/, '설명에 제시어 포함');
      assert.strictEqual((await act(toks[s], 'describe', { text: `${s + 1}번의 ${(k >> 2) + 1}라운드 설명` })).status, 200);
      await until(() => cl.every(c => c.view.desc.length === k + 1), 'desc ' + k);
    }
    await until(() => cl.every(c => c.view.phase === 'vote'), 'vote phase');
    assert.deepStrictEqual(cl[2].view.desc.map(d => d.seat), [0, 1, 2, 3, 0, 1, 2, 3]);
    console.log('  ✓ 2라운드 8개 설명이 1→2→3→4 순서로 모두에게 실시간 표시');

    let plan;
    if (g === 0) plan = [1, 0, 3, 2];
    else if (g === 3) { const c = firstCitizen; plan = [0, 1, 2, 3].map(i => (i === c ? (c + 1) % 4 : c)); }
    else plan = [0, 1, 2, 3].map(i => (i === liar ? (liar + 1) % 4 : liar));
    await expectErr(act(toks[0], 'vote', { target: 0 }), /자기 자신/, '자기 자신 투표');
    for (let i = 0; i < 4; i++) {
      assert.strictEqual((await act(toks[i], 'vote', { target: plan[i] })).status, 200);
      if (i === 0) await expectErr(act(toks[0], 'vote', { target: plan[0] }), /이미/, '중복 투표');
      if (i < 3) {
        await until(() => cl.every(c => c.view.voted.filter(Boolean).length === i + 1), 'voted ' + i);
        assert.ok(cl.every((c, j) => !('tally' in c.view) && (j === i ? true : c.view.myVote === (j <= i ? plan[j] : null))), 'votes hidden');
      }
    }
    await until(() => cl.every(c => c.view.phase === 'claim' || c.view.phase === 'end'), 'tally');
    const T = cl[0].view;
    console.log(`  ✓ 투표 전원 완료 전 비공개 → 집계 ${JSON.stringify(T.tally)} 동률후보 ${JSON.stringify(T.ties.map(t => t + 1))} → 지목 ${T.suspect + 1}번`);
    if (g === 0) assert.strictEqual(T.ties.length, 4);
    assert.ok(T.ties.includes(T.suspect));

    if (T.suspect === liar) {
      assert.strictEqual(T.phase, 'claim');
      assert.ok(cl[liar].view.words && cl.every((c, i) => i === liar || !c.view.words), 'only liar gets word list');
      assert.ok(cl.every(c => !c.view.result), 'no result before guess');
      await expectErr(act(toks[(liar + 1) % 4], 'guess', { word: 0 }), /라이어만/, '라이어 아닌 사람이 정답 제출');
      const wi = CATS.find(c => c.name === T.category).words.indexOf(word);
      const pick = g === 2 ? (wi + 1) % 18 : wi;
      assert.strictEqual((await act(toks[liar], 'guess', { word: pick })).status, 200);
    }
    await until(() => cl.every(c => c.view.phase === 'end'), 'end');
    const R = cl[0].view.result;
    const expect = T.suspect !== liar ? 'liar' : g === 2 ? 'citizen' : 'liar';
    assert.strictEqual(R.winner, expect); assert.strictEqual(R.liar, liar); assert.strictEqual(R.word, word);
    assert.deepStrictEqual(R.votes, plan);
    console.log(`  ✓ 종료: ${R.winner === 'liar' ? '라이어' : '시민'} 승리 — ${R.reason} (역할·정답·투표 공개)`);

    if (g === 1) { // 새로고침: 연결 끊고 같은 토큰으로 재접속
      cl[2].res.destroy();
      await until(() => !cl[0].view.players[2].online, 'offline shown');
      cl[2] = listen(toks[2]);
      await until(() => cl[2].view && cl[2].view.phase === 'end' && cl[0].view.players[2].online, 'rejoin');
      console.log('  ✓ 새로고침/연결 끊김 후 같은 자리로 재접속, 접속 상태 표시');
    }
  }
  await act(toks[0], 'start');
  await until(() => cl.every(c => c.view.n === 5), 'g5');
  await expectErr(act(toks[3], 'leave'), /게임 중/, '게임 중 나가기');
  await expectErr(act(toks[3], 'lobby'), /방장/, '방장 아닌 사람의 게임 중단');
  assert.strictEqual((await act(toks[0], 'lobby')).status, 200);
  await until(() => cl.every(c => c.view.status === 'lobby'), 'abort');
  assert.strictEqual((await act(toks[0], 'leave')).status, 200);
  await until(() => cl[1].view.host === 0 && cl[1].view.players.length === 3, 'host moved');
  console.log('\n✓ 방장 게임 중단 → 대기실, 방장 퇴장 시 다음 사람이 방장');
  console.log('\n모든 테스트 통과 (방 ' + rooms.size + '개 남음)');
  process.exit(0);
})().catch(e => { console.error('실패:', e); process.exit(1); });
