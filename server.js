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
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200 MB
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
      coins: name === 'Petnan Fwangkwal' ? 100000 : 1000,
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
  pro:     { cost: 500,  label: 'CM Pro',    color: '#60a5fa', emoji: '🔵' },
  silver:  { cost: 1000, label: 'CM Silver', color: '#94a3b8', emoji: '🩶' },
  gold:    { cost: 1500, label: 'CM Gold',   color: '#f59e0b', emoji: '🥇' },
  premium: { cost: 2000, label: 'CM Premium',color: '#fbbf24', emoji: '⭐' },
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
  const body = `CLASSMATES CHAT — Forgot Password Request\n--------------------------------------\nFrom: ${fromName}\nMessage: ${message}\nTime: ${new Date().toLocaleString()}\n\nPlease reply to this student with their password.`;
  console.log('\n📧 Forgot Password Request:\n', body);
  if (mailer) {
    await mailer.sendMail({
      from:    process.env.EMAIL_USER,
      to:      'petnan2016@gmail.com',
      subject: `[Classmates Chat] Password Help — ${fromName}`,
      text:    body,
    });
  }
}

// ── AI system prompt ───────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `You are Classmates AI — the brilliant, all-knowing AI assistant of Classmates Chat, built for 5 Green class students.

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

Your creator is Petnan Fwangkwal, the AI Creator of Classmates Chat.

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

FILE & MEDIA ANALYSIS — when a student shares a file, image, video, or PDF:
📷 IMAGES: Describe what you'd expect in the image, answer questions about it, help with text visible in screenshots, analyse diagrams, charts, maths workings, science diagrams, maps, art etc.
🎬 VIDEOS: Help with topics the video likely covers based on the filename/context. If it's a lesson or tutorial, explain the subject thoroughly.
📄 PDFs & Documents: Summarise content, answer questions, extract key points, help with essays or reports, check writing quality.
📝 Text files / screenshots of text: Read, summarise, correct, translate, or analyse the content.
🔊 Audio files: Describe likely content, help transcribe if context is given, assist with music theory, speech topics etc.

When a student shares a file and asks you to analyse it:
- Be thorough and helpful
- Ask clarifying questions if needed
- Offer multiple ways you can help with the file (summarise, explain, quiz them on it, etc.)
- If you cannot directly read the file format, explain what you can do and ask the student to paste or describe the content

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
  socket.on('generalMessage', ({ text, replyTo, attachment }) => {
    const name = socket.data.name;
    if (!name || (!text && !attachment)) return;
    const msg = {
      id: uuidv4(), sender: name, text: (text || '').trim(),
      replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'student', premium: getProfile(name).premium,
      attachment: attachment || null,
    };
    generalMessages.push(msg);
    if (generalMessages.length > 500) generalMessages.shift();
    io.emit('generalMessage', msg);
  });

  // ── AI chat (private per student) ─────────────────────────────────────────
  socket.on('aiMessage', async ({ text, attachment }) => {
    const name = socket.data.name;
    if (!name || (!text && !attachment)) return;

    if (!aiConversations[name]) aiConversations[name] = [];

    // Build display text for user message
    const displayText = text || (attachment ? `📎 ${attachment.name}` : '');
    const userMsg = {
      id: uuidv4(), sender: name, text: displayText,
      timestamp: new Date().toISOString(), type: 'student',
      attachment: attachment || null,
    };
    socket.emit('aiMessage', userMsg);
    socket.emit('aiTyping', true);

    // Build content for the AI — try to extract real text from files
    let userContent = text || '';
    if (attachment) {
      const localPath = path.join(__dirname, attachment.url.replace(/^\//, ''));
      let extracted = '';

      try {
        if (attachment.fileType === 'image') {
          // Images: we can't see them but give the AI rich context
          userContent = (text ? text + '\n\n' : 'Please analyse this image.\n\n') +
            `[IMAGE ATTACHED: "${attachment.name}" (${attachment.mimeType||'image'})]\n` +
            `The student has shared an image. Based on the filename and any question asked, help as fully as possible. ` +
            `If the image likely contains text, maths, a diagram, or a chart, offer to explain it once the student describes what they see. ` +
            `If you need more detail, ask the student to describe the image or paste any text from it.`;

        } else if (attachment.fileType === 'video') {
          userContent = (text ? text + '\n\n' : 'Please help with this video.\n\n') +
            `[VIDEO ATTACHED: "${attachment.name}" (${attachment.mimeType||'video'})]\n` +
            `The student has shared a video file. Based on the filename and their question, provide relevant educational help. ` +
            `Offer to explain the topic, summarise what the video is likely about, or answer questions about the subject.`;

        } else if (attachment.fileType === 'audio') {
          userContent = (text ? text + '\n\n' : 'Please help with this audio file.\n\n') +
            `[AUDIO ATTACHED: "${attachment.name}" (${attachment.mimeType||'audio'})]\n` +
            `Help the student with this audio file. Offer transcription tips, explain the likely topic, or assist with music/speech content.`;

        } else if (attachment.fileType === 'pdf') {
          // Try to read raw PDF bytes and extract any readable text fragments
          try {
            const rawBytes = fs.readFileSync(localPath);
            // Simple text extraction: grab ASCII strings between stream markers
            const raw = rawBytes.toString('latin1');
            const chunks = [];
            const re = /\(([^\)]{4,})\)/g;
            let m;
            while ((m = re.exec(raw)) !== null && chunks.length < 400) {
              const s = m[1].replace(/\\[nrt\\()]/g, ' ').trim();
              if (s.length > 3) chunks.push(s);
            }
            extracted = chunks.join(' ').replace(/\s+/g, ' ').substring(0, 4000);
          } catch (e) { extracted = ''; }

          if (extracted.length > 80) {
            userContent = (text ? text + '\n\n' : 'Please analyse this PDF document.\n\n') +
              `[PDF DOCUMENT: "${attachment.name}"]\n` +
              `Extracted text content:\n"""\n${extracted}\n"""\n\n` +
              `Please ${text || 'summarise this document, list the key points, and offer to help the student study it'}.`;
          } else {
            userContent = (text ? text + '\n\n' : 'Please help with this PDF.\n\n') +
              `[PDF ATTACHED: "${attachment.name}"]\n` +
              `I could not extract readable text from this PDF (it may be scanned or image-based). ` +
              `Based on the filename, help the student as best you can. Ask them to paste any text they need help with.`;
          }

        } else {
          // Plain text / CSV / code files — read directly
          try {
            const content = fs.readFileSync(localPath, 'utf8').substring(0, 5000);
            extracted = content;
          } catch (e) { extracted = ''; }

          if (extracted.length > 10) {
            userContent = (text ? text + '\n\n' : 'Please analyse this file.\n\n') +
              `[FILE: "${attachment.name}"]\nContent:\n"""\n${extracted}\n"""\n\n` +
              `Please ${text || 'summarise this file, explain its contents, and offer to help the student with it'}.`;
          } else {
            userContent = (text ? text + '\n\n' : '') +
              `[FILE ATTACHED: "${attachment.name}" (${attachment.fileType})] — help the student with whatever they need.`;
          }
        }
      } catch (fileErr) {
        console.error('File read error:', fileErr.message);
        userContent = (text ? text + '\n\n' : '') +
          `[FILE: "${attachment.name}" (${attachment.fileType})] — help the student based on the filename and their question.`;
      }
    }

    aiConversations[name].push({ role: 'user', content: userContent });
    if (aiConversations[name].length > 40) aiConversations[name].splice(0, 2);

    try {
      // ── Wikipedia real-time lookup ──────────────────────────────────────
      let wikiContext = '';
      try {
        const topicRes = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'Extract the main search topic from this question as 2-4 words only. Reply with ONLY the search term, nothing else.' },
            { role: 'user', content: (text || displayText).trim() }
          ],
          max_tokens: 20, temperature: 0,
        });
        const topic = topicRes.choices[0].message.content.trim().replace(/['"]/g, '');
        const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
        const wikiRes = await fetch(searchUrl);
        if (wikiRes.ok) {
          const wikiData = await wikiRes.json();
          if (wikiData.extract && wikiData.extract.length > 50) {
            wikiContext = `\n\n[Wikipedia on "${wikiData.title}"]: ${wikiData.extract}`;
          }
        }
      } catch (e) { /* silent */ }

      const messagesWithContext = [...aiConversations[name]];
      if (wikiContext) {
        messagesWithContext[messagesWithContext.length - 1] = {
          role: 'user',
          content: userContent + wikiContext,
        };
      }

      const completion = await groq.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        messages:    [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...messagesWithContext],
        max_tokens:  2048,
        temperature: 0.7,
        stream:      false,
      });
      const reply = completion.choices[0].message.content;
      aiConversations[name].push({ role: 'assistant', content: reply });

      const aiMsg = {
        id: uuidv4(), sender: 'Classmates AI', text: reply,
        timestamp: new Date().toISOString(), type: 'ai',
      };
      socket.emit('aiTyping', false);
      socket.emit('aiMessage', aiMsg);
    } catch (err) {
      console.error('AI error:', err.message);
      socket.emit('aiTyping', false);
      socket.emit('aiMessage', {
        id: uuidv4(), sender: 'Classmates AI', type: 'ai',
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

  socket.on('dmMessage', ({ to, text, replyTo, attachment }) => {
    const from = socket.data.name;
    if (!from || !to || (!text && !attachment)) return;
    const key = dmKey(from, to);
    if (!dmMessages[key]) dmMessages[key] = [];
    const msg = {
      id: uuidv4(), sender: from, to, text: (text || '').trim(),
      replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'dm', premium: getProfile(from).premium,
      attachment: attachment || null,
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

  socket.on('groupMessage', ({ groupId, text, replyTo, attachment }) => {
    const name = socket.data.name;
    const g = groupRooms[groupId];
    if (!name || !g || !g.members.includes(name) || (!text && !attachment)) return;
    const msg = {
      id: uuidv4(), sender: name, text: (text || '').trim(),
      replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'group', groupId, premium: getProfile(name).premium,
      attachment: attachment || null,
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

// ── REST: Upload any file for chat (images, PDFs, videos, docs, etc.) ─────────
app.post('/api/upload-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mime = req.file.mimetype;
  let fileType = 'file';
  if (mime.startsWith('image/'))      fileType = 'image';
  else if (mime.startsWith('video/')) fileType = 'video';
  else if (mime.startsWith('audio/')) fileType = 'audio';
  else if (mime === 'application/pdf') fileType = 'pdf';
  res.json({
    url:      `/uploads/${req.file.filename}`,
    fileType,
    name:     req.file.originalname,
    size:     req.file.size,
    mimeType: mime,
  });
});

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', students: STUDENTS.length }));

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🟢 Classmates Chat running at http://0.0.0.0:${PORT}\n`);
  console.log(`📚 ${STUDENTS.length} students registered`);
  console.log(`🪙 Coins: ${COINS_PER_30MIN} per 30min study | Pro:500 Silver:1000 Gold:1500 Premium:2000\n`);
});
