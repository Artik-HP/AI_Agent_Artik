# AGENTS.md

Краткие инструкции для coding-агентов в репозитории AI_Agent_Artik.

## Scope

- Применяется ко всему репозиторию.
- Изменяй только файлы, напрямую затронутые задачей. Не переименовывай переменные, не меняй форматирование и не выноси код в новые функции, если это не требуется для выполнения задачи.
- Перед изменениями в логике агента проверяй влияние и на CLI, и на Telegram режимы.
- При расхождении между AGENTS.md и README.md считай README.md источником истины для env-переменных и пользовательских команд, а AGENTS.md - для архитектурных ограничений и соглашений по коду.

## Start Here

1. Прочитай [README.md](README.md) для запуска, переменных окружения и списка пользовательских команд.
2. Быстрый обзор точки входа: [index.js](index.js).
3. Основная бизнес-логика: [src/agent.js](src/agent.js).
4. Роутинг инструментов: [src/routerAgent.js](src/routerAgent.js).
5. Реестр инструментов: [src/tools/index.js](src/tools/index.js).

## Run And Check

- Установка: npm install
- CLI режим: npm start
- Telegram режим: npm run telegram
- Тесты: npm test
- Линт (скрипт не задан): npx eslint .

## Architecture Boundaries

- [index.js](index.js): выбор режима запуска и bootstrap.
- [src/agent.js](src/agent.js): обработка сообщений, команды, память, вызов роутера/инструментов.
- [src/routerAgent.js](src/routerAgent.js): LLM-роутер, ожидает валидный JSON {tool,input}.
- [src/tools/index.js](src/tools/index.js): единый реестр инструментов формата { description, run }.
- [src/model.js](src/model.js): запросы к OpenRouter.
- [src/memory.js](src/memory.js) + [src/database.js](src/database.js): долговременная память (PostgreSQL при DATABASE_URL, иначе файловый fallback).
- [src/telegram.js](src/telegram.js): Telegram-специфика (кнопки, voice/audio, разбиение сообщений).

## Project Conventions

- JavaScript + ES Modules (package.json содержит type: module).
- Предпочтительно async/await; избегать смешивания с .then() без необходимости.
- Язык пользовательских сообщений и ошибок: русский.
- Для публичных функций в src обычно используется JSDoc-типизация.
- Инструменты добавляются отдельными файлами в [src/tools/](src/tools) и регистрируются в [src/tools/index.js](src/tools/index.js).

## Safe Change Patterns

- Новая команда/инструмент:
  1. Реализуй модуль в [src/tools/](src/tools).
  2. Зарегистрируй в [src/tools/index.js](src/tools/index.js) (description + run).
  3. При необходимости обнови эвристику в [src/routerAgent.js](src/routerAgent.js).
  4. Проверь сценарии в CLI и Telegram.
- Изменение памяти:
  - Не ломай fallback на [memory.json](memory.json), если DATABASE_URL не задана.
- Изменение моделей/LLM:
  - Учитывай обязательность OPENROUTER_API_KEY и обработку ошибок в [src/model.js](src/model.js).

## Pitfalls

- Невалидный JSON из роутера должен безопасно падать в route none.
- Изменения в [src/agent.js](src/agent.js) почти всегда влияют сразу на 2 интерфейса (CLI + Telegram).
- Не дублируй справку по env/командам из [README.md](README.md); при необходимости добавляй только ссылку.

## PR Checklist For Agents

- Запускал npm test после изменений в логике.
- Прогнал npx eslint . при изменениях JS-файлов.
- Не изменял формат и поведение пользовательских команд без явной необходимости.
- Проверил, что новые/измененные сообщения на русском и понятны пользователю.
