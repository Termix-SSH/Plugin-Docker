# Contributing to Docker

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run format     # format the code with Prettier
```

## Settings

### Host

- **Enable Docker:** show the Docker tab for this host
- **Container Runtime:** Docker or Podman

## Permissions

- `docker.use`: open the Docker manager and container consoles on hosts with Docker turned on. Admins and users have it by default.

## Services

Provides to other plugins:

- `docker.containers`: list containers and start, stop, restart, pause, unpause or remove them
- `docker.events`: get notified when a container starts, exits, restarts or turns unhealthy
