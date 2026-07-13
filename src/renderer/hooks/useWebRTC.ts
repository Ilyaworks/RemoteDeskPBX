import { useEffect, useRef, useCallback, useState } from 'react';

const SIGNALING_URL = `ws://localhost:3001/ws`;

interface UseWebRTCOptions {
  role: 'host' | 'viewer';
  roomCode?: string;
  onRemoteStream?: (stream: MediaStream) => void;
}

interface UseWebRTCResult {
  roomCode: string | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isConnected: boolean;
  error: string | null;
  startHosting: () => Promise<void>;
  joinRoom: (code: string) => Promise<void>;
  stop: () => void;
}

export function useWebRTC(options: UseWebRTCOptions): UseWebRTCResult {
  const { role, onRemoteStream } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const createPeerConnection = useCallback((ws: WebSocket, peerId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({
          type: 'ice-candidate',
          payload: { targetPeerId: peerId, candidate: event.candidate },
        }));
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      setRemoteStream(stream);
      onRemoteStream?.(stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setIsConnected(true);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setIsConnected(false);
      }
    };

    return pc;
  }, [onRemoteStream]);

  const startHosting = useCallback(async () => {
    cleanup();
    setError(null);

    try {
      // Захват экрана
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Подключение к сигнальному серверу
      const ws = new WebSocket(SIGNALING_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'create-room', payload: {} }));
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'room-created': {
            setRoomCode(msg.payload.code as string);
            break;
          }
          case 'peer-joined': {
            const peerId = msg.payload.peerId as string;
            const pc = createPeerConnection(ws, peerId);
            pcRef.current = pc;

            // Добавляем треки в peer connection
            stream.getTracks().forEach(track => {
              pc.addTrack(track, stream);
            });

            // Создаём offer
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            ws.send(JSON.stringify({
              type: 'offer',
              payload: { targetPeerId: peerId, sdp: pc.localDescription },
            }));
            break;
          }
          case 'answer': {
            if (pcRef.current && msg.payload.sdp) {
              await pcRef.current.setRemoteDescription(
                new RTCSessionDescription(msg.payload.sdp as RTCSessionDescriptionInit)
              );
            }
            break;
          }
          case 'ice-candidate': {
            if (pcRef.current && msg.payload.candidate) {
              await pcRef.current.addIceCandidate(
                new RTCIceCandidate(msg.payload.candidate as RTCIceCandidateInit)
              );
            }
            break;
          }
          case 'peer-left': {
            setIsConnected(false);
            break;
          }
          case 'error': {
            setError(msg.payload.message as string);
            break;
          }
        }
      };

      ws.onerror = () => {
        setError('WebSocket connection error');
      };

      ws.onclose = () => {
        setIsConnected(false);
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start hosting';
      setError(message);
    }
  }, [cleanup, createPeerConnection]);

  const joinRoom = useCallback(async (code: string) => {
    cleanup();
    setError(null);

    try {
      const ws = new WebSocket(SIGNALING_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join-room', payload: { code } }));
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'room-joined': {
            setRoomCode(code);
            const hostId = msg.payload.hostId as string;
            const pc = createPeerConnection(ws, hostId);
            pcRef.current = pc;
            break;
          }
          case 'offer': {
            const senderPeerId = msg.payload.senderPeerId as string;
            const pc = createPeerConnection(ws, senderPeerId);
            pcRef.current = pc;

            if (msg.payload.sdp) {
              await pc.setRemoteDescription(
                new RTCSessionDescription(msg.payload.sdp as RTCSessionDescriptionInit)
              );

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              ws.send(JSON.stringify({
                type: 'answer',
                payload: { targetPeerId: senderPeerId, sdp: pc.localDescription },
              }));
            }
            break;
          }
          case 'ice-candidate': {
            if (pcRef.current && msg.payload.candidate) {
              await pcRef.current.addIceCandidate(
                new RTCIceCandidate(msg.payload.candidate as RTCIceCandidateInit)
              );
            }
            break;
          }
          case 'peer-left': {
            setIsConnected(false);
            break;
          }
          case 'error': {
            setError(msg.payload.message as string);
            break;
          }
        }
      };

      ws.onerror = () => {
        setError('WebSocket connection error');
      };

      ws.onclose = () => {
        setIsConnected(false);
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join room';
      setError(message);
    }
  }, [cleanup, createPeerConnection]);

  const stop = useCallback(() => {
    cleanup();
    setRoomCode(null);
    setLocalStream(null);
    setRemoteStream(null);
  }, [cleanup]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    roomCode,
    localStream,
    remoteStream,
    isConnected,
    error,
    startHosting,
    joinRoom,
    stop,
  };
}
