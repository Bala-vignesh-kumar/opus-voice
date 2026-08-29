// Where everything is, decided before anything is spawned.
//
// A login-launched process inherits a minimal environment: no Homebrew, no nvm,
// nothing useful on PATH. So none of this is discovered at runtime — the repo
// and node are recorded into Info.plist when the bundle is built, and the
// project folder comes from config.json. What this file adds is refusing to
// guess when one of them is wrong.

import Foundation

/// Everything needed to start the orchestrator.
struct Launch {
  let repoRoot: URL
  let node: URL
  let projectDir: URL
}

/// Places node ends up, tried in order when the recorded path has gone stale.
let NODE_FALLBACKS = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

enum LaunchProblem: Error {
  case repoMissing(String)
  case nodeMissing(String)
  case projectUnset
  case projectMissing(String)

  /// What the menu says. Each one names the thing to go and fix.
  var message: String {
    switch self {
    case .repoMissing(let path):
      return "opus voice is not at \(path) — re-run scripts/bundle.sh"
    case .nodeMissing(let path):
      return "node not found at \(path) or anywhere expected — re-run scripts/bundle.sh"
    case .projectUnset:
      return "no project set — add \"dir\" to config.json and restart"
    case .projectMissing(let path):
      return "the project folder \(path) is gone — fix \"dir\" in config.json"
    }
  }
}

/// The `dir` key from a config.json, or nil if it is absent or empty.
func projectDirectory(inConfigAt file: URL) -> String? {
  guard
    let data = try? Data(contentsOf: file),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let dir = json["dir"] as? String,
    !dir.trimmingCharacters(in: .whitespaces).isEmpty
  else { return nil }
  return (dir as NSString).expandingTildeInPath
}

func resolveLaunch(
  repoRoot: String?,
  nodePath: String?,
  fileManager fm: FileManager = .default
) -> Result<Launch, LaunchProblem> {
  let root = repoRoot ?? ""
  var isDir: ObjCBool = false
  guard fm.fileExists(atPath: root, isDirectory: &isDir), isDir.boolValue else {
    return .failure(.repoMissing(root.isEmpty ? "(unrecorded)" : root))
  }
  let rootURL = URL(fileURLWithPath: root)

  // The recorded path first; it is right until node is upgraded or Homebrew
  // moves, and then the fallbacks cover the ordinary cases without a rebundle.
  let candidates = [nodePath].compactMap { $0 } + NODE_FALLBACKS
  guard let node = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) else {
    return .failure(.nodeMissing(nodePath ?? "(unrecorded)"))
  }

  guard let dir = projectDirectory(inConfigAt: rootURL.appendingPathComponent("config.json")) else {
    return .failure(.projectUnset)
  }
  guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else {
    return .failure(.projectMissing(dir))
  }

  return .success(Launch(
    repoRoot: rootURL,
    node: URL(fileURLWithPath: node),
    projectDir: URL(fileURLWithPath: dir)
  ))
}


/// Which media key wakes it, from config.json. Defaults to next-track, which is
/// a double squeeze on AirPods — chosen over play/pause because skipping a
/// track by accident costs less than pausing what you were listening to.
func mediaKeyBinding(inConfigAt file: URL) -> Int {
  guard
    let data = try? Data(contentsOf: file),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let code = json["wakeMediaKey"] as? Int
  else { return MEDIA_KEY_NEXT }
  return code
}
