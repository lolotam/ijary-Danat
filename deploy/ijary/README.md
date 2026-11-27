# IJARY — background stack

`docker-compose.yml` here runs the two containers that have no web front:

| Service  | What it is                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `redis`  | `redis:7.4-alpine`, `appendonly yes` on a named volume, no published port.                                                         |
| `worker` | Built from the repository `Dockerfile` with `target: worker`; runs `bun run src/worker/main.ts` and waits for Redis to be healthy. |

It does **not** run the web application or the Supabase stack — both are
deployed separately in Dokploy on the same host, and the worker reaches them
through `SUPABASE_URL`.

## Environment

The worker reads `deploy/ijary/.env.worker`, a file you create and never commit
(`.gitignore` already ignores `.env.*`). It holds values only; the names come
from `src/lib/env.server.ts`:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_PUBLISHABLE_KEY
SUPABASE_JWT_SECRET
INTEGRATIONS_MASTER_KEY
PLATFORM_ROOT_HOST
PLATFORM_ADMIN_HOST
CRON_SECRET
```

`REDIS_URL` is not one of them: the compose file sets it to `redis://redis:6379`.
The optional names (email, WhatsApp, MyFatoorah) are listed in the comment
above the `worker` service in the compose file.

## Deploying

Nothing here is deployed without the owner's explicit go-ahead at that moment.
The worker image comes from the repository `Dockerfile`, so deploy the web app
first and the worker once the queue and the migrations are in place.
