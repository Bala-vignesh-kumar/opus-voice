// The session, as the app sees it.
//
// Follows the same server-sent events the window does, so the menu bar reflects
// what actually happened rather than what it last asked for — the same reason
// src/view.mjs exists on the node side.
//
// It reports upward and touches nothing: no status item, no window, no menu.
// What any of this means on screen is the app's business.

import Foundation

final class SessionClient {
  /// Mode, and the current status if there is one. A snapshot carries both; a
  /// patch carries whichever changed.
  private let onChange: (String?, String?, Bool) -> Void
  /// One line of conversation: who said it, and what.
  private let onEntry: (String, String) -> Void
  /// A late client gets the whole transcript at once and has to start over.
  private let onReset: () -> Void
  private var stream: Task<Void, Never>?

  init(onChange: @escaping (String?, String?, Bool) -> Void,
       onEntry: @escaping (String, String) -> Void,
       onReset: @escaping () -> Void) {
    self.onChange = onChange
    self.onEntry = onEntry
    self.onReset = onReset
  }

  /// Follows `session` until it ends or `stop()` is called.
  func follow(session base: URL) {
    stream?.cancel()
    stream = Task { [weak self] in
      guard let events = URL(string: "/events?\(base.query ?? "")", relativeTo: base) else { return }
      guard let (bytes, _) = try? await URLSession.shared.bytes(from: events) else { return }
      // The stream ends when the session does. A dropped connection is not
      // worth surfacing on its own, because the orchestrator already reports a
      // dead child — and reporting it twice would mean two different glyphs
      // racing to describe one failure.
      do {
        for try await line in bytes.lines {
          guard line.hasPrefix("data: "), let self else { continue }
          let payload = String(line.dropFirst(6))
          guard
            let data = payload.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
          else { continue }
          await MainActor.run {
            self.onChange(json["mode"] as? String,
                          json["status"] as? String,
                          json.keys.contains("status"))
            self.absorb(json)
          }
        }
      } catch {
        // Cancelled, or the server went away. Either way there is nothing to say.
      }
    }
  }

  func stop() {
    stream?.cancel()
    stream = nil
  }

  /// Pulls conversation lines out of a snapshot or a patch. The bus sends a
  /// whole `entries` array to a client that connects late, and single `entry`
  /// objects after that.
  private func absorb(_ json: [String: Any]) {
    var incoming: [[String: Any]] = []
    if let entries = json["entries"] as? [[String: Any]] {
      onReset()
      incoming = entries
    }
    if let entry = json["entry"] as? [String: Any] { incoming = [entry] }
    for entry in incoming {
      guard
        let kind = entry["type"] as? String,
        kind == "you" || kind == "falcon",
        let text = entry["text"] as? String,
        !text.isEmpty
      else { continue }
      onEntry(kind, text)
    }
  }

  /// The same POST the window's buttons make, so a menu item and a button are
  /// the same instruction arriving by different routes.
  func post(_ body: [String: String], to base: URL) {
    guard
      let endpoint = URL(string: "/command", relativeTo: base),
      let token = URLComponents(url: base, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "k" })?.value,
      let data = try? JSONSerialization.data(withJSONObject: body)
    else { return }

    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(token, forHTTPHeaderField: "x-falcon-token")
    request.httpBody = data
    URLSession.shared.dataTask(with: request).resume()
  }
}
