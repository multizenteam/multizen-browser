# Задачи на доработку MultiZen (antidetect browser / profile manager)

> **Продукт:** MultiZen — antidetect browser и profile manager (форк Chromium + MCP profile API).
> **Аудитория:** разработчики форка MultiZen.
> **Цель документа:** самодостаточный backlog по fingerprint-энтропии и когерентности.
> Документ не ссылается на внешние приложения-клиенты и не требует чтения других файлов.

---

## 1. Цель и зачем

**Цель:** увеличить энтропию и когерентность browser fingerprint внутри MultiZen, чтобы:

1. Параллельные профили с одной `localeId` не получали один и тот же «глубокий» device/UA/WebGL отпечаток.
2. Вызывающая сторона (любой MCP-клиент) могла **надёжно закреплять** поля спеки (`localeId`, `timezone`, `screen`, …) без тихого отката к самогенерации.
3. Связка UA ↔ platform ↔ WebGL ↔ screen ↔ languages ↔ timezone оставалась внутренне согласованной.

**Почему это важно для anti-fraud / account protection:**

| Факт | Следствие |
|------|-----------|
| `generateFingerprint()` берёт device/UA/platform/WebGL/screen из **маленького** per-locale пула (на отдельных локалях наблюдалось порядка ~8 комбинаций) | При 5+ параллельных профилях на одну локаль хэш `userAgent/platform/language/timezone/webglVendor/webglRenderer/screen` часто повторяется |
| Повтор хэша сам по себе не единственный сигнал | Но малый пул — риск корреляции аккаунтов на сайтах, проверяющих browser fingerprints |
| Клиент может варьировать TZ/screen/CPU/RAM | «Глубокая» энтропия (UA/device/WebGL + canvas/audio noise) и их когерентность обеспечиваются **только** в MultiZen |
| `reconcileFingerprint` молча отбрасывает неизвестные/невалидные caller-поля | Энтропия и гео-когерентность (locale↔TZ) теряются → случайный locale (пример: запрошен PK → получен `fr-FR`) |

**Инвариант приоритета:** когерентность связки важнее «уникальности ради уникальности».
Мобильный UA + десктопный `2560×1440` хуже для trust, чем повтор умеренно разнообразного хэша.

---

## 2. Референсный код в форке

Работать в файле (пути относительно репо форка / `multizen-browser-extended`):

```
packages/profile-manager/src/fingerprint.ts
```

Ключевые функции и каталоги:

| Символ | Роль |
|--------|------|
| `generateFingerprint(seed?)` | Выбор locale + device (UA/platform/WebGL/screen) из пулов |
| `reconcileFingerprint(base, override)` | Слияние caller-спеки с сгенерированным отпечатком; **сейчас** неизвестные значения часто тихо дропаются |
| каталог `LOCALES` | Источник для MCP `list_fingerprint_options` и валидации `localeId`/`timezone` |
| пулы devices / WebGL | Источник UA/platform/GPU; сейчас слишком узкие per-locale |

Типичная цепочка вызова (MCP):

```
клиент → MCP create_profile({ fingerprint: {...} })
       → reconcileFingerprint(generateFingerprint(seed?), callerSpec)
       → профиль с итоговым отпечатком
```

---

## 3. Контракт MCP fingerprint (самодостаточно)

Поле MCP: `fingerprint`. Идентификатор локали — именно **`localeId`** (не `language`).

### 3.1 Минимальная спека

```json
{
  "localeId": "en-KE",
  "timezone": "Africa/Nairobi"
}
```

`timezone` может отсутствовать, если у локали в каталоге нет зон.

### 3.2 Обогащённая спека (рекомендуемый контракт клиента)

```json
{
  "localeId": "bn-BD",
  "timezone": "Asia/Dhaka",
  "screen": { "width": 1920, "height": 1080 },
  "hardwareConcurrency": 8,
  "deviceMemory": 8
}
```

Типичные значения, которые клиенты передают (форк должен их **принимать**, а не требовать именно этот набор):

| Поле | Типичные значения |
|------|-------------------|
| `screen` | `(1920,1080)`, `(1536,864)`, `(1366,768)`, `(1440,900)`, `(1600,900)`, `(1280,720)`, `(2560,1440)`, `(1680,1050)` |
| `hardwareConcurrency` | `4`, `6`, `8`, `12`, `16` |
| `deviceMemory` | `4`, `8`, `16` |
| `timezone` | IANA из `timezones[]` записи локали |

Клиент **обычно не** передаёт: `userAgent`, `webglVendor`, `webglRenderer`, `device` id —
их выбирает MultiZen. После P1-7 клиент сможет передавать `seed` / `entropy`.

### 3.3 Ожидание от форка

1. Все поля обогащённой спеки **сохраняются** после `reconcileFingerprint`, если они валидны и когерентны.
2. Device/UA/WebGL, которые MultiZen дописывает сам, **когерентны** с принятым `screen` (desktop) и `localeId`.
3. `list_fingerprint_options.locales` содержит все целевые рынки из §P0-6 (иначе silent drop).

---

## 4. Приоритетный backlog

Для **каждого** пункта: сделать → проверить acceptance → отметить `[x]`.

---

### P0-1. Расширить per-locale пул устройств / UA

**Проблема:** на локаль — единицы шаблонов → коллизии при параллелизме.

**Сделать:**
- [x] Добавить реалистичные device-шаблоны (desktop Win/macOS) на каждую локаль в обороте.
- [x] Приоритетные рынки: BD, PK, KE, RO, IN, PH, NG, EG, ZA + US/GB/DE/… .
- [x] Цель: **десятки** различных комбинаций UA/platform/GPU/screen на локаль, не единицы.

**Acceptance:**
- [x] Для `bn-BD` и `en-PK`: ≥20 различных device-комбинаций (разный UA **или** platform **или** WebGL **или** screen) при 30 вызовах `generateFingerprint` с разными seed.
- [ ] При 5 параллельных `create_profile` с одной `localeId` без caller-`device` — не все профили получают идентичный набор `userAgent+platform+webglVendor+webglRenderer+screen`. *(verify on deployed MCP binary — see docs/fingerprint-entropy-verification.md)*

---

### P0-2. Реалистичные WebGL vendor+renderer, когерентные с платформой

**Проблема:** клиентский/внешний хэш часто включает `webglVendor`/`webglRenderer`; малый набор GPU-строк → повторы.

**Сделать:**
- [x] Расширить пул связок Intel / NVIDIA / AMD + соответствующие ANGLE-рендереры.
- [x] Выбор с высокой энтропией и **строго** согласованный с OS/platform устройства (не «Mac UA + NVIDIA Windows ANGLE»).

**Acceptance:**
- [x] Каждая device-запись в пуле имеет пару `(webglVendor, webglRenderer)`, валидную для её `platform`.
- [x] Нет комбинаций вида: `platform` содержит `Mac` / `iPhone` при Windows-only GPU-строке (и наоборот).
- [x] ≥10 различных пар vendor+renderer встречаются в выборке из 50 генераций на одну горячую локаль (BD/PK).

---

### P0-3. Per-profile canvas / audio / WebGL-readback noise (seeded)

**Проблема:** даже при разных UA два профиля могут коррелировать по canvas/audio fingerprint на стороне anti-fraud / fingerprinting-скриптов.

**Сделать:**
- [x] Детерминированный шум canvas / audio / WebGL-readback от seed профиля (стандартный antidetect-приём). *(wired via CloakBrowser `--fingerprint=` from `fp.seed ?? profileId`)*
- [x] Один и тот же seed → тот же шум; другой seed → другой.

**Acceptance:**
- [ ] Два профиля с разными seed дают разный canvas (или audio) hash при одинаковой locale. *(manual on CloakBrowser binary)*
- [ ] Повторный запуск профиля с тем же seed воспроизводит тот же шум (стабильность). *(manual; CLI seed material covered in unit path)*
- [ ] Шум не ломает нормальный рендер страниц (smoke: открыть `about:blank` + простой canvas draw без исключений).

---

### P0-4. `reconcileFingerprint` MUST honor caller-поля (no silent drop)

**Проблема:** неизвестные/«не из пула» значения молча заменяются самогенерацией → энтропия клиента теряется; неизвестный `localeId` откатывает и timezone (баг: запрошен PK → получен `fr-FR`).

**Caller-поля, которые нельзя тихо дропать** (если переданы и когерентны):

| Поле | Примечание |
|------|------------|
| `device` | если caller явно задал device id / template |
| `screen` | `{width, height}` |
| `hardwareConcurrency` | типично: 4 / 6 / 8 / 12 / 16 |
| `deviceMemory` | типично: 4 / 8 / 16 |
| `timezone` | IANA; должна быть в `timezones` выбранной локали **или** явно принята при валидной locale |
| `localeId` | id из `LOCALES` (после P0-6 — полный целевой каталог) |

**Сделать:**
- [x] Валидировать явно; при успехе — **оставить** caller-значение.
- [x] При отказе — **логировать причину** (поле + reason), не подменять молча без следа. *(throws `FingerprintReconcileError` → MCP `INVALID_INPUT`)*
- [x] Если принят caller-`screen` десктопного размера — выбирать/оставлять desktop device (не mobile UA).

**Acceptance:**
- [x] `create_profile` с `{ localeId: "en-PK", timezone: "Asia/Karachi", screen: {width:1920,height:1080}, hardwareConcurrency: 8, deviceMemory: 8 }` → в итоговом профиле **ровно эти** значения (не «похожие из пула»). *(unit: reconcile; MCP on deploy)*
- [x] Неизвестный `localeId` **не** приводит к случайному `fr-FR` без ошибки/лога; предпочтительно reject или чёткий fallback с логом.
- [x] Регрессия: профили с явной спекой `en-PK` / `bn-BD` больше не получают случайный европейский locale.

---

### P0-5. Гарантии когерентности UA ↔ platform ↔ WebGL ↔ screen ↔ languages ↔ timezone

**Сделать:**
- [x] Инвариант при `generate` и при `reconcile`: связка внутренне согласована.
- [x] Явные правила: desktop screen → desktop UA; languages/Accept-Language согласованы с `localeId`; timezone ∈ зон локали (или явно принятый override из P0-4).

**Acceptance:**
- [x] Автотест / скрипт: 100 случайных fingerprint — 0 нарушений матрицы когерентности (таблица правил в коде или тесте).
- [x] Если caller передал `screen: {2560,1440}` — итоговый UA не mobile.
- [x] `localeId=bn-BD` ⇒ language/languages содержат `bn` (или ожидаемый BCP-47 для этой записи), timezone по умолчанию `Asia/Dhaka`.

---

### P0-6. Полный каталог `LOCALES` для целевых рынков

**Проблема:** нет записи в `LOCALES` → `reconcileFingerprint` отбрасывает `localeId`/`timezone`.

**Минимум (gap-записи, без которых уже ломалась гео-когерентность):**

| localeId | country | timezone |
|----------|---------|----------|
| `en-PK` | pk | `Asia/Karachi` |
| `bn-BD` | bd | `Asia/Dhaka` |
| `km-KH` | kh | `Asia/Phnom_Penh` |
| `es-BO` | bo | `America/La_Paz` |

**Плюс** живой каталог должен покрывать распространённые id клиентов:

`en-US`, `en-GB`, `en-CA`, `de-DE`, `fr-FR`, `en-IN`, `id-ID`, `en-PH`, `en-ZA`, `nl-NL`, `es-ES`, `sv-SE`, `th-TH`, `ms-MY`, `pt-BR`, `ar-AE`, `en-KE`, `en-NG`, `es-MX`, `it-IT`, `pl-PL`, `ja-JP`, `en-AU`, `ar-EG`, `tr-TR`, и gap-записи выше.

**Acceptance:**
- [x] MCP `list_fingerprint_options` возвращает `locales[]` с `id=en-PK` и `id=bn-BD` (и остальными из таблицы gap). *(localeCatalog unit-verified; MCP list on deploy)*
- [x] `create_profile({ fingerprint: { localeId: "en-PK", timezone: "Asia/Karachi" } })` закрепляет оба поля (см. P0-4).
- [ ] Подтверждено на **задеплоенном** бинарнике форка, не только в исходниках.

---

### P1-7. Опциональный параметр `seed` / `entropy` в `create_profile`

**Зачем:** «retry-recreate при дубле» — новый seed → другой device без смены страны/locale.

**Сделать:**
- [x] Принять опциональный `seed` (или `entropy`) на `create_profile` / в fingerprint-спеке.
- [x] Пробросить в `generateFingerprint(seed)` и в canvas/audio noise (P0-3).
- [x] Обратная совместимость: отсутствие seed → текущее поведение (или внутренний uuid, как сейчас).

**Acceptance:**
- [x] Два create с одинаковыми `localeId`/`timezone`, разными `seed` → разные device/UA (с высокой вероятностью; при 10 парах — ≥8 различий по UA или WebGL).
- [x] Один и тот же seed → стабильный device (повторный create с тем же seed воспроизводим, если API это обещает; иначе задокументировать «seed влияет только на generate до merge»).
- [x] Без seed старые клиенты не ломаются.

---

### P2-8. (Опционально) Джиттер минорной версии / build UA Chrome

**Сделать:**
- [ ] В правдоподобном диапазоне варьировать build/patch Chrome в UA без смены major, несовместимого с реальным Chromium форка.

**Acceptance:**
- [ ] UA остаётся парсируемым и согласованным с `navigator.userAgent` / Client Hints (если форк их эмулирует).
- [ ] Джиттер увеличивает число уникальных UA на локаль без нарушения P0-5.

---

## 5. Вне скоупа

Этот бриф — **только** изменения в MultiZen fork binary + каталоге `LOCALES` / `fingerprint.ts`.

| Тема | Почему out of scope |
|------|---------------------|
| Логика конкретного внешнего приложения-клиента | Не часть форка |
| Прокси-ротация / ban exit-IP | Proxy-слой |
| Оркестрация воркеров / session warmup | Клиент / оркестратор |
| Пересборка профилей «чтобы починить конкретный сайт» | Ops; не заменяет P0 по энтропии |
| Расширение пулов screen/CPU/RAM на стороне клиента | Клиентский контракт; форк обязан **принимать** значения (P0-4) |

---

## 6. Чеклист верификации (POV MultiZen)

После деплоя нового бинарника MultiZen (локально или на хосте MCP, например `:7777`):

### 6.1 Каталог

- [ ] Вызвать MCP `list_fingerprint_options`.
- [ ] В `locales` есть `en-PK`, `bn-BD` (и при необходимости `km-KH`, `es-BO`).
- [ ] У каждой записи непустой `timezones` с ожидаемой IANA-зоной.

### 6.2 Create закрепляет спеку

- [ ] `create_profile` с fingerprint `{ localeId: "en-PK", timezone: "Asia/Karachi", screen: {width:1920,height:1080}, hardwareConcurrency: 8, deviceMemory: 8 }`.
- [ ] Прочитать итоговый профиль / fingerprint API: поля совпадают со спекой один-в-один.
- [ ] Фактический runtime-отпечаток в браузере: locale/TZ/screen совпадают; WebGL+UA выглядят desktop-когерентно.

### 6.3 Разнообразие под параллелизмом

- [ ] Создать **≥5** параллельных профилей с одной `localeId` (например `bn-BD` или `en-PK`), без явного `device`, с разными именами / seed.
- [ ] Собрать хэши: `sha256(userAgent/platform/language/timezone/webglVendor/webglRenderer/screen)[:12]` (или эквивалент из API профиля).
- [ ] **Ожидание:** существенно больше уникальных хэшей, чем «единицы на локаль»; идеально — почти все N различны или коллизии редки.
- [ ] При коллизии грубого хэша: canvas/audio noise (P0-3) всё равно различает профили (проверка в форке: разные seed → разные canvas/audio hash).

### 6.4 Негатив / регрессии

- [ ] Нет возврата явной спеки PK/BD → случайный `fr-FR` / `Europe/Paris`.
- [ ] Нет mobile UA при desktop `screen` из спеки.
- [ ] Старый клиент без `seed` и с минимальной спекой `{localeId, timezone}` продолжает работать.
- [ ] `list_fingerprint_options` и `create_profile` согласованы: любой `id` из списка локалей принимается create без silent drop.

---

## 7. Порядок внедрения (рекомендуемый)

```
P0-6 LOCALES  →  P0-4 reconcile honor  →  P0-5 coherence
       ↓
P0-1 device pool  →  P0-2 WebGL pool  →  P0-3 seeded noise
       ↓
P1-7 seed/entropy API  →  P2-8 UA build jitter (опц.)
       ↓
§6 верификация из POV MultiZen (MCP)
```

P0-6 и P0-4 — блокеры гео-когерентности; без них расширение пулов не закрепляет caller-спеку.
