"""Runs tui-load in a 200x50 PTY and saves everything it writes (helper for check.test.ts)."""
import fcntl, os, pty, struct, sys, termios
out, report, tui = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    import time; time.sleep(0.3)  # let the parent set the window size first
    os.execv(tui, [tui, "run", "--seconds", "4", "--seed", "7", "--report", report])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
with open(out, "wb") as f:
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        f.write(data)
os.waitpid(pid, 0)
