require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Groq       = require('groq-sdk');
const path       = require('path');
const http       = require('http');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { maxHttpBufferSize: 1e8 });

// ── Uploads directory ──────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
app.use('/uploads', express.static(uploadsDir));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Student roster ─────────────────────────────────────────────────────────────
const STUDENTS = [
  { name: 'Toni Macauly',               password: 'Toni123'         },
  { name: 'Oghenetejiri Ogheneochukwu', password: 'Oghenetejiri123' },
  { name: 'Joanna Bogoro',              password: 'Joanna123'       },
  { name: 'Ama-Abasi Benson',           password: 'Ama123'          },
  { name: 'Oluyemi Sosan',              password: 'Oluyemi123'      },
  { name: 'Aisha Adeniyi',              password: 'Aisha123'        },
  { name: 'Elissa Ojei',                password: 'Elissa123'       },
  { name: 'Kwame Sagoe',                password: 'Kwame123'        },
  { name: 'Oluwafeyikunmi Osunsedo',    password: 'Feyi123'         },
  { name: 'Olayomade King',             password: 'Yomade123'       },
  { name: 'Anthonia Celey Okogun',      password: 'Anthonia123'     },
  { name: 'Netochi Anichebe',           password: 'Netochi123'      },
  { name: 'Ishaq Babalola',             password: 'Ishaq123'        },
  { name: 'Eliora Ighodalo',            password: 'Eliora123'       },
  { name: 'Oluwanifesimi Thomas',       password: 'Nifesimi123'     },
  { name: 'Ereremena Orife',            password: 'Ereremena123'    },
  { name: 'Petnan Fwangkwal',           password: 'Petnan123'       },
  { name: 'Fareedah Ibrahim',           password: 'Fareedah123'     },
  { name: 'Tamunomiebi Miebaga',        password: 'Tamuno123'       },
  { name: 'Adedamola Egbonwon',         password: 'Adedamola123'    },
  { name: 'Fievaoghene Atebe',          password: 'Fieva123'        },
  { name: 'Ethan Adeleke',              password: 'Ethan123'        },
];

// ── In-memory profile + coins store ───────────────────────────────────────────
// profileStore[name] = { avatar, bio, status, coins, premium, premiumSince, studyMinutes }
const profileStore = {};

function getProfile(name) {
  if (!profileStore[name]) {
    profileStore[name] = {
      avatar: null, bio: '', status: 'online',
      coins: name === 'Petnan Fwangkwal' ? 100000 : 0,
      premium: false, tier: null, premiumSince: null,
      studyMinutes: 0,
    };
  }
  // ensure Petnan always starts with 100k if not set yet
  if (name === 'Petnan Fwangkwal' && profileStore[name].coins === 0) {
    profileStore[name].coins = 100000;
  }
  return profileStore[name];
}

// ── Study session tracker ──────────────────────────────────────────────────────
// studySessions[name] = { startTime, intervalId }
const studySessions = {};

const COINS_PER_30MIN  = 100;
const STUDY_INTERVAL_MS = 30 * 60 * 1000;

// ── Tier costs ────────────────────────────────────────────────────────────────
const TIERS = {
  pro:     { cost: 500,  label: '5G Pro',    color: '#60a5fa', emoji: '🔵' },
  silver:  { cost: 1000, label: '5G Silver', color: '#94a3b8', emoji: '🩶' },
  gold:    { cost: 1500, label: '5G Gold',   color: '#f59e0b', emoji: '🥇' },
  premium: { cost: 2000, label: '5G Premium',color: '#fbbf24', emoji: '⭐' },
};

function startStudySession(name, socket) {
  if (studySessions[name]) return; // already running
  studySessions[name] = {
    startTime: Date.now(),
    intervalId: setInterval(() => {
      const p = getProfile(name);
      p.coins += COINS_PER_30MIN;
      p.studyMinutes += 30;
      console.log(`🪙 ${name} earned ${COINS_PER_30MIN} coins (total: ${p.coins})`);
      // Notify the student
      Object.entries(connectedUsers).forEach(([sid, u]) => {
        if (u.name === name) {
          io.to(sid).emit('coinsEarned', { coins: COINS_PER_30MIN, total: p.coins, reason: '30 minutes of study!' });
          io.to(sid).emit('profileData', { name, profile: p });
        }
      });
    }, STUDY_INTERVAL_MS),
  };
  console.log(`📚 ${name} started study session`);
}

function stopStudySession(name) {
  if (studySessions[name]) {
    clearInterval(studySessions[name].intervalId);
    delete studySessions[name];
    console.log(`📚 ${name} stopped study session`);
  }
}

// ── Message stores ─────────────────────────────────────────────────────────────
const generalMessages = [];
const dmMessages      = {};  // { "UserA||UserB": [ msg ] }
const groupRooms      = {};  // { groupId: { name, members, messages, createdBy, avatar } }
const homeworkStore   = [];
const aiConversations = {}; // { name: [ {role, content} ] } — per-student private AI history

function dmKey(a, b) { return [a, b].sort().join('||'); }

// ── Nodemailer ─────────────────────────────────────────────────────────────────
let mailer = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

async function sendForgotPasswordEmail(fromName, message) {
  const body = `5 GREEN CHAT — Forgot Password Request\n--------------------------------------\nFrom: ${fromName}\nMessage: ${message}\nTime: ${new Date().toLocaleString()}\n\nPlease reply to this student with their password.`;
  console.log('\n📧 Forgot Password Request:\n', body);
  if (mailer) {
    await mailer.sendMail({
      from:    process.env.EMAIL_USER,
      to:      'petnan2016@gmail.com',
      subject: `[5 Green Chat] Password Help — ${fromName}`,
      text:    body,
    });
  }
}

// ── AI system prompt ───────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `You are 5 GREEN AI — the brilliant, all-knowing AI assistant of 5 Green Chat, built for 5 Green class students.

You are extraordinarily intelligent and knowledgeable across ALL subjects and domains:
• Mathematics (arithmetic, algebra, geometry, calculus, statistics)
• Sciences (physics, chemistry, biology, earth science, astronomy)
• History & Geography (world history, Nigerian history, African history, maps, capitals)
• English Language & Literature (grammar, writing, essays, poetry, novels)
• Computer Science & Coding (Python, JavaScript, HTML, algorithms, logic)
• Arts, Music, Sports, Health & Physical Education
• Social Studies, Civic Education, Economics
• Languages (English, French, Yoruba, Igbo, Hausa, and more)
• Logic, Philosophy, Critical Thinking
• Current Events & General Knowledge

Your personality:
• Warm, encouraging, and supportive — you celebrate student effort
• Patient: you explain things multiple ways until understood
• Engaging: you use examples, analogies, stories, and humour appropriately
• Honest: if something is beyond your training data, you say so
• Age-appropriate: you speak at the right level for school students

Your creator is Petnan Fwangkwal, the AI Creator of 5 Green Chat.

You can:
✅ Solve maths problems step-by-step
✅ Explain any concept clearly
✅ Help write essays, stories, and assignments
✅ Translate between languages
✅ Quiz students and test their knowledge
✅ Give study tips and learning strategies
✅ Summarise texts and books
✅ Answer general knowledge questions
✅ Help with coding problems
✅ Provide homework help

Never refuse to help with legitimate school or learning questions. Always aim to be the most helpful tutor possible.`;

// ── Socket.io ──────────────────────────────────────────────────────────────────
const connectedUsers = {}; // { socketId: { name, socketId } }

io.on('connection', (socket) => {

  // ── Login ──────────────────────────────────────────────────────────────────
  socket.on('login', ({ name, password }) => {
    const student = STUDENTS.find(s => s.name === name && s.password === password);
    if (!student) {
      socket.emit('loginError', 'Wrong name or password. Please try again.');
      return;
    }
    socket.data.name = name;
    connectedUsers[socket.id] = { name, socketId: socket.id };
    const profile = getProfile(name);

    socket.emit('loginSuccess', {
      name,
      profile,
      students: STUDENTS.map(s => ({
        name:    s.name,
        profile: getProfile(s.name),
        online:  Object.values(connectedUsers).some(u => u.name === s.name),
      })),
      groups: Object.values(groupRooms).filter(g => g.members.includes(name)),
      coins:   profile.coins,
      premium: profile.premium,
    });

    socket.emit('generalHistory',  generalMessages.slice(-100));
    socket.emit('homeworkList',    homeworkStore);

    broadcastOnlineUsers();

    // Rejoin group socket rooms
    Object.values(groupRooms).forEach(g => {
      if (g.members.includes(name)) socket.join(`group_${g.id}`);
    });

    console.log(`✅ ${name} logged in`);
  });

  // ── General chat ──────────────────────────────────────────────────────────
  socket.on('generalMessage', ({ text, replyTo }) => {
    const name = socket.data.name;
    if (!name || !text) return;
    const msg = {
      id: uuidv4(), sender: name, text: text.trim(),
      replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'student', premium: getProfile(name).premium,
    };
    generalMessages.push(msg);
    if (generalMessages.length > 500) generalMessages.shift();
    io.emit('generalMessage', msg);
  });

  // ── AI chat (private per student) ─────────────────────────────────────────
  socket.on('aiMessage', async ({ text }) => {
    const name = socket.data.name;
    if (!name || !text) return;

    if (!aiConversations[name]) aiConversations[name] = [];

    const userMsg = {
      id: uuidv4(), sender: name, text: text.trim(),
      timestamp: new Date().toISOString(), type: 'student',
    };
    socket.emit('aiMessage', userMsg);
    socket.emit('aiTyping', true);

    // Build history for this student
    aiConversations[name].push({ role: 'user', content: text.trim() });
    // Keep last 20 turns
    if (aiConversations[name].length > 40) aiConversations[name].splice(0, 2);

    try {
      // ── Wikipedia real-time lookup ──────────────────────────────────────
      let wikiContext = '';
      try {
        // extract key topic from the question
        const topicRes = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'Extract the main search topic from this question as 2-4 words only. Reply with ONLY the search term, nothing else.' },
            { role: 'user', content: text.trim() }
          ],
          max_tokens: 20, temperature: 0,
        });
        const topic = topicRes.choices[0].message.content.trim().replace(/['"]/g, '');
        // search Wikipedia
        const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
        const wikiRes = await fetch(searchUrl);
        if (wikiRes.ok) {
          const wikiData = await wikiRes.json();
          if (wikiData.extract && wikiData.extract.length > 50) {
            wikiContext = `\n\n[Wikipedia on "${wikiData.title}"]: ${wikiData.extract}`;
          }
        }
      } catch (e) { /* wiki lookup failed silently, AI still answers from training */ }

      const messagesWithWiki = [...aiConversations[name]];
      if (wikiContext) {
        // inject wiki info into the last user message
        messagesWithWiki[messagesWithWiki.length - 1] = {
          role: 'user',
          content: text.trim() + wikiContext
        };
      }

      const completion = await groq.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        messages:    [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...messagesWithWiki],
        max_tokens:  2048,
        temperature: 0.7,
        stream:      false,
      });
      const reply = completion.choices[0].message.content;
      aiConversations[name].push({ role: 'assistant', content: reply });

      const aiMsg = {
        id: uuidv4(), sender: '5 GREEN AI', text: reply,
        timestamp: new Date().toISOString(), type: 'ai',
      };
      socket.emit('aiTyping', false);
      socket.emit('aiMessage', aiMsg);
    } catch (err) {
      console.error('AI error:', err.message);
      socket.emit('aiTyping', false);
      socket.emit('aiMessage', {
        id: uuidv4(), sender: '5 GREEN AI', type: 'ai',
        text: '⚠️ Sorry, I had a little trouble with that. Please try again in a moment!',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── DMs ───────────────────────────────────────────────────────────────────
  socket.on('getDM', ({ with: other }) => {
    const name = socket.data.name;
    if (!name) return;
    const key = dmKey(name, other);
    socket.emit('dmHistory', { with: other, messages: (dmMessages[key] || []).slice(-100) });
  });

  socket.on('dmMessage', ({ to, text, replyTo }) => {
    const from = socket.data.name;
    if (!from || !to || !text) return;
    const key = dmKey(from, to);
    if (!dmMessages[key]) dmMessages[key] = [];
    const msg = {
      id: uuidv4(), sender: from, to, text: text.trim(),
      replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'dm', premium: getProfile(from).premium,
    };
    dmMessages[key].push(msg);
    if (dmMessages[key].length > 500) dmMessages[key].shift();
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('dmMessage', msg);
    });
    socket.emit('dmMessage', msg);
  });

  // ── Groups ────────────────────────────────────────────────────────────────
  socket.on('createGroup', ({ name: groupName, members }) => {
    const creator = socket.data.name;
    if (!creator || !groupName) return;
    const allMembers = [...new Set([creator, ...members])];
    const id = uuidv4();
    groupRooms[id] = { id, name: groupName, members: allMembers, messages: [], createdBy: creator, avatar: null };

    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (allMembers.includes(u.name)) {
        io.to(sid).emit('groupCreated', groupRooms[id]);
        io.sockets.sockets.get(sid)?.join(`group_${id}`);
      }
    });
    socket.join(`group_${id}`);
    console.log(`📁 Group "${groupName}" created by ${creator}`);
  });

  socket.on('getGroup', ({ groupId }) => {
    const name = socket.data.name;
    const g = groupRooms[groupId];
    if (!g || !g.members.includes(name)) return;
    socket.emit('groupHistory', { groupId, messages: g.messages.slice(-100) });
  });

  socket.on('groupMessage', ({ groupId, text, replyTo }) => {
    const name = socket.data.name;
    const g = groupRooms[groupId];
    if (!name || !g || !g.members.includes(name) || !text) return;
    const msg = {
      id: uuidv4(), sender: name, text: text.trim(),
      replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'group', groupId, premium: getProfile(name).premium,
    };
    g.messages.push(msg);
    if (g.messages.length > 500) g.messages.shift();
    io.to(`group_${groupId}`).emit('groupMessage', msg);
  });

  socket.on('addToGroup', ({ groupId, memberName }) => {
    const name = socket.data.name;
    const g = groupRooms[groupId];
    if (!name || !g || !g.members.includes(name)) return;
    if (!g.members.includes(memberName)) {
      g.members.push(memberName);
      io.to(`group_${groupId}`).emit('groupUpdated', g);
      Object.entries(connectedUsers).forEach(([sid, u]) => {
        if (u.name === memberName) {
          io.to(sid).emit('groupCreated', g);
          io.sockets.sockets.get(sid)?.join(`group_${groupId}`);
        }
      });
    }
  });

  socket.on('leaveGroup', ({ groupId }) => {
    const name = socket.data.name;
    const g = groupRooms[groupId];
    if (!name || !g) return;
    g.members = g.members.filter(m => m !== name);
    socket.leave(`group_${groupId}`);
    socket.emit('groupLeft', { groupId });
    io.to(`group_${groupId}`).emit('groupUpdated', g);
  });

  // ── Profile updates ───────────────────────────────────────────────────────
  socket.on('updateProfile', ({ avatar, bio, status }) => {
    const name = socket.data.name;
    if (!name) return;
    const p = getProfile(name);
    if (avatar !== undefined) p.avatar = avatar;
    if (bio    !== undefined) p.bio    = bio;
    if (status !== undefined) p.status = status;
    io.emit('profileUpdated', { name, profile: p });
  });

  socket.on('getProfile', ({ name: targetName }) => {
    const p = getProfile(targetName);
    socket.emit('profileData', { name: targetName, profile: p });
  });

  // ── Homework ──────────────────────────────────────────────────────────────
  socket.on('postHomework', ({ title, description, subject, dueDate }) => {
    const name = socket.data.name;
    if (!name || !title) return;
    const hw = {
      id: uuidv4(), postedBy: name, title, description,
      subject, dueDate, timestamp: new Date().toISOString(),
      comments: [], submissions: [],
    };
    homeworkStore.unshift(hw);
    if (homeworkStore.length > 200) homeworkStore.pop();
    io.emit('homeworkPosted', hw);
  });

  socket.on('homeworkComment', ({ hwId, text }) => {
    const name = socket.data.name;
    const hw = homeworkStore.find(h => h.id === hwId);
    if (!name || !hw || !text) return;
    const comment = { id: uuidv4(), sender: name, text, timestamp: new Date().toISOString() };
    hw.comments.push(comment);
    io.emit('homeworkComment', { hwId, comment });
  });

  socket.on('submitHomework', ({ hwId, text }) => {
    const name = socket.data.name;
    const hw = homeworkStore.find(h => h.id === hwId);
    if (!name || !hw || !text) return;
    // Remove previous submission by same student
    hw.submissions = hw.submissions.filter(s => s.sender !== name);
    const sub = { id: uuidv4(), sender: name, text, timestamp: new Date().toISOString() };
    hw.submissions.push(sub);
    io.emit('homeworkSubmission', { hwId, submission: sub });
  });

  // ── Class Coins & Premium ─────────────────────────────────────────────────
  socket.on('startStudy', () => {
    const name = socket.data.name;
    if (!name) return;
    startStudySession(name, socket);
    socket.emit('studyStarted', { message: 'Study session started! Earn 100 coins every 30 minutes.' });
  });

  socket.on('stopStudy', () => {
    const name = socket.data.name;
    if (!name) return;
    stopStudySession(name);
    socket.emit('studyStopped', { message: 'Study session ended.' });
  });

  socket.on('buyTier', ({ tier }) => {
    const name = socket.data.name;
    if (!name) return;
    const p = getProfile(name);
    const t = TIERS[tier];
    if (!t) { socket.emit('tierError', 'Invalid tier.'); return; }

    // check if already has this tier or higher
    const tierOrder = ['pro','silver','gold','premium'];
    const currentIdx = tierOrder.indexOf(p.tier);
    const newIdx = tierOrder.indexOf(tier);
    if (currentIdx >= newIdx) {
      socket.emit('tierError', `You already have ${t.label} or higher!`);
      return;
    }
    if (p.coins < t.cost) {
      socket.emit('tierError', `You need ${t.cost} coins for ${t.label}. You have ${p.coins}. Keep studying!`);
      return;
    }
    p.coins -= t.cost;
    p.tier = tier;
    p.premium = (tier === 'premium');
    p.premiumSince = new Date().toISOString();
    console.log(`${t.emoji} ${name} purchased ${t.label}`);
    socket.emit('tierUnlocked', { tier, tierLabel: t.label, emoji: t.emoji, profile: p });
    io.emit('profileUpdated', { name, profile: p });
  });

  // keep old buyPremium for compatibility
  socket.on('buyPremium', () => {
    socket.emit('buyTierProxy');
    const name = socket.data.name;
    if (!name) return;
    const p = getProfile(name);
    const t = TIERS.premium;
    if (p.tier === 'premium') { socket.emit('tierError', 'You already have Premium!'); return; }
    if (p.coins < t.cost) { socket.emit('tierError', `You need ${t.cost} coins. You have ${p.coins}. Keep studying!`); return; }
    p.coins -= t.cost; p.tier = 'premium'; p.premium = true;
    p.premiumSince = new Date().toISOString();
    socket.emit('tierUnlocked', { tier: 'premium', tierLabel: '5G Premium', emoji: '⭐', profile: p });
    io.emit('profileUpdated', { name, profile: p });
  });

  socket.on('getCoins', () => {
    const name = socket.data.name;
    if (!name) return;
    const p = getProfile(name);
    socket.emit('coinsData', { coins: p.coins, premium: p.premium, studyMinutes: p.studyMinutes });
  });

  // ── Video call signalling (WebRTC) ────────────────────────────────────────
  socket.on('callUser', ({ to, offer, from }) => {
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('incomingCall', { from, offer, socketId: socket.id });
    });
  });

  socket.on('callAnswer', ({ to, answer }) => {
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('callAnswered', { answer, from: socket.data.name });
    });
  });

  socket.on('callDecline', ({ to }) => {
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('callDeclined', { from: socket.data.name });
    });
  });

  socket.on('iceCandidate', ({ to, candidate }) => {
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('iceCandidate', { from: socket.data.name, candidate });
    });
  });

  socket.on('endCall', ({ to }) => {
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('callEnded', { from: socket.data.name });
    });
  });

  // In-call chat messages
  socket.on('callChatMessage', ({ to, text }) => {
    const from = socket.data.name;
    if (!from || !to || !text) return;
    const msg = { sender: from, text, timestamp: new Date().toISOString() };
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('callChatMessage', msg);
    });
    socket.emit('callChatMessage', msg);
  });

  // ── Typing indicators ─────────────────────────────────────────────────────
  socket.on('typing', ({ channel, to }) => {
    const name = socket.data.name;
    if (!name) return;
    if (channel === 'general') {
      socket.broadcast.emit('userTyping', { name, channel: 'general' });
    } else if (channel === 'dm' && to) {
      Object.entries(connectedUsers).forEach(([sid, u]) => {
        if (u.name === to) io.to(sid).emit('userTyping', { name, channel: 'dm', from: name });
      });
    } else if (channel === 'group' && to) {
      socket.to(`group_${to}`).emit('userTyping', { name, channel: 'group', groupId: to });
    }
  });

  socket.on('stopTyping', ({ channel, to }) => {
    const name = socket.data.name;
    if (!name) return;
    if (channel === 'general') {
      socket.broadcast.emit('userStopTyping', { name, channel: 'general' });
    } else if (channel === 'dm' && to) {
      Object.entries(connectedUsers).forEach(([sid, u]) => {
        if (u.name === to) io.to(sid).emit('userStopTyping', { name, channel: 'dm', from: name });
      });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const name = socket.data.name;
    stopStudySession(name);
    delete connectedUsers[socket.id];
    broadcastOnlineUsers();
    console.log(`🔌 Disconnected: ${name || socket.id}`);
  });

  function broadcastOnlineUsers() {
    const online = [...new Set(Object.values(connectedUsers).map(u => u.name))];
    io.emit('onlineUsers', online);
  }
});

// ── REST: Forgot password ──────────────────────────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { name, message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  try {
    await sendForgotPasswordEmail(name || 'Unknown student', message);
    res.json({ ok: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.json({ ok: true });
  }
});

// ── REST: Upload avatar ────────────────────────────────────────────────────────
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', students: STUDENTS.length }));

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🟢 5 Green Chat running at http://0.0.0.0:${PORT}\n`);
  console.log(`📚 ${STUDENTS.length} students registered`);
  console.log(`🪙 Coins: ${COINS_PER_30MIN} per 30min study | Premium costs ${PREMIUM_COST} coins\n`);
});
