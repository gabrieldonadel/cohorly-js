import Foundation

// Vendored from sdks/ios/Sources/Cohorly/DeviceInfo.swift (repo convention: shared
// logic is copied, not imported, to keep each package standalone). Kept to just the
// fields React Native core's `Platform`/`Dimensions` can't already provide - os/os
// version/screen size are derived JS-side instead.
enum CohorlyDeviceInfo {
    /// `CFBundleShortVersionString` (marketing version) of the host app.
    static var appVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// `CFBundleVersion` (build number) of the host app.
    static var appBuild: String? {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String
    }

    /// Hardware identifier from `utsname` (e.g. "iPhone15,2"). On the simulator
    /// this is the host architecture (e.g. "arm64"), which is acceptable.
    static var model: String? {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { raw -> String in
            guard let base = raw.baseAddress else { return "" }
            return String(cString: base.assumingMemoryBound(to: CChar.self))
        }
        return machine.isEmpty ? nil : machine
    }

    static func asDictionary() -> [String: Any] {
        var dict: [String: Any] = ["manufacturer": "Apple"]
        if let appVersion { dict["appVersion"] = appVersion }
        if let appBuild { dict["appBuild"] = appBuild }
        if let model { dict["model"] = model }
        return dict
    }
}
