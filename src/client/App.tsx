import React, { useState, useRef, useEffect, useCallback } from 'react';
import { colors, mono, radius, shadow, s, quality } from '../shared/theme';

const API = 'https://remotedeskpbx-server.onrender.com';

const App: React.FC = () => {
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [roomCode, setRoomCode] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [connectionQuality, setConnectionQuality] = useState('');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const chatDcRef = useRef<RTCDataChannel | null>(null);
  const pollingRef = useRef(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const codeRef = useRef('');

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

  const pollLoop = async (code: string) => {
    pollingRef.current = true;
    while (pollingRef.current) {
      try {
        const res = await fetch(`${API}/poll/host/${code}`, { signal: AbortSignal.timeout(30000) });
        const msg = await res.json();
        if (!pollingRef.current) break;
        if (msg.type === 'timeout') continue;

        if (msg.type === 'viewer-joined') {
          addLog('Сотрудник подключился! Создаю offer...');
          setStatus('connecting');
          const pc = pcRef.current;
          if (!pc) continue;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await apiPost('/signal', { code, type: 'offer', sdp: offer.sdp, role: 'host' });
          continue;
        }

        if (msg.type === 'answer' && msg.sdp) {
          addLog('Answer получен');
          await pcRef.current?.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          setStatus('connected');
          continue;
        }

        if (msg.type === 'ice-candidate' && msg.candidate) {
          await pcRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
          continue;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') continue;
        addLog(`Poll error: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  const cleanup = useCallback(() => {
    pollingRef.current = false;
    dcRef.current?.close();
    dcRef.current = null;
    chatDcRef.current?.close();
    chatDcRef.current = null;
    (window as any).electronAPI?.hideChat?.();
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); setLocalStream(null); }
    setStatus('disconnected');
    setRoomCode('');
    setError(null);
    setConnectionQuality('');
  }, [localStream]);

  const handleStartHost = async () => {
    try {
      setError(null);
      addLog('--- Запрос захвата экрана ---');

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as MediaTrackConstraints,
        audio: true,
      });

      // Ограничение качества для слабого интернета
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          await videoTrack.applyConstraints({
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 15 },
          } as any);
        } catch (e) {}
      }

      setLocalStream(stream);
      localStreamRef.current = stream;
      addLog('Захват экрана запущен');

      setStatus('registering');
      const reg = await apiPost('/register', {});
      if (reg.type !== 'code') {
        setError('Ошибка регистрации на сервере');
        return;
      }

      const code = reg.code;
      codeRef.current = code;
      setRoomCode(code);
      setStatus('waiting');
      addLog(`Код комнаты: ${code}`);

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      // Data channel для команд управления
      const dc = pc.createDataChannel('control', { ordered: false, maxRetransmits: 0 });
      dcRef.current = dc;
      dc.onmessage = (e) => {
        try {
          const cmd = JSON.parse(e.data);
          const api = (window as any).electronAPI;
          if (!api) return;
          switch (cmd.type) {
            case 'mousemove': api.mouseMove(cmd.x, cmd.y); break;
            case 'mousedown': api.mouseClick(cmd.button); break;
            case 'mouseup': api.mouseClick(cmd.button); break;
            case 'mousescroll': api.mouseScroll(cmd.delta); break;
            case 'keydown': api.keyPress(cmd.keycode); break;
          }
        } catch (err: any) {
          addLog(`Ошибка команды: ${err.message}`);
        }
      };
      dc.onopen = () => addLog('Канал управления открыт');
      dc.onclose = () => addLog('Канал управления закрыт');

      // Data channel для чата → плавающее окно (T2)
      const chatDc = pc.createDataChannel('chat', { ordered: true });
      chatDcRef.current = chatDc;
      chatDc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'chat') {
            addLog(`💬 Сотрудник: ${msg.text}`);
            (window as any).electronAPI?.showChat?.({ from: 'employee', text: msg.text });
          }
        } catch {}
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          apiPost('/signal', { code, type: 'ice-candidate', candidate: e.candidate.toJSON(), role: 'host' }).catch(() => {});
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

      // Polling
      pollLoop(code);
    } catch (err: any) {
      setError(err.message || 'Ошибка запуска');
      addLog(`ERROR: ${err.message}`);
    }
  };

  // T2: сообщения из плавающего окна чата → отправка сотруднику по DataChannel
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onChatOutgoing) return;
    api.onChatOutgoing((text: string) => {
      const dc = chatDcRef.current;
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'chat', text }));
      else addLog('Чат недоступен: нет соединения');
      addLog(`💬 Я: ${text}`);
    });
  }, []);

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => () => cleanup(), []);

  const handleDisconnect = async () => {
    if (roomCode) apiPost('/disconnect', { code: roomCode }).catch(() => {});
    cleanup();
  };

  const displayCode = roomCode.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');

  if (!roomCode) {
    return (
      <div style={{ ...s.page, minHeight: '100vh', padding: '56px 24px', textAlign: 'center' }}>
        <div style={{ maxWidth: 420, margin: '0 auto' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🖥️</div>
          <h1 style={s.h1}>RemoteDeskPBX</h1>
          <p style={{ ...s.subtitle, marginBottom: 32 }}>Ваш помощник удалённо подключится к вашему компьютеру</p>
          {error && <div style={{ ...s.bannerError, marginBottom: 16, textAlign: 'left' }}>{error}</div>}
          <button onClick={handleStartHost}
            style={{ ...s.btnPrimary, width: '100%', padding: '16px', fontSize: 17, boxShadow: shadow.card }}>
            Разрешить подключение
          </button>
          <div style={{ ...s.log, marginTop: 24, maxHeight: 200, textAlign: 'left' }}>
            {log.length === 0 ? <span style={{ color: colors.muted }}>Логи появятся здесь</span> : log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...s.page, minHeight: '100vh', padding: 24 }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.green, display: 'inline-block' }} />
          <h2 style={{ ...s.h1, fontSize: 20 }}>RemoteDeskPBX</h2>
        </div>
        <div style={{ ...s.card, padding: 24, textAlign: 'center', marginBottom: 20 }}>
          <p style={{ fontSize: 14, color: colors.muted, margin: 0 }}>Сообщите этот код сотруднику техподдержки:</p>
          <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: 10, color: colors.navy, fontFamily: mono, padding: '14px 20px', background: colors.subtle, borderRadius: radius.lg, border: `1px dashed ${colors.green}`, display: 'inline-block', userSelect: 'all', margin: '14px 0 6px' }}>
            {displayCode}
          </div>
          <p style={{ fontSize: 13, marginTop: 8, color: colors.muted, display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center' }}>
            <span>Статус: <span style={{ fontWeight: 600, color: status === 'connected' ? colors.green : colors.warning }}>{status}</span></span>
            {connectionQuality && quality[connectionQuality] && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: quality[connectionQuality].color, display: 'inline-block' }} />
                {quality[connectionQuality].label}
              </span>
            )}
          </p>
        </div>
        {error && <div style={{ ...s.bannerError, marginBottom: 12 }}>{error}</div>}
        {localStream && <video ref={localVideoRef} autoPlay muted style={{ width: '100%', maxHeight: '40vh', borderRadius: radius.lg, border: `1px solid ${colors.border}` }} />}

        {/* T2: чат вынесен в отдельное плавающее окно на рабочем столе */}
        <div style={{ ...s.bannerInfo, marginTop: 16 }}>
          💬 Когда специалист поддержки напишет, у вас всплывёт отдельное окно чата поверх рабочего стола.
        </div>

        <button onClick={handleDisconnect} style={{ ...s.btnDanger, marginTop: 16, padding: '11px 22px', fontSize: 15 }}>Отключиться</button>
        <div style={{ ...s.log, marginTop: 12, maxHeight: 150 }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
};

export default App;