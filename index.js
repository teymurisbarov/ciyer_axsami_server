const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB Atlas bağlantısı
mongoose.connect("mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/?appName=Cluster0", {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB qoşuldu'))
.catch(err => console.log('MongoDB error:', err));

// User modeli
const UserSchema = new mongoose.Schema({
  emailOrPhone: String,
  username: String,
  password: String,
  balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// Qeydiyyat route
app.post('/register', async (req, res) => {
  const { email, phone, username, password } = req.body;

  // Username yoxlaması
  const existingUser = await User.findOne({ username });
  if (existingUser) {
    return res.status(400).json({ message: 'Bu username artıq mövcuddur' });
  }

  const newUser = new User({ emailOrPhone: email || phone, username, password, balance: 0 });
  await newUser.save();
  res.json({ message: 'Qeydiyyat uğurlu oldu' });
});

// Login route
app.post('/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;
  const user = await User.findOne({ emailOrPhone, password });
  if (user) {
    res.json({ message: 'Giriş uğurlu oldu', balance: user.balance, username: user.username });
  } else {
    res.status(400).json({ message: 'Email/Telefon və ya parol səhvdir' });
  }
});

app.listen(5000, () => console.log('Server 5000 portunda işləyir'));
