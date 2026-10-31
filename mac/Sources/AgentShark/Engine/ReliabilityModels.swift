import Foundation

struct ReliabilityCallExemption: Codable, Hashable, Sendable {
    var tool: String
    var inputDigest: String
    var outputDigest: String
}

/// Shared with `POST /api/workbench/reliability`. Limits describe each session's own consumption.
struct ReliabilityPolicy: Codable, Hashable, Sendable {
    var minRepeats = 3
    var stopAfterRepeats = 5
    var tokenBudget: Int64?
    var timeBudgetUs: Int64?
    var allowedRepeatTools: [String] = []
    var allowedRepeatCalls: [ReliabilityCallExemption]?
    var advisoryOnly: Bool? = true
}

struct ReliabilityResult: WorkbenchResult {
    var schemaVersion: String
    var analysisVersion: String
    var coverage: WorkbenchCoverage
    var sessions: [String: WorkbenchSession]?
    var sessionId: String
    var policy: ReliabilityPolicy
    var summary: Summary
    var failureHandling: [Handling]
    var noProgress: [Repetition]
    var decisions: [Decision]
    var caveats: [String]

    struct Summary: Codable, Hashable, Sendable {
        var failureHandlingCandidates: Int
        var repeatedObservationChains: Int
        var stopRecommendations: Int
    }
    struct Handling: Codable, Hashable, Sendable {
        var rule: String
        var sessionId: String
        var confidence: WorkbenchConfidence
        var message: String
        var target: String
        var evidence: [EvidenceRef]
    }
    struct Repetition: Codable, Hashable, Sendable {
        var rule: String
        var sessionId: String
        var confidence: WorkbenchConfidence
        var tool: String?
        var outcome: String?
        /// Older 1.2 engines omit this field; the tool name remains a useful fallback.
        var target: String?
        var attempts: Int
        var evidence: [EvidenceRef]
        var measurement: Measurement
        var active: Bool
    }
    struct Measurement: Codable, Hashable, Sendable {
        var inputDigest: String
        var outputDigest: String
        var state: String
        var wallUs: Int64?
        var toolUs: Int64?
        var tokens: Int64?
        var usageEvents: Int
        var medianTokensPerRepeat: Double?
        var tokenSamples: Int
        var medianUsPerRepeat: Double?
    }
    struct Decision: Codable, Hashable, Sendable {
        var sessionId: String
        var decision: String
        var confidence: WorkbenchConfidence
        var reason: String
        var evidence: [EvidenceRef]
        var budget: Budget
    }
    struct Budget: Codable, Hashable, Sendable {
        var scope: String
        var tokenBudget: Int64?
        var usedTokens: Int64?
        var knownTokens: Int64
        var remainingTokens: Int64?
        var timeBudgetUs: Int64?
        var usedUs: Int64?
        var remainingUs: Int64?
        var forecast: Forecast
    }
    struct Forecast: Codable, Hashable, Sendable {
        var rule: String
        var confidence: WorkbenchConfidence
        var repeatsWithinTokenBudget: Int64?
        var repeatsWithinTimeBudget: Int64?
        var tokenSamples: Int
        var basis: String
    }
}
