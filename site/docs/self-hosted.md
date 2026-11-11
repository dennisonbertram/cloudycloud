# Run on your own machine

> Run Cloudy Cloud subagents in Docker containers on a Mac or Linux computer you own, reached over SSH or Tailscale.

Source: https://cloudycloud.tech/docs/self-hosted.html

Instead of Instabox, subagents can run in Docker containers on a computer you own, such as a Mac Studio or a Linux server. Cloudy Cloud reaches it over SSH. Tools, branches and follow-ups work the same way.

## How it works

Set `CLOUDY_CLOUD_PROVIDER=self-hosted` (setup does this). Each subagent gets its own container on the machine, named `cc-<id>`, started from a worker image that setup builds there. Cloudy Cloud runs every command through one shared SSH connection and uses `docker exec` inside the container. The reaper that deletes a session's machines also removes that session's containers.

> Warning: On your own machine there is no proxy to hide the GitHub token. If you allow it, the token is stored inside each worker container for as long as it runs. See The GitHub token.

## What the machine needs

### A Mac

- **Remote Login.** Turn it on in System Settings, General, Sharing. This is the macOS SSH server.
- **An SSH key.** Remote Login with a key needs your public key in `~/.ssh/authorized_keys` on the Mac. Cloudy Cloud never asks for a password (it runs `ssh` with `BatchMode=yes`). Test with `ssh user@host true`.
- **Tailscale**, on the Mac and on your computer, so you can reach the Mac by its Tailscale name or `100.x` address from anywhere. Tailscale's own SSH server runs only on Linux, so on a Mac you use Remote Login with a key over the tailnet.
- **Docker Desktop or OrbStack.** Open it once so its engine is running. Setup looks for the `docker` program and saves its full path, because a non-interactive SSH session on a Mac does not have `/opt/homebrew/bin` on its `PATH`.
- **No sleep.** A sleeping Mac stops every subagent on it. In System Settings, Battery (or Energy), turn on "Prevent automatic sleeping when the display is off", or run `sudo pmset -a sleep 0` on the Mac. Doctor warns when the Mac is set to sleep.

### Linux

- Docker (or Podman) installed and running. Setup finds `docker` first and `podman` second.
- SSH access with a key, or Tailscale SSH (`sudo tailscale up --ssh`), in which case you need no key.

Either way, about 20 GB of free disk is expected for the worker image and containers. Setup and doctor warn below that.

## Run setup

```
cloudy-cloud setup --provider self-hosted
```

Without `--provider`, the installer asks "Where should subagents run?" and you type 2. Setup then asks, in order:

1. **SSH address** (`user@host`), for example `me@mac-studio`.
2. **Path to your SSH key**, optional. Press Enter to use your default keys or Tailscale SSH.
3. **How many subagents may run at once.** The suggestion is half the CPUs or one per 4 GB of memory, whichever is lower, and at least 1. On a Mac the container VM's own CPU and memory limit counts if it is lower than the Mac's.
4. **Allow the GitHub token on the machine?** Default is no. If you say yes, it asks you to paste a token. Nothing shows as you paste.

Between the questions it checks SSH, sleep (Mac), the container runtime and free disk, then builds the worker image `cloudy-cloud-worker:<version>` on the machine. The first build takes several minutes. It then saves the settings to `~/.config/cloudy-cloud/env` (mode 600). Run setup again after you update Cloudy Cloud, because the image version must match.

## The GitHub token

Subagents need a GitHub token to push their branches. On Instabox the token never reaches the machine. On your own machine it has to. If you answer yes at setup:

- The token is saved as `GH_TOKEN` in the config file, and `CLOUDY_CLOUD_SELF_HOSTED_TOKEN_ON_BOX=yes` records your consent.
- For each worker, the token is written over SSH standard input into a file on a memory-only filesystem inside the container (`/run/secrets/env`, mode 600). It is not in a command line, a container label or `docker inspect`, and it disappears with the container.
- Every `cloud_agent` reply says `GitHub token: on your machine <host> (you allowed it)`.

If you answer no, workers will not start, because they could not push. A subagent that runs on the machine can read the token while it runs, and it can push to any branch the token reaches. Use a fine-grained token limited to the repositories subagents may push to, and protect your main branch. Allow the token only on a machine you own and trust.

## Check the machine

```
cloudy-cloud doctor
```

Doctor checks the saved machine and prints one line per check, marked `ok`, `warn` or `fail`, with a `fix:` line under each problem. It exits with status 1 if any check fails. If the provider is not `self-hosted` it says so and checks nothing. It covers:

- SSH reachability and how long it took. A slow answer may mean Tailscale check mode is asking you to sign in again. Give the machine an "accept" rule or a longer `checkPeriod` in the Tailscale admin console, or use a normal key.
- Sleep settings, on a Mac.
- The container runtime, its path and version. A rootless Podman gets a warning that limits may not apply.
- Free disk, with a warning under 20 GB.
- The worker image, and whether its version matches Cloudy Cloud.
- Capacity: whether your slot count is above what the machine suggests.
- Running Cloudy Cloud containers, and a warning for any that is past its deadline, with the command to remove it.
- Saved settings: the container path, the slot count, and the GitHub token consent.

## Slots and sizing

The number of subagents at once is `CLOUDY_CLOUD_SELF_HOSTED_SLOTS`. Past it, a new subagent waits with the status `queued` and starts when one ends. Setup also saves a per-container limit that splits the machine between the slots: CPUs (`CLOUDY_CLOUD_SELF_HOSTED_CPUS`, at least 1) and 80% of memory (`CLOUDY_CLOUD_SELF_HOSTED_MEMORY`). On a Mac, "the machine" means the container VM's limits, which you set in Docker Desktop or OrbStack. If you raise them there, run setup again.

## Cleanup and deadlines

Each container runs `timeout <seconds> sleep infinity` as its main process and is started with `--rm`. It exits at its deadline (at most 24 hours) and Docker removes it, even if your computer is off. The client also deletes a session's containers when the session ends. To see and remove them yourself:

```
ssh user@host /path/to/docker ps -a --filter label=cloudy-cloud.purpose
ssh user@host /path/to/docker rm -f cc-<id>
```

Doctor prints these with your real values. What happens to containers when the machine reboots has not been checked yet. Doctor lists any that are left over.

## Previewing an app

`cloudy-cloud open <agent> <port>` works. It forwards a port on your computer to the container over SSH. `--share` does not work on this provider, because it cannot publish links.

## Limits

- **One machine.** Setup saves one SSH address.
- **No coordinators yet.** The provider has no snapshots, so `cloudy-cloud coordinator image` and `start` stop with "Provider self-hosted has no snapshots, which coordinators need." Workers work.
- **No published links.** `open --share` is refused.
- **Docker and rootless Podman.** Docker is the supported route. Podman is accepted but its limits may not apply when rootless.
- **Setup asks for no Instabox key.** It still asks for your Claude token and optional model provider keys.
- **The agent can reach your network.** A container on your machine can reach the other devices that machine can reach.

## Docker Desktop: image build fails over SSH

Docker Desktop on a Mac can store registry logins in the macOS keychain (`credsStore` in `~/.docker/config.json`). A build started over SSH cannot unlock the keychain, so pulling the base image can fail with an error about credentials. The image uses `node:22-bookworm-slim`. Two ways around it:

- On the Mac itself, in a Terminal window, run `docker pull node:22-bookworm-slim`, then run setup again. The build then finds the base image locally.
- Use OrbStack instead.

This is a known Docker Desktop behavior. It has not yet been checked on the Mac Studio.
