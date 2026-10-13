
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
  PhoneOff
} from 'lucide-react';
import { Room, RoomEvent, Track } from 'livekit-client';
import './App.css';

type Contact = {
  id: string;
  name: string;
  online?: boolean;
  status?: string;
  color: string;
  initials: string;
};

type CallHistoryItem = {
  id: number;
  name: string;
  time: string;
  duration: string;
  type: 'incoming' | 'outgoing' | 'missed';
  color: string;
  initials: string;
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

type CallStatus =
  | 'idle'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'error';

const API_URL = 'https://echo-mufe.onrender.com';

const avatarColors = [
  '#8B78F6',
  '#E5A5BC',
  '#5CA8A0',
  '#DDA65B',
  '#729BEA',
  '#D98272'
];

function initialsOf(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'E';
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

async function postJson<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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

function App() {
  const [activeTab, setActiveTab] = useState('Звонки');
  const [search, setSearch] = useState('');
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

  const roomRef = useRef<Room | null>(null);
  const joiningCallIdRef = useRef('');
  const currentCallIdRef = useRef('');
  const callStartedAtRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const endedCallIdsRef = useRef(new Set<string>());

  const filteredContacts = contacts.filter((contact) =>
    contact.name.toLowerCase().includes(search.toLowerCase())
  );

  const filteredCalls = calls.filter((call) =>
    call.name.toLowerCase().includes(search.toLowerCase())
  );

  const addHistory = useCallback(
    (
      contact: Contact,
      type: 'incoming' | 'outgoing' | 'missed',
      startedAt: number | null
    ) => {
      const duration =
        startedAt === null
          ? 'Не отвечен'
          : (() => {
              const seconds = Math.max(
                0,
                Math.floor((Date.now() - startedAt) / 1000)
              );

              return `${Math.floor(seconds / 60)
                .toString()
                .padStart(2, '0')}:${(seconds % 60)
                .toString()
                .padStart(2, '0')}`;
            })();

      setCalls((previous) => [
        {
          id: Date.now(),
          name: contact.name,
          time: 'Только что',
          duration,
          type,
          color: contact.color,
          initials: contact.initials
        },
        ...previous
      ]);
    },
    []
  );

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
      if (
        joiningCallIdRef.current === call.id ||
        roomRef.current
      ) {
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

        await room.connect(
          tokenData.serverUrl,
          tokenData.participantToken
        );

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

  useEffect(() => {
    let cancelled = false;

    async function register() {
      try {
        const result = await postJson<{ user: Contact }>('/api/register', {
          name: myName
        });

        if (cancelled) return;

        setUserId(result.user.id);
        setConnectionOnline(true);
      } catch (error) {
        if (cancelled) return;

        setConnectionOnline(false);
        setCallError(
          error instanceof Error
            ? error.message
            : 'Не удалось зарегистрироваться на сервере.'
        );
      }
    }

    void register();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    let polling = false;

    async function refreshState() {
      if (polling || cancelled) return;
      polling = true;

      try {
        const response = await fetch(
          `${API_URL}/api/state?userId=${encodeURIComponent(userId)}`
        );

        if (!response.ok) {
          throw new Error('Сервер Echo недоступен.');
        }

        const state = (await response.json()) as ServerState;

        if (cancelled) return;

        setConnectionOnline(true);
        setContacts(
          state.users.map((user) => contactFromServer(user))
        );

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

          if (
            joiningCallIdRef.current !== active.id &&
            !roomRef.current
          ) {
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
  }, [userId, myName, joinCall, callStatus]);

  useEffect(() => {
    return () => {
      attemptRef.current += 1;

      if (roomRef.current) {
        void roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, []);

  async function changeProfile() {
    const proposedName = window.prompt(
      'Как тебя будут видеть другие пользователи?',
      myName
    );

    if (proposedName === null) return;

    const name = proposedName.trim().replace(/\s+/g, ' ').slice(0, 48);

    if (!name) {
      setCallError('Имя не может быть пустым.');
      return;
    }

    setMyName(name);
    localStorage.setItem('echo-display-name', name);

    if (!userId) return;

    try {
      await postJson('/api/profile', { userId, name });
      setCallError('');
    } catch (error) {
      setCallError(
        error instanceof Error ? error.message : 'Не удалось изменить имя.'
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
    const contact = selectedContact;
    const startedAt = callStartedAtRef.current;
    const room = roomRef.current;

    attemptRef.current += 1;
    roomRef.current = null;

    if (room) {
      try {
        await room.disconnect();
      } catch {
      }
    }

    if (id && userId) {
      try {
        await postJson(`/api/call/${id}/end`, { userId });
      } catch {
      }
    }

    if (contact) {
      addHistory(
        contact,
        incomingCall ? 'incoming' : 'outgoing',
        startedAt
      );
    }

    resetCallUi();
  }

  function dismissCallError() {
    setCallError('');
    resetCallUi();
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
            <span>{userId ? 'Мой аккаунт' : 'Подключение…'}</span>
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

          <div className="sidebar-footer">
            <span>Echo Desktop</span>
            <span>v1.1.0</span>
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
          {activeTab === 'Настройки' ? (
            <section className="settings-page">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ПЕРСОНАЛИЗАЦИЯ</div>
                  <h1>Настройки</h1>
                  <p>Настрой Echo под себя.</p>
                </div>
              </div>

              <div className="settings-card">
                <button className="settings-row" onClick={() => void changeProfile()}>
                  <div className="settings-icon">
                    <Users size={21} />
                  </div>
                  <div>
                    <strong>Твой профиль</strong>
                    <p>Нажми, чтобы изменить имя</p>
                  </div>
                  <span className="settings-value">{myName}</span>
                </button>

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
                      ? 'Пользователи онлайн'
                      : activeTab === 'Недавние'
                        ? 'История звонков'
                        : 'На связи?'}
                  </h1>
                  <p>
                    {activeTab === 'Контакты'
                      ? 'Выбирай пользователя и звони ему.'
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
                      Выбирай пользователя онлайн и начинай разговор.
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
                        ? 'Кто сейчас в сети'
                        : activeTab === 'Недавние'
                          ? 'Последние разговоры'
                          : 'Недавние звонки'}
                    </h2>
                    <span>
                      {activeTab === 'Контакты'
                        ? `${filteredContacts.length} пользователей`
                        : `${filteredCalls.length} звонков`}
                    </span>
                  </div>

                  <label className="search-box">
                    <Search size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Поиск..."
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
                    {filteredContacts.map((contact) => (
                      <article className="contact-card" key={contact.id}>
                        <div className="contact-card-top">
                          <Avatar
                            initials={contact.initials}
                            color={contact.color}
                            online
                            size="large"
                          />
                          <button
                            className="more-button"
                            aria-label="Дополнительно"
                            onClick={() => {
                              setCallError(`Пользователь: ${contact.name}`);
                            }}
                          >
                            <MoreHorizontal size={19} />
                          </button>
                        </div>

                        <strong>{contact.name}</strong>
                        <span className="contact-status">В сети</span>

                        <button
                          className="contact-call-button"
                          disabled={busyAction || !userId}
                          onClick={() => void startCall(contact)}
                        >
                          <PhoneCall size={17} />
                          Позвонить
                        </button>
                      </article>
                    ))}

                    {filteredContacts.length === 0 && (
                      <div className="empty-state">
                        {connectionOnline
                          ? 'Пока никого нет в сети. Открой Echo в другом окне или на другом устройстве.'
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
                          className={`call-duration ${call.type === 'missed' ? 'missed-text' : ''}`}
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
                        Здесь пока нет звонков в этой сессии.
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
                        ? `Ты вошёл как ${myName}. Можно звонить пользователям онлайн.`
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
                aria-label={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
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
