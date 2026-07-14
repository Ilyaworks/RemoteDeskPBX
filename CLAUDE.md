# CLAUDE.md — правила проекта RemoteDeskPBX

Приложение удалённого рабочего стола: два Electron-приложения + сигналинг/админ-сервер.

## Как работать
- Одна сессия = одна задача из `BACKLOG.md`. Перед стартом читай `BACKLOG.md`, `STATE.md`, `AGENTS.md`.
- Полный чек-лист старта — в `SESSION_PROMPT.md`.
- Тесты обязательны перед коммитом. После задачи: коммит + обнови `BACKLOG.md` + хэндофф в `STATE.md`.

## ⚠️ Два репозитория (самая частая ошибка)
- **Разработка:** `Ilyaworks/RemoteDeskPBX` (master) — весь код здесь.
- **Прод-сервер деплоит Render из ДРУГОГО репо:** `Ilyaworks/remotedeskpbx-server` (main), `npm start` → `node server.js`.
- Изменения сервера на прод: правь `server.js` здесь → скопируй в клон `remotedeskpbx-server` → `git push origin main`.
- Живой прод: `GET https://remotedeskpbx-server.onrender.com/` содержит `"server":"express-v2"`. Админка `/admin`, пароль `admin123`.
- `render-server/` в этом репо **gitignore'ится и НЕ деплоится** — не путать.

## Приложения
- **Client** (`src/main/client.ts` + `src/client/App.tsx`): хост, делится экраном+системным звуком (`getDisplayMedia audio:true` + handler `audio:'loopback'`), `/register` → 9-значный код.
- **Employee** (`src/main/employee.ts` + `src/employee/App.tsx`): сотрудник, `/join` по коду, управляет мышью/клавиатурой (nut-js).
- `src/renderer/` — старый UI, НЕ используется.
- Клиенты ходят на `https://remotedeskpbx-server.onrender.com`.

## Сборка и тесты
- `npm run build` — tsc + webpack (должно быть без ошибок).
- `npm run pack:client` / `pack:employee` / `pack` → portable `.exe` в `release/`. В `electron-builder.*.yml` обязателен `extraMetadata.main` (иначе оба берут `main` из package.json).
- `server.js`: `node --check server.js`; логику гонять локально (`PORT=39xx node server.js` + curl); админку проверять в браузере.
- Менял код приложения → пересобери соответствующий `.exe`.

## Грабли (журнал повторяющихся ошибок)
- **Экранирование в админ-HTML:** страница `/admin` отдаётся через `res.send(\`...\`)` (template literal). Экранированные одинарные кавычки в inline-обработчиках (`onclick="fn(\\'x\\')"`) должны быть `\\'` (двойной бэкслеш); одиночный `\'` схлопывается в `'` и ломает весь скрипт → белый экран, вход невозможен.
- **Контракт сигналинга:** `/join` возвращает `{type:'ok'}` (клиент проверяет `joinRes.type==='ok'`). Роуты: `/register /join /signal /poll/:role/:code /disconnect`.
- **Аудио:** для шаринга экрана НЕ передавай `echoCancellation/noiseSuppression` (это микрофонные, ломают loopback на Windows → «Could not start audio source»). Только `audio:true` + `audio:'loopback'`.
- **Скриншоты на Render:** диск эфемерный — сохранённые скриншоты пропадают при редеплое (для постоянного хранения нужен внешний storage).
