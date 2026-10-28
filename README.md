# PulseSync Addon Template

Шаблон React-аддона для PulseSync на TypeScript, Vite и `@pulsesync/addon-sdk`.

## Быстрый старт

Требования: Node.js 20.19+ в ветке 20.x либо 22.12+, Yarn, актуальные версии PulseSync и мода.

```bash
yarn install
yarn dev
```

Откройте PulseSync и Яндекс Музыку. `yarn dev` собирает, устанавливает и обновляет аддон при изменениях.

## Структура проекта

- `addon.config.mjs`: метаданные аддона, `allowedUrls` и параметры сборки. Укажите свои `id` и `directoryName`.
- `src/main.tsx`: логика и интерфейс.
- `src/settings.ts`: настройки, доступные через `settings.use()`.
- `addon/`: статические файлы.
- `vite.config.ts`: сборка через SDK.

## Редактор проекта

В PulseSync откройте меню аддонов (⋯), выберите **Открыть проект** и укажите корневую папку шаблона.
Нужна версия клиента с поддержкой редактора проектов.

Если вы указаны автором установленного аддона, кнопка **Редактировать проект** доступна прямо в его карточке.
Выберите папку исходников один раз: клиент запомнит её для этого аддона. Если папка перемещена, выберите её заново.

По умолчанию метаданные хранятся в `addon.config.mjs`: редактор сохраняет правки прямо в этот файл.
При желании их можно вынести в `addon.manifest.json` и импортировать в `addon.config.mjs`.
Если есть `addon.manifest.json`, редактор читает и сохраняет метаданные в нём.

Во вкладке **Метаданные** можно менять название, авторов, версию, теги, зависимости, разрешённые URL и совместимость.
Выбранные изображения копируются в `addon/Assets/`, а данные сохраняются в выбранном формате метаданных.
Описание и патчноуты редактируются в Markdown с предпросмотром и сохраняются в `addon/README.md` и `addon/CHANGELOG.md`.

Если запущен `yarn dev`, сохранение запускает обычную пересборку и доставку аддона в клиент.
Настройки пока объявляются в `src/settings.ts`.

## Минимальный аддон

```tsx
import { defineAddon, IconButton, notifications } from '@pulsesync/addon-sdk'

import addonConfig from '../addon.config.mjs'

function PlayerButton() {
    return (
        <IconButton
            icon="info"
            label="Показать уведомление"
            onClick={() => notifications.info('Аддон работает')}
        />
    )
}

export default defineAddon({
    id: addonConfig.id,
    slots: { playerBarButton: PlayerButton },
})
```

React предоставляет WebHost, `createRoot()` не нужен. Вызывайте сервисы SDK в обработчиках, компонентах или `start`. Подробнее: [документация SDK](https://www.npmjs.com/package/@pulsesync/addon-sdk).

## Команды

| Команда | Действие |
| --- | --- |
| `yarn dev` | Разработка с автообновлением |
| `yarn build` | Сборка в `dist/<directoryName>` без установки |
| `yarn sync` | Установка сборки с сохранением настроек |
| `yarn build:sync` | Сборка и установка |
| `yarn format` | Форматирование |

Другой каталог установки можно задать через `PULSESYNC_ADDONS_DIR`.

## Локальные модули

Каждый модуль хранится в своей папке:

```text
modules/
  formatter/
    index.ts
  calculator/
    Cargo.toml
    src/lib.rs
```

Шаблон распознаёт TS/JS по `index.ts` или `index.js`, Rust/WASM по `Cargo.toml`. Имя папки используется при загрузке через SDK.

`yarn dev` собирает и обновляет модули автоматически. Публикация не нужна; в архив аддона локальные модули не входят.

Пример и настройка Rust: [examples/module-demo](./examples/module-demo).

## Лицензия

PulseSync Addon Development License 1.1: [русский текст](./LICENSE.ru.md) · [English](./LICENSE). При расхождениях применяется русская версия в пределах, допускаемых законом.

Copyright © 2026 Матвиенко Артём Евгеньевич.
Все права защищены.
