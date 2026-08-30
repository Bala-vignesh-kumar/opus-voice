import Foundation

// Wrapped in a function for the same reason as MenuBarStateTests: only
// main.swift may carry statements at file scope.
func runEnvironmentTests() -> Int {
  var envFailures = 0

  func check(_ condition: Bool, _ what: String) {
    if !condition {
      print("  ✗ \(what)")
      envFailures += 1
    }
  }

  // MARK: reloading an open window

  // The window is a web view holding one url, and that url carries the session
  // token. node restarting mints a new one, so a window left open across a
  // restart is pointed at a session that no longer exists: its event stream
  // 403s, EventSource gives up for good, and the page sits there frozen with an
  // empty library. Nothing recovers it, because nothing was watching.
  let first = URL(string: "http://127.0.0.1:4477/?k=aaaa")!
  let second = URL(string: "http://127.0.0.1:4477/?k=bbbb")!
  check(shouldReloadWindow(loaded: first, current: second), "a new token reloads")
  check(!shouldReloadWindow(loaded: first, current: first), "the same session does not reload")
  check(shouldReloadWindow(loaded: nil, current: first), "a window with nothing loaded reloads")
  check(!shouldReloadWindow(loaded: first, current: nil), "no session means nothing to reload to")

  // The port moves when 4477 is taken, and that is just as stale as a new
  // token — same token, different session.
  let moved = URL(string: "http://127.0.0.1:4478/?k=aaaa")!
  check(shouldReloadWindow(loaded: first, current: moved), "a new port reloads")

  let fm = FileManager.default
  let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("falcon-env-\(UUID().uuidString)")
  try! fm.createDirectory(at: tmp, withIntermediateDirectories: true)
  defer { try? fm.removeItem(at: tmp) }

  // A repo that is not there is the failure you get by moving the checkout
  // after bundling, and it has to name the path it was looking for.
  if case .failure(let problem) = resolveLaunch(
    repoRoot: tmp.appendingPathComponent("gone").path, nodePath: "/bin/sh", fileManager: fm) {
    check(problem.message.contains("gone"), "repoMissing names the path")
  } else {
    check(false, "a missing repo must fail")
  }

  // A real repo whose config sets no dir. Falling back to the home folder would
  // root an agent with shell access somewhere nobody chose.
  let repo = tmp.appendingPathComponent("repo")
  try! fm.createDirectory(at: repo, withIntermediateDirectories: true)
  try! #"{"model":"opus"}"#.write(
    to: repo.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
  if case .failure(let problem) = resolveLaunch(
    repoRoot: repo.path, nodePath: "/bin/sh", fileManager: fm) {
    check(problem.message.contains("dir"), "projectUnset explains which key is missing")
  } else {
    check(false, "an unset project must fail")
  }

  // A dir that is set but does not exist.
  try! #"{"dir":"/nowhere/at/all"}"#.write(
    to: repo.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
  if case .failure(let problem) = resolveLaunch(
    repoRoot: repo.path, nodePath: "/bin/sh", fileManager: fm) {
    check(problem.message.contains("/nowhere/at/all"), "projectMissing names the folder")
  } else {
    check(false, "a missing project folder must fail")
  }

  // Everything present.
  let project = tmp.appendingPathComponent("project")
  try! fm.createDirectory(at: project, withIntermediateDirectories: true)
  try! "{\"dir\":\"\(project.path)\"}".write(
    to: repo.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
  if case .success(let launch) = resolveLaunch(
    repoRoot: repo.path, nodePath: "/bin/sh", fileManager: fm) {
    check(launch.projectDir.path == project.path, "project resolves")
    check(launch.node.path == "/bin/sh", "node resolves")
  } else {
    check(false, "a complete setup must succeed")
  }

  // A recorded node path that has gone stale falls back rather than giving up,
  // because node moves whenever Homebrew does.
  if case .success(let launch) = resolveLaunch(
    repoRoot: repo.path, nodePath: "/opt/definitely/not/node", fileManager: fm) {
    check(NODE_FALLBACKS.contains(launch.node.path), "a stale node path falls back")
  } else {
    // Acceptable only on a machine with no node at all, which cannot run this.
    check(false, "node fallback failed — is node installed?")
  }

  // A tilde in config.json is what a person actually types.
  try! #"{"dir":"~"}"#.write(
    to: repo.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
  if case .success(let launch) = resolveLaunch(
    repoRoot: repo.path, nodePath: "/bin/sh", fileManager: fm) {
    check(!launch.projectDir.path.contains("~"), "a tilde in dir is expanded")
  } else {
    check(false, "a tilde dir must resolve")
  }

  if envFailures == 0 { print("  ✓ launch environment") }
  return envFailures
}
