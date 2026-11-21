import Capacitor
import Foundation

/// The crypto engine lives here, in native code. The page only sees results over this narrow bridge.
@objc(VgSignalPlugin)
public class VgSignalPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VgSignalPlugin"
    public let jsName = "VgSignal"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "win.karatel.vanishgram.signal")
    private var engines: [Int: SignalEngine] = [:]
    private var next = 1

    @objc func open(_ call: CAPPluginCall) {
        queue.async {
            let id = self.next
            self.next += 1
            self.engines[id] = SignalEngine()
            call.resolve(["handle": id])
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        queue.async {
            self.engines.removeValue(forKey: call.getInt("handle") ?? 0)
            call.resolve()
        }
    }

    @objc func call(_ call: CAPPluginCall) {
        queue.async {
            do {
                guard let e = self.engines[call.getInt("handle") ?? 0], let method = call.getString("method"),
                      let raw = (call.getString("args") ?? "[]").data(using: .utf8),
                      let args = try JSONSerialization.jsonObject(with: raw) as? [Any] else { throw EngineError("bad request") }
                let out = try Bridge.dispatch(e, method, args)
                let wrapped = try JSONSerialization.data(withJSONObject: ["v": out])
                call.resolve(["result": String(decoding: wrapped, as: UTF8.self)])
            } catch {
                call.reject(String(describing: error))
            }
        }
    }
}
