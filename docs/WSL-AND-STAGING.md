# Optional setups: WSL and staging

These are not needed to run the app. They cover two setups that come up often.

## Postgres already running in WSL

If Postgres runs natively in WSL and you don't want Docker Desktop, start only
the gateway, from inside WSL:

```bash
sudo docker compose -f docker-compose.wsl.yml --env-file .env up -d
```

`WEBHOOK_TARGET` must then use the Windows host IP as seen from WSL, not
`localhost`. That IP changes every time WSL restarts. Check it with:

```bash
wsl -e bash -lc "ip route show default | awk '{print \$3}'"
```

## A separate staging environment

Staging runs next to your normal setup with its own database (port 5433), its
own login secret, and the mock gateway instead of a real WhatsApp account.

```bash
cp .env.staging.example .env.staging   # fill in the values marked <...>
npm run staging:up        # staging Postgres in Docker
npm run staging:migrate
npm run staging:seed
npm run staging:gateway   # mock gateway on port 8099, in its own terminal
npm run staging:dev       # app on http://127.0.0.1:3200
```

`.env.staging` is loaded only by `scripts/staging.mjs`, never by a plain
`npm run dev`, so the two environments cannot mix by accident.
