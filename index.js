const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

app.use(express.json());
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// RAM otaqlar
const rooms = {};


// ===================
// MongoDB
// ===================

mongoose.connect(
"mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/ciyerAxsami"
)
.then(()=>console.log("MongoDB qoşuldu"))
.catch(err=>console.log(err));


// ===================
// USER MODEL
// ===================

const UserSchema = new mongoose.Schema({

email:String,
phone:String,
username:{type:String,unique:true},
password:String,
balance:{type:Number,default:0}

});

const User = mongoose.model('User',UserSchema);


// ===================
// ROOM MODEL
// ===================

const RoomSchema = new mongoose.Schema({

name:String,
limit:Number,
minAmount:Number,
players:[String],
createdBy:String

});

const Room = mongoose.model('Room',RoomSchema);



// ===================
// USER ROUTES
// ===================


app.post('/register',async(req,res)=>{

const {email,phone,username,password}=req.body;

const userExist=await User.findOne({username});

if(userExist)
return res.status(400).json({message:"Username mövcuddur"});

const newUser=new User({
email,
phone,
username,
password
});

await newUser.save();

res.json(newUser);

});



app.post('/login',async(req,res)=>{

const {emailOrPhone,password}=req.body;

const user=await User.findOne({

$or:[
{email:emailOrPhone},
{phone:emailOrPhone}
],

password

});

if(!user)
return res.status(400).json({message:"Səhv login"});


res.json({

username:user.username,
balance:user.balance

});

});




// BALANS GET

app.get('/user/:username',async(req,res)=>{

const user=await User.findOne({
username:req.params.username
});

if(!user)
return res.status(404).json({});

res.json(user);

});



// ===================
// ROOM ROUTES
// ===================


// Otaqları gətir

app.get('/rooms',async(req,res)=>{

// boş otaqları təmizlə

await Room.deleteMany({players:{$size:0}});

const list=await Room.find();

res.json(list);

});




// OTAQ YARAT

app.post('/rooms',async(req,res)=>{

const {name,limit,minBet,createdBy}=req.body;

if(limit<2 || limit>10)
return res.status(400).json({
message:"Limit 2-10"
});

const room=new Room({

name,
limit,
minAmount:minBet,
players:[createdBy],
createdBy

});

await room.save();

res.json(room);

});




// OTAĞA GİR

app.post('/join-room/:id',async(req,res)=>{

const {username}=req.body;

const room=await Room.findById(req.params.id);

if(!room)
return res.status(404).json({});

if(room.players.length>=room.limit)
return res.status(400).json({});

if(!room.players.includes(username))
room.players.push(username);

await room.save();

res.json(room);

});




// OTAQDAN ÇIX

app.post('/leave-room/:id',async(req,res)=>{

const {username}=req.body;

const room=await Room.findById(req.params.id);

if(!room)
return res.status(404).json({});


room.players=room.players.filter(
p=>p!==username
);


if(room.players.length===0){

await Room.findByIdAndDelete(req.params.id);

return res.json({
message:"silindi"
});

}


await room.save();

res.json(room);

});



// ===================
// SOCKET.IO
// ===================


io.on('connection',(socket)=>{

let currentRoom=null;
let currentUser=null;


// OTAĞA GİR

socket.on('joinRoom',async({roomId,username})=>{

if(!username) return;

const room=await Room.findById(roomId);

if(!room) return;


socket.join(roomId);

if(!rooms[roomId]){

rooms[roomId]={

allPlayers:[],
roundPlayers:[],
timerActive:false

};

}


// balansı DB-dən götür

const user=await User.findOne({username});

const balance=user?.balance ?? 0;


// duplicate olmasın

const exist=
rooms[roomId].allPlayers.find(
p=>p.username===username
);


if(!exist){

rooms[roomId].allPlayers.push({

username,
balance

});

}


currentRoom=roomId;
currentUser=username;


// hamıya göndər

io.to(roomId).emit(
'updatePlayerList',
rooms[roomId].allPlayers
);

});



// OTAQDAN ÇIX

const leave=async(roomId,username)=>{

if(!roomId || !username) return;


const room=await Room.findById(roomId);

if(!room) return;


// MongoDB-dən sil

room.players=
room.players.filter(
p=>p!==username
);


// son oyunçudur?

if(room.players.length===0){

await Room.findByIdAndDelete(roomId);

delete rooms[roomId];

console.log("Otaq silindi");

return;

}


// saxla

await room.save();


// RAM yenilə

if(rooms[roomId]){

rooms[roomId].allPlayers=
rooms[roomId].allPlayers.filter(
p=>p.username!==username
);


io.to(roomId).emit(
'updatePlayerList',
rooms[roomId].allPlayers
);

}

};



// CLIENT leaveRoom

socket.on('leaveRoom',async({roomId,username})=>{

await leave(roomId,username);

socket.leave(roomId);

});



// disconnect

socket.on('disconnect',async()=>{

if(currentRoom && currentUser){

await leave(
currentRoom,
currentUser
);

}

});


});




// ===================
// SERVER
// ===================


server.listen(5000,()=>{

console.log("Server 5000 portunda");

});
