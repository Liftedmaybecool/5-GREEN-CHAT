require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Groq       = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path       = require('path');
const http       = require('http');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const DB_FILE = path.join(dataDir, 'data.json');

let dbState = {
  students: [],
  messages: [],
  ai_history: [],
  groups: [],
  group_members: [],
  homework: [],
  homework_comments: [],
  homework_submissions: [],
};

function saveDB(){
  try { fs.writeFileSync(DB_FILE, JSON.stringify(dbState, null, 2)); }
  catch (err) { console.error('Failed to save data.json', err); }
}

function loadDB(){
  if (fs.existsSync(DB_FILE)) {
    try {
      dbState = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      console.error('Failed to load data.json, recreating file.', err);
      dbState = {
        students: [], messages: [], ai_history: [], groups: [], group_members: [],
        homework: [], homework_comments: [], homework_submissions: [],
      };
      saveDB();
    }
  } else {
    saveDB();
  }
  dbState.students = dbState.students || [];
  dbState.messages = dbState.messages || [];
  dbState.ai_history = dbState.ai_history || [];
  dbState.groups = dbState.groups || [];
  dbState.group_members = dbState.group_members || [];
  dbState.homework = dbState.homework || [];
  dbState.homework_comments = dbState.homework_comments || [];
  dbState.homework_submissions = dbState.homework_submissions || [];
}

loadDB();
const groupRooms = {};
loadGroupsFromDB();

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

// ── Groq (primary AI) ─────────────────────────────────────────────────────────
const groqClients = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
].filter(Boolean).map(key => new Groq({ apiKey: key }));

if (groqClients.length === 0) console.warn('⚠️  No GROQ_API_KEY found!');
else console.log(`🤖 Groq: ${groqClients.length} API key(s) loaded`);

// ── Gemini (fallback AI) ───────────────────────────────────────────────────────
let gemini = null;
if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  gemini = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  console.log('✨ Gemini fallback ready');
} else {
  console.warn('⚠️  No GEMINI_API_KEY — fallback disabled');
}

// ── Smart AI caller: Groq first, Gemini if Groq fails ─────────────────────────
async function callAI(messages, systemPrompt) {
  // Build the full messages array with system prompt
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  // Try each Groq key first
  for (const client of groqClients) {
    try {
      const res = await client.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        messages:    fullMessages,
        max_tokens:  2048,
        temperature: 0.7,
      });
      return res.choices[0].message.content;
    } catch (err) {
      const status = err?.status || err?.statusCode || err?.error?.status;
      if (status === 429 || status === 401 || status === 503) {
        console.warn(`⚠️  Groq failed (${status}), trying next…`);
        continue;
      }
      throw err;
    }
  }

  // All Groq keys failed — try Gemini
  if (gemini) {
    console.log('🔄 Switching to Gemini fallback…');
    try {
      // Convert messages to Gemini format
      const history = messages.slice(0, -1).map(m => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const lastMsg = messages[messages.length - 1]?.content || '';
      const chat = gemini.startChat({
        history,
        systemInstruction: systemPrompt,
      });
      const result = await chat.sendMessage(lastMsg);
      return result.response.text();
    } catch (gErr) {
      console.error('Gemini also failed:', gErr.message);
      throw gErr;
    }
  }

  throw new Error('All AI providers failed and no fallback available.');
}

// Separate lighter groqCreate for the topic-extraction mini-call (no fallback needed)
async function groqMiniCreate(params) {
  for (const client of groqClients) {
    try {
      return await client.chat.completions.create(params);
    } catch (err) {
      const status = err?.status || err?.statusCode;
      if (status === 429 || status === 401) continue;
      throw err;
    }
  }
  return null; // silently skip wiki lookup if all keys busy
}

// ── Student roster ─────────────────────────────────────────────────────────────
const STUDENTS = [
  { name: 'Toni Macauly',               password: 'Toni_5'         },
  { name: 'Oghenetejiri Ogheneochukwu', password: 'Oghenetejiri_5' },
  { name: 'Joanna Bogoro',              password: 'Joanna_5'       },
  { name: 'Ama-Abasi Benson',           password: 'Ama_5'          },
  { name: 'Oluyemi Sosan',              password: 'Oluyemi_5'      },
  { name: 'Aisha Adeniyi',              password: 'Aisha_5'        },
  { name: 'Elissa Ojei',                password: 'Elissa_5'       },
  { name: 'Kwame Sagoe',                password: 'Kwame_5'        },
  { name: 'Oluwafeyikunmi Osunsedo',    password: 'Feyi_5'         },
  { name: 'Olayomade King',             password: 'Yomade_5'       },
  { name: 'Anthonia Celey Okogun',      password: 'Anthonia_5'     },
  { name: 'Netochi Anichebe',           password: 'Netochi_5'      },
  { name: 'Ishaq Babalola',             password: 'Ishaq_5'        },
  { name: 'Eliora Ighodalo',            password: 'Eliora_5'       },
  { name: 'Oluwanifesimi Thomas',       password: 'Nifesimi_5'     },
  { name: 'Ereremena Orife',            password: 'Ereremena_5'    },
  { name: '✨ Petnan Fwangkwal',         password: 'Petnan_5'       },
  { name: 'Fareedah Ibrahim',           password: 'Fareedah_5'     },
  { name: 'Tamunomiebi Miebaga',        password: 'Tamuno_5'       },
  { name: 'Adedamola Egbonwon',         password: 'Adedamola_5'    },
  { name: 'Fievaoghene Atebe',          password: 'Fieva_5'        },
  { name: 'Ethan Adeleke',              password: 'Ethan_5'        },
  { name: 'Test Person',                password: 'Test_5'          },
];

if (!dbState.students.length) autoSeedStudents(); else migrateStudentData();

function autoSeedStudents(){
  for (const s of STUDENTS){
    let existing = dbState.students.find(st => st.name === s.name);
    if (existing) continue;
    const initialCoins = s.name === '✨ Petnan Fwangkwal' ? 100000 : s.name === 'Test Person' ? 1000 : 0;
    dbState.students.push({
      name: s.name,
      password: s.password,
      avatar: null,
      bio: '',
      status: 'online',
      coins: initialCoins,
      class_coins: initialCoins,
      premium: 0,
      tier: null,
      premiumSince: null,
      studyMinutes: 0,
    });
  }
  saveDB();
}

function migrateStudentData(){
  let updated = false;
  dbState.students.forEach(s => {
    if (typeof s.password === 'string' && s.password.endsWith('123')) {
      s.password = s.password.slice(0, -3) + '_5';
      updated = true;
    }
    if (s.coins === undefined) { s.coins = 0; updated = true; }
    if (s.class_coins === undefined) { s.class_coins = s.coins; updated = true; }
    if (s.premium === undefined) { s.premium = 0; updated = true; }
    if (s.tier === undefined) { s.tier = null; updated = true; }
    if (s.premiumSince === undefined) { s.premiumSince = null; updated = true; }
    if (s.studyMinutes === undefined) { s.studyMinutes = 0; updated = true; }
    if (s.status === undefined) { s.status = 'online'; updated = true; }
  });
  if (updated) saveDB();
}

function getProfile(name) {
  const row = dbState.students.find(s => s.name === name);
  if (row) {
    const balance = row.class_coins !== null && row.class_coins !== undefined ? row.class_coins : row.coins || 0;
    return {
      avatar: row.avatar,
      bio: row.bio || '',
      status: row.status || 'online',
      coins: balance,
      class_coins: balance,
      premium: Boolean(row.premium),
      tier: row.tier || null,
      premiumSince: row.premiumSince || null,
      studyMinutes: row.studyMinutes || 0,
    };
  }
  return {
    avatar: null,
    bio: '',
    status: 'online',
    coins: 0,
    class_coins: 0,
    premium: false,
    tier: null,
    premiumSince: null,
    studyMinutes: 0,
  };
}

function updateProfile(name, updates){
  const row = dbState.students.find(s => s.name === name);
  if (!row) return;
  if (updates.avatar !== undefined) row.avatar = updates.avatar;
  if (updates.bio !== undefined) row.bio = updates.bio;
  if (updates.status !== undefined) row.status = updates.status;
  if (updates.coins !== undefined) row.coins = updates.coins;
  if (updates.class_coins !== undefined) row.class_coins = updates.class_coins;
  if (updates.premium !== undefined) row.premium = updates.premium ? 1 : 0;
  if (updates.tier !== undefined) row.tier = updates.tier;
  if (updates.premiumSince !== undefined) row.premiumSince = updates.premiumSince;
  if (updates.studyMinutes !== undefined) row.studyMinutes = updates.studyMinutes;
  saveDB();
}

function changeCoins(name, delta){
  const row = dbState.students.find(s => s.name === name);
  if (!row) return null;
  row.class_coins = (row.class_coins || 0) + delta;
  row.coins = (row.coins || 0) + delta;
  saveDB();
  return row.class_coins;
}

function setCoins(name, amount){
  const row = dbState.students.find(s => s.name === name);
  if (!row) return;
  row.class_coins = amount;
  row.coins = amount;
  saveDB();
}

function storeMessage(msg){
  dbState.messages.push({
    id: msg.id,
    channel: msg.channel,
    sender: msg.sender,
    recipient: msg.recipient || null,
    groupId: msg.groupId || null,
    text: msg.text || null,
    replyTo: msg.replyTo || null,
    attachment: msg.attachment || null,
    timestamp: msg.timestamp,
  });
  saveDB();
}

function getGeneralHistory(limit = 100){
  const rows = dbState.messages.filter(m => m.channel === 'general');
  return rows.slice(Math.max(rows.length - limit, 0)).map(r => ({ ...r }));
}

function getDMHistory(userA, userB, limit = 100){
  const rows = dbState.messages.filter(m =>
    m.channel === 'dm' && ((m.sender === userA && m.recipient === userB) || (m.sender === userB && m.recipient === userA))
  );
  return rows.slice(Math.max(rows.length - limit, 0)).map(r => ({ ...r }));
}

function getGroupHistory(groupId, limit = 100){
  const rows = dbState.messages.filter(m => m.channel === 'group' && m.groupId === groupId);
  return rows.slice(Math.max(rows.length - limit, 0)).map(r => ({ ...r }));
}

function saveAIHistory(student, role, content){
  dbState.ai_history.push({ id: uuidv4(), student, role, content, timestamp: new Date().toISOString() });
  saveDB();
}

function getAIHistory(student, limit = 10){
  const rows = dbState.ai_history.filter(r => r.student === student);
  return rows.slice(Math.max(rows.length - limit, 0)).map(r => ({ role: r.role, content: r.content }));
}

function loadGroupsFromDB(){
  Object.keys(groupRooms).forEach(key => delete groupRooms[key]);
  dbState.groups.forEach(g => {
    groupRooms[g.id] = {
      id: g.id,
      name: g.name,
      members: [],
      createdBy: g.createdBy,
      avatar: g.avatar,
      createdAt: g.createdAt,
      messages: [],
    };
  });
  dbState.group_members.forEach(m => {
    if (groupRooms[m.groupId]) {
      groupRooms[m.groupId].members.push(m.member);
    }
  });
}

function getHomeworkList(){
  const assignments = [...dbState.homework].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const comments = [...dbState.homework_comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const submissions = [...dbState.homework_submissions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const map = new Map(assignments.map(hw => [hw.id, { ...hw, comments: [], submissions: [] }]));
  comments.forEach(c => {
    const hw = map.get(c.hwId);
    if (hw) hw.comments.push(c);
  });
  submissions.forEach(s => {
    const hw = map.get(s.hwId);
    if (hw) hw.submissions.push(s);
  });
  return Array.from(map.values());
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
  premium: { cost: 2000, label: 'CM Premium',color: '#f7b100ff', emoji: '⭐' },
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
      to:      'liftedyaktu@gmail.com',
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

Your creator is ✨ Petnan Fwangkwal, the AI Creator of Classmates Chat.

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

    socket.emit('generalHistory',  getGeneralHistory(100));
    socket.emit('homeworkList',    getHomeworkList());

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
      channel: 'general', replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'student', premium: getProfile(name).premium,
      attachment: attachment || null,
    };
    storeMessage(msg);
    io.emit('generalMessage', msg);
  });

  // ── AI chat (private per student) ─────────────────────────────────────────
  socket.on('aiMessage', async ({ text, attachment }) => {
    const name = socket.data.name;
    if (!name || (!text && !attachment)) return;

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

    saveAIHistory(name, 'user', userContent);
    storeMessage({
      id: userMsg.id,
      channel: 'ai',
      sender: name,
      recipient: 'Classmates AI',
      text: displayText,
      replyTo: null,
      attachment: attachment || null,
      timestamp: userMsg.timestamp,
    });

    try {
      // ── Load the latest AI memory from the database
      const history = getAIHistory(name, 10);
      const messagesWithContext = [...history, { role: 'user', content: userContent }];

      // ── Wikipedia real-time lookup ──────────────────────────────────────
      let wikiContext = '';
      try {
        const topicRes = await groqMiniCreate({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'Extract the main search topic from this question as 2-4 words only. Reply with ONLY the search term, nothing else.' },
            { role: 'user', content: (text || displayText).trim() }
          ],
          max_tokens: 20, temperature: 0,
        });
        if (topicRes) {
          const topic = topicRes.choices[0].message.content.trim().replace(/['"]/g, '');
          const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
          const wikiRes = await fetch(searchUrl);
          if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            if (wikiData.extract && wikiData.extract.length > 50) {
              wikiContext = `\n\n[Wikipedia on "${wikiData.title}"]: ${wikiData.extract}`;
            }
          }
        }
      } catch (e) { /* silent */ }

      if (wikiContext) {
        messagesWithContext[messagesWithContext.length - 1].content += wikiContext;
      }

      const reply = await callAI(messagesWithContext, AI_SYSTEM_PROMPT);
      saveAIHistory(name, 'assistant', reply);

      const aiMsg = {
        id: uuidv4(), sender: 'Classmates AI', text: reply,
        channel: 'ai', recipient: name, timestamp: new Date().toISOString(), type: 'ai',
      };
      storeMessage(aiMsg);
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
    socket.emit('dmHistory', { with: other, messages: getDMHistory(name, other, 100) });
  });

  socket.on('dmMessage', ({ to, text, replyTo, attachment }) => {
    const from = socket.data.name;
    if (!from || !to || (!text && !attachment)) return;
    const msg = {
      id: uuidv4(), sender: from, recipient: to, text: (text || '').trim(),
      channel: 'dm', replyTo: replyTo || null, timestamp: new Date().toISOString(),
      type: 'dm', premium: getProfile(from).premium,
      attachment: attachment || null,
    };
    storeMessage(msg);
    Object.entries(connectedUsers).forEach(([sid, u]) => {
      if (u.name === to) io.to(sid).emit('dmMessage', msg);
    });
    socket.emit('dmMessage', msg);
  });

  // ── Groups ────────────────────────────────────────────────────────────────
  socket.on('createGroup', ({ name: groupName, members }) => {
    const creator = socket.data.name;
    if (!creator || !groupName) return;
    const allMembers = [...new Set([creator, ...(members || [])])];
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    dbState.groups.push({ id, name: groupName, createdBy: creator, avatar: null, createdAt });
    allMembers.forEach(member => {
      dbState.group_members.push({ id: uuidv4(), groupId: id, member });
    });
    saveDB();

    groupRooms[id] = { id, name: groupName, members: allMembers, messages: [], createdBy: creator, avatar: null, createdAt };

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
    socket.emit('groupHistory', { groupId, messages: getGroupHistory(groupId) });
  });

  socket.on('groupMessage', ({ groupId, text, replyTo, attachment }) => {
    const name = socket.data.name;
    const g = groupRooms[groupId];
    if (!name || !g || !g.members.includes(name) || (!text && !attachment)) return;
    const msg = {
      id: uuidv4(), sender: name, text: (text || '').trim(),
      channel: 'group', replyTo: replyTo || null, groupId, timestamp: new Date().toISOString(),
      type: 'group', premium: getProfile(name).premium,
      attachment: attachment || null,
    };
    storeMessage(msg);
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
      dbState.group_members.push({ id: uuidv4(), groupId, member: memberName });
      saveDB();
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
    dbState.group_members = dbState.group_members.filter(m => !(m.groupId === groupId && m.member === name));
    saveDB();
    socket.leave(`group_${groupId}`);
    socket.emit('groupLeft', { groupId });
    io.to(`group_${groupId}`).emit('groupUpdated', g);
  });

  // ── Profile updates ───────────────────────────────────────────────────────
  socket.on('updateProfile', ({ avatar, bio, status }) => {
    const name = socket.data.name;
    if (!name) return;
    const updates = {};
    if (avatar !== undefined) updates.avatar = avatar;
    if (bio !== undefined) updates.bio = bio;
    if (status !== undefined) updates.status = status;
    if (Object.keys(updates).length) updateProfile(name, updates);
    const p = getProfile(name);
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
      id: uuidv4(), postedBy: name, title, description: description || null,
      subject: subject || null, dueDate: dueDate || null, timestamp: new Date().toISOString(),
    };
    dbState.homework.push(hw);
    saveDB();
    io.emit('homeworkPosted', { ...hw, comments: [], submissions: [] });
  });

  socket.on('homeworkComment', ({ hwId, text }) => {
    const name = socket.data.name;
    if (!name || !text) return;
    const exists = dbState.homework.some(hw => hw.id === hwId);
    if (!exists) return;
    const comment = { id: uuidv4(), hwId, sender: name, text, timestamp: new Date().toISOString() };
    dbState.homework_comments.push(comment);
    saveDB();
    io.emit('homeworkComment', { hwId, comment });
  });

  socket.on('submitHomework', ({ hwId, text }) => {
    const name = socket.data.name;
    if (!name || !text) return;
    const exists = dbState.homework.some(hw => hw.id === hwId);
    if (!exists) return;
    dbState.homework_submissions = dbState.homework_submissions.filter(sub => !(sub.hwId === hwId && sub.sender === name));
    const sub = { id: uuidv4(), hwId, sender: name, text, timestamp: new Date().toISOString() };
    dbState.homework_submissions.push(sub);
    saveDB();
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
    p.class_coins = p.coins;
    p.tier = tier;
    p.premium = (tier === 'premium');
    p.premiumSince = new Date().toISOString();
    updateProfile(name, {
      class_coins: p.class_coins,
      tier: p.tier,
      premium: p.premium,
      premiumSince: p.premiumSince,
    });
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
    p.coins -= t.cost;
    p.class_coins = p.coins;
    p.tier = 'premium';
    p.premium = true;
    p.premiumSince = new Date().toISOString();
    updateProfile(name, {
      class_coins: p.class_coins,
      tier: p.tier,
      premium: p.premium,
      premiumSince: p.premiumSince,
    });
    socket.emit('coinsData', { coins: p.coins, premium: p.premium, studyMinutes: p.studyMinutes });
  });

  // ── Coin Transfer ─────────────────────────────────────────────────────────
  socket.on('transferCoins', ({ to, amount }) => {
    const from = socket.data.name;
    if (!from) return;

    const recipients = Array.isArray(to) ? to : [to];
    const validRecipients = recipients.filter(name => typeof name === 'string' && name.trim());
    if (!validRecipients.length) {
      socket.emit('transferResult', { ok: false, error: '❌ Please choose at least one classmate.' });
      return;
    }

    const uniqueRecipients = [...new Set(validRecipients)];
    if (uniqueRecipients.length !== validRecipients.length) {
      socket.emit('transferResult', { ok: false, error: '❌ Please select each classmate only once.' });
      return;
    }
    if (uniqueRecipients.includes(from)) {
      socket.emit('transferResult', { ok: false, error: '❌ You cannot send coins to yourself.' });
      return;
    }

    const invalid = uniqueRecipients.find(name => !STUDENTS.some(s => s.name === name));
    if (invalid) {
      socket.emit('transferResult', { ok: false, error: `❌ "${invalid}" is not a valid classmate.` });
      return;
    }

    const amt = Math.floor(Number(amount));
    if (!amt || amt <= 0 || isNaN(amt)) {
      socket.emit('transferResult', { ok: false, error: '❌ Please enter a valid amount.' });
      return;
    }
    if (amt > 1000000) {
      socket.emit('transferResult', { ok: false, error: '❌ Maximum transfer per person is 1,000,000 coins.' });
      return;
    }

    const senderProfile = getProfile(from);
    const totalCost = amt * uniqueRecipients.length;
    if (senderProfile.coins < totalCost) {
      const shortBy = totalCost - senderProfile.coins;
      socket.emit('transferResult', {
        ok: false,
        error: `❌ Insufficient funds! You need ${shortBy.toLocaleString()} more 🪙 to send ${amt.toLocaleString()} to ${uniqueRecipients.length} classmate${uniqueRecipients.length===1?'':'s'}.`,
        balance: senderProfile.coins,
      });
      return;
    }

    const transferTx = (sender, recipients, amount) => {
      const senderRow = dbState.students.find(s => s.name === sender);
      if (!senderRow) return;
      senderRow.class_coins = (senderRow.class_coins || 0) - amount * recipients.length;
      senderRow.coins = (senderRow.coins || 0) - amount * recipients.length;
      recipients.forEach(recipient => {
        const recipientRow = dbState.students.find(s => s.name === recipient);
        if (recipientRow) {
          recipientRow.class_coins = (recipientRow.class_coins || 0) + amount;
          recipientRow.coins = (recipientRow.coins || 0) + amount;
        }
      });
      saveDB();
    };

    try {
      transferTx(from, uniqueRecipients, amt);
    } catch (err) {
      socket.emit('transferResult', { ok: false, error: '❌ Transfer failed. Please try again.' });
      return;
    }

    const updatedSender = getProfile(from);
    console.log(`💸 ${from} sent ${amt} coins each to ${uniqueRecipients.join(', ')} | ${from}: ${updatedSender.coins}`);

    socket.emit('transferResult', {
      ok: true,
      message: `✅ Successfully sent ${amt.toLocaleString()} 🪙 each to ${uniqueRecipients.length} classmate${uniqueRecipients.length===1?'':'s'}!`,
      newBalance: updatedSender.coins,
      to: uniqueRecipients,
      amount: amt,
    });

    uniqueRecipients.forEach(name => {
      const recipientProfile = getProfile(name);
      Object.entries(connectedUsers).forEach(([sid, u]) => {
        if (u.name === name) {
          io.to(sid).emit('coinsReceived', {
            from,
            amount: amt,
            newBalance: recipientProfile.coins,
            message: `💸 ${from} sent you ${amt.toLocaleString()} 🪙!`,
          });
          io.to(sid).emit('profileData', { name, profile: recipientProfile });
        }
      });
      io.emit('profileUpdated', { name, profile: recipientProfile });
    });

    io.emit('profileUpdated', { name: from, profile: updatedSender });
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
