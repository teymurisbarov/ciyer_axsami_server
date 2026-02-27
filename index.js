const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
app.use(express.json());
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const rooms = {};
const dealCards = (players) => {
  const deck = [];
  const suits = ['heart', 'brick', 'diamond', 'club'];
  const ranks = ['6', '7', '8', '9', '10', 'B', 'D', 'K', 'T'];
  for (let s of suits) for (let r of ranks) deck.push({ rank: r, suit: s });
  deck.sort(() => Math.random() - 0.5);
  const result = {};
  players.forEach((p) => { result[p] = [deck.pop(), deck.pop(), deck.pop()];});
  return result;
};
const calculatePoints = (cards) => { 
  if (!cards || cards.length === 0) return 0;
  const ranks = cards.map(c => c.rank);
  if (ranks.filter(r => r === 'T').length === 3) return 33;
  if (ranks.filter(r => r === 'T').length === 2) return 22;
  if (ranks.filter(r => r === '6').length === 3) return 32;
  const value = (r) => { if (r === 'T') return 11; if (['K', 'D', 'B'].includes(r)) return 10; return Number(r); };
  const suits = {};
  cards.forEach(c => {suits[c.suit] = (suits[c.suit] || 0) + value(c.rank);});
  return Math.max(...Object.values(suits));
};

mongoose.connect("mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/ciyerAxsami")
  .then(() => console.log('MongoDB qoşuldu'))
  .catch(err => console.log('MongoDB error:', err));
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true },
  phone: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);
const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  limit: { type: Number, min: 2, max: 10, required: true },
  minAmount: { type: Number, min: 0.2, required: true },
  players: [{ type: String }],
  createdBy: { type: String, required: true }
});
const Room = mongoose.model('Room', RoomSchema);
app.post('/register', async (req, res) => {
  const { email, phone, username, password } = req.body;
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ message: 'Bu username artıq mövcuddur' });
    const newUser = new User({ email, phone, username, password });
    await newUser.save();
    res.json({ message: 'Qeydiyyat uğurlu oldu', user: newUser });
  } catch (err) {
      res.status(500).json({ message: 'Server xətası', error: err.message });
    }
});
app.post('/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;
  const user = await User.findOne({
    $or: [{ email: emailOrPhone }, { phone: emailOrPhone }],
    password
  });
  if (user) {
    res.json({ message: 'Giriş uğurlu oldu', balance: user.balance, username: user.username });
  } else {
    res.status(400).json({ message: 'Email/Telefon və ya parol səhvdir' });
  }
});

app.get('/rooms', async (req, res) => {
  try {
    await Room.deleteMany({ players: { $size: 0 } });
    const roomsList = await Room.find();
    res.json(roomsList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/rooms', async (req, res) => {
  try {
    const { name, limit, minBet, createdBy } = req.body;

    if (limit < 2 || limit > 10) return res.status(400).json({ message: 'Limit 2-10 arası olmalıdır' });
    if (minBet < 0.2) return res.status(400).json({ message: 'Minimum giriş 0.20 olmalıdır' });

    const newRoom = new Room({
      name,
      limit,
      minAmount: minBet,
      players: [createdBy],
      createdBy
    });

    await newRoom.save();
    res.status(201).json(newRoom);
  } catch (err) {
    res.status(500).json({ message: 'Server xətası', error: err.message });
  }
});

app.get('/rooms/:id', async (req, res) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) return res.status(404).json({ message: 'Otaq tapılmadı' });
    res.json(room);
  } catch (err) {
    res.status(500).json({ message: 'Server xətası', error: err.message });
  }
});

app.post('/join-room/:id', async (req, res) => {
  const { username } = req.body;
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Otaq tapılmadı' });
  if (room.players.length >= room.limit) return res.status(400).json({ message: 'Otaq doludur' });

  room.players.push(username);
  await room.save();
  res.json(room);
});

app.post('/leave-room/:id', async (req, res) => {
  const { username } = req.body;
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Otaq tapılmadı' });

  room.players = room.players.filter(p => p !== username);

  if (room.players.length === 0) {
    await Room.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Otaq silindi' });
  }

  await room.save();
  res.json(room);
});

app.get('/user/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ message: 'User tapılmadı' });
    res.json({ username: user.username, balance: user.balance });
  } catch (err) {
    res.status(500).json({ message: 'Server xətası', error: err.message });
  }
});

// =====================
// SOCKET GAME LOGIC
// =====================
const safeNumber = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

const emitBalances = async (roomId) => {
  const r = rooms[roomId];
  if (!r) return;

  // RAM-da olan allPlayers balansını DB-dən yenilə (sadə)
  for (const p of r.allPlayers) {
    const u = await User.findOne({ username: p.username });
    p.balance = u?.balance ?? 0;
  }
  io.to(roomId).emit('updatePlayerList', r.allPlayers);
};

const ensureRoomState = (roomId) => {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      allPlayers: [],          // [{username,balance}]
      roundPlayers: [],        // joinRound-a basanlar (timer 10s müddətdə)
      timerActive: false,
      countdown: 0,

      activePlayers: [],       // raund başlayanda sabitlənir (seka ilə sonradan arta bilər)
      turnIndex: 0,
      turnTime: 30,
      turnTimer: null,

      lastWinner: null,
      lastBet: 0,

      pot: 0,                  // oyun içi "çip" potu
      cards: null,

      // SEKA / 50-50
      sekaMode: false,
      sekaOfferFrom: null,
      halfOfferFrom: null,
    };
  }
};

const stopTurnTimer = (r) => {
  if (r?.turnTimer) clearInterval(r.turnTimer);
  r.turnTimer = null;
};

const startTurnTimer = (roomId) => {
  const r = rooms[roomId];
  if (!r) return;

  stopTurnTimer(r);
  r.turnTime = 30;

  r.turnTimer = setInterval(() => {
    io.to(roomId).emit('turnTimer', r.turnTime);
    r.turnTime--;

    if (r.turnTime < 0) {
      stopTurnTimer(r);

      if (!r.activePlayers || r.activePlayers.length === 0) return;

      r.turnIndex = (r.turnIndex + 1) % r.activePlayers.length;
      const nextUser = r.activePlayers[r.turnIndex];
      io.to(roomId).emit('turnChanged', nextUser);

      // yenidən timer
      startTurnTimer(roomId);
    }
  }, 1000);
};

const endRound = async (roomId, winnerUsername, scoreLabel) => {
  const r = rooms[roomId];
  if (!r) return;

  r.lastWinner = winnerUsername;

  // kartları aç
  if (r.cards) io.to(roomId).emit('showCards', r.cards);

  io.to(roomId).emit('roundWinner', {
    winner: winnerUsername,
    winnerUsername,
    score: scoreLabel
  });

  // pot qalibə (balans oyun içi çip kimidir)
  if (winnerUsername) {
    const user = await User.findOne({ username: winnerUsername });
    if (user) {
      user.balance += safeNumber(r.pot);
      await user.save();
    }
  }

  r.pot = 0;
  io.to(roomId).emit('updatePot', 0);
  await emitBalances(roomId);

  // raund reset (4 saniyə sonra)
  setTimeout(async () => {
    const rr = rooms[roomId];
    if (!rr) return;

    rr.roundPlayers = [];
    rr.activePlayers = [];
    rr.lastBet = 0;
    const roomDB=await Room.findById(roomId);
    rr.lastBet=roomDB.minAmount;
    rr.cards = null;
    rr.sekaMode = false;
    rr.sekaOfferFrom = null;
    rr.halfOfferFrom = null;

    stopTurnTimer(rr);

    io.to(roomId).emit('newRound');
  }, 4000);
};

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // Otağa giriş
  socket.on('joinRoom', async ({ roomId, username }) => {
    if (!roomId || !username) return;

    ensureRoomState(roomId);

    socket.join(roomId);

    const user = await User.findOne({ username });
    const balance = user?.balance ?? 0;

    // Duplicate olmasın
    const r = rooms[roomId];
    const exists = r.allPlayers.find(p => p.username === username);
    if (!exists) r.allPlayers.push({ username, balance });
    else exists.balance = balance;

    currentRoom = roomId;
    currentUser = username;

    io.to(roomId).emit('updatePlayerList', r.allPlayers);
    io.to(roomId).emit('updatePot', r.pot || 0);
  });
  socket.on('skipTurn',({roomId,username})=>{

const r=rooms[roomId];

if(!r) return;

const turnUser=
r.activePlayers[r.turnIndex];

if(turnUser!==username)
return;


stopTurnTimer(r);

r.turnIndex=
(r.turnIndex+1)%
r.activePlayers.length;

const nextUser=
r.activePlayers[r.turnIndex];

io.to(roomId).emit(
'turnChanged',
nextUser
);

startTurnTimer(roomId);

});
  // Manual çıxış
  socket.on('leaveRoom', async ({ roomId, username }) => {
    try {
      if (!roomId || !username) return;

      // DB
      const room = await Room.findById(roomId);
      if (room) {
        room.players = room.players.filter(p => p !== username);
        if (room.players.length === 0) {
          await Room.findByIdAndDelete(roomId);
          delete rooms[roomId];
          socket.leave(roomId);
          return;
        }
        await room.save();
      }

      // RAM
      if (rooms[roomId]) {
        rooms[roomId].allPlayers = rooms[roomId].allPlayers.filter(p => p.username !== username);
        rooms[roomId].roundPlayers = rooms[roomId].roundPlayers.filter(u => u !== username);
        rooms[roomId].activePlayers = rooms[roomId].activePlayers.filter(u => u !== username);

        io.to(roomId).emit('updatePlayerList', rooms[roomId].allPlayers);

        // əgər raundda 1 nəfər qalıbsa qalib elə
        if (rooms[roomId].activePlayers.length === 1) {
          const winner = rooms[roomId].activePlayers[0];
          await endRound(roomId, winner, "Opponent left");
        }
      }

      socket.leave(roomId);
    } catch (e) {
      console.log("leaveRoom error", e);
    }
  });

  // Raunda qoşulma (10 saniyə sayım üçün)
  socket.on('joinRound', async ({ roomId, username, amount }) => {
    ensureRoomState(roomId);
    const r = rooms[roomId];
    if (!r || !username) return;

    const roomDB = await Room.findById(roomId);
    const minAmount = roomDB?.minAmount ?? 0.2;

    const joinAmount = safeNumber(amount);

    // minimum
    if (joinAmount < minAmount) return;

    // sekaMode aktivdirsə => yarı pot qədər minimum
    if (r.sekaMode) {
      const needed = Math.max(minAmount, safeNumber(r.pot) / 2);
      if (joinAmount < needed) return;
    }

    // eyni user 2 dəfə girməsin
    if (!r.roundPlayers.includes(username)) {
      r.roundPlayers.push(username);
      r.pot = safeNumber(r.pot) + joinAmount;
      io.to(roomId).emit('updatePot', r.pot);
    }

    // minimum 2 nəfər => 10s countdown başlasın
    if (r.roundPlayers.length >= 2 && !r.timerActive) {
      r.timerActive = true;
      r.countdown = 10;

      const roundInterval = setInterval(async () => {
        io.to(roomId).emit('roundCountdown', r.countdown);
        r.countdown--;

        if (r.countdown < 0) {
          clearInterval(roundInterval);

          // raund başladı
          r.activePlayers = [...r.roundPlayers];
          r.lastBet = minAmount; // minimum mərc start
          r.sekaMode = false;
          r.sekaOfferFrom = null;
          r.halfOfferFrom = null;

          // starter: lastWinner varsa o, yoxsa ilk daxil olan
          let starter = r.lastWinner || r.activePlayers[0];
          r.turnIndex = Math.max(0, r.activePlayers.indexOf(starter));

          r.cards = dealCards(r.activePlayers);

          io.to(roomId).emit('roundStarted', r.cards);
          io.to(roomId).emit('activePlayersUpdate', r.activePlayers);

          io.to(roomId).emit('turnChanged', starter);
          startTurnTimer(roomId);

          // reset join-phase
          r.timerActive = false;
          r.roundPlayers = [];
        }
      }, 1000);
    }
  });

  // Mərc (növbəli)
  socket.on('makeMove', async (data) => {
    const { roomId, username, amount } = data || {};
    const r = rooms[roomId];
    if (!r) return;

    // növbə yoxlaması
    const turnUser = r.activePlayers[r.turnIndex];
    if (turnUser !== username) {
      io.to(socket.id).emit('notYourTurn', { currentTurn: turnUser });
      return;
    }

    const bet = safeNumber(amount);
    if (bet < safeNumber(r.lastBet)) return;

    // pot artır + lastBet
    r.lastBet = bet;
    r.pot = safeNumber(r.pot) + bet;
    io.to(roomId).emit('updatePot', r.pot);

    // timeri dayandır
    stopTurnTimer(r);

    // 2 nəfər qalırsa => qərar mərhələsi (Kartı Aç / Keç)
    if (r.activePlayers.length === 2) {
      let decisionSeconds = r.turnTime;
      if (decisionSeconds > 10) decisionSeconds = 10;
      if (decisionSeconds < 1) decisionSeconds = 10;

      io.to(roomId).emit('openDecision', {
        seconds: decisionSeconds,
        turnUser: username
      });
      return;
    }

    // 3+ => dərhal növbə keçir
    r.turnIndex = (r.turnIndex + 1) % r.activePlayers.length;
    const nextUser = r.activePlayers[r.turnIndex];
    io.to(roomId).emit('turnChanged', nextUser);
    startTurnTimer(roomId);
  });

  // PAS (istənilən vaxt, amma təsiri raunddadır)
  socket.on('passDecision', async ({ roomId, username }) => {
    const r = rooms[roomId];
    if (!r || !username) return;

    // əgər raund yoxdursa heç nə eləmə
    if (!r.activePlayers || r.activePlayers.length === 0) return;

    // PAS edən çıxır
    r.activePlayers = r.activePlayers.filter(p => p !== username);
    io.to(roomId).emit('activePlayersUpdate', r.activePlayers);

    // 1 nəfər qalıbsa qalib
    if (r.activePlayers.length === 1) {
      const winner = r.activePlayers[0];
      await endRound(roomId, winner, "Opponent PAS");
      return;
    }

    // növbə indeksini düzəlt
    if (r.turnIndex >= r.activePlayers.length) r.turnIndex = 0;

    // növbə keçsin
    const nextUser = r.activePlayers[r.turnIndex];
    io.to(roomId).emit('turnChanged', nextUser);
    startTurnTimer(roomId);
  });

  // Kartları aç (2 oyunçuda qərar mərhələsi)
  socket.on('openCards', async ({ roomId }) => {
    const r = rooms[roomId];
    if (!r || !r.cards) return;

    io.to(roomId).emit('showCards', r.cards);

    // xal hesabla
    const users = Object.keys(r.cards);
    if (users.length < 2) return;

    const scores = users.map(u => ({ u, s: calculatePoints(r.cards[u]) }));

    // 2 oyunçu bərabərdirsə => SEKA say, kartları yenilə, növbəni o birinə keç
    if (r.activePlayers.length === 2) {
      const a = r.activePlayers[0];
      const b = r.activePlayers[1];
      const sa = calculatePoints(r.cards[a]);
      const sb = calculatePoints(r.cards[b]);

      if (sa === sb) {
        // sekaRound event
        io.to(roomId).emit('sekaRound', { score: sa });

        // kartlar sıfırlansın (yenidən payla)
        r.cards = dealCards(r.activePlayers);
        io.to(roomId).emit('roundStarted', r.cards);

        // növbə: kartı açdıran digərinə
        const currentTurn = r.activePlayers[r.turnIndex];
        r.turnIndex = currentTurn === a ? 1 : 0;
        const nextUser = r.activePlayers[r.turnIndex];
        io.to(roomId).emit('turnChanged', nextUser);

        startTurnTimer(roomId);
        return;
      }
    }

    // qalibi tap
    let winner = null;
    let maxScore = -1;

    for (const it of scores) {
      if (it.s > maxScore) {
        maxScore = it.s;
        winner = it.u;
      }
    }

    await endRound(roomId, winner, maxScore);
  });

  // =====================
  // SEKA / 50-50 (yalnız 2 nəfər qalanda)
  // =====================
  socket.on('sekaRequest', ({ roomId, username }) => {
    const r = rooms[roomId];
    if (!r || r.activePlayers.length !== 2) return;

    // yalnız növbədə olan istəsin
    const turnUser = r.activePlayers[r.turnIndex];
    if (turnUser !== username) return;

    r.sekaOfferFrom = username;
    const opponent = r.activePlayers.find(u => u !== username);

    io.to(roomId).emit('sekaOffer', { from: username, to: opponent });
  });

  socket.on('sekaRespond', ({ roomId, username, accept }) => {
    const r = rooms[roomId];
    if (!r || r.activePlayers.length !== 2) return;

    const offerFrom = r.sekaOfferFrom;
    if (!offerFrom) return;

    const opponent = r.activePlayers.find(u => u !== offerFrom);
    if (username !== opponent) return;

    if (accept) {
      r.sekaMode = true;
      io.to(roomId).emit('sekaStarted', { pot: r.pot });
    } else {
      r.sekaMode = false;
      io.to(roomId).emit('sekaDeclined', { from: username });
    }

    r.sekaOfferFrom = null;
  });

  // SEKA başlayanda digərləri yarı potla daxil olsun (joinRound istifadə edir, sadəcə sekaMode=true olmalıdır)
  // Burada sadəcə "sekaMode" aktiv olanda joinRound min = pot/2 edir (yuxarıda yazdıq).

  socket.on('halfRequest', ({ roomId, username }) => {
    const r = rooms[roomId];
    if (!r || r.activePlayers.length !== 2) return;

    const turnUser = r.activePlayers[r.turnIndex];
    if (turnUser !== username) return;

    r.halfOfferFrom = username;
    const opponent = r.activePlayers.find(u => u !== username);

    io.to(roomId).emit('halfOffer', { from: username, to: opponent });
  });

  socket.on('halfRespond', async ({ roomId, username, accept }) => {
    const r = rooms[roomId];
    if (!r || r.activePlayers.length !== 2) return;

    const offerFrom = r.halfOfferFrom;
    if (!offerFrom) return;

    const opponent = r.activePlayers.find(u => u !== offerFrom);
    if (username !== opponent) return;

    if (!accept) {
      io.to(roomId).emit('halfDeclined', { from: username });
      r.halfOfferFrom = null;
      return;
    }

    // qəbul: pot yarı bölünsün iki oyunçuya
    const half = safeNumber(r.pot) / 2;

    for (const uName of r.activePlayers) {
      const u = await User.findOne({ username: uName });
      if (u) {
        u.balance += half;
        await u.save();
      }
    }

    r.pot = 0;
    io.to(roomId).emit('updatePot', 0);
    await emitBalances(roomId);

    // raund bitir
    r.lastWinner = null;
    r.roundPlayers = [];
    r.activePlayers = [];
    r.lastBet = 0;
    r.cards = null;
    r.sekaMode = false;
    r.sekaOfferFrom = null;
    r.halfOfferFrom = null;
    stopTurnTimer(r);

    io.to(roomId).emit('newRound');
  });

  

  // SEKA raunduna ortadan qoşulma (sekaMode aktiv olanda)
  socket.on('joinSeka', ({ roomId, username, amount }) => {
    const r = rooms[roomId];
    if (!r || !username) return;
    if (!r.sekaMode) return;
    if (!r.activePlayers || r.activePlayers.length < 2) return;
    if (!r.cards) return;

    const joinAmount = safeNumber(amount);
    const needed = safeNumber(r.pot) / 2;
    if (joinAmount < needed) return;

    if (r.activePlayers.includes(username)) return;

    // pot artır
    r.pot = safeNumber(r.pot) + joinAmount;
    io.to(roomId).emit('updatePot', r.pot);

    // aktiv oyunçu siyahısına əlavə et
    r.activePlayers.push(username);

    // Sadəlik üçün hamıya kartları yenidən paylayırıq (prototype)
    const currentTurnUser = r.activePlayers[r.turnIndex] || r.activePlayers[0];
    r.cards = dealCards(r.activePlayers);

    io.to(roomId).emit('activePlayersUpdate', r.activePlayers);
    io.to(roomId).emit('roundStarted', r.cards);
    io.to(roomId).emit('turnChanged', currentTurnUser);
  });

// Disconnect
  socket.on('disconnect', () => {
    if (currentRoom && currentUser) {
      socket.emit('leaveRoom', { roomId: currentRoom, username: currentUser });
    }
  });
});

server.listen(5000, () => console.log('Server 5000 portunda işləyir'));
