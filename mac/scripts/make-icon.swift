// Packages the approved blue agent-head artwork at every macOS icon size.
// Usage: swift scripts/make-icon.swift OUT.iconset [WEB_ASSETS]
// The optional web directory receives matching 32 px and 128 px PNGs.

import AppKit
import ImageIO

let arguments = CommandLine.arguments
guard (2...3).contains(arguments.count) else {
    FileHandle.standardError.write(Data("Usage: make-icon.swift OUT.iconset [WEB_ASSETS]\n".utf8))
    exit(2)
}

let sourceURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Resources/AppIcon.png")
guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write(Data("Cannot load icon artwork: \(sourceURL.path)\n".utf8))
    exit(1)
}

// The approved 1254 px master includes a transparent margin. Map its tile to
// the macOS 824/1024 grid, then clip to a smooth edge so stray alpha pixels in
// the source margin never appear in the Dock.
let sourceTile = CGRect(
    x: CGFloat(image.width) * 40 / 1254,
    y: CGFloat(image.height) * 48 / 1254,
    width: CGFloat(image.width) * 1176 / 1254,
    height: CGFloat(image.height) * 1158 / 1254
)
guard let tile = image.cropping(to: sourceTile) else {
    FileHandle.standardError.write(Data("Cannot read icon tile.\n".utf8))
    exit(1)
}

func iconPNG(pixels: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "AgentShark.Icon", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot allocate \(pixels) px icon."])
    }
    let context = graphics.cgContext
    context.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    let scale = CGFloat(pixels) / 1024
    context.scaleBy(x: scale, y: scale)
    context.interpolationQuality = .high
    context.setShouldAntialias(true)

    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    context.addPath(CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil))
    context.clip()
    context.setFillColor(CGColor(srgbRed: 248.0 / 255, green: 250.0 / 255,
                                blue: 252.0 / 255, alpha: 1))
    context.fill(body)
    context.draw(tile, in: body)
    graphics.flushGraphics()

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "AgentShark.Icon", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot encode \(pixels) px icon."])
    }
    return data
}

let output = URL(fileURLWithPath: arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(size)x\(size).png" : "icon_\(size)x\(size)@2x.png"
        try iconPNG(pixels: size * scale).write(to: output.appendingPathComponent(name))
    }
}
if arguments.count == 3 {
    let web = URL(fileURLWithPath: arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: web, withIntermediateDirectories: true)
    for size in [32, 128] {
        try iconPNG(pixels: size).write(to: web.appendingPathComponent("app-icon-\(size).png"))
    }
}
print("wrote \(output.path)")
