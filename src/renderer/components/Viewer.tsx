import React, { useState, useRef, useEffect } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    gap: '20px',
    padding: '20px',
  },
  title: {
    fontSize: '22px',
    fontWeight: 600,
    color: '#0f3460',
  },
  inputGroup: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
  input: {
    padding: '12px 16px',
    fontSize: '20px',
    fontFamily: 'monospace',
    letterSpacing: '4px',
    textTransform: 'uppercase',
    background: '#16213e',
    border: '2px solid #333',
    borderRadius: '8px',
    color: '#fff',
    outline: 'none',
    width: '200px',
    textAlign: 'center' as const,
  },
  joinBtn: {
    padding: '12px 24px',
    background: '#0f3460',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: 600,
  },
  video: {
    width: '90%',
    maxWidth: '960px',
    borderRadius: '8px',
    border: '2px solid #333',
    background: '#000',
  },
  status: {
    fontSize: '14px',
    color: '#888',
  },
  connected: {
    color: '#4ecca3',
  },
  error: {
    color: '#e94560',
    fontSize: '14px',
  },
  disconnectBtn: {
    padding: '10px 24px',
    background: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 600,
  },
};

export default function Viewer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [codeInput, setCodeInput] = useState('');
  const [hasJoined, setHasJoined] = useState(false);

  const {
    remoteStream,
    isConnected,
    error,
    joinRoom,
    stop,
  } = useWebRTC({ role: 'viewer' });

  useEffect(() => {
    if (videoRef.current && remoteStream) {
      videoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const handleJoin = () => {
    const code = codeInput.trim().toUpperCase();
    if (code.length === 0) return;
    setHasJoined(true);
    joinRoom(code);
  };

  const handleDisconnect = () => {
    setHasJoined(false);
    setCodeInput('');
    stop();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleJoin();
    }
  };

  if (!hasJoined) {
    return (
      <div style={styles.container}>
        <h2 style={styles.title}>👁 Подключиться к комнате</h2>
        <div style={styles.inputGroup}>
          <input
            style={styles.input}
            type="text"
            placeholder="XXXXXX"
            maxLength={6}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase().slice(0, 6))}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            style={styles.joinBtn}
            onClick={handleJoin}
            disabled={codeInput.length < 6}
          >
            Подключиться
          </button>
        </div>
        {error && <p style={styles.error}>❌ {error}</p>}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>👁 Просмотр экрана</h2>

      <p style={styles.status}>
        Статус:{' '}
        <span style={isConnected ? styles.connected : undefined}>
          {isConnected ? '🔗 Подключено' : '⏳ Подключение...'}
        </span>
      </p>

      {error && <p style={styles.error}>❌ {error}</p>}

      <video
        ref={videoRef}
        style={styles.video}
        autoPlay
        playsInline
      />

      <button style={styles.disconnectBtn} onClick={handleDisconnect}>
        Отключиться
      </button>
    </div>
  );
}
