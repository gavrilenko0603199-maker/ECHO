import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error(
    'Не заданы LIVEKIT_URL, LIVEKIT_API_KEY или LIVEKIT_API_SECRET в переменных окружения.'
  );
  process.exit(1);
}

const users = new Map();
const calls = new Map();

const USER_TIMEOUT = 20000;
const CALL_TIMEOUT = 60000;

app.use(
  cors({
    origin(origin, callback) {
      const allowedOrigins = [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'null'
      ];

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin не разрешён'));
      }
    }
  })
);

app.use(express.json({ limit: '10kb' }));

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 48);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    online: Date.now() - user.lastSeen < USER_TIMEOUT
  };
}

function getCallForUser(call, userId) {
  if (call.from !== userId && call.to !== userId) {
    return false;
  }

  const otherId = call.from === userId ? call.to : call.from;
  const other = users.get(otherId);

  return {
    id: call.id,
    roomName: call.roomName,
    status: call.status,
    from: call.from,
    to: call.to,
    caller: publicUser(users.get(call.from) || {
      id: call.from,
      name: 'Пользователь',
      lastSeen: 0
    }),
    callee: publicUser(users.get(call.to) || {
      id: call.to,
      name: 'Пользователь',
      lastSeen: 0
    }),
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

function getUserId(req) {
  return typeof req.query.userId === 'string'
    ? req.query.userId
    : '';
}

function findCall(id) {
  return calls.get(id);
}

function isCallParticipant(call, userId) {
  return Boolean(
    call && (call.from === userId || call.to === userId)
  );
}

function touchUser(userId) {
  const user = users.get(userId);

  if (user) {
    user.lastSeen = Date.now();
  }

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

    if (
      expired ||
      call.status === 'ended' ||
      call.status === 'rejected'
    ) {
      calls.delete(id);
    } else if (
      call.status === 'ringing' &&
      now - call.createdAt > CALL_TIMEOUT
    ) {
      call.status = 'missed';
    }
  }
}

setInterval(cleanup, 5000);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Echo voice and call server'
  });
});

app.post('/api/register', (req, res) => {
  const name = cleanName(req.body?.name);

  if (!name) {
    return res.status(400).json({
      error: 'Укажи имя пользователя.'
    });
  }

  const id = crypto.randomUUID();

  const user = {
    id,
    name,
    lastSeen: Date.now()
  };

  users.set(id, user);

  res.json({
    user: publicUser(user)
  });
});

app.post('/api/profile', (req, res) => {
  const { userId } = req.body ?? {};
  const name = cleanName(req.body?.name);
  const user = typeof userId === 'string'
    ? touchUser(userId)
    : null;

  if (!user) {
    return res.status(404).json({
      error: 'Пользователь не найден. Перезапусти Echo.'
    });
  }

  if (!name) {
    return res.status(400).json({
      error: 'Имя не может быть пустым.'
    });
  }

  user.name = name;

  res.json({
    user: publicUser(user)
  });
});

app.get('/api/state', (req, res) => {
  cleanup();

  const userId = getUserId(req);
  const user = touchUser(userId);

  if (!user) {
    return res.status(401).json({
      error: 'Сессия завершена. Перезапусти Echo.'
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
});

app.post('/api/call', (req, res) => {
  cleanup();

  const { callerId, calleeId } = req.body ?? {};

  const caller = typeof callerId === 'string'
    ? touchUser(callerId)
    : null;

  const callee = typeof calleeId === 'string'
    ? users.get(calleeId)
    : null;

  if (!caller || !callee) {
    return res.status(404).json({
      error: 'Пользователь не найден или отключился.'
    });
  }

  if (caller.id === callee.id) {
    return res.status(400).json({
      error: 'Нельзя позвонить самому себе.'
    });
  }

  if (Date.now() - callee.lastSeen >= USER_TIMEOUT) {
    return res.status(409).json({
      error: 'Пользователь сейчас не в сети.'
    });
  }

  const busy = [...calls.values()].some(
    (call) =>
      ['ringing', 'accepted'].includes(call.status) &&
      (
        call.from === callee.id ||
        call.to === callee.id ||
        call.from === caller.id ||
        call.to === caller.id
      )
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
    createdAt: Date.now()
  };

  calls.set(id, call);

  res.json({
    call: getCallForUser(call, caller.id)
  });
});

app.post('/api/call/:id/accept', (req, res) => {
  const { userId } = req.body ?? {};
  const call = findCall(req.params.id);

  const user = typeof userId === 'string'
    ? touchUser(userId)
    : null;

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

  res.json({
    call: getCallForUser(call, user.id)
  });
});

app.post('/api/call/:id/reject', (req, res) => {
  const { userId } = req.body ?? {};
  const call = findCall(req.params.id);

  if (!isCallParticipant(call, userId) || call.to !== userId) {
    return res.status(404).json({
      error: 'Вызов не найден.'
    });
  }

  if (call.status === 'ringing') {
    call.status = 'rejected';
  }

  res.json({ ok: true });
});

app.post('/api/call/:id/end', (req, res) => {
  const { userId } = req.body ?? {};
  const call = findCall(req.params.id);

  if (!isCallParticipant(call, userId)) {
    return res.status(404).json({
      error: 'Вызов не найден.'
    });
  }

  if (['ringing', 'accepted'].includes(call.status)) {
    call.status = 'ended';
  }

  res.json({ ok: true });
});

app.post('/api/token', async (req, res) => {
  try {
    const { callId, userId, participantName } = req.body ?? {};

    const call = typeof callId === 'string'
      ? findCall(callId)
      : null;

    const user = typeof userId === 'string'
      ? touchUser(userId)
      : null;

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Echo voice server запущен на порту ${PORT}`);
});