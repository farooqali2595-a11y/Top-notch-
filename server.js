const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.log('❌ MongoDB Error:', err));

// ========== MODELS ==========
const User = require('./models/User');
const Number = require('./models/Number');
const OTP = require('./models/OTP');

// ========== AUTH MIDDLEWARE ==========
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== LOGIN API ==========
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid password' });
    
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        payout: user.payout,
        totalOTPs: user.totalOTPs,
        weeklyOTPs: user.weeklyOTPs,
        todayOTPs: user.todayOTPs
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== OWNER: CREATE AGENT ==========
app.post('/api/owner/create-agent', authMiddleware, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only owner can create agents' });
  }
  
  const { username, password, payout } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const agent = new User({
      username,
      password: hashedPassword,
      role: 'agent',
      parentId: req.user.id,
      payout: payout || 0
    });
    await agent.save();
    res.json({ success: true, agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== OWNER: ADD NUMBERS (Bulk) ==========
app.post('/api/owner/add-numbers', authMiddleware, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only owner can add numbers' });
  }
  
  const { numbers, rangeName } = req.body;
  
  try {
    const numbersArray = numbers.split('\n').filter(n => n.trim());
    const savedNumbers = [];
    
    for (const num of numbersArray) {
      const newNumber = new Number({
        number: num.trim(),
        rangeName: rangeName || 'Default',
        assignedTo: req.user.id,
        assignedBy: req.user.id,
        payout: 0
      });
      await newNumber.save();
      savedNumbers.push(newNumber);
    }
    
    res.json({ success: true, count: savedNumbers.length, numbers: savedNumbers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== AGENT: CREATE CLIENT ==========
app.post('/api/agent/create-client', authMiddleware, async (req, res) => {
  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only agent can create clients' });
  }
  
  const { username, password, numberId, payout } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const client = new User({
      username,
      password: hashedPassword,
      role: 'client',
      parentId: req.user.id,
      payout: payout || 0
    });
    await client.save();
    
    // Assign number to client
    if (numberId) {
      await Number.findByIdAndUpdate(numberId, {
        assignedTo: client._id,
        assignedBy: req.user.id
      });
    }
    
    res.json({ success: true, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET OTPs (Role based) ==========
app.get('/api/otps', authMiddleware, async (req, res) => {
  const { page = 1, limit = 25 } = req.query;
  const skip = (page - 1) * limit;
  
  try {
    let query = {};
    
    if (req.user.role === 'owner') {
      // Owner sees all OTPs
      query = {};
    } else if (req.user.role === 'agent') {
      // Agent sees only their clients' OTPs
      const clients = await User.find({ parentId: req.user.id, role: 'client' });
      const clientIds = clients.map(c => c._id);
      query = { userId: { $in: [...clientIds, req.user.id] } };
    } else {
      // Client sees only their own OTPs
      query = { userId: req.user.id };
    }
    
    const otps = await OTP.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('userId', 'username');
    
    const total = await OTP.countDocuments(query);
    
    res.json({
      otps,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET STATS (Dashboard) ==========
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    let stats = {};
    
    if (req.user.role === 'owner') {
      const agents = await User.find({ role: 'agent' });
      const clients = await User.find({ role: 'client' });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      stats = {
        totalAgents: agents.length,
        totalClients: clients.length,
        todayOTPs: await OTP.countDocuments({ timestamp: { $gte: today } }),
        weeklyOTPs: await OTP.countDocuments({
          timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        })
      };
    } else if (req.user.role === 'agent') {
      const clients = await User.find({ parentId: req.user.id, role: 'client' });
      const clientIds = clients.map(c => c._id);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      stats = {
        totalClients: clients.length,
        todayOTPs: await OTP.countDocuments({
          userId: { $in: clientIds },
          timestamp: { $gte: today }
        }),
        weeklyOTPs: await OTP.countDocuments({
          userId: { $in: clientIds },
          timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }),
        totalEarned: req.user.payout || 0
      };
    } else {
      // Client stats
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      stats = {
        myNumbers: await Number.countDocuments({ assignedTo: req.user.id }),
        todayOTPs: await OTP.countDocuments({
          userId: req.user.id,
          timestamp: { $gte: today }
        }),
        weeklyOTPs: await OTP.countDocuments({
          userId: req.user.id,
          timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }),
        totalOTPs: await OTP.countDocuments({ userId: req.user.id })
      };
    }
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CHANGE PASSWORD ==========
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  
  try {
    const user = await User.findById(req.user.id);
    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) return res.status(401).json({ error: 'Old password is incorrect' });
    
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== WEEKLY RESET CRON JOB ==========
// This will run every Monday at 12:00 AM
// For Vercel, we'll use a separate endpoint

app.post('/api/weekly-reset', async (req, res) => {
  try {
    // Reset weekly OTPs for all users
    await User.updateMany({}, { weeklyOTPs: 0 });
    res.json({ success: true, message: 'Weekly OTPs reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SERVER START ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});