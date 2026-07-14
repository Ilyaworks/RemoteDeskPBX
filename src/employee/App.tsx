import React, { useState, useRef, useEffect, useCallback } from 'react';

const API = 'https://remotedeskpbx-server.onrender.com';

const App: React.FC = () => {
  // Авторизация
  const [loggedIn, setLoggedIn] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [empName, setEmpName] = useState('');
  const [authError, setAuthError] = useState('');
  const [remember, setRemember] = useState(true);

  // Подключение
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [inputCode, setInputCode] = useState('');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionQuality, setConnectionQuality] = useState('');
  const [rtt, setRtt] = useState(0);
  const [packetLoss, setPacketLoss] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const chatDcRef = useRef<RTCDataChannel | null>(null);
  const pollingRef = useRef(false);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
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

  // T1: авто-вход по сохранённым данным при запуске
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.credsLoad) return;
    api.credsLoad().then((creds: any) => {
      if (creds?.login && creds?.password) {
        setLogin(creds.login);
        setPassword(creds.password);
        setRemember(true);
        addLog('Найдены сохранённые данные, вход…');
        handleLogin(creds.login, creds.password);
      }
    }).catch(() => {});
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
        if (state === 'connected') setConnectionQuality('🟢 Отличное');
        else if (state === 'checking') setConnectionQuality('🟡 Среднее');
        else if (state === 'disconnected') setConnectionQuality('🔴 Плохое');
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
    sendDC({ type: 'screenshot-request' });
    addLog('📸 Запрос скриншота...');
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

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => () => cleanup(), []);

  const handleDisconnect = async () => {
    await apiPost('/disconnect', { code: inputCode }).catch(() => {});
    cleanup();
  };

  // Экран логина
  if (!loggedIn) {
    return (
      <div style={{ padding: '40px', fontFamily: 'Arial', maxWidth: '360px', margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ color: '#34a853', fontSize: '28px' }}>🛠️ RemoteDeskPBX</h1>
        <p style={{ color: '#888', marginBottom: '30px' }}>Авторизация сотрудника</p>
        {authError && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '10px', borderRadius: '4px', marginBottom: '15px' }}>{authError}</div>}
        <input value={login} onChange={e => setLogin(e.target.value)}
          placeholder="Логин" autoComplete="username"
          style={{ width: '100%', padding: '12px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '16px', boxSizing: 'border-box' }} />
        <input value={password} onChange={e => setPassword(e.target.value)}
          type="password" placeholder="Пароль" autoComplete="current-password"
          onKeyDown={e => e.key === 'Enter' && handleLogin()}
          style={{ width: '100%', padding: '12px', marginBottom: '12px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '16px', boxSizing: 'border-box' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '15px', fontSize: '14px', color: '#555', cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
          Запомнить меня (вход без пароля при следующем запуске)
        </label>
        <button onClick={() => handleLogin()}
          style={{ width: '100%', padding: '14px', background: '#34a853', color: 'white', border: 'none', borderRadius: '6px', fontSize: '18px', cursor: 'pointer' }}>
          Войти
        </button>
      </div>
    );
  }

  // Экран подключения к клиенту
  if (!status || status === 'disconnected' || status === 'failed') {
    return (
      <div style={{ padding: '40px', fontFamily: 'Arial', maxWidth: '480px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <span style={{ fontSize: '13px', color: '#888' }}>👤 {empName || login}</span>
          <button onClick={handleLogout}
            style={{ padding: '4px 12px', background: 'transparent', color: '#ea4335', border: '1px solid #ea4335', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
            Выйти
          </button>
        </div>
        <h1 style={{ color: '#34a853', fontSize: '28px', textAlign: 'center' }}>🛠️ RemoteDeskPBX</h1>
        <p style={{ textAlign: 'center', color: '#888', marginBottom: '30px' }}>Введите код, который назвал клиент</p>
        {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '10px', borderRadius: '4px', marginBottom: '15px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <input type="text" value={inputCode}
            onChange={e => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 9))}
            placeholder="111 222 333"
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
            style={{ flex: 1, padding: '12px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '18px', fontFamily: 'monospace', letterSpacing: '4px', textAlign: 'center' }} />
          <button onClick={handleConnect}
            style={{ padding: '12px 24px', background: '#34a853', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', cursor: 'pointer' }}>
            Подключиться
          </button>
        </div>
        <div style={{ background: '#1e1e1e', color: '#0f0', padding: '10px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', maxHeight: '300px', overflow: 'auto' }}>
          {log.length === 0 ? <span style={{ color: '#666' }}>Логи появятся здесь</span> : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    );
  }

  // Основной экран — просмотр
  return (
    <div style={{ padding: '15px', fontFamily: 'Arial' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h2 style={{ color: '#34a853', margin: 0 }}>🛠️ Подключено к клиенту</h2>
        <div style={{ fontSize: '13px', color: '#666' }}>
          {connectionQuality} | RTT: {rtt}ms | Потери: {packetLoss}%
        </div>
      </div>

      {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '8px', borderRadius: '4px', marginBottom: '10px' }}>{error}</div>}

      <div style={{ display: 'flex', gap: '15px' }}>
        {/* Видео */}
        <div style={{ flex: 1 }}>
          {!remoteStream && <div style={{ padding: '60px', textAlign: 'center', background: '#f5f5f5', borderRadius: '8px', color: '#666', fontSize: '18px' }}>⏳ Ожидание видео...</div>}
          {remoteStream && (
            <div
              style={{ border: '1px solid #ccc', borderRadius: '8px', overflow: 'hidden', background: '#000', cursor: 'crosshair', outline: 'none' }}
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
              <video ref={remoteVideoRef} autoPlay style={{ width: '100%', maxHeight: '80vh', display: 'block', pointerEvents: 'none' }} />
            </div>
          )}
        </div>

        {/* Боковая панель: скриншот + чат */}
        <div style={{ width: '300px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Скриншот */}
          <div style={{ border: '1px solid #e0e0e0', borderRadius: '8px', padding: '10px' }}>
            <h4 style={{ margin: '0 0 8px', color: '#555' }}>📸 Скриншот</h4>
            <button onClick={requestScreenshot}
              style={{ width: '100%', padding: '8px', background: '#34a853', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              Сделать скриншот
            </button>
            {lastScreenshot && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '11px', color: '#34a853', marginBottom: '4px' }}>
                  ✅ Сохранён в Документы\RemoteDeskPBX\{inputCode || 'general'}\
                </div>
                <a href={lastScreenshot} download={`screenshot-${Date.now()}.jpg`}
                  style={{ fontSize: '12px', color: '#1a73e8', cursor: 'pointer' }}>
                  💾 Скачать вручную
                </a>
                <img src={lastScreenshot} alt="screenshot" style={{ width: '100%', marginTop: '5px', borderRadius: '4px', border: '1px solid #ddd' }} />
              </div>
            )}
          </div>

          {/* Чат */}
          <div style={{ border: '1px solid #e0e0e0', borderRadius: '8px', padding: '10px', flex: 1 }}>
            <h4 style={{ margin: '0 0 8px', color: '#555' }}>💬 Чат</h4>
            <div style={{ maxHeight: '200px', overflow: 'auto', marginBottom: '8px', background: '#f9f9f9', padding: '8px', borderRadius: '4px', fontSize: '13px', minHeight: '80px' }}>
              {chatMessages.length === 0 && <span style={{ color: '#aaa' }}>Нет сообщений</span>}
              {chatMessages.map((m, i) => (
                <div key={i} style={{ margin: '2px 0', color: m.from === 'me' ? '#34a853' : '#1a73e8' }}>
                  {m.from === 'me' ? '🛠️ Я: ' : '👤 Клиент: '}{m.text}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="Сообщение..." style={{ flex: 1, padding: '6px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '13px' }} />
              <button onClick={sendChat} style={{ padding: '6px 12px', background: '#34a853', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>→</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button onClick={handleDisconnect} style={{ padding: '10px 20px', backgroundColor: '#ea4335', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '16px' }}>Отключиться</button>
        <span style={{ fontSize: '12px', color: '#888' }}>Статус: {status}</span>
      </div>

      <div style={{ marginTop: '10px', background: '#1e1e1e', color: '#0f0', padding: '10px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', maxHeight: '100px', overflow: 'auto' }}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
};

export default App;