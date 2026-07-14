# RemoteDeskPBX

## Репозиторий
- GitHub: https://github.com/Ilyaworks/remotedeskpbx-server (RemoteDeskPBX)
- Ветка: master

## Стек
- Node.js 22, TypeScript 5, React 18
- Electron 33 + @nut-tree-fork/nut-js (мышь/клавиатура, без PowerShell)
- Webpack 5, ts-loader
- Fastify + Express (сервер, Render.com)
- ioredis (Redis)
- electron-builder (portable .exe)

## Сборка
```bash
npm run build:main     # tsc main process
npm run build:renderer # webpack renderer
npm run build          # обе сборки
npm run pack           # сборка + .exe
npm start              # сборка + запуск
```

## Текущий билд
- `release/RemoteDeskPBX-v3.exe` — 72 MB, portable

## Следующие задачи
- [ ] Разделить на два приложения: Client (хост) и Employee (сотрудник с авторизацией)
- [ ] Сервер: админ-панель (управление сотрудниками, сессии, скриншоты)
- [ ] Сервер: статистика сессий (начало/конец/длительность)
- [ ] Автоматические скриншоты каждые 30 сек
- [ ] Чат через DataChannel
- [ ] Индикатор стабильности соединения (RTT, потери пакетов)
- [ ] Передача звука