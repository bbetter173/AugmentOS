import Foundation
import Translation

/// Offline text translator using Apple's Translation framework (iOS 17.4+).
/// Manages a TranslationSession for on-device language translation.
@available(iOS 17.4, *)
class Translator {
    private static let TAG = "Translator"

    private static var session: TranslationSession?
    private static var configuration: TranslationSession.Configuration?

    /// Get available languages for translation.
    static func getAvailableLanguages() async -> [[String: String]] {
        let availability = LanguageAvailability()
        let languages = await availability.supportedLanguages
        return languages.map { lang in
            let code = lang.minimalIdentifier
            let locale = Locale(identifier: code)
            let name = locale.localizedString(forIdentifier: code) ?? code
            return ["code": code, "name": name]
        }
    }

    /// Check if a specific language pair is available for offline translation.
    static func checkLanguageAvailability(source: String, target: String) async -> [String: Any] {
        let availability = LanguageAvailability()
        let sourceLang = Locale.Language(identifier: source)
        let targetLang = Locale.Language(identifier: target)

        do {
            let status = try await availability.status(from: sourceLang, to: targetLang)
            switch status {
            case .installed:
                return ["available": true, "needsDownload": false]
            case .supported:
                return ["available": true, "needsDownload": true]
            case .unsupported:
                return ["available": false, "needsDownload": false]
            @unknown default:
                return ["available": false, "needsDownload": false]
            }
        } catch {
            NSLog("\(TAG): Error checking availability: \(error.localizedDescription)")
            return ["available": false, "error": error.localizedDescription]
        }
    }

    /// Prepare/download a language pair for offline use.
    static func prepareLanguage(source: String, target: String) async -> [String: Any] {
        let sourceLang = Locale.Language(identifier: source)
        let targetLang = Locale.Language(identifier: target)
        let config = TranslationSession.Configuration(source: sourceLang, target: targetLang)

        do {
            let session = try await TranslationSession(configuration: config)
            try await session.prepareTranslation()
            return ["success": true]
        } catch {
            NSLog("\(TAG): Error preparing language: \(error.localizedDescription)")
            return ["success": false, "error": error.localizedDescription]
        }
    }

    /// Start a translation session with given source and target language codes.
    static func startSession(source: String, target: String) async -> [String: Any] {
        let sourceLang = Locale.Language(identifier: source)
        let targetLang = Locale.Language(identifier: target)
        let config = TranslationSession.Configuration(source: sourceLang, target: targetLang)

        do {
            let newSession = try await TranslationSession(configuration: config)
            session = newSession
            configuration = config
            NSLog("\(TAG): Session started (\(source) -> \(target))")
            return ["success": true]
        } catch {
            NSLog("\(TAG): Error starting session: \(error.localizedDescription)")
            return ["success": false, "error": error.localizedDescription]
        }
    }

    /// Translate a single text string using the active session.
    static func translateText(_ text: String) async -> [String: Any] {
        guard let session = session else {
            return ["success": false, "error": "No active translation session"]
        }

        do {
            let response = try await session.translate(text)
            return ["success": true, "translatedText": response.targetText]
        } catch {
            NSLog("\(TAG): Error translating: \(error.localizedDescription)")
            return ["success": false, "error": error.localizedDescription]
        }
    }

    /// Stop the current translation session.
    static func stopSession() -> [String: Any] {
        session?.invalidate()
        session = nil
        configuration = nil
        NSLog("\(TAG): Session stopped")
        return ["success": true]
    }
}
