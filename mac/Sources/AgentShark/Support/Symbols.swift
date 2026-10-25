import Foundation

/// SF Symbol names for kinds, tools, agents, severities and workspaces. Render them with hierarchical rendering.
enum Symbols {
    static func eventKind(_ kind: EventKind) -> String {
        switch kind {
        case .sessionMeta: return "info.circle"
        case .sessionState: return "slider.horizontal.3"
        case .userPrompt: return "person.fill"
        case .userInject: return "text.badge.plus"
        case .llmText: return "text.bubble"
        case .llmThinking: return "brain"
        case .llmUsage: return "gauge.with.dots.needle.33percent"
        case .llmError: return "exclamationmark.octagon"
        case .llmRefusal: return "hand.raised"
        case .toolCall: return "wrench.and.screwdriver"
        case .toolResult: return "arrow.turn.down.left"
        case .toolExec: return "terminal"
        case .agentSpawn: return "arrow.triangle.branch"
        case .agentMessage: return "envelope"
        case .agentStatus: return "person.2"
        case .contextAttachment: return "paperclip"
        case .contextCompaction: return "arrow.down.right.and.arrow.up.left"
        case .contextSnapshot: return "doc.text.magnifyingglass"
        case .turnStart: return "play.circle"
        case .turnEnd: return "stop.circle"
        case .turnAbort: return "xmark.circle"
        case .hookRun: return "bolt.horizontal"
        case .permissionRequest: return "lock.shield"
        case .permissionDecision: return "checkmark.shield"
        case .rawUnknown: return "questionmark.square.dashed"
        default:
            switch kind.layer {
            case "harness": return "gearshape"
            case "tool": return "wrench"
            case "agent": return "person.2"
            case "context": return "paperclip"
            default: return "circle"
            }
        }
    }

    /// For a tool kind tag (`shell`, `file`, …) or nil.
    static func toolKind(_ kind: String?) -> String {
        switch kind {
        case "shell": return "terminal"
        case "file": return "doc.text"
        case "web": return "globe"
        case "mcp": return "puzzlepiece.extension"
        case "agent": return "person.2"
        case "plan": return "checklist"
        case "custom": return "curlybraces"
        default: return "wrench"
        }
    }

    static func agent(_ agent: AgentKind) -> String {
        switch agent {
        case .claudeCode: return "terminal"
        case .claudeCowork: return "briefcase"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .copilot: return "airplane"
        default: return "cpu"
        }
    }

    /// For an API severity (`error | warn | note | chat`).
    static func severity(_ severity: String) -> String {
        switch severity {
        case "error": return "xmark.octagon.fill"
        case "warn": return "exclamationmark.triangle.fill"
        case "note": return "info.circle.fill"
        default: return "info.circle"
        }
    }

    static func spanKind(_ kind: SpanKind) -> String {
        switch kind {
        case .session: return "rectangle.stack"
        case .turn: return "arrow.uturn.right"
        case .llm: return "sparkles"
        case .tool: return "wrench.and.screwdriver"
        case .exec: return "terminal"
        case .workflow, .phase: return "flowchart"
        case .compaction: return "arrow.down.right.and.arrow.up.left"
        case .hook: return "bolt.horizontal"
        case .retry: return "arrow.clockwise"
        case .permission: return "lock.shield"
        default: return "circle"
        }
    }

    static func workspace(_ w: Workspace) -> String {
        switch w {
        case .failures: return "exclamationmark.triangle"
        case .events: return "list.bullet.rectangle"
        case .session: return "list.number"
        case .timeline: return "chart.bar.xaxis"
        case .stats: return "chart.pie"
        case .diagnostics: return "stethoscope"
        case .sources: return "externaldrive.connected.to.line.below"
        }
    }

    /// For a capability level (`logged | derived | partial | absent`).
    static func capabilityLevel(_ level: String) -> String {
        switch level {
        case "logged": return "checkmark.circle.fill"
        case "derived": return "equal.circle"
        case "partial": return "circle.lefthalf.filled"
        default: return "minus.circle"
        }
    }
}
