# hyperlane-mint

## Как запустить
Для работы требуется установленный Node.js v18 или выше (https://nodejs.org/en/download)

Нужно открыть CMD, перейти в папку с софтом и выполнить следующие команды:

Установка зависимостей
```bash
npm install
```

Запуск
```bash
npm start
```

## Настройки data/config.json

По умолчанию скрипт настроен на вывод монет в сети BSC (ChainID 56).\
Если монеты уже в этой сети и для кошелька указан адрес вывода, то все монеты будут отправлены на него.\
Если монеты в другой сети, то будут отправлены на адрес вывода через мост в указанной сети.

Также обязательно нужно указать `SOLVIUM_API_KEY`, для обхода защиты vercel при получении аллокации.

## Формат кошельков в data/wallets.txt

Адрес для вывода опциональный, если его указать софт выведет все монеты на него после клейма.

```txt
privateKey:withdrawAddress

// Пример

0x0000001
0x0000002:0x0000003
```

## Формат прокси в data/proxies.txt

Прокси опциональные и нужны только для загрузки аллокации с claim.hyperlane.foundation

```txt
http://user:pass@127.0.0.1:1234
ИЛИ
127.0.0.1:1234:user:pass
```

## Как изменить RPC?
В файле main.js сверху есть переменная `PROVIDERS`, по умолчанию используется `publicnode.com`.
