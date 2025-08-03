const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('./oogiri-game-firebase-adminsdk-fbsvc-4c8e79b44b.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

function randomId(len = 20) {
  return [...Array(len)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join('');
}

const THEMES = [
  "最近笑ったこと", "好きなゲーム", "子供の頃の夢", "明日やりたいこと", "変なクセ", "秘密の特技", "もしも透明人間なら", "理想の休日",
  "面白い失敗談", "最近のマイブーム", "学生時代の思い出", "驚いた話", "一番好きな食べ物", "好きな言葉", "友達に言われて嬉しかったこと", "人生で一度はやってみたいこと"
];
const HAND_GENERAL = ["ネコ", "電車", "カレー", "先生", "山", "テレビ", "アイス", "本", "家族", "温泉", "ピザ", "スマホ"];
const HAND_FUNNY = ["うんち", "宇宙人", "ドーナツ枕", "変顔", "屁", "ゴリラ"];
const HAND_ADVERB = ["すごく", "こっそり", "なぜか", "たまたま", "突然"];
const HAND_VERB = ["走る", "食べる", "歌う", "飛ぶ", "踊る", "叫ぶ"];
const PARTICLES = ["に", "は", "を", "が", "の", "へ", "と", "より", "から", "で"];

function randomFromArray(arr, n) {
  const a = [...arr];
  let r = [];
  while (r.length < n && a.length) {
    const i = Math.floor(Math.random() * a.length);
    r.push(a.splice(i, 1)[0]);
  }
  return r;
}

app.post('/api/rooms', async (req, res) => {
  const { roomName, hostName } = req.body;
  const roomId = randomId(8);
  await db.collection('rooms').doc(roomId).set({
    roomName, started: false, phase: 'waiting', round: 1, roundMax: 5, createdAt: Date.now()
  });
  const userId = randomId(16);
  await db.collection('users').doc(userId).set({
    roomId, userName: hostName, isHost: true, points: 0, hand: [], usedParticle: null
  });
  res.json({ roomId, userId });
});

app.get('/api/rooms/list', async (req, res) => {
  const snap = await db.collection('rooms').get();
  const arr = [];
  snap.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
  res.json(arr);
});

app.post('/api/rooms/:roomId/join', async (req, res) => {
  const { userName } = req.body;
  const userId = randomId(16);
  await db.collection('users').doc(userId).set({
    roomId: req.params.roomId, userName, isHost: false, points: 0, hand: [], usedParticle: null
  });
  res.json({ userId });
});

app.post('/api/rooms/:roomId/start', async (req, res) => {
  const roomId = req.params.roomId;
  await db.collection('rooms').doc(roomId).update({
    started: true, phase: 'theme_vote', round: 1
  });
  const userSnap = await db.collection('users').where('roomId', '==', roomId).get();
  for (const u of userSnap.docs) {
    const hand = [
      ...randomFromArray(HAND_GENERAL, 4),
      ...randomFromArray(HAND_FUNNY, 2),
      randomFromArray(HAND_ADVERB, 1)[0],
      ...randomFromArray(HAND_VERB, 2)
    ];
    await db.collection('users').doc(u.id).update({ hand, usedParticle: null });
  }
  const themes = randomFromArray(THEMES, 6);
  await db.collection('rounds').doc(`${roomId}_1`).set({
    round: 1, roomId, themes, themeVotes: {}, theme: "", answers: {}, votes: {}, answerRevealOrder: [], result: {}
  });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/theme-vote', async (req, res) => {
  const { userId, themeIndex } = req.body;
  const roundDoc = db.collection('rounds').doc(`${req.params.roomId}_${req.params.round}`);
  await roundDoc.update({ [`themeVotes.${userId}`]: themeIndex });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/answer-reveal', async (req, res) => {
  const roundId = `${req.params.roomId}_${req.params.round}`;
  const roundRef = db.collection('rounds').doc(roundId);
  const round = (await roundRef.get()).data();
  const votes = round.themeVotes || {};
  const themes = round.themes || [];
  const counts = Array(themes.length).fill(0);
  Object.values(votes).forEach(idx => { if (typeof idx === "number") counts[idx]++; });
  let max = Math.max(...counts);
  let candidateIdxs = counts.map((c, i) => c === max ? i : -1).filter(i => i >= 0);
  let themeIndex = candidateIdxs[0];
  for (const uid of Object.keys(votes)) {
    if (candidateIdxs.includes(votes[uid])) { themeIndex = votes[uid]; break; }
  }
  const theme = themes[themeIndex] || themes[0] || "";
  await roundRef.update({ theme });
  await db.collection('rooms').doc(req.params.roomId).update({ phase: 'theme_reveal' });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/answer-phase', async (req, res) => {
  await db.collection('rooms').doc(req.params.roomId).update({ phase: 'answer' });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/answer', async (req, res) => {
  const { userId, answer, usedWords } = req.body;
  const roundId = `${req.params.roomId}_${req.params.round}`;
  const roundRef = db.collection('rounds').doc(roundId);
  await roundRef.update({ [`answers.${userId}`]: { answer, usedWords } });

  // 自動進行：全員が回答したらフェーズ遷移
  const room = (await db.collection('rooms').doc(req.params.roomId).get()).data();
  const userSnap = await db.collection('users').where('roomId', '==', req.params.roomId).get();
  const totalPlayers = userSnap.docs.length;
  const round = (await roundRef.get()).data();
  if (Object.keys(round.answers||{}).length === totalPlayers) {
    // ホストのリクエスト時のみ遷移
    for (const u of userSnap.docs) {
      if (u.data().isHost) {
        await db.collection('rooms').doc(req.params.roomId).update({ phase: 'answer_reveal' });
        // 回答順ランダム生成
        const answerOrder = Object.keys(round.answers || {});
        for (let i = answerOrder.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [answerOrder[i], answerOrder[j]] = [answerOrder[j], answerOrder[i]];
        }
        await roundRef.update({ answerRevealOrder: answerOrder });
        break;
      }
    }
  }
  res.json({ ok: true });
});

app.post('/api/users/:userId/particle', async (req, res) => {
  const { usedParticle } = req.body;
  await db.collection('users').doc(req.params.userId).update({ usedParticle });
  res.json({ ok: true });
});

// ポイントリセット
app.post('/api/users/:userId', async (req, res) => {
  const { points } = req.body;
  await db.collection('users').doc(req.params.userId).update({ points });
  res.json({ ok: true });
});

// allチェンジAPI
app.post('/api/users/:userId/hand', async (req, res) => {
  const { changeType, cardIdx, keepIdx } = req.body;
  const userRef = db.collection('users').doc(req.params.userId);
  const user = (await userRef.get()).data();
  let hand = [...user.hand];
  if (changeType === "one" && typeof cardIdx === "number" && cardIdx >= 0 && cardIdx < hand.length) {
    let newCard = "";
    if (cardIdx < 4) newCard = randomFromArray(HAND_GENERAL, 1)[0];
    else if (cardIdx < 6) newCard = randomFromArray(HAND_FUNNY, 1)[0];
    else if (cardIdx == 6) newCard = randomFromArray(HAND_ADVERB, 1)[0];
    else newCard = randomFromArray(HAND_VERB, 1)[0];
    hand[cardIdx] = newCard;
    await userRef.update({ hand });
    res.json({ ok: true, hand });
  } else if (changeType === "all") {
    let newHand = [
      ...randomFromArray(HAND_GENERAL, 4),
      ...randomFromArray(HAND_FUNNY, 2),
      randomFromArray(HAND_ADVERB, 1)[0],
      ...randomFromArray(HAND_VERB, 2)
    ];
    if (Array.isArray(keepIdx)) {
      for (let i = 0; i < hand.length; ++i) {
        if (keepIdx.includes(i)) newHand[i] = hand[i];
      }
    }
    await userRef.update({ hand: newHand });
    res.json({ ok: true, hand: newHand });
  } else {
    res.status(400).json({ error: "Invalid request" });
  }
});

app.post('/api/rooms/:roomId/rounds/:round/answer-reveal-phase', async (req, res) => {
  const roundId = `${req.params.roomId}_${req.params.round}`;
  const round = (await db.collection('rounds').doc(roundId).get()).data();
  const answerOrder = Object.keys(round.answers || {});
  for (let i = answerOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerOrder[i], answerOrder[j]] = [answerOrder[j], answerOrder[i]];
  }
  await db.collection('rounds').doc(roundId).update({ answerRevealOrder: answerOrder });
  await db.collection('rooms').doc(req.params.roomId).update({ phase: 'answer_reveal' });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/vote-phase', async (req, res) => {
  await db.collection('rooms').doc(req.params.roomId).update({ phase: 'vote' });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/vote', async (req, res) => {
  const { userId, voteForUserId } = req.body;
  const roundRef = db.collection('rounds').doc(`${req.params.roomId}_${req.params.round}`);
  await roundRef.update({ [`votes.${userId}`]: voteForUserId });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/rounds/:round/result-phase', async (req, res) => {
  const roundId = `${req.params.roomId}_${req.params.round}`;
  const roundRef = db.collection('rounds').doc(roundId);
  const round = (await roundRef.get()).data();
  const votes = round.votes || {};
  let cnts = {};
  Object.values(votes).forEach(uid => {
    if (!cnts[uid]) cnts[uid] = 0;
    cnts[uid]++;
  });
  await roundRef.update({ result: cnts });

  // ポイント加算（得票最多→全員1ptに修正）
  const maxVote = Math.max(...Object.values(cnts), 0);
  const winners = Object.entries(cnts).filter(([k,v]) => v === maxVote).map(([k])=>k);
  const userSnap = await db.collection('users').where('roomId', '==', req.params.roomId).get();
  for (const u of userSnap.docs) {
    let p = u.data().points || 0;
    if (winners.includes(u.id)) p += 1;
    await db.collection('users').doc(u.id).update({ points: p });
  }
  await db.collection('rooms').doc(req.params.roomId).update({ phase: 'result' });
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/next', async (req, res) => {
  const room = (await db.collection('rooms').doc(req.params.roomId).get()).data();
  let round = room.round + 1;
  if (round > room.roundMax) {
    await db.collection('rooms').doc(req.params.roomId).update({ phase: 'end' });
    return res.json({ ok: true });
  }
  await db.collection('rooms').doc(req.params.roomId).update({ phase: 'theme_vote', round });
  // 手札・usedParticleリセット
  const userSnap = await db.collection('users').where('roomId', '==', req.params.roomId).get();
  for (const u of userSnap.docs) {
    const hand = [
      ...randomFromArray(HAND_GENERAL, 4),
      ...randomFromArray(HAND_FUNNY, 2),
      randomFromArray(HAND_ADVERB, 1)[0],
      ...randomFromArray(HAND_VERB, 2)
    ];
    await db.collection('users').doc(u.id).update({ hand, usedParticle: null });
  }
  // 新ラウンド
  const themes = randomFromArray(THEMES, 6);
  await db.collection('rounds').doc(`${req.params.roomId}_${round}`).set({
    round, roomId: req.params.roomId, themes, themeVotes: {}, theme: "", answers: {}, votes: {}, answerRevealOrder: [], result: {}
  });
  res.json({ ok: true });
});

// ▼▼▼【再戦エンドポイント（完全リセット）】▼▼▼
app.post('/api/rooms/:roomId/restart', async (req, res) => {
  const roomId = req.params.roomId;

  // 1. ルーム状態リセット
  await db.collection('rooms').doc(roomId).update({
    phase: 'theme_vote',
    round: 1,
    started: true
  });

  // 2. 全ユーザーのポイント・手札・助詞リセット
  const userSnap = await db.collection('users').where('roomId', '==', roomId).get();
  for (const u of userSnap.docs) {
    const hand = [
      ...randomFromArray(HAND_GENERAL, 4),
      ...randomFromArray(HAND_FUNNY, 2),
      randomFromArray(HAND_ADVERB, 1)[0],
      ...randomFromArray(HAND_VERB, 2)
    ];
    await db.collection('users').doc(u.id).update({ points: 0, hand, usedParticle: null });
  }

  // 3. 全ラウンド削除
  const roundsSnap = await db.collection('rounds').where('roomId', '==', roomId).get();
  const batch = db.batch();
  roundsSnap.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  // 4. 新ラウンド1生成
  const themes = randomFromArray(THEMES, 6);
  await db.collection('rounds').doc(`${roomId}_1`).set({
    round: 1, roomId, themes, themeVotes: {}, theme: "", answers: {}, votes: {}, answerRevealOrder: [], result: {}
  });

  res.json({ ok: true });
});
// ▲▲▲【再戦エンドポイントここまで】▲▲▲

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server started on http://localhost:' + PORT);
});
