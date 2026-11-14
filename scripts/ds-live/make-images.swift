import AppKit
import Foundation

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
func save(_ image: NSImage, _ name: String) {
  guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let png = rep.representation(using: .png, properties: [:]) else { exit(2) }
  try! png.write(to: URL(fileURLWithPath: outDir + "/" + name))
}
func para(_ align: NSTextAlignment = .left) -> NSMutableParagraphStyle {
  let p = NSMutableParagraphStyle(); p.alignment = align; p.lineSpacing = 8; return p
}
func font(_ name: String, _ size: CGFloat) -> NSFont {
  return NSFont(name: name, size: size) ?? NSFont.systemFont(ofSize: size)
}
func draw(_ text: String, _ rect: NSRect, _ f: NSFont, _ color: NSColor = .black, _ align: NSTextAlignment = .left) {
  (text as NSString).draw(in: rect, withAttributes: [.font: f, .foregroundColor: color, .paragraphStyle: para(align)])
}

// 1) title + body
let img1 = NSImage(size: NSSize(width: 1200, height: 800))
img1.lockFocus()
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1200, height: 800).fill()
NSColor(calibratedRed: 0.10, green: 0.35, blue: 0.75, alpha: 1).setFill()
NSRect(x: 0, y: 680, width: 1200, height: 120).fill()
draw("2026年11月14日 项目周报", NSRect(x: 60, y: 700, width: 1080, height: 80), font("PingFang SC Semibold", 52), .white)
draw("AI 范儿 · 第 42 期", NSRect(x: 60, y: 580, width: 1000, height: 60), font("PingFang SC", 36), .darkGray)
draw("本周完成 3 个包，修复 17 个问题，剩余 2 个。\n语音闭环 8.96 秒，数字 2026 和名字张伟都要读对。", NSRect(x: 60, y: 300, width: 1080, height: 220), font("Songti SC", 40))
img1.unlockFocus(); save(img1, "title.png")

// 2) table
let img2 = NSImage(size: NSSize(width: 1200, height: 800))
img2.lockFocus()
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1200, height: 800).fill()
draw("本周能力验收表", NSRect(x: 60, y: 700, width: 1080, height: 70), font("PingFang SC Semibold", 44))
let cols: [CGFloat] = [60, 420, 640, 860, 1080]
let rows: [CGFloat] = [620, 520, 420, 320]
let headers = ["能力", "调用次数", "金额（元）", "状态"]
let data = [["语音识别", "128", "7.42", "已验收"], ["图片识别", "35", "0.08", "进行中"], ["文档读取", "12", "0.00", "待接线"]]
NSColor.black.setStroke()
for y in rows { let p = NSBezierPath(); p.move(to: NSPoint(x: cols[0], y: y)); p.line(to: NSPoint(x: cols[4], y: y)); p.lineWidth = 2; p.stroke() }
for x in cols { let p = NSBezierPath(); p.move(to: NSPoint(x: x, y: rows[0])); p.line(to: NSPoint(x: x, y: rows[3])); p.lineWidth = 2; p.stroke() }
for (i, h) in headers.enumerated() { draw(h, NSRect(x: cols[i] + 12, y: 640, width: cols[i+1] - cols[i] - 20, height: 50), font("PingFang SC Semibold", 30)) }
for (r, row) in data.enumerated() {
  for (i, cell) in row.enumerated() {
    draw(cell, NSRect(x: cols[i] + 12, y: rows[r+1] + 28, width: cols[i+1] - cols[i] - 20, height: 50), font("Songti SC", 30))
  }
}
img2.unlockFocus(); save(img2, "table.png")

// 3) handwriting feel
let img3 = NSImage(size: NSSize(width: 1200, height: 800))
img3.lockFocus()
NSColor(calibratedRed: 0.98, green: 0.97, blue: 0.92, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 1200, height: 800).fill()
NSColor(calibratedRed: 0.75, green: 0.82, blue: 0.9, alpha: 0.6).setStroke()
for i in 0..<16 { let y = CGFloat(80 + i * 45); let p = NSBezierPath(); p.move(to: NSPoint(x: 60, y: y)); p.line(to: NSPoint(x: 1140, y: y)); p.lineWidth = 1; p.stroke() }
let hand = font("Hannotate SC", 52)
draw("今天的重点是：语音闭环要跑通，", NSRect(x: 70, y: 560, width: 1060, height: 80), hand, NSColor(calibratedRed: 0.15, green: 0.2, blue: 0.55, alpha: 1))
draw("数字 2026 和名字张伟不能错。", NSRect(x: 70, y: 460, width: 1060, height: 80), hand, NSColor(calibratedRed: 0.15, green: 0.2, blue: 0.55, alpha: 1))
draw("—— 测试员 11月14日", NSRect(x: 620, y: 330, width: 500, height: 70), font("Hannotate SC", 36), .darkGray, .right)
img3.unlockFocus(); save(img3, "handwriting.png")
print("ok")
