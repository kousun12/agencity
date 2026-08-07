import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrictActionFixture, action } from "../acceptance/strict-action-fixture.ts";

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

test.skipIf(!python || process.platform === "win32")("linked interactive OpenTUI navigates a retained child, detaches, and resumes the root through a real pseudo-terminal", async () => {
  const provider = new StrictActionFixture();
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
  const childTask = "PTY retained child";
  provider.script(task, [
    action("typescript", `await sdk.agents.spawn({ task: ${JSON.stringify(childTask)}, name: "PTY reviewer", run: false }); return "spawned";`),
    action("final", `fixture completed: ${task}`),
  ]);
  const script = String.raw`
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

workspace, home, executable, task = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(workspace)
    os.environ["HOME"] = home
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 112, 0, 0))
    os.execv(executable, [executable, "new", "--workspace", workspace, "--profile", os.path.join(home, "profile.db")])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 112, 0, 0))
os.set_blocking(fd, False)
output = bytearray()

def pump(seconds, needle=None, start=0):
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
        if target and target in output[start:]:
            return True
    return target is None or target in output[start:]

def wait_exit(seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.05)
    return None

provider_prompt = pump(10, "Provider number or ID:")
if provider_prompt:
    os.write(fd, b"1\r")
credential_prompt = pump(5, "API key for OpenAI")
if credential_prompt:
    os.write(fd, b"acceptance-fixture-key\r")
model_prompt = pump(5, "Model ID for OpenAI:")
if model_prompt:
    os.write(fd, b"fixture-v1\r")
ready = pump(10, "Ask Agencity")
if ready:
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
family_summary = pump(10, "1 agent: 1 working")
summary_mark = len(output)
if family_summary:
    os.write(fd, b"\x1b[B")
summary_focus = pump(5, "> 1 agent", summary_mark)
browser_mark = len(output)
if summary_focus:
    os.write(fd, b"\x1b[C")
family_browser = pump(5, "AGENT FAMILY", browser_mark) and pump(1, "PTY reviewer", browser_mark)
child_mark = len(output)
if family_browser:
    os.write(fd, b"\x1b[C")
child_open = pump(8, "PTY reviewer / unnamed branch", child_mark)
parent_mark = len(output)
if child_open:
    os.write(fd, b"\x1b[D")
parent_open = pump(8, "1 agent: 1 working", parent_mark)
if ready:
    os.write(fd, b"/quit\r")
    pump(4, "workspace service will stop automatically")
exit_code = wait_exit(5)
if exit_code is None:
    os.kill(pid, signal.SIGTERM)
    exit_code = wait_exit(2)
if exit_code is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
os.close(fd)
resume_root = False
resume_exit_code = None
if exit_code == 0:
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.environ["HOME"] = home
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 112, 0, 0))
        os.execv(executable, [executable, "--workspace", workspace, "--profile", os.path.join(home, "profile.db")])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 112, 0, 0))
    os.set_blocking(fd, False)
    resume_mark = len(output)
    resume_root = pump(10, "1 agent: 1 working", resume_mark)
    if resume_root:
        os.write(fd, b"/quit\r")
        pump(4, "workspace service will stop automatically", resume_mark)
    resume_exit_code = wait_exit(5)
    if resume_exit_code is None:
        os.kill(pid, signal.SIGTERM)
        resume_exit_code = wait_exit(2)
    if resume_exit_code is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
print(json.dumps({
    "providerPrompt": provider_prompt,
    "credentialPrompt": credential_prompt,
    "modelPrompt": model_prompt,
    "ready": ready,
    "taskComplete": task_complete,
    "familySummary": family_summary,
    "summaryFocus": summary_focus,
    "familyBrowser": family_browser,
    "childOpen": child_open,
    "parentOpen": parent_open,
    "exitCode": exit_code,
    "resumeRoot": resume_root,
    "resumeExitCode": resume_exit_code,
    "idleDetach": b"workspace service will stop automatically" in output,
    "secretHidden": b"acceptance-fixture-key" not in output,
    "outputTail": output.decode("utf-8", "replace")[-1200:],
}))
`;
  try {
    const {
      OPENAI_API_KEY: _openai,
      OPENAI_MODEL: _openaiModel,
      ANTHROPIC_API_KEY: _anthropic,
      AI_GATEWAY_API_KEY: _gateway,
      ...cleanEnvironment
    } = process.env;
    const processResult = Bun.spawn([python!, "-c", script, workspace, home, executable, task], {
      cwd: root,
      env: { ...cleanEnvironment, HOME: home, OPENAI_BASE_URL: provider.baseUrl },
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
    expect(ptyResult, ptyResult.outputTail).toMatchObject({
      providerPrompt: true,
      credentialPrompt: true,
      modelPrompt: true,
      ready: true,
      taskComplete: true,
      familySummary: true,
      summaryFocus: true,
      familyBrowser: true,
      childOpen: true,
      parentOpen: true,
      exitCode: 0,
      resumeRoot: true,
      resumeExitCode: 0,
      idleDetach: true,
      secretHidden: true,
    });

    let history: any = null;
    let historyError = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await cli(executable, workspace, home, ["history", "current", "--json"]);
      historyError = result.stderr;
      if (result.code === 0) {
        history = JSON.parse(result.stdout);
        if (history.messages?.some((message: any) => message.role === "assistant" && message.content === `fixture completed: ${task}`)) break;
      }
      await Bun.sleep(50);
    }
    expect(history, historyError).not.toBeNull();
    expect(history.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", task],
      ["assistant", `fixture completed: ${task}`],
    ]);
    expect(history.runs.at(-1)?.status).toBe("succeeded");
    const treeResult = await cli(executable, workspace, home, ["tree", "--json"]);
    expect(treeResult.code, treeResult.stderr).toBe(0);
    const tree = JSON.parse(treeResult.stdout);
    expect(tree.items).toEqual([expect.objectContaining({
      name: "PTY reviewer",
      relationship: "child",
      task: childTask,
      taskStatus: "admitted",
      cancellationRequested: false,
      activity: "working",
    })]);
  } finally {
    await cli(executable, workspace, home, ["service", "shutdown"]).catch(() => null);
    provider.close();
  }
}, 45_000);
