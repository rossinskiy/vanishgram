import Capacitor
import Foundation

/// Background message notifications (see PushListener): the page hands over the signed-in sessions.
@objc(VgPushPlugin)
public class VgPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VgPushPlugin"
    public let jsName = "VgPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    override public func load() { PushListener.shared.observeLifecycle() }

    @objc func requestPermission(_ call: CAPPluginCall) {
        PushListener.shared.requestPermission { ok in call.resolve(["granted": ok]) }
    }

    @objc func start(_ call: CAPPluginCall) {
        let list = (call.getArray("accounts") as? [[String: Any]] ?? []).compactMap { a -> PushListener.Account? in
            guard let id = a["id"] as? String, let token = a["token"] as? String, !id.isEmpty, !token.isEmpty else { return nil }
            return PushListener.Account(id: id, label: a["label"] as? String ?? "", token: token)
        }
        PushListener.shared.apply(list.isEmpty ? nil : PushListener.Config(base: call.getString("base") ?? "", mode: call.getString("mode") ?? "hidden", accounts: list))
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        PushListener.shared.apply(nil)
        call.resolve()
    }
}
