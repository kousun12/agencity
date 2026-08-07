import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const python = Bun.which("python3");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function cli(executable: string, workspace: string, home: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args, "--workspace", workspace, "--profile", join(home, "profile.db")], {
    cwd: workspace,
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test.skipIf(!python || process.platform === "win32")("linked interactive OpenTUI accepts a task and detaches through a real pseudo-terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agencity-opentui-pty-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const installation = join(directory, "bun-install");
  await mkdir(workspace);
  await mkdir(home);
  const linked = Bun.spawn([process.execPath, "link", "--cwd", root], {
    cwd: root,
    env: { ...process.env, HOME: home, BUN_INSTALL: installation },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [linkCode, linkError] = await Promise.all([linked.exited, new Response(linked.stderr).text()]);
  expect(linkCode, linkError).toBe(0);
  const executable = join(installation, "bin", "agencity");
  const task = "OpenTUI pseudo-terminal round trip";
  const script = String.raw`
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

workspace, home, executable, task = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(workspace)
    os.environ["HOME"] = home
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 112, 0, 0))
    os.execv(executable, [executable, "new", "--demo", "--workspace", workspace, "--profile", os.path.join(home, "profile.db")])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 112, 0, 0))
os.set_blocking(fd, False)
output = bytearray()

def pump(seconds, needle=None):
    deadline = time.time() + seconds
    target = needle.encode() if needle else None
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if target and target in output:
            return True
    return target is None or target in output

def wait_exit(seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.05)
    return None

ready = pump(10, "Ask Agencity")
os.write(fd, task.encode() + b"\r")
task_complete = False
deadline = time.time() + 10
while time.time() < deadline:
    status = subprocess.run([
        executable, "status", "current", "--json",
        "--workspace", workspace,
        "--profile", os.path.join(home, "profile.db"),
    ], cwd=workspace, env={**os.environ, "HOME": home}, capture_output=True)
    if status.returncode == 0:
        try:
            task_complete = json.loads(status.stdout).get("status") == "succeeded"
        except Exception:
            task_complete = False
        if task_complete:
            break
    time.sleep(0.1)
os.write(fd, b"/quit\r")
pump(4, "workspace service will stop automatically")
exit_code = wait_exit(5)
if exit_code is None:
    os.kill(pid, signal.SIGTERM)
    exit_code = wait_exit(2)
if exit_code is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
print(json.dumps({
    "ready": ready,
    "taskComplete": task_complete,
    "exitCode": exit_code,
    "idleDetach": b"workspace service will stop automatically" in output,
    "outputTail": output.decode("utf-8", "replace")[-1200:],
}))
`;
  try {
    const processResult = Bun.spawn([python!, "-c", script, workspace, home, executable, task], {
      cwd: root,
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [processCode, processStdout, processStderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);
    expect(processCode, processStderr).toBe(0);
    const ptyResult = JSON.parse(processStdout);
    expect(ptyResult, ptyResult.outputTail).toMatchObject({ ready: true, taskComplete: true, exitCode: 0, idleDetach: true });

    let history: any = null;
    let historyError = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await cli(executable, workspace, home, ["history", "current", "--json"]);
      historyError = result.stderr;
      if (result.code === 0) {
        history = JSON.parse(result.stdout);
        if (history.messages?.some((message: any) => message.role === "assistant" && message.content === `Echo: ${task}`)) break;
      }
      await Bun.sleep(50);
    }
    expect(history, historyError).not.toBeNull();
    expect(history.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", task],
      ["assistant", `Echo: ${task}`],
    ]);
    expect(history.runs.at(-1)?.status).toBe("succeeded");
  } finally {
    await cli(executable, workspace, home, ["service", "shutdown"]).catch(() => null);
  }
}, 30_000);
