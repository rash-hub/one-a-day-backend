import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3001;

// ---- data.json is loaded once, kept in memory, written back safely ----
let db = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
let writeQueue = Promise.resolve();
function save() {
  // One write at a time; write to a temp file then rename so the file is never half-written.
  writeQueue = writeQueue.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, DATA_FILE);
  }).catch((e) => console.error('Save failed', e));
  return writeQueue;
}

// ---- dates: the SERVER decides the day, in Indian time ----
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
const dayString = (d = new Date()) => fmt.format(d); // YYYY-MM-DD
const today = () => dayString();
const yesterday = () => dayString(new Date(Date.now() - 24 * 60 * 60 * 1000));
const dayNumber = (s) => Math.floor(Date.parse(s) / 86400000);
const questionFor = (date) => db.questions[dayNumber(date) % db.questions.length];

// ---- scoring rules ----
const BASE_POINTS = 10;
const MAX_BONUS = 10;

// ---- PIN hashing ----
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');

// ---- very small rate limiter (per IP, per minute) ----
const hits = new Map();
function limit(max) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (list.length >= max) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '2kb' }));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const name = db.sessions[token];
  if (!name || !db.users[name]) return res.status(401).json({ error: 'Please log in again.' });
  req.name = name;
  next();
}

function stats(name) {
  const u = db.users[name];
  // If the player missed a day, show the streak as 0 (it resets on the next answer).
  const alive = u.lastAnswered === today() || u.lastAnswered === yesterday();
  return { name: u.nickname, totalPoints: u.totalPoints, streak: alive ? u.streak : 0 };
}

// POST /api/login  { nickname, pin }  -> creates the player if new
app.post('/api/login', limit(20), async (req, res) => {
  const nickname = String(req.body.nickname || '').trim();
  const pin = String(req.body.pin || '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nickname))
    return res.status(400).json({ error: 'Nickname: 3 to 16 letters or numbers.' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 numbers.' });

  const key = nickname.toLowerCase();
  let user = db.users[key];
  if (!user) {
    const salt = crypto.randomBytes(16).toString('hex');
    user = db.users[key] = {
      nickname, salt, pinHash: hashPin(pin, salt),
      totalPoints: 0, streak: 0, lastAnswered: null, scoreAt: null,
      createdAt: new Date().toISOString(),
    };
  } else {
    const a = Buffer.from(hashPin(pin, user.salt), 'hex');
    const b = Buffer.from(user.pinHash, 'hex');
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong PIN for this nickname.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = key;
  await save();
  res.json({ token, ...stats(key) });
});

// GET /api/today -> today's tip + question (never the answer, until answered)
app.get('/api/today', auth, (req, res) => {
  const date = today();
  const q = questionFor(date);
  const attempt = db.attempts.find((a) => a.user === req.name && a.date === date);
  const out = { date, tip: q.tip, question: q.question, options: q.options, me: stats(req.name), answered: null };
  if (attempt) {
    out.answered = {
      choice: attempt.choice, correctIndex: q.answer,
      correct: attempt.correct, points: attempt.points,
    };
  }
  res.json(out);
});

// POST /api/answer { choice } -> server checks, scores, updates streak
app.post('/api/answer', auth, limit(30), async (req, res) => {
  const choice = req.body.choice;
  const date = today();
  const q = questionFor(date);
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length)
    return res.status(400).json({ error: 'Pick one of the answers.' });
  if (db.attempts.some((a) => a.user === req.name && a.date === date))
    return res.status(409).json({ error: 'You already answered today. Come back tomorrow!' });

  const u = db.users[req.name];
  u.streak = u.lastAnswered === yesterday() ? u.streak + 1 : 1; // wrong answers still count as showing up
  u.lastAnswered = date;
  const correct = choice === q.answer;
  const points = correct ? BASE_POINTS + Math.min(u.streak, MAX_BONUS) : 0;
  if (points > 0) { u.totalPoints += points; u.scoreAt = new Date().toISOString(); }
  db.attempts.push({ user: req.name, date, choice, correct, points });
  await save();
  res.json({ choice, correctIndex: q.answer, correct, points, me: stats(req.name) });
});

// GET /api/leaderboard -> top 10 + my own rank
app.get('/api/leaderboard', auth, (req, res) => {
  const ranked = Object.entries(db.users)
    .map(([key, u]) => ({ key, name: u.nickname, totalPoints: u.totalPoints, scoreAt: u.scoreAt || '9999' }))
    .sort((a, b) => b.totalPoints - a.totalPoints || a.scoreAt.localeCompare(b.scoreAt))
    .map((u, i) => ({ rank: i + 1, ...u }));
  const strip = ({ rank, name, totalPoints }) => ({ rank, name, totalPoints });
  const mine = ranked.find((u) => u.key === req.name);
  res.json({ top: ranked.slice(0, 10).map(strip), me: strip(mine) });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`One a Day API running on http://localhost:${PORT}`));
