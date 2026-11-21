// A self-check of the native engine, run only when the app is started with the launch argument -vg-selftest (the CI simulator
// test does this). It goes through the same JSON bridge the page uses: two engines do a key exchange and a message round trip.
import Capacitor
import Foundation

enum SelfTest {
    private static func call(_ e: SignalEngine, _ method: String, _ args: [Any]) throws -> Any {
        let raw = try JSONSerialization.data(withJSONObject: args)
        guard let parsed = try JSONSerialization.jsonObject(with: raw) as? [Any] else { throw EngineError("bad args") }
        let out = try Bridge.dispatch(e, method, parsed)
        let wrapped = try JSONSerialization.data(withJSONObject: ["v": out])
        guard let o = try JSONSerialization.jsonObject(with: wrapped) as? [String: Any] else { throw EngineError("bad result") }
        return o["v"] ?? NSNull()
    }

    private static func bytes(_ s: String) -> [String: Any] { Bridge.u8(Data(s.utf8)) }
    private static func text(_ o: Any) throws -> String { String(decoding: try Bridge.bytes(o), as: UTF8.self) }
    private static func check(_ ok: Bool, _ what: String) throws { if !ok { throw EngineError("check failed: \(what)") } }

    private static func bundle(_ e: SignalEngine) throws -> [String: Any] {
        let otks = try call(e, "newOneTimePrekeys", [1]) as? [Any] ?? []
        return ["identityKey": try call(e, "identityKey", []), "registrationId": try call(e, "registrationId", []),
                "signedPrekey": try call(e, "signedPrekey", []), "kyberPrekey": try call(e, "kyberPrekey", []), "oneTimePrekey": otks.first ?? NSNull()]
    }

    static func run() throws {
        let a = SignalEngine(), c = SignalEngine()
        _ = try call(a, "create", []); _ = try call(c, "create", [])
        let ab = try bundle(a), cb = try bundle(c)
        _ = try call(a, "trust", ["c:1", cb["identityKey"] as Any]); _ = try call(c, "trust", ["a:1", ab["identityKey"] as Any])
        _ = try call(a, "processBundle", ["c:1", 1, cb])
        guard let ct = try call(a, "encrypt", ["c:1", bytes("hello")]) as? [String: Any] else { throw EngineError("no ciphertext") }
        try check((ct["type"] as? Int) == 3, "first message is a prekey message")
        try check(try text(call(c, "decrypt", ["a:1", ct])) == "hello", "first message decrypts")
        guard let ct2 = try call(c, "encrypt", ["a:1", bytes("back")]) as? [String: Any] else { throw EngineError("no reply") }
        try check((ct2["type"] as? Int) == 2, "reply is a ratchet message")
        try check(try text(call(a, "decrypt", ["c:1", ct2])) == "back", "reply decrypts")
        try check((try call(a, "hasSession", ["c:1"]) as? Bool) == true, "session exists")
        // state survives a save and load, and the engine keeps working
        let state = try call(a, "save", [])
        let a2 = SignalEngine()
        _ = try call(a2, "load", [state])
        try check((try call(a2, "identityKey", []) as? String) == (ab["identityKey"] as? String), "identity restored")
        guard let ct3 = try call(c, "encrypt", ["a:1", bytes("after reload")]) as? [String: Any] else { throw EngineError("no third message") }
        try check(try text(call(a2, "decrypt", ["c:1", ct3])) == "after reload", "message after reload")
        // a replayed first message is refused
        let c2 = SignalEngine(); _ = try call(c2, "create", [])
        let b2 = try bundle(c2)
        _ = try call(c2, "trust", ["a:1", ab["identityKey"] as Any]); _ = try call(a, "trust", ["c2:1", b2["identityKey"] as Any])
        _ = try call(a, "processBundle", ["c2:1", 1, b2])
        guard let first = try call(a, "encrypt", ["c2:1", bytes("once")]) as? [String: Any] else { throw EngineError("no message") }
        _ = try call(c2, "decrypt", ["a:1", first])
        var refused = false
        do { _ = try call(c2, "decrypt", ["a:1", first]) } catch { refused = true }
        try check(refused, "replayed message refused")
    }
}
