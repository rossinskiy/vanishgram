// Pairwise end-to-end encryption on the official libsignal (PQXDH + Double Ratchet), the iOS twin of
// packages/signal-engine. Same behaviour and the same state format, so every engine is interchangeable behind SignalProvider.
// AGPL-3.0-only, because libsignal is.
import Foundation
import LibSignalClient

struct EngineError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

private struct Ctx: StoreContext {}

final class SignalEngine: IdentityKeyStore, PreKeyStore, SignedPreKeyStore, KyberPreKeyStore, SessionStore {
    private static let keepOld = 3
    private let ctx = Ctx()
    private let lock = NSRecursiveLock()

    private var identity: IdentityKeyPair!
    private var regId: UInt32 = 0
    private var spkId: UInt32 = 0, kyberId: UInt32 = 0, nextOpk: UInt32 = 1
    private var spk: [UInt32: SignedPreKeyRecord] = [:]
    private var kyber: [UInt32: KyberPreKeyRecord] = [:]
    private var opk: [UInt32: PreKeyRecord] = [:]
    private var sessions: [String: SessionRecord] = [:]
    private var trusted: [String: Data] = [:]
    private var usedKyber = Set<String>()

    private static func b64(_ d: Data) -> String { d.base64EncodedString() }
    private static func unb64(_ s: String) throws -> Data {
        guard let d = Data(base64Encoded: s) else { throw EngineError("bad base64") }
        return d
    }
    private func addr(_ name: String) throws -> ProtocolAddress { try ProtocolAddress(name: name, deviceId: 1) }

    // MARK: libsignal store callbacks, backed by the maps above

    func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair { identity }
    func localRegistrationId(context: StoreContext) throws -> UInt32 { regId }
    func saveIdentity(_ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext) throws -> IdentityChange {
        let had = trusted[address.name]
        let now = identity.serialize()
        trusted[address.name] = now
        if let had = had, had != now { return .replacedExisting }
        return .newOrUnchanged
    }
    // Only a key that the caller has already checked against the account certificate is trusted.
    func isTrustedIdentity(_ identity: IdentityKey, for address: ProtocolAddress, direction: Direction, context: StoreContext) throws -> Bool {
        guard let t = trusted[address.name] else { return false }
        return t == identity.serialize()
    }
    func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
        guard let t = trusted[address.name] else { return nil }
        return try IdentityKey(bytes: t)
    }

    func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
        guard let r = opk[id] else { throw EngineError("unknown one-time prekey") }
        return r
    }
    func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws { opk[id] = record }
    func removePreKey(id: UInt32, context: StoreContext) throws { opk.removeValue(forKey: id) } // one-time means one-time

    func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
        guard let r = spk[id] else { throw EngineError("unknown signed prekey") }
        return r
    }
    func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws { spk[id] = record }

    func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
        guard let r = kyber[id] else { throw EngineError("unknown kyber prekey") }
        return r
    }
    func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws { kyber[id] = record }
    func markKyberPreKeyUsed(id: UInt32, signedPreKeyId: UInt32, baseKey: PublicKey, context: StoreContext) throws {
        // Last-resort Kyber keys may be reused, but the exact (key, base key) pair must never repeat: that would be a replay.
        let tag = "\(id):\(signedPreKeyId):\(Self.b64(baseKey.serialize()))"
        if usedKyber.contains(tag) { throw EngineError("replayed first message") }
        usedKyber.insert(tag)
    }

    func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? { sessions[address.name] }
    func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
        try addresses.map { a in
            guard let s = sessions[a.name] else { throw EngineError("no session") }
            return s
        }
    }
    func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws { sessions[address.name] = record }

    // MARK: operations (one at a time)

    func create() throws {
        lock.lock(); defer { lock.unlock() }
        identity = IdentityKeyPair.generate()
        regId = UInt32.random(in: 1...0x3ffe) // 14 bits, as in libsignal
        spk.removeAll(); kyber.removeAll(); opk.removeAll(); sessions.removeAll(); trusted.removeAll(); usedKyber.removeAll()
        spkId = 0; kyberId = 0; nextOpk = 1
        try rotate()
    }

    func rotate() throws {
        lock.lock(); defer { lock.unlock() }
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        let sk = PrivateKey.generate(); spkId += 1
        spk[spkId] = try SignedPreKeyRecord(id: spkId, timestamp: now, privateKey: sk, signature: identity.privateKey.generateSignature(message: sk.publicKey.serialize()))
        let kp = KEMKeyPair.generate(); kyberId += 1
        kyber[kyberId] = try KyberPreKeyRecord(id: kyberId, timestamp: now, keyPair: kp, signature: identity.privateKey.generateSignature(message: kp.publicKey.serialize()))
        for id in spk.keys.sorted(by: >).dropFirst(Self.keepOld) { spk.removeValue(forKey: id) }
        for id in kyber.keys.sorted(by: >).dropFirst(Self.keepOld) { kyber.removeValue(forKey: id) }
    }

    func newOneTimePrekeys(_ count: Int) throws -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        var out: [[String: Any]] = []
        for _ in 0..<max(0, count) {
            let k = PrivateKey.generate(); let id = nextOpk; nextOpk += 1
            opk[id] = try PreKeyRecord(id: id, privateKey: k)
            out.append(["id": Int(id), "pub": Self.b64(k.publicKey.serialize())])
        }
        return out
    }
    func oneTimePrekeyCount() -> Int { lock.lock(); defer { lock.unlock() }; return opk.count }
    func identityKey() -> String { lock.lock(); defer { lock.unlock() }; return Self.b64(identity.publicKey.serialize()) }
    func registrationId() -> Int { lock.lock(); defer { lock.unlock() }; return Int(regId) }
    func signedPrekey() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard let r = spk[spkId] else { throw EngineError("no signed prekey") }
        return ["id": Int(r.id), "pub": Self.b64(try r.publicKey().serialize()), "sig": Self.b64(r.signature)]
    }
    func kyberPrekey() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard let r = kyber[kyberId] else { throw EngineError("no kyber prekey") }
        return ["id": Int(r.id), "pub": Self.b64(try r.publicKey().serialize()), "sig": Self.b64(r.signature)]
    }

    func verify(_ identityKey: String, _ message: Data, _ signature: String) -> Bool {
        guard let k = try? PublicKey(Self.unb64(identityKey)), let sig = try? Self.unb64(signature) else { return false }
        return (try? k.verifySignature(message: message, signature: sig)) ?? false
    }
    func trust(_ peer: String, _ identityKey: String) throws {
        lock.lock(); defer { lock.unlock() }
        let now = try Self.unb64(identityKey)
        if let had = trusted[peer], had != now { sessions.removeValue(forKey: peer) } // a changed key invalidates the old session
        trusted[peer] = now
    }
    func hasSession(_ peer: String) -> Bool { lock.lock(); defer { lock.unlock() }; return sessions[peer]?.hasCurrentState ?? false }
    func dropSession(_ peer: String) { lock.lock(); defer { lock.unlock() }; sessions.removeValue(forKey: peer); trusted.removeValue(forKey: peer) }

    func processBundle(_ peer: String, _ remoteDeviceId: Int, _ b: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        guard let s = b["signedPrekey"] as? [String: Any], let k = b["kyberPrekey"] as? [String: Any],
              let reg = b["registrationId"] as? Int, let ik = b["identityKey"] as? String,
              let sid = s["id"] as? Int, let spub = s["pub"] as? String, let ssig = s["sig"] as? String,
              let kid = k["id"] as? Int, let kpub = k["pub"] as? String, let ksig = k["sig"] as? String else { throw EngineError("bad bundle") }
        let identityKey = try IdentityKey(bytes: Self.unb64(ik))
        let signedPub = try PublicKey(Self.unb64(spub)), kyberPub = try KEMPublicKey(Self.unb64(kpub))
        let bundle: PreKeyBundle
        if let o = b["oneTimePrekey"] as? [String: Any], let oid = o["id"] as? Int, let opub = o["pub"] as? String {
            bundle = try PreKeyBundle(registrationId: UInt32(reg), deviceId: UInt32(remoteDeviceId), prekeyId: UInt32(oid), prekey: PublicKey(Self.unb64(opub)),
                                      signedPrekeyId: UInt32(sid), signedPrekey: signedPub, signedPrekeySignature: Self.unb64(ssig), identity: identityKey,
                                      kyberPrekeyId: UInt32(kid), kyberPrekey: kyberPub, kyberPrekeySignature: Self.unb64(ksig))
        } else {
            bundle = try PreKeyBundle(registrationId: UInt32(reg), deviceId: UInt32(remoteDeviceId),
                                      signedPrekeyId: UInt32(sid), signedPrekey: signedPub, signedPrekeySignature: Self.unb64(ssig), identity: identityKey,
                                      kyberPrekeyId: UInt32(kid), kyberPrekey: kyberPub, kyberPrekeySignature: Self.unb64(ksig))
        }
        try processPreKeyBundle(bundle, for: addr(peer), sessionStore: self, identityStore: self, context: ctx)
    }

    func encrypt(_ peer: String, _ plaintext: Data) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let ct = try signalEncrypt(message: plaintext, for: addr(peer), sessionStore: self, identityStore: self, context: ctx)
        return ["type": Int(ct.messageType.rawValue), "body": Bridge.u8(ct.serialize())]
    }

    func decrypt(_ peer: String, _ type: Int, _ body: Data) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        let a = try addr(peer)
        if type == Int(CiphertextMessage.MessageType.preKey.rawValue) {
            let m = try PreKeySignalMessage(bytes: body)
            return try signalDecryptPreKey(message: m, from: a, sessionStore: self, identityStore: self, preKeyStore: self, signedPreKeyStore: self, kyberPreKeyStore: self, context: ctx)
        }
        if type == Int(CiphertextMessage.MessageType.whisper.rawValue) {
            return try signalDecrypt(message: SignalMessage(bytes: body), from: a, sessionStore: self, identityStore: self, context: ctx)
        }
        throw EngineError("unsupported message type")
    }

    // MARK: persistence (same JSON format as the Node engine)

    func save() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        var s: [String: Any] = ["v": 1, "identity": Self.b64(identity.privateKey.serialize()), "regId": Int(regId), "spkId": Int(spkId), "kyberId": Int(kyberId), "nextOpk": Int(nextOpk)]
        s["spk"] = Dictionary(uniqueKeysWithValues: spk.map { (String($0.key), Self.b64($0.value.serialize())) })
        s["kyber"] = Dictionary(uniqueKeysWithValues: kyber.map { (String($0.key), Self.b64($0.value.serialize())) })
        s["opk"] = Dictionary(uniqueKeysWithValues: opk.map { (String($0.key), Self.b64($0.value.serialize())) })
        s["sessions"] = Dictionary(uniqueKeysWithValues: sessions.map { ($0.key, Self.b64($0.value.serialize())) })
        s["trusted"] = Dictionary(uniqueKeysWithValues: trusted.map { ($0.key, Self.b64($0.value)) })
        s["usedKyber"] = Array(usedKyber)
        return try JSONSerialization.data(withJSONObject: s)
    }

    func load(_ state: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard let s = try JSONSerialization.jsonObject(with: state) as? [String: Any], (s["v"] as? Int) == 1 else { throw EngineError("unknown signal state version") }
        func map(_ k: String) throws -> [String: String] { guard let m = s[k] as? [String: String] else { throw EngineError("corrupt signal state") }; return m }
        guard let idb = s["identity"] as? String, let r = s["regId"] as? Int, let si = s["spkId"] as? Int, let ki = s["kyberId"] as? Int, let no = s["nextOpk"] as? Int else { throw EngineError("corrupt signal state") }
        let priv = try PrivateKey(Self.unb64(idb))
        identity = IdentityKeyPair(publicKey: priv.publicKey, privateKey: priv)
        regId = UInt32(r); spkId = UInt32(si); kyberId = UInt32(ki); nextOpk = UInt32(no)
        spk = try map("spk").reduce(into: [:]) { $0[UInt32($1.key) ?? 0] = try SignedPreKeyRecord(bytes: Self.unb64($1.value)) }
        kyber = try map("kyber").reduce(into: [:]) { $0[UInt32($1.key) ?? 0] = try KyberPreKeyRecord(bytes: Self.unb64($1.value)) }
        opk = try map("opk").reduce(into: [:]) { $0[UInt32($1.key) ?? 0] = try PreKeyRecord(bytes: Self.unb64($1.value)) }
        sessions = try map("sessions").reduce(into: [:]) { $0[$1.key] = try SessionRecord(bytes: Self.unb64($1.value)) }
        trusted = try map("trusted").reduce(into: [:]) { $0[$1.key] = try Self.unb64($1.value) }
        usedKyber = Set(s["usedKyber"] as? [String] ?? [])
    }
}

/// Byte arrays cross the page boundary as {"$u8": "<base64>"}; everything else is plain JSON.
enum Bridge {
    static func u8(_ d: Data) -> [String: Any] { ["$u8": d.base64EncodedString()] }
    static func bytes(_ o: Any?) throws -> Data {
        guard let m = o as? [String: Any], let s = m["$u8"] as? String, let d = Data(base64Encoded: s) else { throw EngineError("expected bytes") }
        return d
    }
    private static func str(_ a: [Any], _ i: Int) throws -> String { guard i < a.count, let s = a[i] as? String else { throw EngineError("bad request") }; return s }
    private static func int(_ a: [Any], _ i: Int) throws -> Int { guard i < a.count, let n = a[i] as? NSNumber else { throw EngineError("bad request") }; return n.intValue }

    /// Runs one engine method. Method names are the SignalProvider interface of the interface layer.
    static func dispatch(_ e: SignalEngine, _ method: String, _ a: [Any]) throws -> Any {
        switch method {
        case "create": try e.create(); return NSNull()
        case "load": try e.load(bytes(a.first)); return NSNull()
        case "save": return u8(try e.save())
        case "identityKey": return e.identityKey()
        case "registrationId": return e.registrationId()
        case "signedPrekey": return try e.signedPrekey()
        case "kyberPrekey": return try e.kyberPrekey()
        case "newOneTimePrekeys": return try e.newOneTimePrekeys(int(a, 0))
        case "oneTimePrekeyCount": return e.oneTimePrekeyCount()
        case "rotatePrekeys": try e.rotate(); return NSNull()
        case "verify": return e.verify(try str(a, 0), try bytes(a.count > 1 ? a[1] : nil), try str(a, 2))
        case "trust": try e.trust(str(a, 0), str(a, 1)); return NSNull()
        case "hasSession": return e.hasSession(try str(a, 0))
        case "processBundle":
            guard a.count > 2, let b = a[2] as? [String: Any] else { throw EngineError("bad request") }
            try e.processBundle(str(a, 0), int(a, 1), b); return NSNull()
        case "encrypt": return try e.encrypt(str(a, 0), bytes(a.count > 1 ? a[1] : nil))
        case "decrypt":
            guard a.count > 1, let ct = a[1] as? [String: Any], let t = ct["type"] as? Int else { throw EngineError("bad request") }
            return u8(try e.decrypt(str(a, 0), t, bytes(ct["body"])))
        case "dropSession": e.dropSession(try str(a, 0)); return NSNull()
        default: throw EngineError("bad request")
        }
    }
}
