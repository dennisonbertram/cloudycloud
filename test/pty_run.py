# Runs a command in a pty and plays a script of (expect-regex, send) steps. Usage: pty_run.py JSON
# JSON: {"cmd": [...], "env": {...}, "steps": [[regex, text], ...], "timeout": 60}
# Prints the terminal transcript, then a last line EXIT:<code>.
import json, os, pty, re, select, sys, time

spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(spec["cmd"][0], spec["cmd"], spec["env"])
buf, out, steps, deadline = "", "", list(spec["steps"]), time.time() + spec.get("timeout", 60)
while time.time() < deadline:
    if steps and re.search(steps[0][0], buf):
        time.sleep(0.4); os.write(fd, steps.pop(0)[1].encode()); buf = ""; continue
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: data = os.read(fd, 4096).decode("utf-8", "replace")
        except OSError: break
        if not data: break
        buf += data; out += data
_, status = os.waitpid(pid, 0) if time.time() < deadline else (0, 255 << 8)
sys.stdout.write(out.replace("\r\n", "\n") + ("\nUNMATCHED:" + steps[0][0] if steps else "") + "\nEXIT:%d\n" % (status >> 8))
