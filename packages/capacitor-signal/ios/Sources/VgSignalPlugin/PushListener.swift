import AVFoundation
import Foundation
import UIKit
import UserNotifications

/// Background messages on iPhone without Apple's push service (which needs a paid developer account).
/// While the app is in the background it plays silence so the system keeps it running, and holds one WebSocket per signed-in
/// account. A message shows a generic local notification. It cannot read messages (the keys stay in the app) and never
/// acknowledges them, so the server keeps the queue until the app itself opens and processes it.
final class PushListener: NSObject, URLSessionWebSocketDelegate {
    static let shared = PushListener()

    struct Account: Codable, Equatable { let id: String; let label: String; let token: String }
    struct Config: Codable { var base: String; var mode: String; var accounts: [Account] }

    private let queue = DispatchQueue(label: "win.karatel.vanishgram.push")
    private let defaults = UserDefaults.standard
    private var session: URLSession!
    private var conns: [String: Conn] = [:]
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var seen: [String]
    private var unread = 0
    private var started = false

    private override init() {
        seen = UserDefaults.standard.stringArray(forKey: "vg.push.seen") ?? []
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    // MARK: control

    func config() -> Config? {
        guard let d = defaults.data(forKey: "vg.push.cfg"), let c = try? JSONDecoder().decode(Config.self, from: d), !c.accounts.isEmpty else { return nil }
        return c
    }

    func apply(_ cfg: Config?) {
        if let cfg = cfg, let d = try? JSONEncoder().encode(cfg) {
            defaults.set(d, forKey: "vg.push.cfg")
        } else {
            defaults.removeObject(forKey: "vg.push.cfg"); defaults.removeObject(forKey: "vg.push.seen")
            queue.async { self.seen = [] }
        }
        queue.async { self.sync() }
        DispatchQueue.main.async { self.updateBackgroundState() }
    }

    func requestPermission(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in done(ok) }
    }

    /// Called once when the plugin loads.
    func observeLifecycle() {
        guard !started else { return }
        started = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in self.updateBackgroundState() }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            self.stopSilence()
            self.queue.async { self.unread = 0 }
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            UIApplication.shared.applicationIconBadgeNumber = 0
        }
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { n in
            if (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue { self.updateBackgroundState() }
        }
        queue.async { self.sync() }
    }

    // MARK: keep-alive audio (main thread)

    private func updateBackgroundState() {
        guard UIApplication.shared.applicationState != .active else { return }
        if config() != nil { startSilence() } else { stopSilence() }
    }

    private func startSilence() {
        if engine?.isRunning == true { return }
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try s.setActive(true)
            let e = AVAudioEngine(), p = AVAudioPlayerNode()
            let fmt = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
            let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 44100)!
            buf.frameLength = 44100 // one second of zeros
            e.attach(p); e.connect(p, to: e.mainMixerNode, format: fmt)
            try e.start()
            p.scheduleBuffer(buf, at: nil, options: .loops)
            p.play()
            engine = e; player = p
        } catch { engine = nil; player = nil }
    }

    private func stopSilence() {
        guard engine != nil else { return }
        player?.stop(); engine?.stop(); player = nil; engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: connections (on `queue`)

    private func sync() {
        guard let cfg = config() else { for c in conns.values { c.stop() }; conns.removeAll(); return }
        var keep = Set<String>()
        for a in cfg.accounts {
            keep.insert(a.id)
            if let c = conns[a.id], c.account == a, c.base == cfg.base { c.mode = cfg.mode; continue }
            conns[a.id]?.stop()
            let c = Conn(owner: self, account: a, base: cfg.base, mode: cfg.mode)
            conns[a.id] = c; c.start()
        }
        for (id, c) in conns where !keep.contains(id) { c.stop(); conns.removeValue(forKey: id) }
    }

    fileprivate func drop(_ id: String) {
        queue.async {
            guard var cfg = self.config() else { return }
            cfg.accounts.removeAll { $0.id == id }
            self.apply(cfg.accounts.isEmpty ? nil : cfg)
        }
    }

    private func fresh(_ id: String) -> Bool {
        if seen.contains(id) { return false }
        seen.append(id)
        if seen.count > 400 { seen.removeFirst(seen.count - 400) }
        defaults.set(seen, forKey: "vg.push.seen")
        return true
    }

    fileprivate func arrived(_ id: String, from conn: Conn) {
        queue.async {
            guard self.fresh(id) else { return }
            let label: String? = self.conns.count > 1 && conn.mode != "hidden" ? conn.account.label : nil
            self.unread += 1
            let n = self.unread
            DispatchQueue.main.async {
                guard UIApplication.shared.applicationState != .active else { return }
                let c = UNMutableNotificationContent()
                c.title = "Vanishgram"
                c.body = n == 1 ? (label.map { "New message in \($0)" } ?? "New message") : "\(n) new messages"
                c.sound = .default
                c.badge = NSNumber(value: n)
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "vg-msg", content: c, trigger: nil))
            }
        }
    }

    fileprivate final class Conn {
        unowned let owner: PushListener
        let account: Account, base: String
        var mode: String
        private var task: URLSessionWebSocketTask?
        private var stopped = false
        private var attempt = 0
        private var ping: DispatchSourceTimer?

        init(owner: PushListener, account: Account, base: String, mode: String) { self.owner = owner; self.account = account; self.base = base; self.mode = mode }

        func start() {
            guard !stopped, var comps = URLComponents(string: base) else { return }
            comps.scheme = comps.scheme == "http" ? "ws" : "wss"
            comps.path = "/v1/ws"
            guard let url = comps.url else { return }
            let t = owner.session.webSocketTask(with: url, protocols: [account.token])
            task = t; t.resume(); receive(t)
            let timer = DispatchSource.makeTimerSource(queue: owner.queue)
            timer.schedule(deadline: .now() + 30, repeating: 30)
            timer.setEventHandler { [weak t] in t?.sendPing { _ in } }
            timer.resume(); ping = timer
        }

        func stop() { stopped = true; ping?.cancel(); task?.cancel(with: .goingAway, reason: nil) }

        private func receive(_ t: URLSessionWebSocketTask) {
            t.receive { [weak self] result in
                guard let self = self, !self.stopped else { return }
                switch result {
                case .success(let msg):
                    self.attempt = 0
                    if case .string(let text) = msg { self.handle(text) }
                    self.receive(t)
                case .failure:
                    self.ping?.cancel()
                    let status = (t.response as? HTTPURLResponse)?.statusCode
                    if t.closeCode.rawValue == 4002 || status == 401 { self.stopped = true; self.owner.drop(self.account.id); return }
                    let wait = min(60.0, Double(1 << min(self.attempt, 6))); self.attempt += 1
                    self.owner.queue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.start() }
                }
            }
        }

        private func handle(_ text: String) {
            guard let d = text.data(using: .utf8), let f = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  f["type"] as? String == "message", let m = f["message"] as? [String: Any],
                  let id = m["id"] as? String, !id.isEmpty, (m["from"] as? String) != account.id else { return }
            owner.arrived(id, from: self)
        }
    }
}
