import SwiftUI

/// The key window's model, so `Commands` can drive it (MAC-CONTRACT §2.3).
struct WindowModelKey: FocusedValueKey {
    typealias Value = WindowModel
}

extension FocusedValues {
    var windowModel: WindowModel? {
        get { self[WindowModelKey.self] }
        set { self[WindowModelKey.self] = newValue }
    }
}
