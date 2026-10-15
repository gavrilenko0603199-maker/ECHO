import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { AccessToken } from 'livekit-server-sdk';
import { Resend } from 'resend';

dotenv.config();

const { Pool } = pg;
const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = Number(process.env.PORT) || 3001;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const SMTP_PASS = process.env.SMTP_PASS || process.env.RESEND_API_KEY || '';
const SMTP_FROM = process.env.SMTP_FROM || 'Echo <onboarding@resend.dev>';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const USER_TIMEOUT = 20000;
const CALL_TIMEOUT = 60000;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 8;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error(
    'Не заданы LIVEKIT_URL, LIVEKIT_API_KEY или LIVEKIT_API_SECRET.'
  );
  process.exit(1);
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5
    })
  : null;

const users = new Map();
const calls = new Map();
const localAccounts = new Map();
const localSessions = new Map();
const localHistory = new Map();

app.use(
  cors({
    origin(_origin, callback) {
      callback(null, true);
    }
  })
);

app.use(express.json({ limit: '10kb' }));

// -----------------------------------------------------------------------------
// Почта через Resend API
// -----------------------------------------------------------------------------

const resend = SMTP_PASS ? new Resend(SMTP_PASS) : null;

async function sendVerificationEmail(email, code) {
  const subject = 'Код подтверждения Echo';
  const text = `Твой код подтверждения для Echo: ${code}\n\nКод действует 15 минут.\nЕсли ты не регистрировался в Echo — просто проигнорируй это письмо.`;

  console.log(`[EMAIL] Код для ${email}: ${code}`);

  if (!resend) {
    console.log('[EMAIL] Resend API key не задан, письмо не отправлено');
    return;
  }

  try {
    const result = await resend.emails.send({
      from: SMTP_FROM,
      to: email,
      subject,
      text
    });

    if (result.error) {
      console.error('[EMAIL] Ошибка Resend:', JSON.stringify(result.error));
    } else {
      console.log(
        `[EMAIL] Письмо успешно отправлено на ${email}, id: ${result.data?.id}`
      );
    }
  } catch (err) {
    console.error('[EMAIL] Ошибка отправки:', err.message || err);
  }
}

// -----------------------------------------------------------------------------
// База данных
// -----------------------------------------------------------------------------

async function initDatabase() {
  if (!pool) {
    console.warn(
      'DATABASE_URL не задан. Используется временное хранилище.'
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name VARCHAR(48) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(254)
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS username VARCHAR(32)
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_code VARCHAR(6)
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (LOWER(email))
    WHERE email IS NOT NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
    ON users (LOWER(username))
    WHERE username IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx
    ON sessions(user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_history (
      id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      duration_seconds INTEGER NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    ALTER TABLE call_history
    ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE call_history
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS call_history_caller_idx
    ON call_history(caller_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS call_history_callee_idx
    ON call_history(callee_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_pair_unique
    ON conversations (
      LEAST(user_a, user_b),
      GREATEST(user_a, user_b)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS messages_conversation_idx
    ON messages(conversation_id, created_at DESC)
  `);

  await pool.query(`
    DELETE FROM sessions WHERE expires_at <= NOW()
  `);

  console.log(
    'PostgreSQL подключён. Таблицы пользователей, сессий, истории и чатов готовы.'
  );
}

// -----------------------------------------------------------------------------
// Общие функции
// -----------------------------------------------------------------------------

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 48);
}

function cleanEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  let u = value.trim().toLowerCase().replace(/^@+/, '');
  u = u.replace(/[^a-z0-9._]/g, '');
  return u.slice(0, 32);
}

function isValidEmail(email) {
  return (
    email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function isValidUsername(username) {
  return (
    username.length >= 3 &&
    username.length <= 32 &&
    /^[a-z0-9][a-z0-9._]*$/.test(username)
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username || null,
    online: Date.now() - (user.lastSeen || 0) < USER_TIMEOUT
  };
}

function authUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username || null,
    emailVerified: Boolean(user.email_verified ?? user.emailVerified)
  };
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');

  return scryptAsync(password, salt, 64).then((derivedKey) => {
    return `${salt}:${derivedKey.toString('hex')}`;
  });
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') return false;

  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;

  const [salt, savedHex] = parts;

  if (
    !/^[a-f0-9]{32}$/i.test(salt) ||
    !/^[a-f0-9]{128}$/i.test(savedHex)
  ) {
    return false;
  }

  const derivedKey = await scryptAsync(password, salt, 64);
  const savedKey = Buffer.from(savedHex, 'hex');

  return (
    savedKey.length === derivedKey.length &&
    crypto.timingSafeEqual(savedKey, derivedKey)
  );
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  if (pool) {
    await pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, userId, expiresAt]
    );
  } else {
    localSessions.set(tokenHash, {
      userId,
      expiresAt: expiresAt.getTime()
    });
  }

  return token;
}

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';

  const match = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  return match ? match[1] : '';
}

async function findUserBySession(token) {
  if (!token) return null;

  const tokenHash = hashSessionToken(token);

  if (pool) {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.username, u.email_verified
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.expires_at > NOW()
         AND u.password_hash IS NOT NULL
         AND u.email_verified = TRUE`,
      [tokenHash]
    );

    return result.rows[0] || null;
  }

  const session = localSessions.get(tokenHash);

  if (!session || session.expiresAt <= Date.now()) {
    localSessions.delete(tokenHash);
    return null;
  }

  const account = localAccounts.get(session.userId);
  if (!account?.password_hash || !account.email_verified) return null;
  return account;
}

async function deleteSession(token) {
  if (!token) return;

  const tokenHash = hashSessionToken(token);

  if (pool) {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash
    ]);
  } else {
    localSessions.delete(tokenHash);
  }
}

// -----------------------------------------------------------------------------
// История звонков
// -----------------------------------------------------------------------------

function isFinalCallStatus(status) {
  return ['ended', 'rejected', 'missed'].includes(status);
}

function getDurationSeconds(call) {
  if (call.status !== 'ended' || !call.acceptedAt) return 0;

  const endTime = call.endedAt || Date.now();

  return Math.max(0, Math.floor((endTime - call.acceptedAt) / 1000));
}

async function saveCallHistory(call) {
  if (!isFinalCallStatus(call.status)) return;

  const endedAt = call.endedAt ? new Date(call.endedAt) : new Date();

  const durationSeconds = getDurationSeconds({
    ...call,
    endedAt: endedAt.getTime()
  });

  if (!pool) {
    const previous = localHistory.get(call.id);

    localHistory.set(call.id, {
      id: call.id,
      caller_id: call.from,
      callee_id: call.to,
      status: call.status,
      created_at:
        previous?.created_at || new Date(call.createdAt).toISOString(),
      updated_at: new Date().toISOString(),
      ended_at: previous?.ended_at || endedAt.toISOString(),
      accepted_at: call.acceptedAt
        ? new Date(call.acceptedAt).toISOString()
        : previous?.accepted_at || null,
      duration_seconds: durationSeconds
    });

    return;
  }

  await pool.query(
    `INSERT INTO call_history (
       id,
       caller_id,
       callee_id,
       status,
       created_at,
       updated_at,
       ended_at,
       accepted_at,
       duration_seconds
     )
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = NOW(),
       ended_at = COALESCE(call_history.ended_at, EXCLUDED.ended_at),
       accepted_at = COALESCE(
         call_history.accepted_at,
         EXCLUDED.accepted_at
       ),
       duration_seconds = CASE
         WHEN EXCLUDED.status = 'ended'
           THEN EXCLUDED.duration_seconds
         ELSE call_history.duration_seconds
       END`,
    [
      call.id,
      call.from,
      call.to,
      call.status,
      new Date(call.createdAt),
      endedAt,
      call.acceptedAt ? new Date(call.acceptedAt) : null,
      durationSeconds
    ]
  );
}

async function getOtherUserName(otherId) {
  const active = users.get(otherId);
  if (active?.name) return active.name;

  if (!pool) {
    return localAccounts.get(otherId)?.name || 'Пользователь';
  }

  const result = await pool.query(
    'SELECT name FROM users WHERE id = $1',
    [otherId]
  );

  return result.rows[0]?.name || 'Пользователь';
}

async function historyItem(row, userId) {
  const isCaller = row.caller_id === userId;
  const otherId = isCaller ? row.callee_id : row.caller_id;
  const name = await getOtherUserName(otherId);

  let type;

  if (isCaller) {
    type = 'outgoing';
  } else if (row.status === 'rejected' || row.status === 'missed') {
    type = 'missed';
  } else {
    type = 'incoming';
  }

  return {
    id: row.id,
    callId: row.id,
    otherUserId: otherId,
    name,
    status: row.status,
    type,
    direction: isCaller ? 'outgoing' : 'incoming',
    createdAt: row.created_at,
    endedAt: row.ended_at || null,
    durationSeconds: Number(row.duration_seconds) || 0
  };
}

async function getCallHistory(userId) {
  let rows;

  if (pool) {
    const result = await pool.query(
      `SELECT
         id,
         caller_id,
         callee_id,
         status,
         created_at,
         ended_at,
         duration_seconds
       FROM call_history
       WHERE (caller_id = $1 OR callee_id = $1)
         AND status IN ('ended', 'rejected', 'missed')
       ORDER BY COALESCE(ended_at, created_at) DESC
       LIMIT 200`,
      [userId]
    );

    rows = result.rows;
  } else {
    rows = [...localHistory.values()]
      .filter(
        (row) =>
          (row.caller_id === userId || row.callee_id === userId) &&
          isFinalCallStatus(row.status)
      )
      .sort(
        (a, b) =>
          new Date(b.ended_at || b.created_at).getTime() -
          new Date(a.ended_at || a.created_at).getTime()
      )
      .slice(0, 200);
  }

  return Promise.all(rows.map((row) => historyItem(row, userId)));
}

// -----------------------------------------------------------------------------
// Чаты — вспомогательные функции
// -----------------------------------------------------------------------------

function pairUsers(id1, id2) {
  return id1 < id2 ? [id1, id2] : [id2, id1];
}

async function findOrCreateConversation(userId, otherId) {
  if (!pool) {
    throw new Error('DATABASE_URL required for chats');
  }

  const [userA, userB] = pairUsers(userId, otherId);

  const existing = await pool.query(
    `SELECT id, user_a, user_b, created_at, updated_at
     FROM conversations
     WHERE user_a = $1 AND user_b = $2
     LIMIT 1`,
    [userA, userB]
  );

  if (existing.rowCount > 0) return existing.rows[0];

  const id = crypto.randomUUID();
  const inserted = await pool.query(
    `INSERT INTO conversations (id, user_a, user_b)
     VALUES ($1, $2, $3)
     RETURNING id, user_a, user_b, created_at, updated_at`,
    [id, userA, userB]
  );

  return inserted.rows[0];
}

async function getOtherParticipant(conv, meId) {
  const otherId = conv.user_a === meId ? conv.user_b : conv.user_a;

  if (!pool) {
    return { id: otherId, name: 'Пользователь', username: null };
  }

  const result = await pool.query(
    `SELECT id, name, username FROM users
     WHERE id = $1 AND email_verified = TRUE`,
    [otherId]
  );

  if (result.rowCount === 0) {
    return { id: otherId, name: 'Пользователь', username: null };
  }

  return result.rows[0];
}

// -----------------------------------------------------------------------------
// Авторизация
// -----------------------------------------------------------------------------

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    const account = await findUserBySession(token);

    if (!account) {
      return res.status(401).json({
        error:
          'Сессия истекла или недействительна. Войди в аккаунт ещё раз.'
      });
    }

    req.authUser = account;
    next();
  } catch (error) {
    console.error('Ошибка авторизации запроса:', error);

    return res.status(500).json({
      error: 'Не удалось проверить авторизацию.'
    });
  }
}

function requireOwnUserId(req, res, suppliedUserId) {
  if (
    typeof suppliedUserId !== 'string' ||
    suppliedUserId !== req.authUser.id
  ) {
    res.status(403).json({
      error: 'Нет доступа к этому аккаунту.'
    });

    return false;
  }

  return true;
}

// -----------------------------------------------------------------------------
// Восстановление пользователя
// -----------------------------------------------------------------------------

async function restoreUser(userId) {
  if (typeof userId !== 'string' || !userId) return null;

  const activeUser = users.get(userId);

  if (activeUser) {
    activeUser.lastSeen = Date.now();
    return activeUser;
  }

  if (!pool) {
    const account = localAccounts.get(userId);
    if (!account || !account.email_verified) return null;

    const user = {
      id: account.id,
      name: account.name,
      username: account.username,
      lastSeen: Date.now()
    };

    users.set(user.id, user);
    return user;
  }

  const result = await pool.query(
    `SELECT id, name, username
     FROM users
     WHERE id = $1 AND email_verified = TRUE`,
    [userId]
  );

  if (result.rowCount === 0) return null;

  const user = {
    id: result.rows[0].id,
    name: result.rows[0].name,
    username: result.rows[0].username,
    lastSeen: Date.now()
  };

  users.set(user.id, user);
  return user;
}

function getCallForUser(call, userId) {
  if (call.from !== userId && call.to !== userId) return false;

  const otherId = call.from === userId ? call.to : call.from;
  const other = users.get(otherId);

  return {
    id: call.id,
    roomName: call.roomName,
    status: call.status,
    from: call.from,
    to: call.to,
    caller: publicUser(
      users.get(call.from) || {
        id: call.from,
        name: 'Пользователь',
        lastSeen: 0
      }
    ),
    callee: publicUser(
      users.get(call.to) || {
        id: call.to,
        name: 'Пользователь',
        lastSeen: 0
      }
    ),
    other: other
      ? publicUser(other)
      : {
          id: otherId,
          name: 'Пользователь',
          online: false
        },
    createdAt: call.createdAt
  };
}

function findCall(id) {
  return calls.get(id);
}

function isCallParticipant(call, userId) {
  return Boolean(call && (call.from === userId || call.to === userId));
}

function touchUser(userId) {
  const user = users.get(userId);

  if (user) user.lastSeen = Date.now();

  return user;
}

function cleanup() {
  const now = Date.now();

  for (const [id, user] of users) {
    if (now - user.lastSeen > USER_TIMEOUT) {
      users.delete(id);
    }
  }

  for (const [id, call] of calls) {
    const expired = now - call.createdAt > CALL_TIMEOUT * 10;

    if (expired || isFinalCallStatus(call.status)) {
      calls.delete(id);
      continue;
    }

    if (
      call.status === 'ringing' &&
      now - call.createdAt > CALL_TIMEOUT
    ) {
      call.status = 'missed';
      call.endedAt = now;

      void saveCallHistory(call).catch((error) => {
        console.error('Ошибка сохранения пропущенного звонка:', error);
      });
    }
  }
}

setInterval(cleanup, 5000);

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Echo voice and call server'
  });
});

// -----------------------------------------------------------------------------
// Регистрация
// -----------------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = cleanName(req.body?.name);
    const username = cleanUsername(req.body?.username);
    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;

    if (name.length < 2) {
      return res.status(400).json({
        error: 'Имя должно содержать минимум 2 символа.'
      });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error:
          'Ник должен быть от 3 до 32 символов (латиница, цифры, точка и _). Без @.'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Укажи корректный адрес электронной почты.'
      });
    }

    if (
      typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res.status(400).json({
        error: 'Пароль должен содержать от 8 до 128 символов.'
      });
    }

    const passwordHash = await createPasswordHash(password);
    const id = crypto.randomUUID();
    const code = generateCode();
    const expires = new Date(Date.now() + CODE_TTL_MS);

    if (pool) {
      const existing = await pool.query(
        `SELECT
           (SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1) AS email_taken,
           (SELECT 1 FROM users WHERE LOWER(username) = $2 LIMIT 1) AS username_taken`,
        [email, username]
      );

      if (existing.rows[0]?.email_taken) {
        return res.status(409).json({
          error: 'Этот адрес электронной почты уже зарегистрирован.'
        });
      }

      if (existing.rows[0]?.username_taken) {
        return res.status(409).json({
          error: 'Этот ник уже занят. Выбери другой.'
        });
      }

      await pool.query(
        `INSERT INTO users (
           id, name, email, password_hash, username,
           email_verified, verification_code, verification_expires, verification_attempts
         )
         VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, 0)`,
        [id, name, email, passwordHash, username, code, expires]
      );
    } else {
      const emailTaken = [...localAccounts.values()].some(
        (u) => u.email === email
      );
      const usernameTaken = [...localAccounts.values()].some(
        (u) => u.username === username
      );

      if (emailTaken) {
        return res.status(409).json({
          error: 'Этот адрес электронной почты уже зарегистрирован.'
        });
      }

      if (usernameTaken) {
        return res.status(409).json({
          error: 'Этот ник уже занят. Выбери другой.'
        });
      }

      localAccounts.set(id, {
        id,
        name,
        email,
        username,
        password_hash: passwordHash,
        email_verified: false,
        verification_code: code,
        verification_expires: expires.getTime(),
        verification_attempts: 0
      });
    }

    void sendVerificationEmail(email, code);

    res.status(201).json({
      needsVerification: true,
      email
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);

    res.status(500).json({
      error: 'Не удалось создать аккаунт. Попробуй ещё раз.'
    });
  }
});

// -----------------------------------------------------------------------------
// Подтверждение кода
// -----------------------------------------------------------------------------

app.post('/api/auth/verify', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const code =
      typeof req.body?.code === 'string'
        ? req.body.code.trim()
        : '';

    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        error: 'Укажи почту и 6-значный код из письма.'
      });
    }

    let account;

    if (pool) {
      const result = await pool.query(
        `SELECT id, name, email, username, password_hash,
                email_verified, verification_code, verification_expires,
                verification_attempts
         FROM users
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [email]
      );

      account = result.rows[0] || null;
    } else {
      account =
        [...localAccounts.values()].find((u) => u.email === email) ||
        null;
    }

    if (!account || !account.password_hash) {
      return res.status(404).json({
        error: 'Аккаунт не найден. Зарегистрируйся заново.'
      });
    }

    if (account.email_verified) {
      const token = await createSession(account.id);

      users.set(account.id, {
        id: account.id,
        name: account.name,
        username: account.username,
        lastSeen: Date.now()
      });

      return res.json({
        user: authUser({ ...account, email_verified: true }),
        token
      });
    }

    const expires = pool
      ? account.verification_expires
        ? new Date(account.verification_expires).getTime()
        : 0
      : account.verification_expires || 0;

    if (!account.verification_code || Date.now() > expires) {
      return res.status(400).json({
        error: 'Код истёк. Запроси новый код.'
      });
    }

    const attempts = Number(account.verification_attempts) || 0;

    if (attempts >= MAX_CODE_ATTEMPTS) {
      return res.status(429).json({
        error: 'Слишком много попыток. Запроси новый код.'
      });
    }

    if (account.verification_code !== code) {
      if (pool) {
        await pool.query(
          `UPDATE users
           SET verification_attempts = verification_attempts + 1
           WHERE id = $1`,
          [account.id]
        );
      } else {
        account.verification_attempts = attempts + 1;
      }

      return res.status(400).json({
        error: 'Неверный код. Проверь письмо и попробуй ещё раз.'
      });
    }

    if (pool) {
      await pool.query(
        `UPDATE users
         SET email_verified = TRUE,
             verification_code = NULL,
             verification_expires = NULL,
             verification_attempts = 0
         WHERE id = $1`,
        [account.id]
      );
    } else {
      account.email_verified = true;
      account.verification_code = null;
      account.verification_expires = null;
      account.verification_attempts = 0;
    }

    const token = await createSession(account.id);

    users.set(account.id, {
      id: account.id,
      name: account.name,
      username: account.username,
      lastSeen: Date.now()
    });

    res.json({
      user: authUser({ ...account, email_verified: true }),
      token
    });
  } catch (error) {
    console.error('Ошибка подтверждения кода:', error);

    res.status(500).json({
      error: 'Не удалось подтвердить код. Попробуй ещё раз.'
    });
  }
});

// -----------------------------------------------------------------------------
// Повторная отправка кода
// -----------------------------------------------------------------------------

app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Укажи корректный адрес электронной почты.'
      });
    }

    let account;

    if (pool) {
      const result = await pool.query(
        `SELECT id, email, email_verified
         FROM users
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [email]
      );
      account = result.rows[0] || null;
    } else {
      account =
        [...localAccounts.values()].find((u) => u.email === email) ||
        null;
    }

    if (!account) {
      return res.status(404).json({
        error: 'Аккаунт не найден.'
      });
    }

    if (account.email_verified) {
      return res.status(400).json({
        error: 'Почта уже подтверждена. Можно входить.'
      });
    }

    const code = generateCode();
    const expires = new Date(Date.now() + CODE_TTL_MS);

    if (pool) {
      await pool.query(
        `UPDATE users
         SET verification_code = $1,
             verification_expires = $2,
             verification_attempts = 0
         WHERE id = $3`,
        [code, expires, account.id]
      );
    } else {
      account.verification_code = code;
      account.verification_expires = expires.getTime();
      account.verification_attempts = 0;
    }

    void sendVerificationEmail(email, code);

    res.json({ ok: true, email });
  } catch (error) {
    console.error('Ошибка повторной отправки кода:', error);

    res.status(500).json({
      error: 'Не удалось отправить код.'
    });
  }
});

// -----------------------------------------------------------------------------
// Вход
// -----------------------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;

    if (
      !isValidEmail(email) ||
      typeof password !== 'string' ||
      password.length === 0 ||
      password.length > 128
    ) {
      return res.status(400).json({
        error: 'Проверь электронную почту и пароль.'
      });
    }

    let account;

    if (pool) {
      const result = await pool.query(
        `SELECT id, name, email, username, password_hash, email_verified
         FROM users
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [email]
      );

      account = result.rows[0] || null;
    } else {
      account =
        [...localAccounts.values()].find((u) => u.email === email) ||
        null;
    }

    if (
      !account ||
      !account.password_hash ||
      !(await verifyPassword(password, account.password_hash))
    ) {
      return res.status(401).json({
        error: 'Неверная электронная почта или пароль.'
      });
    }

    if (!account.email_verified) {
      return res.status(403).json({
        error: 'Почта не подтверждена. Введи код из письма.',
        needsVerification: true,
        email: account.email
      });
    }

    const token = await createSession(account.id);

    users.set(account.id, {
      id: account.id,
      name: account.name,
      username: account.username,
      lastSeen: Date.now()
    });

    res.json({
      user: authUser(account),
      token
    });
  } catch (error) {
    console.error('Ошибка входа:', error);

    res.status(500).json({
      error: 'Не удалось выполнить вход. Попробуй ещё раз.'
    });
  }
});

// -----------------------------------------------------------------------------
// Проверка сессии
// -----------------------------------------------------------------------------

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = getBearerToken(req);
    const account = await findUserBySession(token);

    if (!account) {
      return res.status(401).json({
        error: 'Сессия истекла. Войди в аккаунт ещё раз.'
      });
    }

    const user = await restoreUser(account.id);

    if (!user) {
      return res.status(401).json({
        error: 'Аккаунт не найден. Войди ещё раз.'
      });
    }

    res.json({
      user: {
        ...authUser(account),
        online: true
      }
    });
  } catch (error) {
    console.error('Ошибка проверки сессии:', error);

    res.status(500).json({
      error: 'Не удалось проверить сессию.'
    });
  }
});

// -----------------------------------------------------------------------------
// Выход
// -----------------------------------------------------------------------------

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = getBearerToken(req);

    if (token) await deleteSession(token);

    res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка выхода:', error);

    res.status(500).json({
      error: 'Не удалось завершить сессию.'
    });
  }
});

// -----------------------------------------------------------------------------
// Старая совместимость
// -----------------------------------------------------------------------------

app.post('/api/register', async (req, res) => {
  try {
    const name = cleanName(req.body?.name);

    if (!name) {
      return res.status(400).json({
        error: 'Укажи имя пользователя.'
      });
    }

    const id = crypto.randomUUID();

    if (pool) {
      await pool.query(
        'INSERT INTO users (id, name, email_verified) VALUES ($1, $2, TRUE)',
        [id, name]
      );
    }

    const user = {
      id,
      name,
      lastSeen: Date.now()
    };

    users.set(id, user);

    res.json({
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Ошибка старой регистрации:', error);

    res.status(500).json({
      error: 'Не удалось создать аккаунт. Попробуй ещё раз.'
    });
  }
});

// -----------------------------------------------------------------------------
// Защита API
// -----------------------------------------------------------------------------

app.use(
  [
    '/api/profile',
    '/api/state',
    '/api/call',
    '/api/token',
    '/api/history',
    '/api/users',
    '/api/conversations'
  ],
  requireAuth
);

// -----------------------------------------------------------------------------
// Поиск пользователей
// -----------------------------------------------------------------------------

app.get('/api/users/search', async (req, res) => {
  try {
    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    const q = cleanUsername(raw);

    if (q.length < 2) {
      return res.json({ users: [] });
    }

    let rows = [];

    if (pool) {
      const result = await pool.query(
        `SELECT id, name, username
         FROM users
         WHERE email_verified = TRUE
           AND username IS NOT NULL
           AND (
             LOWER(username) = $1
             OR LOWER(username) LIKE $2
             OR LOWER(name) LIKE $2
           )
         ORDER BY
           CASE WHEN LOWER(username) = $1 THEN 0 ELSE 1 END,
           username
         LIMIT 20`,
        [q, `${q}%`]
      );
      rows = result.rows;
    } else {
      rows = [...localAccounts.values()]
        .filter(
          (u) =>
            u.email_verified &&
            u.username &&
            (u.username === q ||
              u.username.startsWith(q) ||
              u.name.toLowerCase().startsWith(q))
        )
        .slice(0, 20)
        .map((u) => ({
          id: u.id,
          name: u.name,
          username: u.username
        }));
    }

    const list = rows
      .filter((row) => row.id !== req.authUser.id)
      .map((row) => {
        const active = users.get(row.id);
        return publicUser({
          id: row.id,
          name: row.name,
          username: row.username,
          lastSeen: active?.lastSeen || 0
        });
      });

    res.json({ users: list });
  } catch (error) {
    console.error('Ошибка поиска пользователей:', error);

    res.status(500).json({
      error: 'Не удалось выполнить поиск.'
    });
  }
});

// -----------------------------------------------------------------------------
// Чаты
// -----------------------------------------------------------------------------

app.get('/api/conversations', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'База данных недоступна.' });
    }

    const me = req.authUser.id;

    const result = await pool.query(
      `SELECT
         c.id,
         c.user_a,
         c.user_b,
         c.updated_at,
         (
           SELECT m.body FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_body,
         (
           SELECT m.created_at FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_at,
         (
           SELECT COUNT(*)::int FROM messages m
           WHERE m.conversation_id = c.id
             AND m.sender_id <> $1
             AND m.read_at IS NULL
         ) AS unread
       FROM conversations c
       WHERE c.user_a = $1 OR c.user_b = $1
       ORDER BY COALESCE(
         (SELECT m.created_at FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1),
         c.updated_at
       ) DESC
       LIMIT 100`,
      [me]
    );

    const list = await Promise.all(
      result.rows.map(async (row) => {
        const other = await getOtherParticipant(row, me);
        const active = users.get(other.id);
        return {
          id: row.id,
          other: publicUser({
            id: other.id,
            name: other.name,
            username: other.username,
            lastSeen: active?.lastSeen || 0
          }),
          lastMessage: row.last_body
            ? { body: row.last_body, createdAt: row.last_at }
            : null,
          unread: row.unread || 0
        };
      })
    );

    res.json({ conversations: list });
  } catch (error) {
    console.error('Ошибка списка диалогов:', error);
    res.status(500).json({ error: 'Не удалось загрузить чаты.' });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'База данных недоступна.' });
    }

    const otherId =
      typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';

    if (!otherId || otherId === req.authUser.id) {
      return res.status(400).json({
        error: 'Укажи другого пользователя.'
      });
    }

    const otherCheck = await pool.query(
      `SELECT id, name, username FROM users
       WHERE id = $1 AND email_verified = TRUE`,
      [otherId]
    );

    if (otherCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден.' });
    }

    const conv = await findOrCreateConversation(req.authUser.id, otherId);
    const other = otherCheck.rows[0];
    const active = users.get(other.id);

    res.json({
      conversation: {
        id: conv.id,
        other: publicUser({
          id: other.id,
          name: other.name,
          username: other.username,
          lastSeen: active?.lastSeen || 0
        })
      }
    });
  } catch (error) {
    console.error('Ошибка создания диалога:', error);
    res.status(500).json({ error: 'Не удалось открыть чат.' });
  }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'База данных недоступна.' });
    }

    const me = req.authUser.id;
    const convId = req.params.id;

    const convResult = await pool.query(
      `SELECT id, user_a, user_b FROM conversations WHERE id = $1`,
      [convId]
    );

    if (convResult.rowCount === 0) {
      return res.status(404).json({ error: 'Диалог не найден.' });
    }

    const conv = convResult.rows[0];
    if (conv.user_a !== me && conv.user_b !== me) {
      return res.status(403).json({ error: 'Нет доступа к этому чату.' });
    }

    await pool.query(
      `UPDATE messages
       SET read_at = NOW()
       WHERE conversation_id = $1
         AND sender_id <> $2
         AND read_at IS NULL`,
      [convId, me]
    );

    const before =
      typeof req.query.before === 'string' ? req.query.before : null;

    let messagesResult;
    if (before) {
      messagesResult = await pool.query(
        `SELECT id, sender_id, body, created_at, read_at
         FROM messages
         WHERE conversation_id = $1 AND created_at < $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [convId, before]
      );
    } else {
      messagesResult = await pool.query(
        `SELECT id, sender_id, body, created_at, read_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [convId]
      );
    }

    const messages = messagesResult.rows
      .map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        createdAt: m.created_at,
        readAt: m.read_at,
        mine: m.sender_id === me
      }))
      .reverse();

    const other = await getOtherParticipant(conv, me);

    res.json({
      conversationId: convId,
      other: publicUser({
        id: other.id,
        name: other.name,
        username: other.username,
        lastSeen: users.get(other.id)?.lastSeen || 0
      }),
      messages
    });
  } catch (error) {
    console.error('Ошибка загрузки сообщений:', error);
    res.status(500).json({ error: 'Не удалось загрузить сообщения.' });
  }
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'База данных недоступна.' });
    }

    const me = req.authUser.id;
    const convId = req.params.id;
    const body =
      typeof req.body?.body === 'string' ? req.body.body.trim() : '';

    if (!body || body.length > 4000) {
      return res.status(400).json({
        error: 'Сообщение должно быть от 1 до 4000 символов.'
      });
    }

    const convResult = await pool.query(
      `SELECT id, user_a, user_b FROM conversations WHERE id = $1`,
      [convId]
    );

    if (convResult.rowCount === 0) {
      return res.status(404).json({ error: 'Диалог не найден.' });
    }

    const conv = convResult.rows[0];
    if (conv.user_a !== me && conv.user_b !== me) {
      return res.status(403).json({ error: 'Нет доступа к этому чату.' });
    }

    const id = crypto.randomUUID();

    const inserted = await pool.query(
      `INSERT INTO messages (id, conversation_id, sender_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, sender_id, body, created_at, read_at`,
      [id, convId, me, body]
    );

    await pool.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [convId]
    );

    const m = inserted.rows[0];

    res.status(201).json({
      message: {
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        createdAt: m.created_at,
        readAt: m.read_at,
        mine: true
      }
    });
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
    res.status(500).json({ error: 'Не удалось отправить сообщение.' });
  }
});

// -----------------------------------------------------------------------------
// История
// -----------------------------------------------------------------------------

app.get('/api/history', async (req, res) => {
  try {
    const history = await getCallHistory(req.authUser.id);
    res.json({ history });
  } catch (error) {
    console.error('Ошибка загрузки истории звонков:', error);

    res.status(500).json({
      error: 'Не удалось загрузить историю звонков.'
    });
  }
});

// -----------------------------------------------------------------------------
// Профиль
// -----------------------------------------------------------------------------

app.post('/api/profile', async (req, res) => {
  try {
    const { userId } = req.body ?? {};
    const name = cleanName(req.body?.name);
    const usernameRaw = req.body?.username;
    const username =
      typeof usernameRaw === 'string'
        ? cleanUsername(usernameRaw)
        : null;

    if (!requireOwnUserId(req, res, userId)) return;

    if (name.length < 2) {
      return res.status(400).json({
        error: 'Имя должно содержать минимум 2 символа.'
      });
    }

    if (username !== null && !isValidUsername(username)) {
      return res.status(400).json({
        error:
          'Ник должен быть от 3 до 32 символов (латиница, цифры, точка и _).'
      });
    }

    const user = await restoreUser(req.authUser.id);

    if (!user) {
      return res.status(404).json({
        error: 'Пользователь не найден. Перезапусти Echo.'
      });
    }

    if (pool) {
      if (username) {
        const taken = await pool.query(
          `SELECT 1 FROM users
           WHERE LOWER(username) = $1 AND id <> $2
           LIMIT 1`,
          [username, user.id]
        );

        if (taken.rowCount > 0) {
          return res.status(409).json({
            error: 'Этот ник уже занят.'
          });
        }
      }

      await pool.query(
        `UPDATE users
         SET name = $1,
             username = COALESCE($2, username)
         WHERE id = $3`,
        [name, username, user.id]
      );
    } else {
      const account = localAccounts.get(user.id);
      if (account) {
        if (username) {
          const taken = [...localAccounts.values()].some(
            (u) => u.username === username && u.id !== user.id
          );
          if (taken) {
            return res.status(409).json({
              error: 'Этот ник уже занят.'
            });
          }
          account.username = username;
        }
        account.name = name;
      }
    }

    user.name = name;
    if (username) user.username = username;
    user.lastSeen = Date.now();

    res.json({
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Ошибка обновления профиля:', error);

    res.status(500).json({
      error: 'Не удалось сохранить профиль.'
    });
  }
});

// -----------------------------------------------------------------------------
// Состояние
// -----------------------------------------------------------------------------

app.get('/api/state', async (req, res) => {
  try {
    cleanup();

    const userId = req.authUser.id;
    const user = await restoreUser(userId);

    if (!user) {
      return res.status(401).json({
        error: 'Аккаунт не найден. Войди в Echo ещё раз.'
      });
    }

    const onlineUsers = [...users.values()]
      .filter(
        (item) =>
          item.id !== userId &&
          Date.now() - item.lastSeen < USER_TIMEOUT
      )
      .map(publicUser);

    const relevantCalls = [...calls.values()]
      .filter((call) => isCallParticipant(call, userId))
      .sort((a, b) => b.createdAt - a.createdAt);

    const incomingCall = relevantCalls.find(
      (call) => call.to === userId && call.status === 'ringing'
    );

    const outgoingCall = relevantCalls.find(
      (call) => call.from === userId && call.status === 'ringing'
    );

    const activeCall = relevantCalls.find(
      (call) => call.status === 'accepted'
    );

    res.json({
      me: publicUser(user),
      users: onlineUsers,
      incomingCall: incomingCall
        ? getCallForUser(incomingCall, userId)
        : null,
      outgoingCall: outgoingCall
        ? getCallForUser(outgoingCall, userId)
        : null,
      activeCall: activeCall
        ? getCallForUser(activeCall, userId)
        : null
    });
  } catch (error) {
    console.error('Ошибка получения состояния:', error);

    res.status(500).json({
      error: 'Не удалось получить состояние Echo.'
    });
  }
});

// -----------------------------------------------------------------------------
// Звонки
// -----------------------------------------------------------------------------

app.post('/api/call', async (req, res) => {
  try {
    cleanup();

    const { callerId, calleeId } = req.body ?? {};

    if (!requireOwnUserId(req, res, callerId)) return;

    const caller = await restoreUser(req.authUser.id);
    let callee = touchUser(calleeId);

    if (!callee && pool) {
      const result = await pool.query(
        `SELECT id, name, username
         FROM users
         WHERE id = $1 AND email_verified = TRUE`,
        [calleeId]
      );

      if (result.rowCount > 0) {
        callee = {
          id: result.rows[0].id,
          name: result.rows[0].name,
          username: result.rows[0].username,
          lastSeen: 0
        };
      }
    } else if (!callee && !pool) {
      const account = localAccounts.get(calleeId);
      if (account?.email_verified) {
        callee = {
          id: account.id,
          name: account.name,
          username: account.username,
          lastSeen: 0
        };
      }
    }

    if (!caller || !callee) {
      return res.status(404).json({
        error: 'Пользователь не найден.'
      });
    }

    if (caller.id === callee.id) {
      return res.status(400).json({
        error: 'Нельзя позвонить самому себе.'
      });
    }

    if (Date.now() - (callee.lastSeen || 0) >= USER_TIMEOUT) {
      return res.status(409).json({
        error: 'Пользователь сейчас не в сети.'
      });
    }

    const busy = [...calls.values()].some(
      (call) =>
        ['ringing', 'accepted'].includes(call.status) &&
        (call.from === callee.id ||
          call.to === callee.id ||
          call.from === caller.id ||
          call.to === caller.id)
    );

    if (busy) {
      return res.status(409).json({
        error: 'Один из пользователей уже участвует в звонке.'
      });
    }

    const id = crypto.randomUUID();

    const call = {
      id,
      from: caller.id,
      to: callee.id,
      roomName: `echo-call-${id.replace(/-/g, '')}`,
      status: 'ringing',
      createdAt: Date.now(),
      acceptedAt: null,
      endedAt: null
    };

    calls.set(id, call);

    res.json({
      call: getCallForUser(call, caller.id)
    });
  } catch (error) {
    console.error('Ошибка создания звонка:', error);

    res.status(500).json({
      error: 'Не удалось начать звонок.'
    });
  }
});

app.post('/api/call/:id/accept', async (req, res) => {
  try {
    const { userId } = req.body ?? {};

    if (!requireOwnUserId(req, res, userId)) return;

    const call = findCall(req.params.id);
    const user = await restoreUser(req.authUser.id);

    if (!user || !call || call.to !== user.id) {
      return res.status(404).json({
        error: 'Входящий вызов не найден.'
      });
    }

    if (call.status !== 'ringing') {
      return res.status(409).json({
        error: 'Этот вызов уже завершён.'
      });
    }

    call.status = 'accepted';
    call.acceptedAt = Date.now();

    res.json({
      call: getCallForUser(call, user.id)
    });
  } catch (error) {
    console.error('Ошибка принятия звонка:', error);

    res.status(500).json({
      error: 'Не удалось принять звонок.'
    });
  }
});

app.post('/api/call/:id/reject', async (req, res) => {
  try {
    const { userId } = req.body ?? {};

    if (!requireOwnUserId(req, res, userId)) return;

    const call = findCall(req.params.id);

    if (!call || call.to !== req.authUser.id) {
      return res.status(404).json({
        error: 'Входящий вызов не найден.'
      });
    }

    if (call.status !== 'ringing') {
      return res.status(409).json({
        error: 'Этот вызов уже завершён.'
      });
    }

    call.status = 'rejected';
    call.endedAt = Date.now();

    await saveCallHistory(call);

    res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка отклонения звонка:', error);

    res.status(500).json({
      error: 'Не удалось отклонить звонок.'
    });
  }
});

app.post('/api/call/:id/end', async (req, res) => {
  try {
    const { userId } = req.body ?? {};

    if (!requireOwnUserId(req, res, userId)) return;

    const call = findCall(req.params.id);

    if (!isCallParticipant(call, req.authUser.id)) {
      return res.status(404).json({
        error: 'Вызов не найден.'
      });
    }

    if (['ringing', 'accepted'].includes(call.status)) {
      const wasAccepted = call.status === 'accepted';

      call.status = wasAccepted ? 'ended' : 'missed';
      call.endedAt = Date.now();

      await saveCallHistory(call);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка завершения звонка:', error);

    res.status(500).json({
      error: 'Не удалось завершить звонок.'
    });
  }
});

app.post('/api/token', async (req, res) => {
  try {
    const { callId, userId, participantName } = req.body ?? {};

    if (!requireOwnUserId(req, res, userId)) return;

    const call =
      typeof callId === 'string' ? findCall(callId) : null;

    const user = await restoreUser(req.authUser.id);

    if (
      !call ||
      call.status !== 'accepted' ||
      !user ||
      !isCallParticipant(call, user.id)
    ) {
      return res.status(403).json({
        error: 'Нет активного принятого звонка.'
      });
    }

    const name = cleanName(participantName) || user.name;

    const accessToken = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity: `echo_${user.id}`,
        name,
        ttl: '10m'
      }
    );

    accessToken.addGrant({
      roomJoin: true,
      room: call.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await accessToken.toJwt();

    res.json({
      serverUrl: LIVEKIT_URL,
      participantToken: token,
      identity: `echo_${user.id}`,
      roomName: call.roomName
    });
  } catch (error) {
    console.error('Ошибка создания токена:', error);

    res.status(500).json({
      error: 'Не удалось подготовить подключение к звонку.'
    });
  }
});

// -----------------------------------------------------------------------------
// Запуск
// -----------------------------------------------------------------------------

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Echo voice server запущен на порту ${PORT}`);
      if (!resend) {
        console.warn(
          'Resend API key не задан. Коды будут только в логах.'
        );
      } else {
        console.log('Resend API настроен, письма будут отправляться.');
      }
    });
  } catch (error) {
    console.error(
      'Не удалось запустить Echo или подключить PostgreSQL:',
      error
    );

    process.exit(1);
  }
}

startServer();