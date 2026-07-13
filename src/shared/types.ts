// PeerJS handles all signaling internally.
// These types are used for the data channel (mouse/keyboard control).

export interface ControlMessage {
  type: 'mouse-move' | 'mouse-click' | 'key-press' | 'key-release';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  key?: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  pressed?: boolean;
}