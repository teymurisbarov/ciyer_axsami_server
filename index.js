const express = require ('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); // Əlavə et
const { Server } = require('socket.io'); // Əlavə et
const rooms = {};
const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // Bütün bağlantılara icazə ver
});

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  socket.on('joinRoom', ({ roomId, username }) => {
    socket.join(roomId);
    currentRoom = roomId;
    currentUser = username;

    if (!rooms[roomId]) rooms[roomId] = [];
    
    if (!rooms[roomId].includes(username)) {
      rooms[roomId].push(username);
    }

    // Otaqdakı hər kəsə yeni siyahını göndər
    io.to(roomId).emit('updatePlayerList', rooms[roomId]);
    console.log(`${username} daxil oldu:`, rooms[roomId]);
  });

  socket.on('makeMove', (data) => {
    io.to(data.roomId).emit('updateGame', data);
  });
socket.on('joinRound', async ({ roomId, username, amount }) => { 
  if (!rooms[roomId]) return;

  if (!rooms[roomId].roundPlayers) { 
    rooms[roomId].roundPlayers = []; 
    rooms[roomId].countdown = 10;
    rooms[roomId].timerActive = false;
  }

  // Oyunçunu raunda əlavə et
  if (!rooms[roomId].roundPlayers.includes(username)) { 
    rooms[roomId].roundPlayers.push(username); 
    // Hər kəsə kimlərin girdiyini bildir
    io.to(roomId).emit('updateRoundPlayers', rooms[roomId].roundPlayers); 
  }

  // Ən az 2 oyunçu varsa və timer hələ başlamayıbsa
  if (rooms[roomId].roundPlayers.length >= 2 && !rooms[roomId].timerActive) { 
    rooms[roomId].timerActive = true;
    rooms[roomId].countdown = 10;

    let roundInterval = setInterval(() => {
      io.to(roomId).emit('roundCountdown', rooms[roomId].countdown);
      rooms[roomId].countdown--;

      if (rooms[roomId].countdown < 0) {
        clearInterval(roundInterval);
        io.to(roomId).emit('roundStarted', rooms[roomId].roundPlayers);
        // Raund başladıqdan sonra datanı sıfırla ki, növbəti raund üçün hazır olsun
        rooms[roomId].timerActive = false;
        rooms[roomId].roundPlayers = []; 
      }
    }, 1000);
  } 
});
  // Otaqdan çıxma funksiyası
  const leave = (roomId, username) => {
    if (rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(u => u !== username);
      io.to(roomId).emit('updatePlayerList', rooms[roomId]);
      console.log(`${username} çıxdı. Qalanlar:`, rooms[roomId]);
      
      // Otaq boşdursa obyektdən sil
      if (rooms[roomId].length === 0) delete rooms[roomId];
    }
  };

  socket.on('leaveRoom', ({ roomId, username }) => {
    leave(roomId, username);
    socket.leave(roomId);
  });

  socket.on('disconnect', () => {
    if (currentRoom && currentUser) {
      leave(currentRoom, currentUser);
    }
  });
});

// MongoDB Atlas bağlantısı
mongoose.connect("mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/ciyerAxsami") 
  .then(() => console.log('MongoDB qoşuldu')) 
  .catch(err => console.log('MongoDB error:', err));

// User modeli
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true },
  phone: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);
const RoomSchema = new mongoose.Schema({ 
  name: { type: String, required: true }, // rayon + "toyu" 
  limit: { type: Number, min: 2, max: 10, required: true }, 
  minAmount: { type: Number, min: 0.2, required: true }, 
  players: [{ type: String }], 
  createdBy: { type: String, required: true } 
}); 
const Room = mongoose.model('Room', RoomSchema);

// Qeydiyyat route
app.post('/register', async (req, res) => {
  const { email, phone, username, password } = req.body;

  try {
    // Username yoxlaması
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Bu username artıq mövcuddur' });
    }

    // Yeni user yaratmaq
    const newUser = new User({ email, phone, username, password });
    await newUser.save();

    res.json({ message: 'Qeydiyyat uğurlu oldu', user: newUser });
  } catch (err) {
    res.status(500).json({ message: 'Server xətası', error: err.message });
  }
});

// Login route
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
// Otaqları gətir
app.get('/rooms', async (req, res) => {
  try {
    // 1. Əvvəlcə bazadakı bütün boş otaqları tap və sil (Həqiqətən silindiyindən əmin oluruq)
    await Room.deleteMany({ players: { $size: 0 } });

    // 2. Silinmə bitdikdən sonra qalanları gətir
    const rooms = await Room.find().lean(); // .lean() daha sürətli və təmiz data gətirir
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ message: "Otaqlar gətirilərkən xəta", error: err.message });
  }
});

// Otaq yarat
app.post('/rooms', async (req, res) => { 
  try {
    const { name, limit, minBet, createdBy } = req.body; 

    // Validasiyalar
    if (limit < 2 || limit > 10) { 
      return res.status(400).json({ message: 'Limit 2-10 arası olmalıdır' }); 
    } 
    if (minBet < 0.2) { 
      return res.status(400).json({ message: 'Minimum giriş 0.20 AZN olmalıdır' }); 
    } 

    // Yeni otaq yarat və yaradanı birbaşa players siyahısına əlavə et
    const newRoom = new Room({ 
      name, 
      limit, 
      minAmount: minBet, 
      players: [createdBy], // Yaradan oyunçu birbaşa daxil olur
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
// Otağa qoşul
app.post('/join-room/:id', async (req, res) => {
  const { username } = req.body;
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Otaq tapılmadı' });
  if (room.players.length >= room.limit) return res.status(400).json({ message: 'Otaq doludur' });

  room.players.push(username);
  await room.save();
  res.json(room);
});

// Otaqdan çıx
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


server.listen(5000, () => console.log('Server 5000 portunda işləyir'));
