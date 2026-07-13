export type SignalMessageType = 'create-room' | 'room-created' | 'join-room' | 'room-joined' | 'peer-joined' | 'offer' | 'answer' | 'ice-candidate' | 'error' | 'peer-left';
export interface SignalMessage {
    type: SignalMessageType;
    payload: Record<string, unknown>;
}
export interface RoomInfo {
    code: string;
    hostId: string;
    viewerId: string | null;
    createdAt: number;
}
//# sourceMappingURL=types.d.ts.map