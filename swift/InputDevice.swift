// Choosing which microphone to listen to.
//
// When an app opens the microphone while AirPods are connected, macOS switches
// them from A2DP into hands-free mode. That gives you a microphone, and it
// costs you almost everything: the input becomes telephone-quality narrowband,
// and the output you are listening to degrades with it.
//
// Measured on a captured turn: only 3.6% of the energy sat above 6kHz, and both
// Apple's recognizer and Whisper produced nonsense from audio whose loudness and
// zero-crossing rate looked like perfectly ordinary speech. The recognizers were
// fine. They were being handed a phone call.
//
// So the built-in microphone is preferred, and the headphones are left alone to
// do the one thing they are good at.

import CoreAudio
import Foundation

enum InputDevice {
  /// The built-in microphone, or nil if this Mac has none.
  static func builtIn() -> AudioDeviceID? {
    for device in all() where transport(device) == kAudioDeviceTransportTypeBuiltIn {
      if inputChannels(device) > 0 { return device }
    }
    return nil
  }

  /// Human-readable name, for saying which microphone is in use.
  static func name(_ device: AudioDeviceID) -> String {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioObjectPropertyName,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &name) {
      AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
    }
    return status == noErr ? (name as String) : "unknown"
  }

  /// Whether a device is a Bluetooth headset, whose microphone costs quality.
  static func isBluetooth(_ device: AudioDeviceID) -> Bool {
    let kind = transport(device)
    return kind == kAudioDeviceTransportTypeBluetooth
        || kind == kAudioDeviceTransportTypeBluetoothLE
  }

  /// The device the system would pick on its own.
  static func systemDefault() -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultInputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
    return status == noErr && device != 0 ? device : nil
  }

  // MARK: internals

  private static func all() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else { return [] }
    return devices
  }

  private static func transport(_ device: AudioDeviceID) -> UInt32 {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyTransportType,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var kind: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &kind) == noErr else { return 0 }
    return kind
  }

  private static func inputChannels(_ device: AudioDeviceID) -> Int {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamConfiguration,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr else { return 0 }
    let buffers = UnsafeMutableRawPointer.allocate(
      byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { buffers.deallocate() }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, buffers) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(
      buffers.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
  }
}
