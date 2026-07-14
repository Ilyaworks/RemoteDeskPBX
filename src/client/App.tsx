import React, { useState, useRef, useEffect, useCallback } from 'react';

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
  const pollingRef = useRef(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
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
        audio: false,
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

      // Data channel для чата
      const chatDc = pc.createDataChannel('chat', { ordered: true });
      chatDc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'chat') {
            addLog(`💬 Сотрудник: ${msg.text}`);
            setChatMessages(prev => [...prev, { from: 'employee', text: msg.text }]);
          }
        } catch {}
      };

      // Data channel для скриншотов
      const screenDc = pc.createDataChannel('screenshot', { ordered: true });
      screenDc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'screenshot-request') {
            takeScreenshot(screenDc);
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
        if (state === 'connected') setConnectionQuality('🟢 Отличное');
        else if (state === 'checking') setConnectionQuality('🟡 Среднее');
        else if (state === 'disconnected') setConnectionQuality('🔴 Плохое');
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

  const takeScreenshot = async (dc: RTCDataChannel) => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as MediaTrackConstraints,
      });
      const track = stream.getVideoTracks()[0];
      const imageCapture = new (window as any).ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      track.stop();

      // Convert bitmap to blob
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      canvas.toBlob((blob) => {
        if (blob && dc.readyState === 'open') {
          const reader = new FileReader();
          reader.onload = () => {
            dc.send(JSON.stringify({ type: 'screenshot-data', data: reader.result }));
          };
          reader.readAsDataURL(blob);
        }
      }, 'image/jpeg', 0.7);
    } catch (err) {
      addLog(`Ошибка скриншота: ${(err as any).message}`);
    }
  };

  const [chatMessages, setChatMessages] = useState<{from: string; text: string}[]>([]);
  const [chatInput, setChatInput] = useState('');

  const sendChat = () => {
    if (!chatInput.trim()) return;
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'chat', text: chatInput }));
    }
    setChatMessages(prev => [...prev, { from: 'me', text: chatInput }]);
    setChatInput('');
    addLog(`💬 Я: ${chatInput}`);
  };

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
      <div style={{ padding: '40px', fontFamily: 'Arial', maxWidth: '400px', margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ color: '#1a73e8', fontSize: '28px' }}>🖥️ RemoteDeskPBX</h1>
        <p style={{ color: '#888', marginBottom: '30px' }}>Ваш помощник удалённо подключится к вашему компьютеру</p>
        {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '10px', borderRadius: '4px', marginBottom: '15px' }}>{error}</div>}
        <button onClick={handleStartHost}
          style={{ width: '100%', padding: '16px', background: '#1a73e8', color: 'white', border: 'none', borderRadius: '8px', fontSize: '18px', cursor: 'pointer' }}>
          🔌 Разрешить подключение
        </button>
        <div style={{ marginTop: '20px', background: '#1e1e1e', color: '#0f0', padding: '10px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', maxHeight: '200px', overflow: 'auto' }}>
          {log.length === 0 ? <span style={{ color: '#666' }}>Логи появятся здесь</span> : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial' }}>
      <h2 style={{ color: '#1a73e8' }}>🔵 Я — клиент</h2>
      <div style={{ background: '#e8f0fe', padding: '20px', borderRadius: '8px', textAlign: 'center', marginBottom: '20px' }}>
        <p style={{ fontSize: '14px', color: '#666' }}>Сообщите этот код сотруднику техподдержки:</p>
        <div style={{ fontSize: '48px', fontWeight: 'bold', letterSpacing: '12px', color: '#1a73e8', fontFamily: 'monospace', padding: '15px 25px', background: 'white', borderRadius: '8px', border: '2px dashed #1a73e8', display: 'inline-block', userSelect: 'all' }}>
          {displayCode}
        </div>
        <p style={{ fontSize: '13px', marginTop: '10px' }}>
          Статус: <span style={{ fontWeight: 'bold', color: status === 'connected' ? '#34a853' : '#fbbc04' }}>{status}</span>
          {connectionQuality && <span style={{ marginLeft: '10px' }}>{connectionQuality}</span>}
        </p>
      </div>
      {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '8px', borderRadius: '4px', marginBottom: '10px' }}>{error}</div>}
      {localStream && <video ref={localVideoRef} autoPlay muted style={{ width: '100%', maxHeight: '40vh', borderRadius: '8px' }} />}

      {/* Чат */}
      <div style={{ marginTop: '15px', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '10px' }}>
        <h4 style={{ margin: '0 0 10px', color: '#555' }}>💬 Чат с сотрудником</h4>
        <div style={{ maxHeight: '150px', overflow: 'auto', marginBottom: '10px', background: '#f9f9f9', padding: '8px', borderRadius: '4px', fontSize: '13px' }}>
          {chatMessages.length === 0 && <span style={{ color: '#aaa' }}>Нет сообщений</span>}
          {chatMessages.map((m, i) => (
            <div key={i} style={{ margin: '2px 0', color: m.from === 'me' ? '#1a73e8' : '#34a853' }}>
              {m.from === 'me' ? '👤 Я: ' : '🛠️ Сотрудник: '}{m.text}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input value={chatInput} onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendChat()}
            placeholder="Напишите сообщение..." style={{ flex: 1, padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
          <button onClick={sendChat} style={{ padding: '8px 16px', background: '#1a73e8', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Отправить</button>
        </div>
      </div>

      <button onClick={handleDisconnect} style={{ marginTop: '15px', padding: '10px 20px', backgroundColor: '#ea4335', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '16px' }}>Отключиться</button>
      <div style={{ marginTop: '10px', background: '#1e1e1e', color: '#0f0', padding: '10px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', maxHeight: '150px', overflow: 'auto' }}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
};

export default App;