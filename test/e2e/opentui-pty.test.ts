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

test.skipIf(!python || process.platform === "win32")("linked interactive OpenTUI navigates ancestry and workspace roots, then resumes the selected root", async () => {
  const provider = new StrictActionFixture();
  const directory = await mkdtemp(join(tmpdir(), "agencity-opentui-pty-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const installation = join(directory, "bun-install");
  await mkdir(workspace);
  await mkdir(home);
  const initialized = Bun.spawn(["git", "init", "--quiet"], {
    cwd: workspace,
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [initCode, initError] = await Promise.all([initialized.exited, new Response(initialized.stderr).text()]);
  expect(initCode, initError).toBe(0);
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
  const task = "OpenTUI pseudo-terminal\nround trip";
  const childTask = "PTY retained child";
  const childRunTask = "Create the PTY grandchild";
  const grandchildTask = "PTY retained grandchild";
  provider.script(childRunTask, [
    action("typescript", `await sdk.agents.spawn({ task: ${JSON.stringify(grandchildTask)}, name: "PTY grandchild" }); return "spawned grandchild";`),
    action("final", `fixture completed: ${childRunTask}`),
  ]);
  provider.script(task, [
    action("typescript", `await sdk.agents.spawn({ task: ${JSON.stringify(childTask)}, name: "PTY reviewer" }); return "spawned";`),
    action("final", `fixture completed: ${task}`),
  ]);
  // Keep the first committed cell visible for at least one terminal frame
  // before the final step auto-collapses the completed run.
  provider.hold(task, 2);
  const releaseTaskCompletion = (async () => {
    try {
      await provider.waitFor(task, 2);
      await Bun.sleep(500);
    } finally {
      provider.release(task, 2);
    }
  })();
  const script = String.raw`
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

workspace, home, executable, task, child_run_task = sys.argv[1:]
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

provider_prompt = pump(10, "Choose a provider")
if provider_prompt:
    os.write(fd, b"openai\r")
credential_prompt = pump(5, "API key for OpenAI")
if credential_prompt:
    os.write(fd, b"acceptance-fixture-key\r")
model_prompt = pump(10, "Fixture Reasoner")
if model_prompt:
    os.write(fd, b"fixture reasoner\r")
ready = pump(10, "Ask Agencity")
kitty_query = b"\x1b[?u" in output
if kitty_query:
    os.write(fd, b"\x1b[?0u")
alternate_scroll = kitty_query and pump(5, "\x1b[?1007h")
application_cursor = b"\x1b[?1h" in output
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
cell_rendered = b"TypeScript" in output
if task_complete and not cell_rendered:
    cell_mark = len(output)
    os.write(fd, b"\x0f")
    cell_rendered = pump(5, "TypeScript", cell_mark)
post_cell_inspector = False
if task_complete and cell_rendered:
    inspector_mark = len(output)
    os.write(fd, b"/info\r")
    post_cell_inspector = pump(5, "WORKSPACE STATUS", inspector_mark)
    if post_cell_inspector:
        os.write(fd, b"\x1b")
        time.sleep(0.2)
family_summary = pump(10, "1 agent:")
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
grandchild_summary_mark = len(output)
if child_open:
    os.write(fd, child_run_task.encode() + b"\r")
grandchild_summary = child_open and pump(10, "1 agent:", grandchild_summary_mark)
grandchild_summary_focus_mark = len(output)
if grandchild_summary:
    os.write(fd, b"\x1b[B")
grandchild_summary_focus = grandchild_summary and pump(5, "> 1 agent", grandchild_summary_focus_mark)
grandchild_browser_mark = len(output)
if grandchild_summary_focus:
    os.write(fd, b"\x1b[C")
grandchild_browser = grandchild_summary_focus and pump(5, "AGENT FAMILY", grandchild_browser_mark) and pump(2, "PTY grandchild", grandchild_browser_mark)
grandchild_mark = len(output)
if grandchild_browser:
    time.sleep(0.5)
    os.write(fd, b"\r")
grandchild_open = grandchild_browser and pump(8, "PTY grandchild / unnamed branch", grandchild_mark)
grandchild_parent_ready = grandchild_open and pump(8, "← parent", grandchild_mark)
child_return_mark = len(output)
if grandchild_parent_ready:
    time.sleep(1)
    os.write(fd, b"\x1b[D")
child_return = grandchild_parent_ready and pump(8, "Agencity — PTY reviewer", child_return_mark)
child_browser_restored = child_return and pump(8, "AGENT FAMILY", child_return_mark) and pump(2, "PTY grandchild", child_return_mark)
child_parent_ready = child_browser_restored
if child_browser_restored:
    time.sleep(0.5)
    os.write(fd, b"\x1b[D")
    time.sleep(0.5)
parent_mark = len(output)
parent_open = False
if child_parent_ready:
    time.sleep(1)
    os.write(fd, b"\x1b[D")
    parent_open = child_parent_ready and pump(8, "Agencity — OpenTUI pseudo-terminal round trip", parent_mark)
parent_browser_restored = parent_open and pump(8, "AGENT FAMILY", parent_mark) and pump(2, "PTY reviewer", parent_mark)
alternate_mark = len(output)
if parent_browser_restored:
    time.sleep(0.3)
    os.write(fd, b"\x1b[D")
    time.sleep(0.2)
    os.write(fd, b"/new Alternate root\r")
alternate_root = parent_browser_restored and pump(8, "Agencity — Alternate root", alternate_mark)
alternate_agents_ready = alternate_root
agents_mark = len(output)
if alternate_agents_ready:
    time.sleep(1)
    os.write(fd, b"/agents\r")
workspace_agents = alternate_agents_ready and pump(8, "Agencity — Agents", agents_mark)
workspace_named = workspace_agents and pump(8, "Alternate root", agents_mark)
workspace_original = workspace_agents and pump(8, "OpenTUI pseudo-terminal round trip", agents_mark)
workspace_roots = workspace_named and workspace_original
root_selection_mark = len(output)
if workspace_roots:
    os.write(fd, b"\x1b[B")
    time.sleep(0.1)
    os.write(fd, b"\x1b[C")
root_selection = workspace_roots and pump(8, "Agencity — OpenTUI pseudo-terminal round trip", root_selection_mark) and pump(8, "1 agent:", root_selection_mark)
if ready:
    if root_selection:
        time.sleep(1)
    os.write(fd, b"\x04")
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
    resume_root = pump(10, "1 agent: 1 idle", resume_mark)
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
with open(os.path.join(workspace, ".agencity", "workspace-id"), "rb") as marker:
    workspace_id = marker.read().strip()
print(json.dumps({
    "providerPrompt": provider_prompt,
    "credentialPrompt": credential_prompt,
    "modelPrompt": model_prompt,
    "ready": ready,
    "alternateScroll": alternate_scroll,
    "applicationCursor": application_cursor,
    "taskComplete": task_complete,
    "cellRendered": cell_rendered,
    "postCellInspector": post_cell_inspector,
    "familySummary": family_summary,
    "summaryFocus": summary_focus,
    "familyBrowser": family_browser,
    "childOpen": child_open,
    "grandchildSummary": grandchild_summary,
    "grandchildSummaryFocus": grandchild_summary_focus,
    "grandchildBrowser": grandchild_browser,
    "grandchildOpen": grandchild_open,
    "grandchildParentReady": grandchild_parent_ready,
    "childReturn": child_return,
    "childBrowserRestored": child_browser_restored,
    "childParentReady": child_parent_ready,
    "parentOpen": parent_open,
    "parentBrowserRestored": parent_browser_restored,
    "alternateRoot": alternate_root,
    "workspaceAgents": workspace_agents,
    "workspaceRoots": workspace_roots,
    "rootSelection": root_selection,
    "exitCode": exit_code,
    "resumeRoot": resume_root,
    "resumeExitCode": resume_exit_code,
    "residentDetach": b"Service remains active: 2 resident workers" in output,
    "secretHidden": b"acceptance-fixture-key" not in output,
    "workspaceIdHidden": bool(workspace_id) and workspace_id not in output,
    "nativeSelectionAvailable": not any(sequence in output for sequence in (
        b"\x1b[?1000h",
        b"\x1b[?1002h",
        b"\x1b[?1003h",
        b"\x1b[?1005h",
        b"\x1b[?1006h",
        b"\x1b[?1015h",
    )),
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
    const processResult = Bun.spawn([python!, "-c", script, workspace, home, executable, task, childRunTask], {
      cwd: root,
      env: {
        ...cleanEnvironment,
        HOME: home,
        OPENAI_BASE_URL: provider.baseUrl,
        AI_GATEWAY_BASE_URL: provider.baseUrl,
      },
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
      alternateScroll: true,
      applicationCursor: true,
      taskComplete: true,
      cellRendered: true,
      postCellInspector: true,
      familySummary: true,
      summaryFocus: true,
      familyBrowser: true,
      childOpen: true,
      grandchildSummary: true,
      grandchildSummaryFocus: true,
      grandchildBrowser: true,
      grandchildOpen: true,
      grandchildParentReady: true,
      childReturn: true,
      childBrowserRestored: true,
      childParentReady: true,
      parentOpen: true,
      parentBrowserRestored: true,
      alternateRoot: true,
      workspaceAgents: true,
      workspaceRoots: true,
      rootSelection: true,
      exitCode: 0,
      resumeRoot: true,
      resumeExitCode: 0,
      residentDetach: true,
      secretHidden: true,
      workspaceIdHidden: true,
      nativeSelectionAvailable: true,
    });
    expect(provider.catalogRequests).toEqual([
      expect.objectContaining({ authorization: null }),
    ]);

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
    expect(history.messages.map((message: any) => [message.role, message.content]))
      .toEqual(expect.arrayContaining([
        ["user", task],
        ["user", `fixture completed: ${childTask}`],
        ["assistant", `fixture completed: ${task}`],
      ]));
    expect(history.runs.at(-1)?.status).toBe("succeeded");
    expect(history.runs.at(-1)?.steps).toHaveLength(2);
    expect(history.cells).toEqual([expect.objectContaining({
      code: `await sdk.agents.spawn({ task: ${JSON.stringify(childTask)}, name: "PTY reviewer" }); return "spawned";`,
      status: "committed",
      result: "spawned",
    })]);
    const treeResult = await cli(executable, workspace, home, ["tree", "--json"]);
    expect(treeResult.code, treeResult.stderr).toBe(0);
    const tree = JSON.parse(treeResult.stdout);
    expect(tree.items).toEqual([expect.objectContaining({
      name: "PTY reviewer",
      relationship: "child",
      task: childTask,
      taskStatus: "completed",
      cancellationRequested: false,
      activity: "idle",
    })]);
  } finally {
    provider.release(task, 2);
    await releaseTaskCompletion.catch(() => null);
    await cli(executable, workspace, home, ["service", "shutdown"]).catch(() => null);
    provider.close();
  }
}, 45_000);
