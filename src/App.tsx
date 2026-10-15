import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Search,
  Phone,
  PhoneCall,
  Clock3,
  Users,
  Settings,
  Plus,
  Mic,
  MicOff,
  ArrowUpRight,
  ArrowDownLeft,
  MoreHorizontal,
  Headphones,
  X,
  Check,
  PhoneIncoming,
  PhoneOff,
  LogOut,
  Mail,
  LockKeyhole,
  UserRound,
  Eye,
  EyeOff,
  AtSign,
  RefreshCw,
  MessageSquare,
  Send
} from 'lucide-react';
import { Room, RoomEvent, Track } from 'livekit-client';
import './App.css';

type Contact = {
  id: string;
  name: string;
  username?: string | null;
  email?: string;
  online?: boolean;
  status?: string;
  color: string;
  initials: string;
};

type CallHistoryItem = {
  id: string | number;
  name: string;
  time: string;
  duration: string;
  type: 'incoming' | 'outgoing' | 'missed';
  color: string;
  initials: string;
};

type ServerHistoryItem = {
  id: string;
  callId: string;
  otherUserId: string;
  name: string;
  status: string;
  type: 'incoming' | 'outgoing' | 'missed';
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  endedAt: string | null;
  durationSeconds: number;
};

type ServerCall = {
  id: string;
  roomName: string;
  status: string;
  from: string;
  to: string;
  caller: Contact;
  callee: Contact;
  other: Contact;
  createdAt: number;
};

type ServerState = {
  me: Contact;
  users: Contact[];
  incomingCall: ServerCall | null;
  outgoingCall: ServerCall | null;
  activeCall: ServerCall | null;
};

type AuthResponse = {
  user: {
    id: string;
    name: string;
    email: string;
    username?: string | null;
    online?: boolean;
  };
  token: string;
};

type AuthMode = 'login' | 'register' | 'verify';

type CallStatus =
  | 'idle'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'error';

type ChatUser = {
  id: string;
  name: string;
  username: string | null;
  online: boolean;
};

type ConversationItem = {
  id: string;
  other: ChatUser;
  lastMessage: { body: string; createdAt: string } | null;
  unread: number;
};

type ChatMessage = {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  mine: boolean;
};

const API_URL = 'https://echo-mufe.onrender.com';
const TOKEN_KEY = 'echo-auth-token';

const avatarColors = [
  '#8B78F6',
  '#E5A5BC',
  '#5CA8A0',
  '#DDA65B',
  '#729BEA',
  '#D98272'
];

function initialsOf(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'E'
  );
}

function colorOf(id: string) {
  let hash = 0;

  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }

  return avatarColors[Math.abs(hash) % avatarColors.length];
}

function contactFromServer(user: Contact): Contact {
  return {
    ...user,
    color: colorOf(user.id),
    initials: initialsOf(user.name),
    status: user.online ? 'В сети' : 'Не в сети'
  };
}

function formatCallDuration(seconds: number) {
  if (seconds <= 0) return '00:00';

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
    .toString()
    .padStart(2, '0')}`;
}

function formatCallTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return 'Дата неизвестна';

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  });

  if (isToday) return `Сегодня, ${time}`;
  if (isYesterday) return `Вчера, ${time}`;

  return `${date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })}, ${time}`;
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function cleanUsernameInput(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._]/g, '')
    .slice(0, 32);
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);

  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      typeof data.error === 'string'
        ? data.error
        : `Ошибка сервера (${response.status})`
    ) as Error & { needsVerification?: boolean; email?: string };
    if (data.needsVerification) {
      err.needsVerification = true;
      err.email = data.email;
    }
    throw err;
  }

  return data as T;
}

async function getJson<T>(path: string): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);

  const response = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `Ошибка сервера (${response.status})`
    );
  }

  return data as T;
}

function mapServerHistory(item: ServerHistoryItem): CallHistoryItem {
  return {
    id: item.id,
    name: item.name || 'Пользователь',
    time: formatCallTime(item.endedAt || item.createdAt),
    duration:
      item.type === 'missed'
        ? 'Не отвечен'
        : formatCallDuration(item.durationSeconds || 0),
    type: item.type,
    color: colorOf(item.otherUserId || item.id),
    initials: initialsOf(item.name || 'Пользователь')
  };
}

function Avatar({
  initials,
  color,
  online = false,
  size = 'normal'
}: {
  initials: string;
  color: string;
  online?: boolean;
  size?: 'normal' | 'large';
}) {
  return (
    <div
      className={`avatar ${size === 'large' ? 'avatar-large' : ''}`}
      style={{ background: `${color}22`, color }}
    >
      {initials}
      {online && <span className="online-dot" />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Экран авторизации + подтверждение кода
// -----------------------------------------------------------------------------

function AuthScreen({
  mode,
  setMode,
  onAuthenticated,
  verifyEmail,
  setVerifyEmail
}: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  onAuthenticated: (result: AuthResponse) => void;
  verifyEmail: string;
  setVerifyEmail: (email: string) => void;
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const isRegister = mode === 'register';
  const isVerify = mode === 'verify';

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setInfo('');

    if (isVerify) {
      if (!/^\d{6}$/.test(code.trim())) {
        setError('Введи 6-значный код из письма.');
        return;
      }

      setBusy(true);
      try {
        const result = await postJson<AuthResponse>('/api/auth/verify', {
          email: verifyEmail,
          code: code.trim()
        });

        if (!result.token || !result.user?.id) {
          throw new Error('Сервер вернул неполные данные аккаунта.');
        }

        localStorage.setItem(TOKEN_KEY, result.token);
        localStorage.setItem('echo-display-name', result.user.name);
        onAuthenticated(result);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Не удалось подтвердить код.'
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    if (isRegister && name.trim().length < 2) {
      setError('Имя должно содержать минимум 2 символа.');
      return;
    }

    if (isRegister) {
      const clean = cleanUsernameInput(username);
      if (clean.length < 3) {
        setError('Ник должен содержать минимум 3 символа.');
        return;
      }
    }

    if (isRegister && password !== confirmPassword) {
      setError('Пароли не совпадают.');
      return;
    }

    if (password.length < 8) {
      setError('Пароль должен содержать минимум 8 символов.');
      return;
    }

    setBusy(true);

    try {
      if (isRegister) {
        const result = await postJson<{
          needsVerification?: boolean;
          email?: string;
        }>('/api/auth/register', {
          name: name.trim(),
          username: cleanUsernameInput(username),
          email: email.trim().toLowerCase(),
          password
        });

        if (result.needsVerification) {
          setVerifyEmail(result.email || email.trim().toLowerCase());
          setMode('verify');
          setInfo('Код отправлен на почту. Проверь входящие и спам.');
          setCode('');
          return;
        }
      } else {
        const result = await postJson<AuthResponse>('/api/auth/login', {
          email: email.trim().toLowerCase(),
          password
        });

        if (!result.token || !result.user?.id) {
          throw new Error('Сервер вернул неполные данные аккаунта.');
        }

        localStorage.setItem(TOKEN_KEY, result.token);
        localStorage.setItem('echo-display-name', result.user.name);
        onAuthenticated(result);
      }
    } catch (err) {
      const e = err as Error & { needsVerification?: boolean; email?: string };
      if (e.needsVerification) {
        setVerifyEmail(e.email || email.trim().toLowerCase());
        setMode('verify');
        setInfo('Почта ещё не подтверждена. Введи код из письма.');
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Не удалось выполнить запрос. Попробуй ещё раз.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (!verifyEmail || busy) return;
    setBusy(true);
    setError('');
    setInfo('');

    try {
      await postJson('/api/auth/resend-code', { email: verifyEmail });
      setInfo('Новый код отправлен. Проверь почту.');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось отправить код.'
      );
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    height: 46,
    boxSizing: 'border-box',
    padding: '0 14px 0 43px',
    borderRadius: 12,
    border: '1px solid #343447',
    background: '#171722',
    color: '#F5F5FC',
    fontSize: 14,
    outline: 'none'
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    color: '#D7D7E6',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 8
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        overflowY: 'auto',
        background:
          'radial-gradient(ellipse at 15% 15%, #302453 0%, transparent 42%), radial-gradient(ellipse at 85% 85%, #1b3540 0%, transparent 40%), #101018',
        color: '#F5F5FC',
        fontFamily: 'inherit'
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          padding: '36px 34px',
          boxSizing: 'border-box',
          borderRadius: 24,
          border: '1px solid #343044',
          background: 'rgba(22, 22, 33, 0.96)',
          boxShadow: '0 24px 100px #00000055'
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 30 }}>
          <div
            style={{
              width: 58,
              height: 58,
              borderRadius: 18,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #8B78F6, #6550D9)',
              boxShadow: '0 8px 30px #8B78F633',
              marginBottom: 16
            }}
          >
            <AudioLines size={29} color="white" strokeWidth={2.3} />
          </div>

          <h1
            style={{
              margin: '0 0 8px',
              fontSize: 32,
              letterSpacing: '-1.5px',
              fontWeight: 800
            }}
          >
            echo
          </h1>

          <p
            style={{
              margin: 0,
              color: '#9B9BAF',
              fontSize: 14,
              lineHeight: 1.6
            }}
          >
            {isVerify
              ? `Код отправлен на ${verifyEmail}`
              : isRegister
                ? 'Создай аккаунт и оставайся на связи.'
                : 'Рады снова тебя видеть.'}
          </p>
        </div>

        {!isVerify && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              padding: 4,
              gap: 4,
              borderRadius: 13,
              background: '#11111A',
              marginBottom: 25
            }}
          >
            <button
              type="button"
              onClick={() => {
                setError('');
                setInfo('');
                setMode('login');
              }}
              style={{
                height: 39,
                border: 0,
                borderRadius: 10,
                cursor: 'pointer',
                color: !isRegister ? '#FFFFFF' : '#9090A4',
                background: !isRegister ? '#302B49' : 'transparent',
                fontSize: 13,
                fontWeight: 700
              }}
            >
              Вход
            </button>

            <button
              type="button"
              onClick={() => {
                setError('');
                setInfo('');
                setMode('register');
              }}
              style={{
                height: 39,
                border: 0,
                borderRadius: 10,
                cursor: 'pointer',
                color: isRegister ? '#FFFFFF' : '#9090A4',
                background: isRegister ? '#302B49' : 'transparent',
                fontSize: 13,
                fontWeight: 700
              }}
            >
              Регистрация
            </button>
          </div>
        )}

        <form onSubmit={(event) => void submit(event)}>
          {isVerify ? (
            <>
              <div style={{ marginBottom: 17 }}>
                <label style={labelStyle}>Код из письма</label>
                <div style={{ position: 'relative' }}>
                  <LockKeyhole
                    size={18}
                    color="#85859D"
                    style={{
                      position: 'absolute',
                      left: 14,
                      top: 14
                    }}
                  />
                  <input
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    placeholder="6 цифр"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    style={fieldStyle}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => void resendCode()}
                disabled={busy}
                style={{
                  background: 'transparent',
                  border: 0,
                  color: '#8B78F6',
                  fontSize: 13,
                  cursor: busy ? 'wait' : 'pointer',
                  marginBottom: 16,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: 0
                }}
              >
                <RefreshCw size={14} />
                Отправить код ещё раз
              </button>
            </>
          ) : (
            <>
              {isRegister && (
                <>
                  <div style={{ marginBottom: 17 }}>
                    <label style={labelStyle}>Имя</label>
                    <div style={{ position: 'relative' }}>
                      <UserRound
                        size={18}
                        color="#85859D"
                        style={{
                          position: 'absolute',
                          left: 14,
                          top: 14
                        }}
                      />
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Как тебя называть?"
                        autoComplete="name"
                        maxLength={48}
                        required
                        style={fieldStyle}
                      />
                    </div>
                  </div>

                  <div style={{ marginBottom: 17 }}>
                    <label style={labelStyle}>Ник (@username)</label>
                    <div style={{ position: 'relative' }}>
                      <AtSign
                        size={18}
                        color="#85859D"
                        style={{
                          position: 'absolute',
                          left: 14,
                          top: 14
                        }}
                      />
                      <input
                        value={username}
                        onChange={(event) =>
                          setUsername(cleanUsernameInput(event.target.value))
                        }
                        placeholder="alex_1999"
                        autoComplete="username"
                        maxLength={32}
                        required
                        style={fieldStyle}
                      />
                    </div>
                    <p
                      style={{
                        margin: '6px 0 0',
                        color: '#6F6F86',
                        fontSize: 12
                      }}
                    >
                      Латиница, цифры, точка и _. От 3 символов.
                    </p>
                  </div>
                </>
              )}

              <div style={{ marginBottom: 17 }}>
                <label style={labelStyle}>Электронная почта</label>
                <div style={{ position: 'relative' }}>
                  <Mail
                    size={18}
                    color="#85859D"
                    style={{
                      position: 'absolute',
                      left: 14,
                      top: 14
                    }}
                  />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@example.com"
                    autoComplete="email"
                    maxLength={254}
                    required
                    style={fieldStyle}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 17 }}>
                <label style={labelStyle}>Пароль</label>
                <div style={{ position: 'relative' }}>
                  <LockKeyhole
                    size={18}
                    color="#85859D"
                    style={{
                      position: 'absolute',
                      left: 14,
                      top: 14
                    }}
                  />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Минимум 8 символов"
                    autoComplete={
                      isRegister ? 'new-password' : 'current-password'
                    }
                    minLength={8}
                    maxLength={128}
                    required
                    style={{ ...fieldStyle, paddingRight: 44 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={
                      showPassword ? 'Скрыть пароль' : 'Показать пароль'
                    }
                    style={{
                      position: 'absolute',
                      right: 12,
                      top: 11,
                      width: 26,
                      height: 26,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      color: '#85859D',
                      cursor: 'pointer'
                    }}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {isRegister && (
                <div style={{ marginBottom: 18 }}>
                  <label style={labelStyle}>Повтори пароль</label>
                  <div style={{ position: 'relative' }}>
                    <Check
                      size={18}
                      color="#85859D"
                      style={{
                        position: 'absolute',
                        left: 14,
                        top: 14
                      }}
                    />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      placeholder="Введи пароль ещё раз"
                      autoComplete="new-password"
                      maxLength={128}
                      required
                      style={fieldStyle}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: '11px 12px',
                marginBottom: 17,
                borderRadius: 10,
                background: '#5A263333',
                border: '1px solid #A94F6755',
                color: '#F0A6B5',
                fontSize: 13,
                lineHeight: 1.5,
                overflowWrap: 'anywhere'
              }}
            >
              {error}
            </div>
          )}

          {info && (
            <div
              style={{
                padding: '11px 12px',
                marginBottom: 17,
                borderRadius: 10,
                background: '#1E3A2F33',
                border: '1px solid #3A7A5555',
                color: '#8FDBB0',
                fontSize: 13,
                lineHeight: 1.5
              }}
            >
              {info}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              width: '100%',
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 9,
              marginTop: 5,
              border: 0,
              borderRadius: 12,
              background: busy
                ? '#5C4DA8'
                : 'linear-gradient(100deg, #8B78F6, #6D58DF)',
              color: '#FFFFFF',
              fontSize: 14,
              fontWeight: 750,
              cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.8 : 1
            }}
          >
            {busy
              ? 'Подожди…'
              : isVerify
                ? 'Подтвердить и войти'
                : isRegister
                  ? 'Создать аккаунт'
                  : 'Войти в Echo'}
          </button>
        </form>

        {isVerify && (
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError('');
              setInfo('');
              setCode('');
            }}
            style={{
              width: '100%',
              marginTop: 14,
              background: 'transparent',
              border: 0,
              color: '#9090A4',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            ← Вернуться ко входу
          </button>
        )}

        {!isVerify && (
          <p
            style={{
              textAlign: 'center',
              margin: '22px 0 0',
              color: '#77778D',
              fontSize: 12,
              lineHeight: 1.6
            }}
          >
            {isRegister
              ? 'После регистрации придёт код на почту.'
              : 'Твой аккаунт и профиль сохраняются в базе данных.'}
          </p>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Основное приложение
// -----------------------------------------------------------------------------

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [verifyEmail, setVerifyEmail] = useState('');
  const [myEmail, setMyEmail] = useState('');
  const [myUsername, setMyUsername] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  const [activeTab, setActiveTab] = useState('Звонки');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [myName, setMyName] = useState(
    () => localStorage.getItem('echo-display-name') || 'Пользователь'
  );
  const [userId, setUserId] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [calls, setCalls] = useState<CallHistoryItem[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [incomingCall, setIncomingCall] = useState<ServerCall | null>(null);
  const [, setCurrentCallId] = useState('');
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [callError, setCallError] = useState('');
  const [micEnabled, setMicEnabled] = useState(true);
  const [remoteCount, setRemoteCount] = useState(0);
  const [connectionOnline, setConnectionOnline] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatOther, setChatOther] = useState<ChatUser | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const roomRef = useRef<Room | null>(null);
  const joiningCallIdRef = useRef('');
  const currentCallIdRef = useRef('');
  const callStartedAtRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const endedCallIdsRef = useRef(new Set<string>());
  const searchTimerRef = useRef<number | null>(null);

  const filteredContacts = contacts.filter((contact) => {
    const q = search.toLowerCase().replace(/^@/, '');
    return (
      contact.name.toLowerCase().includes(q) ||
      (contact.username || '').toLowerCase().includes(q)
    );
  });

  const filteredCalls = calls.filter((call) =>
    call.name.toLowerCase().includes(search.toLowerCase())
  );

  const displayContacts =
    search.trim().length >= 2 && searchResults.length > 0
      ? searchResults
      : filteredContacts;

  const refreshHistory = useCallback(async () => {
    if (!localStorage.getItem(TOKEN_KEY)) return;

    try {
      const result = await getJson<{ history: ServerHistoryItem[] }>(
        '/api/history'
      );

      setCalls((result.history || []).map(mapServerHistory));
    } catch (error) {
      console.error('Не удалось обновить историю звонков:', error);
    }
  }, []);

  const resetCallUi = useCallback(() => {
    setSelectedContact(null);
    setIncomingCall(null);
    setCurrentCallId('');
    currentCallIdRef.current = '';
    setCallStatus('idle');
    setCallError('');
    setRemoteCount(0);
    setMicEnabled(true);
    setBusyAction(false);
    joiningCallIdRef.current = '';
    callStartedAtRef.current = null;
  }, []);

  const joinCall = useCallback(
    async (call: ServerCall, myId: string, displayName: string) => {
      if (joiningCallIdRef.current === call.id || roomRef.current) {
        return;
      }

      joiningCallIdRef.current = call.id;
      const attempt = ++attemptRef.current;

      setSelectedContact(contactFromServer(call.other));
      setIncomingCall(null);
      setCurrentCallId(call.id);
      currentCallIdRef.current = call.id;
      setCallStatus('connecting');
      setCallError('');
      setRemoteCount(0);

      let room: Room | null = null;

      try {
        const tokenData = await postJson<{
          serverUrl: string;
          participantToken: string;
        }>('/api/token', {
          callId: call.id,
          userId: myId,
          participantName: displayName
        });

        if (attempt !== attemptRef.current) return;

        room = new Room();
        roomRef.current = room;

        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;

          const audioElement = track.attach();
          audioElement.autoplay = true;
          audioElement.setAttribute('playsinline', 'true');
          document.body.appendChild(audioElement);

          void audioElement.play().catch(() => {
            setCallError(
              'Не удалось воспроизвести звук. Проверь настройки аудио.'
            );
          });
        });

        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => element.remove());
        });

        room.on(RoomEvent.ParticipantConnected, () => {
          setRemoteCount(room?.remoteParticipants.size ?? 0);
        });

        room.on(RoomEvent.ParticipantDisconnected, () => {
          setRemoteCount(room?.remoteParticipants.size ?? 0);
        });

        room.on(RoomEvent.Disconnected, () => {
          if (attempt === attemptRef.current) {
            setRemoteCount(0);
          }
        });

        await room.connect(tokenData.serverUrl, tokenData.participantToken);

        if (attempt !== attemptRef.current) {
          await room.disconnect();
          return;
        }

        await room.localParticipant.setMicrophoneEnabled(true);

        if (attempt !== attemptRef.current) {
          await room.disconnect();
          return;
        }

        callStartedAtRef.current = Date.now();
        setRemoteCount(room.remoteParticipants.size);
        setCallStatus('connected');
        setMicEnabled(true);
        setCallError('');
      } catch (error) {
        if (attempt !== attemptRef.current) {
          if (room) await room.disconnect().catch(() => undefined);
          return;
        }

        if (room) await room.disconnect().catch(() => undefined);

        if (roomRef.current === room) {
          roomRef.current = null;
        }

        joiningCallIdRef.current = '';
        setCallStatus('error');
        setCallError(
          error instanceof Error
            ? error.message
            : 'Не удалось подключиться к звонку.'
        );
      }
    },
    []
  );

  // Поиск по @username (с задержкой)
  useEffect(() => {
    if (!authenticated) {
      setSearchResults([]);
      return;
    }

    const q = search.trim();

    if (q.length < 2) {
      setSearchResults([]);
      return;
    }

    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
    }

    searchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          const result = await getJson<{ users: Contact[] }>(
            `/api/users/search?q=${encodeURIComponent(q)}`
          );
          setSearchResults(
            (result.users || []).map((u) => contactFromServer(u))
          );
        } catch {
          setSearchResults([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 350);

    return () => {
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, [search, authenticated]);

  // Восстанавливаем сессию
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const token = localStorage.getItem(TOKEN_KEY);

      if (!token) {
        if (!cancelled) setAuthReady(true);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.user?.id) {
          localStorage.removeItem(TOKEN_KEY);

          if (!cancelled) {
            setAuthenticated(false);
            setAuthReady(true);
          }

          return;
        }

        if (cancelled) return;

        const user = data.user as AuthResponse['user'];

        setUserId(user.id);
        setMyName(user.name);
        setMyEmail(user.email);
        setMyUsername(user.username || '');
        localStorage.setItem('echo-display-name', user.name);
        setAuthenticated(true);
        setConnectionOnline(true);
      } catch {
        if (!cancelled) {
          setConnectionOnline(false);
          setCallError(
            'Не удалось связаться с сервером. Проверь подключение к интернету.'
          );
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthenticated = useCallback((result: AuthResponse) => {
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem('echo-display-name', result.user.name);

    setUserId(result.user.id);
    setMyName(result.user.name);
    setMyEmail(result.user.email);
    setMyUsername(result.user.username || '');
    setAuthenticated(true);
    setConnectionOnline(true);
    setCallError('');
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!authenticated || !userId) {
      setCalls([]);
      return;
    }

    void refreshHistory();

    const timer = window.setInterval(() => {
      void refreshHistory();
    }, 10000);

    return () => window.clearInterval(timer);
  }, [authenticated, userId, refreshHistory]);

  async function logout() {
    if (loggingOut) return;

    setLoggingOut(true);

    const token = localStorage.getItem(TOKEN_KEY);

    try {
      if (token) {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
      }
    } catch {
      // локальный выход
    }

    attemptRef.current += 1;

    if (roomRef.current) {
      await roomRef.current.disconnect().catch(() => undefined);
      roomRef.current = null;
    }

    localStorage.removeItem(TOKEN_KEY);

    setAuthenticated(false);
    setUserId('');
    setMyEmail('');
    setMyUsername('');
    setContacts([]);
    setCalls([]);
    setSearchResults([]);
    setConversations([]);
    setActiveConversationId(null);
    setChatOther(null);
    setChatMessages([]);
    setChatDraft('');
    setIncomingCall(null);
    setSelectedContact(null);
    setCurrentCallId('');
    currentCallIdRef.current = '';
    joiningCallIdRef.current = '';
    setCallStatus('idle');
    setCallError('');
    setConnectionOnline(false);
    setLoggingOut(false);
    setAuthMode('login');
  }

  useEffect(() => {
    if (!authenticated || !userId) return;

    let cancelled = false;
    let polling = false;

    async function refreshState() {
      if (polling || cancelled) return;
      polling = true;

      try {
        const token = localStorage.getItem(TOKEN_KEY);

        const response = await fetch(
          `${API_URL}/api/state?userId=${encodeURIComponent(userId)}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
          }
        );

        if (!response.ok) {
          throw new Error('Сервер Echo недоступен.');
        }

        const state = (await response.json()) as ServerState;

        if (cancelled) return;

        setConnectionOnline(true);
        setContacts(state.users.map((user) => contactFromServer(user)));

        if (state.incomingCall) {
          setIncomingCall(state.incomingCall);

          if (callStatus === 'idle') {
            setCallError('');
          }
        } else {
          setIncomingCall(null);
        }

        if (state.activeCall) {
          const active = state.activeCall;

          if (joiningCallIdRef.current !== active.id && !roomRef.current) {
            void joinCall(active, userId, myName);
          }
        }

        if (
          currentCallIdRef.current &&
          !state.activeCall &&
          !state.outgoingCall &&
          !roomRef.current &&
          !joiningCallIdRef.current
        ) {
          const finishedId = currentCallIdRef.current;

          if (!endedCallIdsRef.current.has(finishedId)) {
            endedCallIdsRef.current.add(finishedId);
            setCallError(
              'Вызов завершён, отклонён или не получил ответа.'
            );
            setCallStatus('error');
            void refreshHistory();
          }
        }
      } catch {
        if (!cancelled) setConnectionOnline(false);
      } finally {
        polling = false;
      }
    }

    void refreshState();

    const timer = window.setInterval(() => {
      void refreshState();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    authenticated,
    userId,
    myName,
    joinCall,
    callStatus,
    refreshHistory
  ]);

  useEffect(() => {
    return () => {
      attemptRef.current += 1;

      if (roomRef.current) {
        void roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const result = await getJson<{ conversations: ConversationItem[] }>(
        '/api/conversations'
      );
      setConversations(result.conversations || []);
    } catch (error) {
      console.error('Не удалось загрузить чаты:', error);
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const result = await getJson<{
        conversationId: string;
        other: ChatUser;
        messages: ChatMessage[];
      }>(`/api/conversations/${conversationId}/messages`);
      setChatMessages(result.messages || []);
      setChatOther(result.other);
      setChatError('');
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : 'Не удалось загрузить сообщения.'
      );
    }
  }, []);

  async function openChatWith(contact: Contact) {
    setChatBusy(true);
    setChatError('');
    try {
      const conv = await postJson<{ conversation: { id: string; other: ChatUser } }>(
        '/api/conversations',
        { userId: contact.id }
      );
      setActiveConversationId(conv.conversation.id);
      setChatOther(conv.conversation.other);
      setActiveTab('Чаты');
      await loadMessages(conv.conversation.id);
      await refreshConversations();
    } catch (error) {
      setCallError(
        error instanceof Error ? error.message : 'Не удалось открыть чат.'
      );
    } finally {
      setChatBusy(false);
    }
  }

  async function sendChatMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!activeConversationId || !chatDraft.trim() || chatBusy) return;
    const body = chatDraft.trim();
    setChatDraft('');
    setChatBusy(true);
    try {
      const message = await postJson<{ message: ChatMessage }>(
        `/api/conversations/${activeConversationId}/messages`,
        { body }
      );
      setChatMessages((prev) => [...prev, message.message]);
      await refreshConversations();
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : 'Не удалось отправить.'
      );
      setChatDraft(body);
    } finally {
      setChatBusy(false);
    }
  }

  useEffect(() => {
    if (!authenticated || !userId) {
      setConversations([]);
      return;
    }
    void refreshConversations();
    const timer = window.setInterval(() => {
      void refreshConversations();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [authenticated, userId, refreshConversations]);

  useEffect(() => {
    if (!authenticated || !activeConversationId || activeTab !== 'Чаты') return;
    void loadMessages(activeConversationId);
    const timer = window.setInterval(() => {
      void loadMessages(activeConversationId);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [authenticated, activeConversationId, activeTab, loadMessages]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  async function changeProfile() {
    const proposedName = window.prompt(
      'Как тебя будут видеть другие пользователи?',
      myName
    );

    if (proposedName === null) return;

    const name = proposedName.trim().replace(/\s+/g, ' ').slice(0, 48);

    if (name.length < 2) {
      setCallError('Имя должно содержать минимум 2 символа.');
      return;
    }

    const proposedUsername = window.prompt(
      'Твой ник (@username). Оставь пустым, чтобы не менять.',
      myUsername || ''
    );

    if (proposedUsername === null) return;

    const username = cleanUsernameInput(proposedUsername);

    if (username && username.length < 3) {
      setCallError('Ник должен содержать минимум 3 символа.');
      return;
    }

    setMyName(name);
    localStorage.setItem('echo-display-name', name);
    if (username) setMyUsername(username);

    if (!userId) return;

    try {
      await postJson('/api/profile', {
        userId,
        name,
        ...(username ? { username } : {})
      });
      setCallError('');
    } catch (error) {
      setCallError(
        error instanceof Error ? error.message : 'Не удалось изменить профиль.'
      );
    }
  }

  async function startCall(contact: Contact) {
    if (!userId || busyAction || callStatus === 'connected') return;

    setBusyAction(true);
    setCallError('');

    try {
      const result = await postJson<{ call: ServerCall }>('/api/call', {
        callerId: userId,
        calleeId: contact.id
      });

      currentCallIdRef.current = result.call.id;
      setCurrentCallId(result.call.id);
      setSelectedContact(contact);
      setCallStatus('ringing');
      setIncomingCall(null);
      endedCallIdsRef.current.delete(result.call.id);
    } catch (error) {
      setCallError(
        error instanceof Error ? error.message : 'Не удалось позвонить.'
      );
    } finally {
      setBusyAction(false);
    }
  }

  async function acceptCall() {
    if (!incomingCall || !userId || busyAction) return;

    setBusyAction(true);

    try {
      const call = incomingCall;

      await postJson(`/api/call/${call.id}/accept`, { userId });

      currentCallIdRef.current = call.id;
      setCurrentCallId(call.id);
      setSelectedContact(contactFromServer(call.other));
      setIncomingCall(null);
      setCallStatus('connecting');
      endedCallIdsRef.current.delete(call.id);
    } catch (error) {
      setCallError(
        error instanceof Error ? error.message : 'Не удалось принять вызов.'
      );
    } finally {
      setBusyAction(false);
    }
  }

  async function rejectCall() {
    if (!incomingCall || !userId || busyAction) return;

    setBusyAction(true);

    try {
      await postJson(`/api/call/${incomingCall.id}/reject`, { userId });
      setIncomingCall(null);
      await refreshHistory();
    } catch (error) {
      setCallError(
        error instanceof Error ? error.message : 'Не удалось отклонить вызов.'
      );
    } finally {
      setBusyAction(false);
    }
  }

  async function toggleMicrophone() {
    const room = roomRef.current;

    if (!room || callStatus !== 'connected') return;

    try {
      const nextState = !micEnabled;
      await room.localParticipant.setMicrophoneEnabled(nextState);
      setMicEnabled(nextState);
      setCallError('');
    } catch (error) {
      setCallError(
        error instanceof Error
          ? error.message
          : 'Не удалось переключить микрофон.'
      );
    }
  }

  async function endCall() {
    const id = currentCallIdRef.current;
    const room = roomRef.current;

    attemptRef.current += 1;
    roomRef.current = null;

    if (room) {
      try {
        await room.disconnect();
      } catch {
        // продолжаем
      }
    }

    if (id && userId) {
      try {
        await postJson(`/api/call/${id}/end`, { userId });
      } catch (error) {
        console.error('Не удалось завершить звонок на сервере:', error);
      }
    }

    resetCallUi();
    await refreshHistory();
  }

  function dismissCallError() {
    setCallError('');
    resetCallUi();
  }

  if (!authReady) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 15,
          background: '#101018',
          color: '#FFFFFF',
          fontFamily: 'inherit'
        }}
      >
        <AudioLines size={40} color="#8B78F6" />
        <strong style={{ fontSize: 25 }}>echo</strong>
        <span style={{ color: '#9696AB', fontSize: 14 }}>
          Проверяем сессию…
        </span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        onAuthenticated={handleAuthenticated}
        verifyEmail={verifyEmail}
        setVerifyEmail={setVerifyEmail}
      />
    );
  }

  const showCallWindow = Boolean(selectedContact);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <AudioLines size={23} strokeWidth={2.4} />
          </div>
          <span>echo</span>
          <div className="brand-status" />
        </div>

        <button className="profile-card" onClick={() => void changeProfile()}>
          <div className="profile-avatar">{initialsOf(myName)}</div>
          <div className="profile-info">
            <strong>{myName}</strong>
            <span>
              {myUsername ? `@${myUsername}` : 'Мой аккаунт'}
            </span>
          </div>
          <MoreHorizontal size={20} className="muted-icon" />
        </button>

        <div className="sidebar-label">МЕНЮ</div>

        <nav className="navigation">
          <button
            className={`nav-item ${activeTab === 'Звонки' ? 'active' : ''}`}
            onClick={() => setActiveTab('Звонки')}
          >
            <Phone size={19} />
            <span>Звонки</span>
            <span className="nav-count">{calls.length}</span>
          </button>

          <button
            className={`nav-item ${activeTab === 'Контакты' ? 'active' : ''}`}
            onClick={() => setActiveTab('Контакты')}
          >
            <Users size={19} />
            <span>Контакты</span>
          </button>

          <button
            className={`nav-item ${activeTab === 'Недавние' ? 'active' : ''}`}
            onClick={() => setActiveTab('Недавние')}
          >
            <Clock3 size={19} />
            <span>Недавние</span>
          </button>

          <button
            className={`nav-item ${activeTab === 'Чаты' ? 'active' : ''}`}
            onClick={() => setActiveTab('Чаты')}
          >
            <MessageSquare size={19} />
            <span>Чаты</span>
            {conversations.some((c) => c.unread > 0) && (
              <span className="nav-count">
                {conversations.reduce((s, c) => s + (c.unread || 0), 0)}
              </span>
            )}
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="connection-card">
            <div className="connection-icon">
              <Headphones size={20} />
            </div>
            <div>
              <strong>Твой голос. Твоя связь.</strong>
              <span>Общайся без границ</span>
            </div>
          </div>

          <button
            className={`nav-item ${activeTab === 'Настройки' ? 'active' : ''}`}
            onClick={() => setActiveTab('Настройки')}
          >
            <Settings size={19} />
            <span>Настройки</span>
          </button>

          <button
            className="nav-item"
            onClick={() => void logout()}
            disabled={loggingOut}
            style={{ color: '#E5A5BC' }}
          >
            <LogOut size={19} />
            <span>{loggingOut ? 'Выходим…' : 'Выйти из аккаунта'}</span>
          </button>

          <div className="sidebar-footer">
            <span>Echo Desktop</span>
            <span>v1.2.0</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Главная</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{activeTab}</strong>
          </div>

          <div className="topbar-right">
            <div className="connection-status">
              <span
                className="status-dot"
                style={{
                  background: connectionOnline ? '#48C78E' : '#E5A5BC'
                }}
              />
              {connectionOnline ? 'Сервер подключён' : 'Сервер недоступен'}
            </div>
            <button
              className="icon-button"
              aria-label="Настройки"
              onClick={() => setActiveTab('Настройки')}
            >
              <Settings size={19} />
            </button>
          </div>
        </header>

        <div className="page-content">
          {activeTab === 'Чаты' ? (
            <section className="chats-page">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">СООБЩЕНИЯ</div>
                  <h1>Чаты</h1>
                  <p>Личные переписки. История хранится на сервере.</p>
                </div>
              </div>

              {chatError && (
                <p className="chat-error" role="alert">
                  {chatError}
                </p>
              )}

              <div className="chats-layout">
                <div className="chats-list">
                  {conversations.length === 0 && (
                    <div className="empty-state" style={{ border: 0 }}>
                      Пока нет диалогов. Найди человека во вкладке «Контакты» и
                      нажми «Написать».
                    </div>
                  )}
                  {conversations.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`chat-list-item ${
                        activeConversationId === item.id ? 'active' : ''
                      }`}
                      onClick={() => {
                        setActiveConversationId(item.id);
                        setChatOther(item.other);
                        void loadMessages(item.id);
                      }}
                    >
                      <Avatar
                        initials={initialsOf(item.other.name)}
                        color={colorOf(item.other.id)}
                        online={item.other.online}
                      />
                      <div className="meta">
                        <strong>{item.other.name}</strong>
                        <div className="preview">
                          {item.lastMessage?.body ||
                            (item.other.username
                              ? `@${item.other.username}`
                              : 'Нет сообщений')}
                        </div>
                      </div>
                      {item.unread > 0 && (
                        <span className="chat-unread">{item.unread}</span>
                      )}
                    </button>
                  ))}
                </div>

                <div className="chat-thread">
                  {activeConversationId && chatOther ? (
                    <>
                      <div className="chat-thread-header">
                        <Avatar
                          initials={initialsOf(chatOther.name)}
                          color={colorOf(chatOther.id)}
                          online={chatOther.online}
                        />
                        <div>
                          <strong>{chatOther.name}</strong>
                          <div className="preview">
                            {chatOther.username
                              ? `@${chatOther.username}`
                              : chatOther.online
                                ? 'В сети'
                                : 'Не в сети'}
                          </div>
                        </div>
                      </div>

                      <div className="chat-messages">
                        {chatMessages.map((m) => (
                          <div
                            key={m.id}
                            className={`chat-bubble ${m.mine ? 'mine' : 'theirs'}`}
                          >
                            {m.body}
                            <time>{formatMessageTime(m.createdAt)}</time>
                          </div>
                        ))}
                        <div ref={chatBottomRef} />
                      </div>

                      <form className="chat-compose" onSubmit={(e) => void sendChatMessage(e)}>
                        <input
                          value={chatDraft}
                          onChange={(e) => setChatDraft(e.target.value)}
                          placeholder="Напиши сообщение…"
                          maxLength={4000}
                          disabled={chatBusy}
                        />
                        <button
                          type="submit"
                          className="primary-button"
                          disabled={chatBusy || !chatDraft.trim()}
                          style={{ minWidth: 48, padding: '0 12px' }}
                          aria-label="Отправить"
                        >
                          <Send size={18} />
                        </button>
                      </form>
                    </>
                  ) : (
                    <div className="empty-state" style={{ border: 0, margin: 'auto' }}>
                      Выбери диалог слева или напиши человеку из контактов.
                    </div>
                  )}
                </div>
              </div>
            </section>
          ) : activeTab === 'Настройки' ? (
            <section className="settings-page">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ПЕРСОНАЛИЗАЦИЯ</div>
                  <h1>Настройки</h1>
                  <p>Настрой Echo под себя.</p>
                </div>
              </div>

              <div className="settings-card">
                <button
                  className="settings-row"
                  onClick={() => void changeProfile()}
                >
                  <div className="settings-icon">
                    <Users size={21} />
                  </div>
                  <div>
                    <strong>Твой профиль</strong>
                    <p>Имя и @ник</p>
                  </div>
                  <span className="settings-value">
                    {myName}
                    {myUsername ? ` · @${myUsername}` : ''}
                  </span>
                </button>

                <div className="settings-row">
                  <div className="settings-icon">
                    <AtSign size={21} />
                  </div>
                  <div>
                    <strong>Ник</strong>
                    <p>По нему тебя находят другие</p>
                  </div>
                  <span className="settings-value">
                    {myUsername ? `@${myUsername}` : 'не задан'}
                  </span>
                </div>

                <div className="settings-row">
                  <div className="settings-icon">
                    <Mail size={21} />
                  </div>
                  <div>
                    <strong>Электронная почта</strong>
                    <p>Адрес твоего аккаунта</p>
                  </div>
                  <span
                    className="settings-value"
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {myEmail}
                  </span>
                </div>

                <div className="settings-row">
                  <div className="settings-icon">
                    <Mic size={21} />
                  </div>
                  <div>
                    <strong>Микрофон</strong>
                    <p>Управление микрофоном во время звонка</p>
                  </div>
                  <span className="settings-value">По умолчанию</span>
                </div>

                <div className="settings-row">
                  <div className="settings-icon">
                    <PhoneCall size={21} />
                  </div>
                  <div>
                    <strong>Звонки</strong>
                    <p>Голосовые комнаты LiveKit</p>
                  </div>
                  <span className="settings-value">LiveKit</span>
                </div>
              </div>
            </section>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ТВОЁ ПРОСТРАНСТВО ДЛЯ ОБЩЕНИЯ</div>
                  <h1>
                    {activeTab === 'Контакты'
                      ? 'Поиск и контакты'
                      : activeTab === 'Недавние'
                        ? 'История звонков'
                        : 'На связи?'}
                  </h1>
                  <p>
                    {activeTab === 'Контакты'
                      ? 'Ищи людей по @нику или звони тем, кто в сети.'
                      : activeTab === 'Недавние'
                        ? 'Твои последние разговоры.'
                        : 'Иногда один звонок меняет весь день.'}
                  </p>
                </div>

                <button
                  className="primary-button"
                  onClick={() => setActiveTab('Контакты')}
                >
                  <Plus size={18} />
                  Новый звонок
                </button>
              </div>

              {activeTab === 'Звонки' && (
                <section className="hero-card">
                  <div className="hero-glow hero-glow-one" />
                  <div className="hero-glow hero-glow-two" />

                  <div className="hero-content">
                    <div className="hero-badge">
                      <span className="status-dot" />
                      ТВОЯ СВЯЗЬ НАЧИНАЕТСЯ ЗДЕСЬ
                    </div>

                    <h2>
                      Меньше расстояния.
                      <br />
                      <span>Больше общения.</span>
                    </h2>

                    <p>
                      Найди человека по @нику и начни разговор.
                      <br />
                      Просто, удобно, без лишнего.
                    </p>

                    <button
                      className="hero-button"
                      onClick={() => setActiveTab('Контакты')}
                    >
                      <PhoneCall size={18} />
                      Начать звонок
                      <ArrowUpRight size={18} />
                    </button>
                  </div>

                  <div className="hero-visual">
                    <div className="sound-ring sound-ring-outer" />
                    <div className="sound-ring sound-ring-middle" />
                    <div className="sound-ring sound-ring-inner" />
                    <div className="sound-core">
                      <AudioLines size={48} strokeWidth={1.7} />
                    </div>
                    <div className="floating-chip chip-top">
                      <span className="status-dot" />
                      <span>Твой голос звучит</span>
                    </div>
                    <div className="floating-chip chip-bottom">
                      <Headphones size={17} />
                      <span>Время поговорить</span>
                    </div>
                  </div>

                  <div className="hero-decoration">ECHO / CONNECT</div>
                </section>
              )}

              <section className="content-section">
                <div className="section-header">
                  <div>
                    <h2>
                      {activeTab === 'Контакты'
                        ? search.trim().length >= 2
                          ? 'Результаты поиска'
                          : 'Кто сейчас в сети'
                        : activeTab === 'Недавние'
                          ? 'Последние разговоры'
                          : 'Недавние звонки'}
                    </h2>
                    <span>
                      {activeTab === 'Контакты'
                        ? searching
                          ? 'Ищем…'
                          : `${displayContacts.length} пользователей`
                        : `${filteredCalls.length} звонков`}
                    </span>
                  </div>

                  <label className="search-box">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={
                        activeTab === 'Контакты'
                          ? 'Поиск по @нику или имени...'
                          : 'Поиск...'
                      }
                    />
                    {search && (
                      <button
                        className="clear-search"
                        onClick={() => setSearch('')}
                        aria-label="Очистить поиск"
                      >
                        <X size={15} />
                      </button>
                    )}
                  </label>
                </div>

                {activeTab === 'Контакты' ? (
                  <div className="contacts-grid">
                    {displayContacts.map((contact) => (
                      <article className="contact-card" key={contact.id}>
                        <div className="contact-card-top">
                          <Avatar
                            initials={contact.initials}
                            color={contact.color}
                            online={Boolean(contact.online)}
                            size="large"
                          />
                          <button
                            className="more-button"
                            aria-label="Дополнительно"
                            onClick={() => {
                              setCallError(
                                `${contact.name}${
                                  contact.username
                                    ? ` · @${contact.username}`
                                    : ''
                                }`
                              );
                            }}
                          >
                            <MoreHorizontal size={19} />
                          </button>
                        </div>

                        <strong>{contact.name}</strong>
                        <span className="contact-status">
                          {contact.username
                            ? `@${contact.username}`
                            : contact.online
                              ? 'В сети'
                              : 'Не в сети'}
                        </span>
                        {contact.username && (
                          <span
                            style={{
                              fontSize: 12,
                              color: contact.online ? '#48C78E' : '#8A8A9E',
                              marginTop: 2
                            }}
                          >
                            {contact.online ? 'В сети' : 'Не в сети'}
                          </span>
                        )}

                        <div className="contact-actions">
                          <button
                            className="contact-call-button"
                            disabled={chatBusy || !userId}
                            onClick={() => void openChatWith(contact)}
                          >
                            <MessageSquare size={17} />
                            Написать
                          </button>
                          <button
                            className="contact-call-button"
                            disabled={
                              busyAction || !userId || !contact.online
                            }
                            onClick={() => void startCall(contact)}
                            title={
                              contact.online
                                ? 'Позвонить'
                                : 'Пользователь не в сети'
                            }
                          >
                            <PhoneCall size={17} />
                            {contact.online ? 'Позвонить' : 'Не в сети'}
                          </button>
                        </div>
                      </article>
                    ))}

                    {displayContacts.length === 0 && (
                      <div className="empty-state">
                        {search.trim().length >= 2
                          ? searching
                            ? 'Ищем пользователей…'
                            : 'Никого не нашли. Проверь ник и попробуй ещё раз.'
                          : connectionOnline
                            ? 'Пока никого нет в сети. Найди человека по @нику в поиске выше.'
                            : 'Подключаемся к серверу Echo…'}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="call-list">
                    {filteredCalls.map((call) => (
                      <article className="call-row" key={call.id}>
                        <Avatar initials={call.initials} color={call.color} />

                        <div className="call-person">
                          <strong>{call.name}</strong>
                          <span>{call.time}</span>
                        </div>

                        <div className={`call-type ${call.type}`}>
                          {call.type === 'incoming' ? (
                            <ArrowDownLeft size={16} />
                          ) : (
                            <ArrowUpRight size={16} />
                          )}
                          <span>
                            {call.type === 'incoming'
                              ? 'Входящий'
                              : call.type === 'missed'
                                ? 'Пропущенный'
                                : 'Исходящий'}
                          </span>
                        </div>

                        <span
                          className={`call-duration ${
                            call.type === 'missed' ? 'missed-text' : ''
                          }`}
                        >
                          {call.duration}
                        </span>

                        <button
                          className="call-action"
                          aria-label={`Позвонить ${call.name}`}
                          onClick={() => setActiveTab('Контакты')}
                        >
                          <Phone size={17} />
                        </button>
                      </article>
                    ))}

                    {filteredCalls.length === 0 && (
                      <div className="empty-state">
                        Здесь пока нет сохранённых звонков.
                      </div>
                    )}
                  </div>
                )}
              </section>

              {activeTab === 'Звонки' && (
                <section className="bottom-info">
                  <div className="info-icon">
                    <Mic size={19} />
                  </div>
                  <div>
                    <strong>Голосовые звонки через LiveKit</strong>
                    <p>
                      {connectionOnline
                        ? `Ты вошёл как ${myName}${
                            myUsername ? ` (@${myUsername})` : ''
                          }. Ищи людей по нику.`
                        : 'Запусти сервер Echo, чтобы подключиться.'}
                    </p>
                  </div>
                  <span className="info-tag">
                    {connectionOnline ? 'ГОТОВО' : 'НЕТ СВЯЗИ'}
                  </span>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {showCallWindow && selectedContact && (
        <div className="call-overlay">
          <div className="call-modal">
            <button
              className="call-modal-close"
              onClick={() => void endCall()}
              aria-label="Закрыть"
            >
              <X size={20} />
            </button>

            <div className="call-modal-brand">
              <AudioLines size={20} />
              <span>echo</span>
            </div>

            <div className="call-avatar-wrap">
              <div className="call-pulse call-pulse-one" />
              <div className="call-pulse call-pulse-two" />
              <Avatar
                initials={selectedContact.initials}
                color={selectedContact.color}
                online={callStatus === 'connected'}
                size="large"
              />
            </div>

            <h2>{selectedContact.name}</h2>
            {selectedContact.username && (
              <p style={{ color: '#8B78F6', margin: '0 0 8px', fontSize: 14 }}>
                @{selectedContact.username}
              </p>
            )}

            <p className="call-modal-status">
              {callStatus === 'ringing'
                ? 'Вызов отправлен…'
                : callStatus === 'connecting'
                  ? 'Подключение к звонку…'
                  : callStatus === 'connected'
                    ? remoteCount > 0
                      ? 'Собеседник подключён'
                      : 'Соединение установлено'
                    : 'Вызов завершён'}
            </p>

            {callStatus === 'connected' && (
              <p className="call-modal-notice">
                {remoteCount > 0
                  ? 'Вы оба в комнате. Можно разговаривать.'
                  : 'Микрофон включён. Ожидание аудиопотока собеседника.'}
              </p>
            )}

            {callStatus === 'ringing' && (
              <p className="call-modal-notice">
                Ожидаем, когда пользователь примет вызов.
              </p>
            )}

            {callStatus === 'connecting' && (
              <p className="call-modal-notice">
                Устанавливаем защищённое голосовое соединение.
              </p>
            )}

            {callError && (
              <p
                className="call-modal-notice"
                role="alert"
                style={{ overflowWrap: 'anywhere' }}
              >
                {callError}
              </p>
            )}

            <div className="call-controls">
              <button
                className="call-control-button"
                onClick={() => void toggleMicrophone()}
                disabled={callStatus !== 'connected'}
                aria-label={
                  micEnabled ? 'Выключить микрофон' : 'Включить микрофон'
                }
                title={
                  micEnabled ? 'Выключить микрофон' : 'Включить микрофон'
                }
              >
                {micEnabled ? <Mic size={21} /> : <MicOff size={21} />}
              </button>

              <button
                className="hangup-button"
                onClick={() => void endCall()}
                aria-label="Завершить вызов"
                title="Завершить вызов"
              >
                <Phone size={23} />
              </button>

              <button
                className="call-control-button"
                aria-label="Скрыть сообщение"
                title="Скрыть сообщение"
                onClick={dismissCallError}
              >
                <MoreHorizontal size={22} />
              </button>
            </div>

            <span className="call-modal-footer">ECHO VOICE · LIVEKIT</span>
          </div>
        </div>
      )}

      {incomingCall && !showCallWindow && (
        <div className="call-overlay">
          <div className="call-modal">
            <div className="call-modal-brand">
              <AudioLines size={20} />
              <span>echo</span>
            </div>

            <div className="call-avatar-wrap">
              <div className="call-pulse call-pulse-one" />
              <div className="call-pulse call-pulse-two" />
              <Avatar
                initials={initialsOf(incomingCall.caller.name)}
                color={colorOf(incomingCall.caller.id)}
                online
                size="large"
              />
            </div>

            <h2>{incomingCall.caller.name}</h2>
            {incomingCall.caller.username && (
              <p style={{ color: '#8B78F6', margin: '0 0 8px', fontSize: 14 }}>
                @{incomingCall.caller.username}
              </p>
            )}
            <p className="call-modal-status">Входящий голосовой вызов</p>
            <p className="call-modal-notice">
              Пользователь хочет поговорить с тобой.
            </p>

            {callError && (
              <p className="call-modal-notice" role="alert">
                {callError}
              </p>
            )}

            <div className="call-controls">
              <button
                className="call-control-button"
                onClick={() => void rejectCall()}
                disabled={busyAction}
                aria-label="Отклонить вызов"
                title="Отклонить вызов"
              >
                <PhoneOff size={21} />
              </button>

              <button
                className="hangup-button"
                style={{ background: '#32B978' }}
                onClick={() => void acceptCall()}
                disabled={busyAction}
                aria-label="Принять вызов"
                title="Принять вызов"
              >
                <PhoneIncoming size={23} />
              </button>

              <button
                className="call-control-button"
                onClick={() => void acceptCall()}
                disabled={busyAction}
                aria-label="Принять вызов"
                title="Принять вызов"
              >
                <Check size={21} />
              </button>
            </div>

            <span className="call-modal-footer">ECHO VOICE · INCOMING</span>
          </div>
        </div>
      )}

      {callError && !showCallWindow && !incomingCall && (
        <div className="call-overlay">
          <div className="call-modal">
            <div className="call-modal-brand">
              <AudioLines size={20} />
              <span>echo</span>
            </div>
            <h2>Сообщение</h2>
            <p className="call-modal-notice" role="alert">
              {callError}
            </p>
            <div className="call-controls">
              <button
                className="hangup-button"
                onClick={() => setCallError('')}
                aria-label="Закрыть сообщение"
                title="Закрыть"
              >
                <X size={22} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;