// swift/EchoPolicyTests.swift
// The rule that keeps the headphone squeeze alive, which is a pure decision and
// so can be tested without headphones, a Bluetooth stack, or an audio device.

func runEchoPolicyTests() -> Int {
  var failures = 0

  func expect(_ actual: EchoDecision, on: Bool, warns: Bool, _ what: String) {
    if actual.enable != on || (actual.warning != nil) != warns {
      print("  ✗ \(what): got enable=\(actual.enable) warning=\(actual.warning != nil), wanted enable=\(on) warning=\(warns)")
      failures += 1
    }
  }

  // Nobody asked for it: nothing to decide, nothing to say.
  expect(echoDecision(requested: false, outputIsBluetoothHeadset: false),
         on: false, warns: false, "off stays off")
  expect(echoDecision(requested: false, outputIsBluetoothHeadset: true),
         on: false, warns: false, "off stays off on bluetooth too")

  // Laptop speakers: this is what echo cancellation is for, and there are no
  // headphones to drag into call mode.
  expect(echoDecision(requested: true, outputIsBluetoothHeadset: false),
         on: true, warns: false, "on where it earns its keep")

  // The trap. Voice processing is a duplex path, duplex puts the buds in SCO,
  // and in SCO a stem pinch is "end call" — no media command is emitted at all,
  // so the squeeze cannot work no matter what the app does about it.
  expect(echoDecision(requested: true, outputIsBluetoothHeadset: true),
         on: false, warns: true, "refused on a bluetooth headset")

  // The warning has to name the thing that breaks, or it is noise in a log
  // nobody reads.
  let refusal = echoDecision(requested: true, outputIsBluetoothHeadset: true).warning ?? ""
  for word in ["echo cancellation", "squeeze", "echoCancellation"] {
    if !refusal.contains(word) {
      print("  ✗ the refusal should mention \(word): \(refusal)")
      failures += 1
    }
  }

  if failures == 0 { print("  ✓ echo cancellation policy") }
  return failures
}
