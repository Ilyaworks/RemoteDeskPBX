import React, { useState, useRef, useEffect, useCallback } from 'react';

const API = 'https://remotedeskpbx-server.onrender.com';

const App: React.FC = () => {
  const [mode, setMode] = useState<'home' | 'hosting' | 'viewing'>('home');
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [inputCode, setInputCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pollingRef = useRef(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const addLog = (msg: string) => setLog(prev => [...prev.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const apiPost = async (path: string, body: any) => {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return res.json();
  };

  const pollLoop = async (role: string, code: string) => {
    pollingRef.current = true;
    while (pollingRef.current) {
      try {
        const res = await fetch(`${API}/poll/${role}/${code}`, { signal: AbortSignal.timeout(30000) });
        const msg = await res.json();
        if (!pollingRef.current) break;
        addLog(`Poll received: ${msg.type}`);

        if (msg.type === 'timeout') continue;

        if (msg.type === 'viewer-joined') {
          addLog('Viewer joined! Creating offer...');
          setStatus('creating-offer');
          const pc = pcRef.current;
          if (!pc) continue;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await apiPost('/signal', { code, type: 'offer', sdp: offer.sdp, role: 'host' });
          addLog('Offer sent');
          continue;
        }

        if (msg.type === 'offer' && msg.sdp) {
          addLog('Offer received, creating answer...');
          const pc = pcRef.current;
          if (!pc) continue;
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await apiPost('/signal', { code, type: 'answer', sdp: answer.sdp, role: 'viewer' });
          addLog('Answer sent');
          setStatus('connected');
          continue;
        }

        if (msg.type === 'answer' && msg.sdp) {
          addLog('Answer received');
          await pcRef.current?.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          setStatus('connected');
          continue;
        }

        if (msg.type === 'ice-candidate' && msg.candidate) {
          await pcRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
          continue;
        }

        if (msg.type === 'host-disconnected') {
          addLog('Host disconnected');
          setStatus('disconnected');
          setError('Host disconnected');
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

  const cleanup = useCallback(() => {
    pollingRef.current = false;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); setLocalStream(null); }
    setRemoteStream(null);
    setStatus('disconnected');
    setRoomCode('');
    setMode('home');
    setError(null);
  }, [localStream]);

  const handleStartHost = async () => {
    try {
      setError(null);
      addLog('--- Starting host mode ---');

      addLog('Requesting screen capture...');
      setStatus('requesting-screen');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' } as MediaTrackConstraints,
        audio: false,
      });
      setLocalStream(stream);
      addLog('Screen capture granted');

      setStatus('registering');
      addLog('Registering on server...');
      const reg = await apiPost('/register', {});
      addLog(`Server response: ${reg.type}`);

      if (reg.type !== 'code') {
        setError('Failed to register');
        return;
      }

      const code = reg.code;
      setRoomCode(code);
      setStatus('waiting-viewer');
      addLog(`Room code: ${code}`);

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          apiPost('/signal', { code, type: 'ice-candidate', candidate: e.candidate.toJSON(), role: 'host' }).catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => addLog(`ICE state: ${pc.iceConnectionState}`);
      pc.onconnectionstatechange = () => { setStatus(pc.connectionState); addLog(`Connection: ${pc.connectionState}`); };

      setMode('hosting');

      // Start polling for viewer
      pollLoop('host', code);
    } catch (err: any) {
      const msg = err.message || 'Failed to start';
      setError(msg);
      addLog(`ERROR: ${msg}`);
    }
  };

  const handleStartViewer = async () => {
    try {
      setError(null);
      const code = inputCode.trim();
      if (!code || code.length !== 9) {
        setError('Enter a valid 9-digit code');
        return;
      }
      addLog(`--- Starting viewer mode (code: ${code}) ---`);

      setStatus('joining');
      addLog('Joining room...');
      const joinRes = await apiPost('/join', { code });
      addLog(`Server response: ${joinRes.type}`);

      if (joinRes.type === 'error') {
        setError(joinRes.msg);
        setStatus('disconnected');
        return;
      }

      setStatus('waiting-offer');
      addLog('Joined room, waiting for offer...');

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;

      pc.ontrack = (e) => {
        addLog('Remote track received!');
        if (e.streams[0]) setRemoteStream(e.streams[0]);
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          apiPost('/signal', { code, type: 'ice-candidate', candidate: e.candidate.toJSON(), role: 'viewer' }).catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => addLog(`ICE state: ${pc.iceConnectionState}`);
      pc.onconnectionstatechange = () => { setStatus(pc.connectionState); addLog(`Connection: ${pc.connectionState}`); };

      setMode('viewing');

      // Start polling for offer/answer
      pollLoop('viewer', code);
    } catch (err: any) {
      setError(err.message);
      addLog(`ERROR: ${err.message}`);
    }
  };

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => () => cleanup(), []);

  const handleDisconnect = async () => {
    if (roomCode) {
      apiPost('/disconnect', { code: roomCode }).catch(() => {});
    }
    cleanup();
  };

  const logPanel = (
    <div style={{ marginTop: '10px', background: '#1e1e1e', color: '#0f0', padding: '10px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', maxHeight: '200px', overflow: 'auto' }}>
      {log.length === 0 ? <span style={{ color: '#666' }}>Logs will appear here</span> : log.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );

  if (mode === 'hosting') {
    const displayCode = roomCode.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial' }}>
        <h2 style={{ color: '#1a73e8' }}>🖥️ Sharing Screen</h2>
        <div style={{ background: '#e8f0fe', padding: '25px', borderRadius: '8px', textAlign: 'center', marginBottom: '20px' }}>
          <p style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>Give this code to the person who will control your PC:</p>
          <div style={{ fontSize: '48px', fontWeight: 'bold', letterSpacing: '12px', color: '#1a73e8', fontFamily: 'monospace', padding: '15px 25px', background: 'white', borderRadius: '8px', border: '2px dashed #1a73e8', display: 'inline-block', userSelect: 'all' }}>
            {displayCode}
          </div>
          <p style={{ fontSize: '13px', marginTop: '10px', color: status === 'connected' ? '#34a853' : '#fbbc04' }}>
            Status: {status}
          </p>
        </div>
        {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '8px', borderRadius: '4px', marginBottom: '10px' }}>{error}</div>}
        {localStream && <video ref={localVideoRef} autoPlay muted style={{ width: '100%', maxHeight: '50vh', borderRadius: '8px' }} />}
        <button onClick={handleDisconnect} style={{ marginTop: '10px', padding: '10px 20px', backgroundColor: '#ea4335', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '16px' }}>Stop sharing</button>
        {logPanel}
      </div>
    );
  }

  if (mode === 'viewing') {
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial' }}>
        <h2 style={{ color: '#34a853' }}>👁️ Viewing Remote PC</h2>
        <p>Status: <span style={{ fontWeight: 'bold', color: status === 'connected' ? '#34a853' : '#fbbc04' }}>{status}</span></p>
        {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '8px', borderRadius: '4px', marginBottom: '10px' }}>{error}</div>}
        {!remoteStream && <div style={{ padding: '60px', textAlign: 'center', background: '#f5f5f5', borderRadius: '8px', color: '#666', fontSize: '18px' }}>⏳ Waiting for video...</div>}
        {remoteStream && (
          <div style={{ border: '1px solid #ccc', borderRadius: '8px', overflow: 'hidden', background: '#000' }}>
            <video ref={remoteVideoRef} autoPlay style={{ width: '100%', maxHeight: '80vh', display: 'block' }} />
          </div>
        )}
        <button onClick={handleDisconnect} style={{ marginTop: '10px', padding: '10px 20px', backgroundColor: '#ea4335', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '16px' }}>Disconnect</button>
        {logPanel}
      </div>
    );
  }

  return (
    <div style={{ padding: '40px', fontFamily: 'Arial', maxWidth: '480px', margin: '0 auto' }}>
      <h1 style={{ textAlign: 'center', color: '#1a73e8', fontSize: '32px' }}>RemoteDeskPBX</h1>
      <p style={{ textAlign: 'center', color: '#888', marginBottom: '30px', fontSize: '14px' }}>Remote desktop control — only 9-digit code needed</p>

      {error && <div style={{ color: '#ea4335', background: '#fce8e6', padding: '10px', borderRadius: '4px', marginBottom: '15px', fontSize: '14px' }}>{error}</div>}

      <div style={{ padding: '20px', border: '1px solid #e0e0e0', borderRadius: '8px', marginBottom: '20px', textAlign: 'center' }}>
        <h3 style={{ color: '#1a73e8', margin: '0 0 10px' }}>Allow control</h3>
        <p style={{ fontSize: '13px', color: '#888', marginBottom: '15px' }}>Someone will control your PC</p>
        <button onClick={handleStartHost}
          style={{ width: '100%', padding: '14px', background: '#1a73e8', color: 'white', border: 'none', borderRadius: '6px', fontSize: '16px', cursor: 'pointer' }}>
          🔌 Share my screen
        </button>
      </div>

      <div style={{ padding: '20px', border: '1px solid #e0e0e0', borderRadius: '8px', textAlign: 'center' }}>
        <h3 style={{ color: '#34a853', margin: '0 0 10px' }}>Take control</h3>
        <p style={{ fontSize: '13px', color: '#888', marginBottom: '15px' }}>Enter code to control someone's PC</p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input type="text" value={inputCode}
            onChange={e => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 9))}
            placeholder="111 222 333" maxLength={9}
            style={{ flex: 1, padding: '12px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '18px', fontFamily: 'monospace', letterSpacing: '4px', textAlign: 'center' }} />
          <button onClick={handleStartViewer}
            style={{ padding: '12px 20px', background: '#34a853', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Connect
          </button>
        </div>
      </div>
      {logPanel}
    </div>
  );
};

export default App;