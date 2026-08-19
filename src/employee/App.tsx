import React, { useState, useRef, useEffect, useCallback } from 'react';
import { colors, font, mono, radius, s, quality } from '../shared/theme';

const API = 'https://remotedeskpbx-server.onrender.com';

const App: React.FC = () => {
  // Авторизация
  const [loggedIn, setLoggedIn] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [empName, setEmpName] = useState('');
  const [authError, setAuthError] = useState('');
  const [remember, setRemember] = useState(true);
  const [checkingCreds, setCheckingCreds] = useState(true);

  // Подключение
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [inputCode, setInputCode] = useState('');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionQuality, setConnectionQuality] = useState('');
  const [rtt, setRtt] = useState(0);
  const [packetLoss, setPacketLoss] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const chatDcRef = useRef<RTCDataChannel | null>(null);
  const screenshotDcRef = useRef<RTCDataChannel | null>(null);
  const pollingRef = useRef(false);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const lastMouseRef = useRef({ x: -1, y: -1 });
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = (msg: string) => setLog(prev => [...prev.slice(-49), `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const apiPost = async (path: string, body: any) => {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return res.json();
  };

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  const handleLogin = async (loginArg?: string, passwordArg?: string) => {
    setAuthError('');
    const l = (loginArg ?? login).trim();
    const p = passwordArg ?? password;
    if (!l || !p) {
      setAuthError('Введите логин и пароль');
      return;
    }
    const res = await apiPost('/auth/login', { login: l, password: p });
    if (res.type === 'ok') {
      setLoggedIn(true);
      setEmpName((res.employee && res.employee.name) || l);
      addLog('Авторизация успешна');
      // T1: запомнить / забыть учётку
      const api = (window as any).electronAPI;
      if (remember) api?.credsSave?.({ login: l, password: p });
      else api?.credsClear?.();
    } else {
      setAuthError(res.msg || 'Неверный логин или пароль');
    }
  };

  // T1: авто-вход по сохранённым данным при запуске (без мигания формы логина)
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.credsLoad) { setCheckingCreds(false); return; }
    (async () => {
      try {
        const creds = await api.credsLoad();
        if (creds?.login && creds?.password) {
          setLogin(creds.login);
          setPassword(creds.password);
          setRemember(true);
          addLog('Найдены сохранённые данные, вход…');
          await handleLogin(creds.login, creds.password);
        }
      } catch {}
      setCheckingCreds(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    const api = (window as any).electronAPI;
    await api?.credsClear?.();
    setLoggedIn(false);
    setPassword('');
    setRemember(false);
    addLog('Выход выполнен');
  };

  const sendDC = (msg: object) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(msg));
    }
  };

  const sendChatDC = (msg: object) => {
    const dc = chatDcRef.current || dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(msg));
    }
  };

  const pollLoop = async (code: string) => {
    pollingRef.current = true;
    while (pollingRef.current) {
      try {
        const res = await fetch(`${API}/poll/viewer/${code}`, { signal: AbortSignal.timeout(30000) });
        const msg = await res.json();
        if (!pollingRef.current) break;
        if (msg.type === 'timeout') continue;

        if (msg.type === 'offer' && msg.sdp) {
          addLog('Offer получен, создаю answer...');
          const pc = pcRef.current;
          if (!pc) continue;
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await apiPost('/signal', { code, type: 'answer', sdp: answer.sdp, role: 'viewer' });
          addLog('Answer отправлен');
          setStatus('connected');
          continue;
        }

        if (msg.type === 'ice-candidate' && msg.candidate) {
          await pcRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
          continue;
        }

        if (msg.type === 'host-disconnected') {
          addLog('Клиент отключился');
          setStatus('disconnected');
          setError('Клиент отключился');
          cleanup();
          break;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') continue;
        addLog(`Poll error: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  const startStatsMonitor = (pc: RTCPeerConnection) => {
    statsIntervalRef.current = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime) {
              setRtt(Math.round(report.currentRoundTripTime * 1000));
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            const lost = report.packetsLost || 0;
            const total = report.packetsReceived || 1;
            setPacketLoss(Math.round((lost / total) * 100));
          }
        });
      } catch {}
    }, 2000);
  };

  const cleanup = useCallback(() => {
    pollingRef.current = false;
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    dcRef.current?.close();
    dcRef.current = null;
    chatDcRef.current?.close();
    chatDcRef.current = null;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    setRemoteStream(null);
    setStatus('disconnected');
    setError(null);
    setConnectionQuality('');
    setRtt(0);
    setPacketLoss(0);
  }, []);

  const handleConnect = async () => {
    try {
      setError(null);
      const code = inputCode.trim();
      if (!code || code.length !== 9) {
        setError('Введите корректный 9-значный код');
        return;
      }
      addLog(`--- Подключение к клиенту (код: ${code}) ---`);

      const joinRes = await apiPost('/join', { code, employeeLogin: login, employeeName: empName || login });
      addLog(`Сервер: ${joinRes.type}`);

      if (joinRes.type === 'error') {
        setError(joinRes.msg);
        return;
      }

      if (joinRes.type === 'ok') {
        setStatus('connected');
        addLog('Клиент найден, ожидание offer...');
      }

      // Создаём только peer connection, offer создаёт клиент
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      pc.ontrack = (e) => {
        addLog('Получен видеопоток клиента!');
        if (e.streams[0]) setRemoteStream(e.streams[0]);
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          apiPost('/signal', { code, type: 'ice-candidate', candidate: e.candidate.toJSON(), role: 'viewer' }).catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        addLog(`ICE: ${state}`);
        if (state === 'connected') setConnectionQuality('good');
        else if (state === 'checking') setConnectionQuality('ok');
        else if (state === 'disconnected') setConnectionQuality('bad');
      };
      pc.onconnectionstatechange = () => {
        setStatus(pc.connectionState);
        addLog(`Статус: ${pc.connectionState}`);
      };

      // Data channel для отправки команд управления
      pc.ondatachannel = (e) => {
        const channel = e.channel;
        addLog(`Data channel: ${channel.label}`);

        if (channel.label === 'control') {
          dcRef.current = channel;
          channel.onopen = () => addLog('Канал управления открыт');
          channel.onclose = () => addLog('Канал управления закрыт');
        } else if (channel.label === 'chat') {
          chatDcRef.current = channel;
          channel.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'chat') {
                setChatMessages(prev => [...prev, { from: 'client', text: msg.text }]);
              }
            } catch {}
          };
          channel.onopen = () => addLog('Канал чата открыт');
        } else if (channel.label === 'screenshot') {
          screenshotDcRef.current = channel;
          channel.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'screenshot-data') {
                setLastScreenshot(msg.data);
                addLog('📸 Скриншот получен');
                // T7: сохраняем в Документы/RemoteDeskPBX/<код>/
                const api = (window as any).electronAPI;
                if (api?.saveScreenshot) {
                  api.saveScreenshot(msg.data, inputCode).then((r: any) => {
                    if (r?.ok) addLog(`💾 Сохранён: ${r.file}`);
                    else addLog(`Не удалось сохранить скриншот: ${r?.error || ''}`);
                  }).catch(() => {});
                }
              }
            } catch {}
          };
        }
      };

      // Статистика соединения
      startStatsMonitor(pc);

      // Polling
      pollLoop(code);
    } catch (err: any) {
      setError(err.message);
      addLog(`ERROR: ${err.message}`);
    }
  };

  const requestScreenshot = () => {
    const dc = screenshotDcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'screenshot-request' }));
      addLog('📸 Запрос скриншота...');
    } else {
      addLog('Скриншот недоступен: канал ещё не готов');
    }
  };

  // Чат
  const [chatMessages, setChatMessages] = useState<{from: string; text: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [lastScreenshot, setLastScreenshot] = useState<string | null>(null);

  const sendChat = () => {
    if (!chatInput.trim()) return;
    sendChatDC({ type: 'chat', text: chatInput });
    setChatMessages(prev => [...prev, { from: 'me', text: chatInput }]);
    setChatInput('');
    addLog(`💬 Я: ${chatInput}`);
  };

  // Полноэкранный режим просмотра экрана клиента
  const toggleFullscreen = () => {
    const el = viewerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  };

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => () => cleanup(), []);

  const handleDisconnect = async () => {
    await apiPost('/disconnect', { code: inputCode }).catch(() => {});
    cleanup();
  };

  // Пока проверяем сохранённые данные — показываем сплэш, а не форму логина
  if (checkingCreds) {
    return (
      <div style={{ ...s.page, minHeight: '100vh', padding: '96px 40px', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🛠️</div>
        <h1 style={s.h1}>RemoteDeskPBX</h1>
        <p style={{ ...s.subtitle, marginTop: 12 }}>Загрузка…</p>
      </div>
    );
  }

  // Экран логина
  if (!loggedIn) {
    return (
      <div style={{ ...s.page, minHeight: '100vh', padding: '56px 24px', textAlign: 'center' }}>
        <div style={{ maxWidth: 380, margin: '0 auto' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🛠️</div>
          <h1 style={s.h1}>RemoteDeskPBX</h1>
          <p style={{ ...s.subtitle, marginBottom: 28 }}>Панель специалиста поддержки</p>
          <div style={{ ...s.card, padding: 24, textAlign: 'left' }}>
            {authError && <div style={{ ...s.bannerError, marginBottom: 15 }}>{authError}</div>}
            <input value={login} onChange={e => setLogin(e.target.value)}
              placeholder="Логин" autoComplete="username"
              style={{ ...s.input, width: '100%', padding: '12px 14px', marginBottom: 10 }} />
            <input value={password} onChange={e => setPassword(e.target.value)}
              type="password" placeholder="Пароль" autoComplete="current-password"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{ ...s.input, width: '100%', padding: '12px 14px', marginBottom: 12 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, fontSize: 13, color: colors.muted, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer', accentColor: colors.green }} />
              Запомнить меня (вход без пароля при следующем запуске)
            </label>
            <button onClick={() => handleLogin()}
              style={{ ...s.btnPrimary, width: '100%', padding: 14, fontSize: 16 }}>
              Войти
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Экран подключения к клиенту
  if (!status || status === 'disconnected' || status === 'failed') {
    return (
      <div style={{ ...s.page, minHeight: '100vh', padding: '40px 24px' }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span style={{ fontSize: 13, color: colors.muted }}>👤 {empName || login}</span>
            <button onClick={handleLogout}
              style={{ ...s.btnGhost, padding: '5px 12px', fontSize: 12 }}>
              Выйти
            </button>
          </div>
          <h1 style={{ ...s.h1, textAlign: 'center' }}>RemoteDeskPBX</h1>
          <p style={{ ...s.subtitle, textAlign: 'center', marginBottom: 28 }}>Введите код, который назвал клиент</p>
          <div style={{ ...s.card, padding: 20 }}>
            {error && <div style={{ ...s.bannerError, marginBottom: 15 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <input type="text" value={inputCode}
                onChange={e => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 9))}
                placeholder="111 222 333"
                onKeyDown={e => e.key === 'Enter' && handleConnect()}
                style={{ ...s.input, flex: 1, padding: 12, fontSize: 18, fontFamily: mono, letterSpacing: 4, textAlign: 'center' }} />
              <button onClick={handleConnect}
                style={{ ...s.btnPrimary, padding: '12px 24px', fontSize: 15 }}>
                Подключиться
              </button>
            </div>
          </div>
          <div style={{ ...s.log, marginTop: 16, maxHeight: 300 }}>
            {log.length === 0 ? <span style={{ color: colors.muted }}>Логи появятся здесь</span> : log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      </div>
    );
  }

  // Основной экран — просмотр
  return (
    <div style={{ ...s.page, minHeight: '100vh', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.green, display: 'inline-block' }} />
          <h2 style={{ ...s.h1, fontSize: 18 }}>Подключено к клиенту</h2>
        </div>
        <div style={{ fontSize: 13, color: colors.muted, display: 'flex', alignItems: 'center', gap: 8 }}>
          {connectionQuality && quality[connectionQuality] && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: quality[connectionQuality].color, display: 'inline-block' }} />
              {quality[connectionQuality].label}
            </span>
          )}
          <span>RTT: {rtt}ms · Потери: {packetLoss}%</span>
        </div>
      </div>

      {error && <div style={{ ...s.bannerError, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 15 }}>
        {/* Видео */}
        <div style={{ flex: 1 }}>
          {!remoteStream && <div style={{ ...s.card, padding: 60, textAlign: 'center', color: colors.muted, fontSize: 17 }}>⏳ Ожидание видео...</div>}
          {remoteStream && (
            <div
              ref={viewerRef}
              style={{ position: 'relative', border: isFullscreen ? 'none' : `1px solid ${colors.border}`, borderRadius: isFullscreen ? 0 : radius.lg, overflow: 'hidden', background: '#000', cursor: 'crosshair', outline: 'none', display: isFullscreen ? 'flex' : 'block', alignItems: 'center', justifyContent: 'center', width: isFullscreen ? '100vw' : 'auto', height: isFullscreen ? '100vh' : 'auto' }}
              tabIndex={0}
              onMouseDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const hostX = Math.round(((e.clientX - rect.left) / rect.width) * 1920);
                const hostY = Math.round(((e.clientY - rect.top) / rect.height) * 1080);
                sendDC({ type: 'mousemove', x: hostX, y: hostY });
                sendDC({ type: 'mousedown', button: e.button === 2 ? 2 : 0 });
              }}
              onMouseUp={(e) => { sendDC({ type: 'mouseup', button: e.button === 2 ? 2 : 0 }); }}
              onContextMenu={(e) => { e.preventDefault(); }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const hostX = Math.round(((e.clientX - rect.left) / rect.width) * 1920);
                const hostY = Math.round(((e.clientY - rect.top) / rect.height) * 1080);
                const last = lastMouseRef.current;
                if (last.x === hostX && last.y === hostY) return;
                last.x = hostX;
                last.y = hostY;
                sendDC({ type: 'mousemove', x: hostX, y: hostY });
              }}
              onWheel={(e) => { sendDC({ type: 'mousescroll', delta: Math.sign(e.deltaY) }); }}
              onKeyDown={(e) => {
                const keyMap: Record<number, number> = {
                  8: 14, 9: 15, 13: 28, 16: 42, 17: 29, 18: 56, 20: 58,
                  27: 1, 32: 57, 33: 3657, 34: 3665, 35: 3663, 36: 3655,
                  37: 57419, 38: 57416, 39: 57421, 40: 57424, 45: 3666,
                  46: 3667, 48: 11, 49: 2, 50: 3, 51: 4, 52: 5, 53: 6,
                  54: 7, 55: 8, 56: 9, 57: 10, 65: 30, 66: 48, 67: 46,
                  68: 32, 69: 18, 70: 33, 71: 34, 72: 35, 73: 23, 74: 36,
                  75: 37, 76: 38, 77: 50, 78: 49, 79: 24, 80: 25, 81: 16,
                  82: 19, 83: 31, 84: 20, 85: 22, 86: 47, 87: 17, 88: 45,
                  89: 21, 90: 44, 96: 82, 97: 79, 98: 80, 99: 81, 100: 75,
                  101: 76, 102: 77, 103: 71, 104: 72, 105: 73, 106: 55,
                  107: 78, 109: 74, 110: 83, 111: 3637, 112: 59, 113: 60,
                  114: 61, 115: 62, 116: 63, 117: 64, 118: 65, 119: 66,
                  120: 67, 121: 68, 122: 87, 123: 88, 186: 39, 187: 13,
                  188: 51, 189: 12, 190: 52, 191: 53, 192: 41, 219: 26,
                  220: 43, 221: 27, 222: 40,
                };
                const keycode = keyMap[e.keyCode] || e.key.charCodeAt(0);
                sendDC({ type: 'keydown', keycode });
              }}
            >
              <button onClick={toggleFullscreen} onMouseDown={(e) => e.stopPropagation()} title="Развернуть подключение на весь экран"
                style={{ position: 'absolute', top: 10, right: 10, zIndex: 2, background: 'rgba(38,44,68,0.72)', color: '#fff', border: 'none', borderRadius: radius.sm, padding: '6px 12px', fontSize: 13, fontFamily: font, fontWeight: 600, cursor: 'pointer' }}>
                {isFullscreen ? '🡼 Свернуть' : '⛶ Во весь экран'}
              </button>
              <video ref={remoteVideoRef} autoPlay style={{ width: isFullscreen ? 'auto' : '100%', maxWidth: '100%', maxHeight: isFullscreen ? '100vh' : '80vh', display: 'block', pointerEvents: 'none' }} />
            </div>
          )}
        </div>

        {/* Боковая панель: скриншот (ручной) */}
        <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ ...s.card, padding: 14 }}>
            <h4 style={{ margin: '0 0 10px', color: colors.heading, fontFamily: font, fontSize: 14, fontWeight: 600 }}>📸 Скриншот</h4>
            <button onClick={requestScreenshot}
              style={{ ...s.btnPrimary, width: '100%', padding: 9, fontSize: 14 }}>
              Сделать скриншот
            </button>
            {lastScreenshot && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: colors.success, marginBottom: 4 }}>
                  ✅ Сохранён в Документы\RemoteDeskPBX\{inputCode || 'general'}\
                </div>
                <a href={lastScreenshot} download={`screenshot-${Date.now()}.jpg`}
                  style={{ fontSize: 12, color: colors.green, cursor: 'pointer', fontWeight: 600 }}>
                  💾 Скачать вручную
                </a>
                <img src={lastScreenshot} alt="screenshot" style={{ width: '100%', marginTop: 6, borderRadius: radius.sm, border: `1px solid ${colors.border}` }} />
              </div>
            )}
          </div>
        </div>

      </div>

      {/* T2: чат сотрудника — снизу в основном окне, во всю ширину */}
      <div style={{ ...s.card, marginTop: 15, padding: 14 }}>
        <h4 style={{ margin: '0 0 10px', color: colors.heading, fontFamily: font, fontSize: 14, fontWeight: 600 }}>💬 Чат с клиентом</h4>
        <div style={{ height: 120, overflow: 'auto', marginBottom: 8, background: colors.subtle, padding: 10, borderRadius: radius.md, fontSize: 13, border: `1px solid ${colors.border}` }}>
          {chatMessages.length === 0 && <span style={{ color: colors.muted }}>Нет сообщений</span>}
          {chatMessages.map((m, i) => (
            <div key={i} style={{ margin: '3px 0', color: m.from === 'me' ? colors.success : colors.navy }}>
              {m.from === 'me' ? '🛠️ Я: ' : '👤 Клиент: '}{m.text}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={chatInput} onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendChat()}
            placeholder="Сообщение клиенту..." style={{ ...s.input, flex: 1, padding: '9px 11px', fontSize: 14 }} />
          <button onClick={sendChat} style={{ ...s.btnPrimary, padding: '9px 20px', fontSize: 14 }}>Отправить</button>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={handleDisconnect} style={{ ...s.btnDanger, padding: '10px 20px', fontSize: 15 }}>Отключиться</button>
        <span style={{ fontSize: 12, color: colors.muted }}>Статус: {status}</span>
      </div>

      <div style={{ ...s.log, marginTop: 12, maxHeight: 100 }}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
};

export default App;