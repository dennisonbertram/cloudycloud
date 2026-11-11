# Worker image

`worker.Dockerfile` is the container the self-hosted provider runs each subagent in: node 22, git, gh, tmux,
curl, python3, uv, pinned `@anthropic-ai/claude-code`, and a non-root user `worker` (uid 1000, home
`/home/worker`). pi and omp are installed per worker by the core. It holds no secrets and has no entrypoint.

`cloudy-cloud setup --provider self-hosted` builds it on your machine as `cloudy-cloud-worker:<version>`. To
rebuild by hand: `docker build --build-arg VERSION=$(node -p "require('./package.json').version") -t cloudy-cloud-worker:$(node -p "require('./package.json').version") -f docker/worker.Dockerfile .`

The image label `cloudy-cloud.image` holds that version; the adapter refuses to start a container whose label
differs from the package version.

Check: `docker build --build-arg VERSION=test -t cc-worker-test -f docker/worker.Dockerfile . && docker run --rm --user worker cc-worker-test sh -c 'node -v && git --version && gh --version && tmux -V && claude --version && uv --version && timeout --version && base64 --version && id -u'`
