// Draws the app icon, so it is source rather than a binary nobody can edit.
//
// The artwork is what the window draws when it is listening to you: dots on a
// golden-angle spiral, in the listening green over the window's own ground. Not
// a bird, and not a microphone glyph — those name the category rather than the
// thing, and the ring is what you actually watch while you talk to it.
//
//   swift scripts/make-icon.swift <iconset-dir>
//   iconutil -c icns -o assets/Falcon.icns <iconset-dir>
//
// `npm run icon` does both.

import AppKit

// The window's own colours, from ui/style.css and ui/app.js.
let ground = NSColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)
let green = NSColor(red: 0.561, green: 0.851, blue: 0.659, alpha: 1)   // #8FD9A8

/// One square of artwork, `size` pixels on a side.
func draw(size: CGFloat) -> NSImage {
  let image = NSImage(size: NSSize(width: size, height: size))
  image.lockFocus()
  defer { image.unlockFocus() }

  guard let ctx = NSGraphicsContext.current?.cgContext else { return image }
  let scale = size / 1024

  // The macOS icon grid: the artwork sits on a squircle inset from the canvas
  // rather than filling it, or it reads a size larger than every icon beside it.
  let inset = (1024 - 824) / 2 * scale
  let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  let squircle = NSBezierPath(roundedRect: rect, xRadius: 185 * scale, yRadius: 185 * scale)
  ground.setFill()
  squircle.fill()
  squircle.addClip()

  let centre = CGPoint(x: size / 2, y: size / 2)

  // The soft middle. Without it the ring reads as a flat washer rather than as
  // the centre of something.
  if let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                           colors: [green.withAlphaComponent(0.13).cgColor,
                                    green.withAlphaComponent(0).cgColor] as CFArray,
                           locations: [0, 1]) {
    ctx.drawRadialGradient(glow, startCenter: centre, startRadius: 0,
                           endCenter: centre, endRadius: 250 * scale, options: [])
  }

  // The same seeded field the window draws, so the icon and the app agree
  // rather than merely resembling each other.
  var seed: UInt64 = 20260830
  func random() -> CGFloat {
    seed = (seed &* 1664525 &+ 1013904223) % 4294967296
    return CGFloat(seed) / 4294967296
  }

  // Fewer, larger dots than the window uses. 130 at 16pt is grey mush; the ring
  // has to survive the smallest size, and that is what decides the count.
  //
  // The band is kept well inside the squircle. Its half-width is 412, so a ring
  // reaching past about 320 has its dots sliced off by the clip and the icon
  // reads as broken rather than round.
  // Below about 64 pixels a scatter of 64 dots is grey fuzz, so the small
  // sizes get fewer and fatter ones. Apple's own icons redraw at small sizes
  // for the same reason: a faithful reduction and a legible mark are different
  // pictures, and the tab bar only ever shows you the second one.
  let small = size <= 64
  let count = small ? 26 : 64
  for i in 0..<count {
    let angle = CGFloat(i) * (small ? 2 * .pi / CGFloat(count) : 2.39996)
    let band = small ? 250 * scale : (215 + random() * 95) * scale
    let radius = small ? 46 * scale : (11 + random() * 15) * scale
    // Brighter on one side, so it reads as lit rather than printed. Gently: at
    // full contrast the dim side disappears into the ground entirely, and half
    // a ring is not a ring.
    let lean = 0.72 + 0.28 * cos(angle - .pi / 4)
    let alpha = small
      ? min(1, 0.80 * lean + 0.20)
      : min(1, (0.62 + random() * 0.38) * lean)

    green.withAlphaComponent(alpha).setFill()
    let dot = CGRect(x: centre.x + cos(angle) * band - radius,
                     y: centre.y + sin(angle) * band - radius,
                     width: radius * 2, height: radius * 2)
    NSBezierPath(ovalIn: dot).fill()
  }

  return image
}

let work = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./Falcon.iconset"
try? FileManager.default.createDirectory(atPath: work, withIntermediateDirectories: true)

// The sizes an iconset must contain. 16pt is the one that decides whether the
// design works at all.
for points in [16, 32, 128, 256, 512] {
  for factor in [1, 2] {
    let image = draw(size: CGFloat(points * factor))
    guard
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:])
    else { continue }
    let suffix = factor == 1 ? "" : "@2x"
    try? png.write(to: URL(fileURLWithPath: "\(work)/icon_\(points)x\(points)\(suffix).png"))
  }
}

print("wrote \(work)")
