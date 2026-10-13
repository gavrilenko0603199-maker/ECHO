import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { AccessToken } from 'livekit-server-sdk';
import nodemailer from 'nodemailer';

dotenv.config();

const { Pool } = pg;
const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = Number(process.env.PORT) || 3001;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// SMTP (Resend, Brevo, Gmail и т.д.)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'Echo <noreply@echo.app>';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const USER_TIMEOUT = 20000;
const CALL_TIMEOUT = 60000;
const CODE_TTL_MS = 15 * 60 * 1000; // 15 минут
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
const localPendingCodes = new Map(); // email -> { code, expires, attempts }

app.use(
  cors({
    origin(origin, callback) {
      // Разрешаем localhost, null (Electron) и любой origin в проде
      callback(null, true);
    }
  })
);

app.use(express.json({ limit: '10kb' }));

// -----------------------------------------------------------------------------
// Почта
// -----------------------------------------------------------------------------

function createMailTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

const mailTransport = createMailTransport();

async function sendVerificationEmail(email, code) {
  const subject = 'Код подтверждения Echo';
  const text = `Твой код подтверждения для Echo: ${code}\n\nКод действует 15 минут.\nЕсли ты не регистрировался в Echo — просто проигнорируй это письмо.`;

  if (!mailTransport) {
    console.log(`[EMAIL DEV] Код для ${email}: ${code}`);
    return;
  }

  await mailTransport.sendMail({
    from: SMTP_FROM,
    to: email,
    subject,
    text
  });
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
    DELETE FROM sessions WHERE expires_at <= NOW()
  `);

  console.log(
    'PostgreSQL подключён. Таблицы пользователей, сессий и истории звонков готовы.'
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
  // убираем @ в начале, оставляем только латиницу, цифры, _ и .
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
  // 3–32 символа, начинается с буквы или цифры
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
// Регистрация (создаёт аккаунт + отправляет код)
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
      // Проверяем уникальность заранее, чтобы дать понятную ошибку
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

    try {
      await sendVerificationEmail(email, code);
    } catch (mailError) {
      console.error('Не удалось отправить письмо:', mailError);
      // Не откатываем регистрацию — код можно запросить повторно
    }

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
      // Уже подтверждён — просто логиним
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

    // Успех
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

    try {
      await sendVerificationEmail(email, code);
    } catch (mailError) {
      console.error('Не удалось отправить письмо:', mailError);
      return res.status(500).json({
        error: 'Не удалось отправить письмо. Попробуй позже.'
      });
    }

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
    '/api/users'
  ],
  requireAuth
);

// -----------------------------------------------------------------------------
// Поиск пользователей по @username
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
// История звонков
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
// Изменение профиля (имя + ник)
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
// Создание звонка
// -----------------------------------------------------------------------------

app.post('/api/call', async (req, res) => {
  try {
    cleanup();

    const { callerId, calleeId } = req.body ?? {};

    if (!requireOwnUserId(req, res, callerId)) return;

    const caller = await restoreUser(req.authUser.id);
    let callee = touchUser(calleeId);

    // Если пользователь не в online-кэше — пробуем подтянуть из БД
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

// -----------------------------------------------------------------------------
// Принятие / отклонение / завершение звонка + токен — без изменений логики
// -----------------------------------------------------------------------------

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
      if (!mailTransport) {
        console.warn(
          'SMTP не настроен. Коды подтверждения будут в логах сервера.'
        );
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