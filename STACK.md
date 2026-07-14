# RemoteDeskPBX — Полный стек технологий

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    RemoteDeskPBX (клиент)                     │
├─────────────────────────────────────────────────────────────┤
│  Frontend (React 18 + Webpack 5)                            │
│  ├─ App.tsx         — UI, WebRTC, data channel              │
│  ├─ index.tsx       — точка входа                           │
│  └─ index.html      — шаблон                                │
├─────────────────────────────────────────────────────────────┤
│  Прелоад (Electron IPC bridge)                              │
│  └─ preload.ts — каналы:                                    │
│       mouseMove(x,y) → ipcMain:mouse-move                   │
│       mouseClick(btn) → ipcMain:mouse-click                 │
│       mouseScroll(delta) → ipcMain:mouse-scroll             │
│       keyPress(keycode) → ipcMain:key-press                 │
├─────────────────────────────────────────────────────────────┤
│  Main Process (Electron + Node.js 22)                       │
│  └─ index.ts:                                               │
│       @nut-tree-fork/nut-js:                                │
│         mouse.setPosition({x,y})       ← перемещение        │
│         mouse.click(Button.LEFT/RIGHT) ← клик               │
│         mouse.scrollUp(1)/scrollDown(1) ← скролл            │
│         keyboard.pressKey(key) + releaseKey(key) ← клавиши  │
│       (троттлинг 60fps, async, без PowerShell)              │
├─────────────────────────────────────────────────────────────┤
│  Сервер (Node.js + Express, хостинг Render.com)              │
│  ├─ server.js  — регистрация комнат, polling, сигнализация  │
│  └─ rooms, 9-значные коды, keepalive                        │
├─────────────────────────────────────────────────────────────┤
│  WebRTC (P2P соединение)                                    │
│  ├─ desktopCapturer → getDisplayMedia() (screen share)      │
│  ├─ DataChannel (ordered:false, maxRetransmits:0)           │
│  ├─ STUN: stun.l.google.com:19302                           │
│  ├─ TURN: openrelay.metered.ca                              │
│  └─ Видео: 1280×720, 15fps                                  │
└─────────────────────────────────────────────────────────────┘
```

## Полный стек

| Категория | Технология | Версия | Назначение |
|-----------|-----------|--------|------------|
| **Язык** | TypeScript | 5.7 | Весь код |
| **Фреймворк** | Electron | 33 | Десктопное приложение |
| **UI** | React | 18 | Интерфейс |
| **Сборка main** | tsc (tsconfig.main.json) | — | Компиляция main process |
| **Сборка renderer** | Webpack 5 + ts-loader | — | Бандл renderer |
| **Управление ПК** | @nut-tree-fork/nut-js | 4.2.6 | Мышь, клавиатура (API) |
| **Управление ПК (низкий уровень)** | @nut-tree-fork/libnut | 4.2.6 | Native addon (C++) |
| **WebRTC** | navigator.mediaDevices + DataChannel | встроено | P2P видео + управление |
| **Сервер** | Node.js + Express + Fastify | — | Комнаты, сигнализация |
| **Сервер WS** | @fastify/websocket / ws | — | WebSocket для сигнализации |
| **Сервер Redis** | ioredis | — | Очереди сигналов |
| **Сервер логи** | pino + pino-pretty | — | Логи сервера |
| **Сборщик** | electron-builder | 25 | Упаковка .exe |
| **Размер бинарника** | portable .exe | — | **72 MB** |

## Лицензии зависимостей

| Пакет | Лицензия | Коммерческое использование | Свой товарный знак |
|-------|----------|---------------------------|-------------------|
| electron | **MIT** | ✅ Да | ✅ Можно |
| electron-builder | **MIT** | ✅ Да | ✅ Можно |
| react | **MIT** | ✅ Да | ✅ Можно |
| react-dom | **MIT** | ✅ Да | ✅ Можно |
| @nut-tree-fork/nut-js | **Apache 2.0** | ✅ Да | ✅ Можно |
| @nut-tree-fork/libnut | **Apache 2.0** | ✅ Да | ✅ Можно |
| @nut-tree-fork/shared | **Apache 2.0** | ✅ Да | ✅ Можно |
| typescript | **Apache 2.0** | ✅ Да | ✅ Можно |
| webpack | **MIT** | ✅ Да | ✅ Можно |
| ts-loader | **MIT** | ✅ Да | ✅ Можно |
| html-webpack-plugin | **MIT** | ✅ Да | ✅ Можно |
| css-loader | **MIT** | ✅ Да | ✅ Можно |
| style-loader | **MIT** | ✅ Да | ✅ Можно |
| concurrently | **MIT** | ✅ Да | ✅ Можно |
| fastify | **MIT** | ✅ Да | ✅ Можно |
| @fastify/websocket | **MIT** | ✅ Да | ✅ Можно |
| ioredis | **MIT** | ✅ Да | ✅ Можно |
| pino | **MIT** | ✅ Да | ✅ Можно |
| pino-pretty | **MIT** | ✅ Да | ✅ Можно |
| ws | **MIT** | ✅ Да | ✅ Можно |
| @types/react | **MIT** | ✅ Да | ✅ Можно |
| @types/react-dom | **MIT** | ✅ Да | ✅ Можно |
| @types/ws | **MIT** | ✅ Да | ✅ Можно |
| peerjs | **MIT** | ✅ Да | ✅ Можно |

## Итог

- **Все лицензии** — MIT или Apache 2.0
- **Никаких GPL/AGPL** (которые требуют открыть свой код)
- **Можно продавать** коммерческому клиенту
- **Можно ставить свой логотип и название**
- **Нельзя удалять** лицензионные файлы из node_modules (это делает electron-builder автоматически)

## Команды

```bash
npm run build:main     # tsc main process
npm run build:renderer # webpack renderer
npm run build          # обе сборки
npm run pack           # сборка + .exe
npm start              # сборка + запуск
```

## Файл сборки

```
C:\RemoteDeskPBX\release\RemoteDeskPBX-v3.exe
Размер: 72 MB
Тип: portable (без установки)