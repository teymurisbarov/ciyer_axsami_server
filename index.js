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
const dealCards = (players)=>{

const deck=[];

const suits=['heart','brick','diamond','club'];
const ranks=['6','7','8','9','10','B','D','K','T'];

for(let s of suits){
for(let r of ranks){

deck.push({rank:r,suit:s});

}
}

// qarışdır

deck.sort(()=>Math.random()-0.5);


const result={};

players.forEach(player=>{

result[player]=[
deck.pop(),
deck.pop(),
deck.pop()
];

});

return result;

};

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // Otağa giriş
  socket.on('joinRoom', async ({ roomId, username }) => {
  if (!username) return;

  socket.join(roomId);

  if (!rooms[roomId]) {
    rooms[roomId] = {
      meta: null,
      allPlayers: [], // [{ username, balance }]
      roundPlayers: [],
      timerActive: false
    };
  }

  // DB-dən balansı götür
  const user = await User.findOne({ username });
  const balance = user?.balance ?? 0;

  // Duplicate olmasın
  const exists = rooms[roomId].allPlayers.find(p => p.username === username);
  if (!exists) {
    rooms[roomId].allPlayers.push({ username, balance });
  } else {
    exists.balance = balance; // yenilə
  }

  currentRoom = roomId;
  currentUser = username;

  io.to(roomId).emit('updatePlayerList', rooms[roomId].allPlayers);
});
  // Raunda Qoşulma (Düyməyə basanda)
  socket.on('joinRound', async ({ roomId, username }) => {

  if (!rooms[roomId]) return;

  // Raunda daxil olanlar
  if (!rooms[roomId].roundPlayers.includes(username)) {
    rooms[roomId].roundPlayers.push(username);
  }

  // Raunda daxil olanları hamıya göstər
  io.to(roomId).emit(
    'roundPlayers',
    rooms[roomId].roundPlayers
  );


  // Minimum 2 nəfər oldu → countdown başlasın
  if (
    rooms[roomId].roundPlayers.length >= 2 &&
    !rooms[roomId].timerActive
  ){

    rooms[roomId].timerActive=true;
    rooms[roomId].countdown=10;


    let interval=setInterval(()=>{

      io.to(roomId).emit(
        'roundCountdown',
        rooms[roomId].countdown
      );

      rooms[roomId].countdown--;


      if(rooms[roomId].countdown<0){

        clearInterval(interval);

        // Kartları payla
        const cards = dealCards(
          rooms[roomId].roundPlayers
        );

        io.to(roomId).emit(
          'roundStarted',
          cards
        );


        rooms[roomId].timerActive=false;
        rooms[roomId].roundPlayers=[];

      }

    },1000);

  }

});
socket.on('leaveRoom', async ({ roomId, username }) => {
  await leave(roomId, username);
  socket.leave(roomId);
});
  // Mərc və hərəkətlər
  socket.on('makeMove', (data) => {
    io.to(data.roomId).emit('updateGame', data);
  });

  // Otaqdan çıxış funksiyası (Disconnet və ya manual çıxış)
  const leave = async (roomId, username) => {
  if (!roomId || !username) return;

  // 1️⃣ MongoDB-dən otağı tap
  const room = await Room.findById(roomId);
  if (!room) return;

  // 2️⃣ Oyunçunu siyahıdan sil
  room.players = room.players.filter(p => p !== username);

  // 3️⃣ Əgər 0 nəfər qalıbsa → otağı sil
  if (room.players.length === 0) {
    await Room.findByIdAndDelete(roomId);
    delete rooms[roomId]; // RAM-dan da sil
    console.log("🗑 Otaq tam silindi:", roomId);
    return;
  }

  // 4️⃣ Yox əgər hələ oyunçu varsa → saxla
  await room.save();

  // 5️⃣ RAM hissəsini yenilə
  if (rooms[roomId]) {
    rooms[roomId].allPlayers =
      rooms[roomId].allPlayers.filter(u => u !== username);

    io.to(roomId).emit('updatePlayerList', rooms[roomId].allPlayers);
  }
};
socket.on('leaveRoom', async ({ roomId, username }) => {
  await leave(roomId, username);
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
    // Siyahını göndərməzdən əvvəl boş otaqları təmizlə
    await Room.deleteMany({ players: { $size: 0 } });
    const roomsList = await Room.find();
    res.json(roomsList);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
app.get('/user/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ message: 'User tapılmadı' });
    res.json({ username: user.username, balance: user.balance });
  } catch (err) {
    res.status(500).json({ message: 'Server xətası', error: err.message });
  }
});

server.listen(5000, () => console.log('Server 5000 portunda işləyir'));
