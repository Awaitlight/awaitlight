# 后台额度保鲜：用 PTY 驱动一个极短的 claude 交互式会话（默认 haiku，最便宜），
# 触发一次真实 API 响应 → statusLine 带出最新 rate_limits（账号级，跨模型共享）。
# 由 server.js 定时 spawn；父进程会设 COCKPIT_LIMITS_ONLY=1，使桥只更新额度、不污染当前显示。
import os, pty, time, select, signal, sys

model = sys.argv[1] if len(sys.argv) > 1 else "claude-haiku-4-5"
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("claude", ["claude", "--model", model])
else:
    def drain(t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.3)
            if r:
                try:
                    if not os.read(fd, 8192):
                        return
                except OSError:
                    return
    drain(4.0)                       # 等启动
    try: os.write(fd, b"hi\r")       # 发一句，产生 API 响应
    except Exception: pass
    drain(18.0)                      # 等响应 + statusLine 重渲染（haiku 较快）
    for _ in range(2):
        try: os.write(fd, b"\x03"); time.sleep(0.2)
        except Exception: pass
    try: os.kill(pid, signal.SIGKILL)
    except Exception: pass
    print("refreshed")
