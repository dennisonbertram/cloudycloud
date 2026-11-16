# Machine kinds on Instabox: live spike (#91)

Run on 2026-11-15 with the key that `cloudy-cloud setup` stores, on the owner's paid plan. Three machines (omarchy, android, gpu with one L4) were created with `--delete-after 30m`, probed, and deleted; `instabox ls --meta purpose=cloudy-cloud-spike` returned `[]` afterwards. macOS was not created (owner's choice: only when a Mac worker is needed). Machine ids are left out.

## Templates the plan can create

From `instabox templates --json --all` (only `creatable: true` rows; latest version shown):

| Kind (Cloudy Cloud) | Template id | Notes from the template list |
|---|---|---|
| linux (default) | `agent-browser` | the standard machine |
| android | `android` | |
| omarchy | `omarchy` | |
| gpu | `gpu` | NVIDIA L4, 24 GiB; one size: 11 vCPU, 36 GiB, 100 GiB disk; up to 4 GPUs per machine |
| gpu (large) | `gpu-metal` | NVIDIA H100 PCIe, 80 GiB; one size: 44 vCPU, 224 GiB, 200 GiB disk; 1 per machine |
| macos | `macos` | models `m2`, `m2pro`, `m4`, `m4pro`; minimum lease 24 h, $0.85/h, $20.40 minimum (as the API reports it) |

Also creatable: `ci`, `t3`, `universal`, `minimal`, `herdr`, `orca`. `whoami --json` lists `allowedSpecs` 2/4, 4/8 and 8/16 (vCPU/GiB) for standard machines.

## What is on each machine

From `instabox ssh <name> -- sh -lc '…'`:

| Kind | Home, user | git | gh | node | claude | docker | tmux | Other |
|---|---|---|---|---|---|---|---|---|
| omarchy | `/data/home`, the account user | yes | yes | yes (v26.13.1) | yes | yes | yes | x86_64; VNC listening on 127.0.0.1:5901 |
| android | `/data/home` | yes | yes | yes (v22.23.3) | yes | yes | **no** | x86_64 |
| gpu (L4) | `/data/home` | yes | yes | yes (v22.23.3) | yes | yes | **no** | x86_64; `nvidia-smi`: NVIDIA L4, 23034 MiB |

`ssh -- cmd` worked on all three. tmux is missing on android and gpu: a coordinator there must install it (the coordinator setup already runs `apt-get install tmux` when missing; check it works on these templates before allowing coordinators on them).

## Desktop and display links

Through the SDK (`@insforge/instabox-sdk` 0.6.0, `sbx.desktop`):

| Kind | `desktop.status()` before | `desktop.start()` | View-only link | Control link | `desktop.screenshot()` |
|---|---|---|---|---|---|
| omarchy | error: `xdotool: command not found` | error: same | created | created | error: `unable to open X server ':1'` |
| android | installed, not running | ok in 1 s | created | created | 3,072 bytes |
| gpu (L4) | not installed | ok in 119 s (installs the desktop) | created | created | 119,378 bytes |

- The stored key **may create display links** (no 403 `permission_denied`), so it acts as the machine creator's personal key.
- Links point to `https://dashboard.instabox.sh/desktop/<machine id>` with the token in the URL fragment; they expire at the requested TTL (300 s in the test).
- **Local browser tool:** `agent-browser open <view-only link>` showed the android machine's live desktop (Android 14 home screen in its window) with no sign-in and no tunnel. Claude in Chrome was not tried.
- omarchy runs Hyprland (Wayland); the SDK's desktop calls assume X on `:1` and `xdotool`, so they fail there, although links are still created and VNC listens locally.

## Recommendations

| Kind | Recommendation |
|---|---|
| linux (`agent-browser`) | Support (default). |
| android | Support. Display works. Preflight passes; coordinators need tmux installed first. |
| gpu (`gpu`, L4) | Support with consent (`CLOUDY_CLOUD_ALLOW_MACHINE_KINDS=gpu`). Display works after a ~2 min first start; say so in the output. Coordinators need tmux installed first. |
| gpu-metal (H100) | Not in the first version; add as `gpu:h100` later if wanted (separate template id, one size). |
| omarchy | Support for workers (tools present). Refuse `display` and `--screenshot` with `desktop_unavailable` until Instabox's desktop API supports Hyprland; `shell` works. |
| macos | Keep experimental behind consent; not verified live (24 h minimum charge). |

## Not verified

- macOS: tools, home directory, `commands.run`/`files` behaviour, desktop.
- Claude in Chrome against a display link.
- Whether the android screenshot (3 KB) was blank at that moment; the live link showed the full desktop.
- GPU workloads beyond `nvidia-smi`.
