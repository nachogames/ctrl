// ctrl-apple-speech: Apple's on-device speech recognition for Ctrl dictation.
//
// The server spawns this helper per dictation session on macOS 26+. It uses
// SpeechAnalyzer with DictationTranscriber, which always runs on device: this
// API has no server-recognition option (unlike SFSpeechRecognizer), so audio
// never leaves the machine. DictationTranscriber rather than SpeechTranscriber
// because only it honors AnalysisContext vocabulary: with "PayParty" as a
// custom word, SpeechTranscriber still wrote "pay party".
//
// Permissions: SpeechAnalyzer does not go through SFSpeechRecognizer
// authorization, so no NSSpeechRecognitionUsageDescription or authorization
// prompt is needed, and audio arrives over stdin, so no microphone access
// either. Verified by running this binary from a plain terminal on macOS 26.
//
// Usage:
//   ctrl-apple-speech probe [--locale <code|auto>]
//   ctrl-apple-speech install --locale <code|auto>
//   ctrl-apple-speech transcribe --locale <code|auto>
//
// stdin (transcribe only) is a sequence of frames:
//   1 byte kind, 4 byte little-endian payload length, payload
//   'C' JSON {"words": [String]}: custom vocabulary, sent before audio
//   'A' 16 kHz mono little-endian int16 PCM
//   'E' end of utterance: finalize, emit the last text, then exit (EOF is the same)
//
// stdout is newline-delimited JSON, one object per line with a "type":
//   probe {available, reason?, locale?, assets, locales}
//   progress {completed, total}   on-device language asset download
//   installed                     assets present
//   ready {locale}                transcribe accepts audio
//   partial {text}                volatile text for the current phrase
//   final {text}                  finalized text for one phrase
//   done                          all audio finalized
//   error {code, message}         code: unavailable | unsupported-locale | assets | failed

import AVFoundation
import Foundation
import Speech

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  stdoutLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  stdoutLock.unlock()
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(1)
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

enum Frame {
  case context([String])
  case audio(Data)
  case end
}

/// Reads frames on a dedicated thread so blocking stdin never stalls the analyzer.
func readFrames() -> AsyncStream<Frame> {
  AsyncStream { continuation in
    let thread = Thread {
      let input = FileHandle.standardInput
      func read(_ count: Int) -> Data? {
        var data = Data()
        while data.count < count {
          let chunk = input.readData(ofLength: count - data.count)
          if chunk.isEmpty { return nil }
          data.append(chunk)
        }
        return data
      }
      while true {
        guard let header = read(5) else { break }
        let kind = header[header.startIndex]
        let length = header.subdata(in: header.startIndex + 1..<header.startIndex + 5)
          .withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        guard length <= 16 * 1024 * 1024, let payload = read(Int(length)) else { break }
        switch kind {
        case UInt8(ascii: "C"):
          let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
          continuation.yield(.context((object?["words"] as? [String]) ?? []))
        case UInt8(ascii: "A"):
          continuation.yield(.audio(payload))
        case UInt8(ascii: "E"):
          continuation.yield(.end)
          continuation.finish()
          return
        default:
          continue
        }
      }
      continuation.yield(.end)
      continuation.finish()
    }
    thread.start()
  }
}

@available(macOS 26, *)
func resolveLocale(_ requested: String?) async -> Locale? {
  let wanted =
    requested == nil || requested == "auto" ? Locale.current : Locale(identifier: requested!)
  return await DictationTranscriber.supportedLocale(equivalentTo: wanted)
}

@available(macOS 26, *)
func makeTranscriber(_ locale: Locale) -> DictationTranscriber {
  DictationTranscriber(
    locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
    reportingOptions: [.volatileResults], attributeOptions: [])
}

@available(macOS 26, *)
func ensureAssets(_ transcriber: DictationTranscriber) async {
  if await AssetInventory.status(forModules: [transcriber]) == .installed { return }
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      let progress = request.progress
      let observation = progress.observe(\.fractionCompleted) { progress, _ in
        emit([
          "type": "progress", "completed": progress.completedUnitCount,
          "total": progress.totalUnitCount,
        ])
      }
      try await request.downloadAndInstall()
      observation.invalidate()
    }
  } catch {
    fail("assets", "Could not download Apple's speech assets: \(error.localizedDescription)")
  }
}

func localeCode(_ locale: Locale) -> String { locale.identifier(.bcp47) }

@available(macOS 26, *)
func probe() async {
  let supported = await DictationTranscriber.supportedLocales
  guard !supported.isEmpty else {
    emit([
      "type": "probe", "available": false, "reason": "Speech recognition is unavailable on this Mac.",
      "assets": "unsupported", "locales": [],
    ])
    return
  }
  let locales = supported.map { locale -> [String: String] in
    let code = localeCode(locale)
    return ["code": code, "label": Locale.current.localizedString(forIdentifier: locale.identifier) ?? code]
  }.sorted { $0["label"]! < $1["label"]! }
  guard let locale = await resolveLocale(argument("--locale")) else {
    emit(["type": "probe", "available": true, "assets": "unsupported", "locales": locales])
    return
  }
  let status = await AssetInventory.status(forModules: [makeTranscriber(locale)])
  let assets: String
  switch status {
  case .installed: assets = "installed"
  case .downloading: assets = "downloading"
  case .supported: assets = "supported"
  default: assets = "unsupported"
  }
  emit(["type": "probe", "available": true, "locale": localeCode(locale), "assets": assets, "locales": locales])
}

@available(macOS 26, *)
func install() async {
  guard let locale = await resolveLocale(argument("--locale")) else {
    fail("unsupported-locale", "Apple's speech recognition does not support this language.")
  }
  await ensureAssets(makeTranscriber(locale))
  emit(["type": "installed", "locale": localeCode(locale)])
}

@available(macOS 26, *)
func transcribe() async {
  guard let locale = await resolveLocale(argument("--locale")) else {
    fail("unsupported-locale", "Apple's speech recognition does not support this language.")
  }
  let transcriber = makeTranscriber(locale)
  await ensureAssets(transcriber)
  let inputFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  guard
    let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
      compatibleWith: [transcriber], considering: inputFormat)
  else { fail("failed", "No audio format is compatible with the speech model.") }
  let converter =
    analyzerFormat == inputFormat ? nil : AVAudioConverter(from: inputFormat, to: analyzerFormat)

  let (inputs, inputContinuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(
    modules: [transcriber],
    options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering))
  do {
    try await analyzer.prepareToAnalyze(in: analyzerFormat)
  } catch {
    fail("failed", "Could not prepare speech recognition: \(error.localizedDescription)")
  }
  let results = Task {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        emit(["type": result.isFinal ? "final" : "partial", "text": text])
      }
    } catch {
      fail("failed", "Speech recognition failed: \(error.localizedDescription)")
    }
  }
  emit(["type": "ready", "locale": localeCode(locale)])
  // Starting on the first audio frame lets vocabulary sent before it apply from the first word.
  var started = false
  func startIfNeeded() async {
    if started { return }
    started = true
    do {
      try await analyzer.start(inputSequence: inputs)
    } catch {
      fail("failed", "Could not start speech recognition: \(error.localizedDescription)")
    }
  }

  for await frame in readFrames() {
    switch frame {
    case .context(let words):
      let context = AnalysisContext()
      context.contextualStrings[.general] = words
      do { try await analyzer.setContext(context) } catch {
        // Vocabulary is a hint; transcription continues without it.
      }
    case .audio(let data):
      await startIfNeeded()
      let frames = AVAudioFrameCount(data.count / 2)
      guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames)
      else { continue }
      buffer.frameLength = frames
      data.withUnsafeBytes { raw in
        buffer.int16ChannelData![0].update(
          from: raw.bindMemory(to: Int16.self).baseAddress!, count: Int(frames))
      }
      if let converter {
        let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(frames) * ratio).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity)
        else { continue }
        var consumed = false
        var conversionError: NSError?
        converter.convert(to: output, error: &conversionError) { _, status in
          if consumed {
            status.pointee = .noDataNow
            return nil
          }
          consumed = true
          status.pointee = .haveData
          return buffer
        }
        if conversionError == nil, output.frameLength > 0 {
          inputContinuation.yield(AnalyzerInput(buffer: output))
        }
      } else {
        inputContinuation.yield(AnalyzerInput(buffer: buffer))
      }
    case .end:
      break
    }
  }
  inputContinuation.finish()
  await startIfNeeded()
  do {
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    fail("failed", "Could not finish speech recognition: \(error.localizedDescription)")
  }
  _ = await results.result
  emit(["type": "done"])
}

@available(macOS 26, *)
func run(_ command: String) async {
  switch command {
  case "probe": await probe()
  case "install": await install()
  case "transcribe": await transcribe()
  default: fail("failed", "Unknown command: \(command)")
  }
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if #available(macOS 26, *) {
  await run(command)
} else if command == "probe" {
  emit([
    "type": "probe", "available": false,
    "reason": "Apple's on-device dictation needs macOS 26 or later.", "assets": "unsupported",
    "locales": [],
  ])
} else {
  fail("unavailable", "Apple's on-device dictation needs macOS 26 or later.")
}
exit(0)
