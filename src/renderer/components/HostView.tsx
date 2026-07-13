import React, { useEffect, useRef } from 'react';
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
    color: '#e94560',
  },
  codeBox: {
    background: '#16213e',
    padding: '20px 40px',
    borderRadius: '12px',
    border: '2px solid #e94560',
    fontSize: '36px',
    fontWeight: 700,
    letterSpacing: '8px',
    color: '#fff',
    fontFamily: 'monospace',
  },
  status: {
    fontSize: '14px',
    color: '#888',
  },
  connected: {
    color: '#4ecca3',
  },
  video: {
    width: '80%',
    maxWidth: '800px',
    borderRadius: '8px',
    border: '2px solid #333',
  },
  error: {
    color: '#e94560',
    fontSize: '14px',
  },
  stopBtn: {
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

export default function HostView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const {
    roomCode,
    localStream,
    isConnected,
    error,
    startHosting,
    stop,
  } = useWebRTC({ role: 'host' });

  useEffect(() => {
    startHosting();
    return () => stop();
  }, []);

  useEffect(() => {
    if (videoRef.current && localStream) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>🖥 Трансляция экрана</h2>

      {roomCode && (
        <>
          <p style={styles.status}>Код комнаты:</p>
          <div style={styles.codeBox}>{roomCode}</div>
          <p style={styles.status}>
            Статус:{' '}
            <span style={isConnected ? styles.connected : undefined}>
              {isConnected ? '🔗 Подключено' : '⏳ Ожидание подключения...'}
            </span>
          </p>
        </>
      )}

      {error && <p style={styles.error}>❌ {error}</p>}

      {localStream && (
        <video
          ref={videoRef}
          style={styles.video}
          autoPlay
          muted
          playsInline
        />
      )}

      <button style={styles.stopBtn} onClick={stop}>
        Остановить трансляцию
      </button>
    </div>
  );
}
