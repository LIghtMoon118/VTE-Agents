import Foundation
import PDFKit
import Vision
import ImageIO
import AppKit

func jsonEscape(_ value: String) -> String {
  var result = ""
  for scalar in value.unicodeScalars {
    switch scalar {
    case "\"": result += "\\\""
    case "\\": result += "\\\\"
    case "\n": result += "\\n"
    case "\r": result += "\\r"
    case "\t": result += "\\t"
    default:
      if scalar.value < 0x20 {
        result += String(format: "\\u%04x", scalar.value)
      } else {
        result.append(String(scalar))
      }
    }
  }
  return result
}

func emit(status: String, text: String = "", note: String = "") {
  let limited = String(text.prefix(20000))
  print("{\"status\":\"\(jsonEscape(status))\",\"text\":\"\(jsonEscape(limited))\",\"note\":\"\(jsonEscape(note))\"}")
}

func extractPdfText(path: String) {
  guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
    emit(status: "error", note: "PDF 文件无法打开。")
    return
  }
  var pieces: [String] = []
  for index in 0..<document.pageCount {
    if let page = document.page(at: index), let text = page.string {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty {
        pieces.append(trimmed)
      }
    }
  }
  let text = pieces.joined(separator: "\n\n")
  if !text.isEmpty {
    emit(status: "ready", text: text)
    return
  }

  var ocrPieces: [String] = []
  for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.0
    let image = NSImage(size: NSSize(width: bounds.width * scale, height: bounds.height * scale))
    image.lockFocus()
    guard let context = NSGraphicsContext.current?.cgContext else {
      image.unlockFocus()
      continue
    }
    NSColor.white.setFill()
    context.fill(CGRect(x: 0, y: 0, width: bounds.width * scale, height: bounds.height * scale))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    image.unlockFocus()
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let cgImage = bitmap.cgImage else { continue }
    let pageText = recognizeText(in: cgImage)
    if !pageText.isEmpty {
      ocrPieces.append(pageText)
    }
  }
  let ocrText = ocrPieces.joined(separator: "\n\n")
  emit(status: ocrText.isEmpty ? "empty" : "ready", text: ocrText, note: ocrText.isEmpty ? "PDF 未检测到可复制文本层，OCR 也未识别到文字。" : "PDF 无文本层，已通过 OCR 识别。")
}

func recognizeText(in image: CGImage) -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  do {
    try handler.perform([request])
    let lines = (request.results ?? [])
      .compactMap { $0.topCandidates(1).first?.string }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return lines.joined(separator: "\n")
  } catch {
    return ""
  }
}

func extractImageText(path: String) {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    emit(status: "error", note: "图片文件无法打开。")
    return
  }

  let text = recognizeText(in: image)
  emit(status: text.isEmpty ? "empty" : "ready", text: text, note: text.isEmpty ? "图片 OCR 未识别到文字。" : "")
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  emit(status: "error", note: "Usage: extract-document-text.swift <pdf|image> <path>")
  exit(1)
}

let type = args[1]
let path = args[2]

if type == "pdf" {
  extractPdfText(path: path)
} else if type == "image" {
  extractImageText(path: path)
} else {
  emit(status: "unsupported", note: "不支持的文件类型：\(type)")
}
