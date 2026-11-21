package win.karatel.vanishgram.signal;

// Pairwise end-to-end encryption on the official libsignal (PQXDH + Double Ratchet), the Android twin of
// packages/signal-engine. Same behaviour and the same state format, so both engines are interchangeable behind SignalProvider.
// AGPL-3.0-only, because libsignal is.

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;
import org.signal.libsignal.protocol.IdentityKey;
import org.signal.libsignal.protocol.IdentityKeyPair;
import org.signal.libsignal.protocol.InvalidKeyIdException;
import org.signal.libsignal.protocol.NoSessionException;
import org.signal.libsignal.protocol.ReusedBaseKeyException;
import org.signal.libsignal.protocol.SessionBuilder;
import org.signal.libsignal.protocol.SessionCipher;
import org.signal.libsignal.protocol.SignalProtocolAddress;
import org.signal.libsignal.protocol.ecc.ECKeyPair;
import org.signal.libsignal.protocol.ecc.ECPrivateKey;
import org.signal.libsignal.protocol.ecc.ECPublicKey;
import org.signal.libsignal.protocol.groups.state.SenderKeyRecord;
import org.signal.libsignal.protocol.kem.KEMKeyPair;
import org.signal.libsignal.protocol.kem.KEMKeyType;
import org.signal.libsignal.protocol.kem.KEMPublicKey;
import org.signal.libsignal.protocol.message.CiphertextMessage;
import org.signal.libsignal.protocol.message.PreKeySignalMessage;
import org.signal.libsignal.protocol.message.SignalMessage;
import org.signal.libsignal.protocol.state.IdentityKeyStore;
import org.signal.libsignal.protocol.state.KyberPreKeyRecord;
import org.signal.libsignal.protocol.state.PreKeyBundle;
import org.signal.libsignal.protocol.state.PreKeyRecord;
import org.signal.libsignal.protocol.state.SessionRecord;
import org.signal.libsignal.protocol.state.SignalProtocolStore;
import org.signal.libsignal.protocol.state.SignedPreKeyRecord;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

final class SignalEngine implements SignalProtocolStore {
    private static final int KEEP_OLD = 3;
    private static final SecureRandom RNG = new SecureRandom();

    private IdentityKeyPair identity;
    private int regId, spkId, kyberId, nextOpk = 1;
    private final TreeMap<Integer, SignedPreKeyRecord> spk = new TreeMap<>();
    private final TreeMap<Integer, KyberPreKeyRecord> kyber = new TreeMap<>();
    private final TreeMap<Integer, PreKeyRecord> opk = new TreeMap<>();
    private final HashMap<String, SessionRecord> sessions = new HashMap<>();
    private final HashMap<String, byte[]> trusted = new HashMap<>();
    private final HashSet<String> usedKyber = new HashSet<>();

    private static String b64(byte[] u) { return Base64.encodeToString(u, Base64.NO_WRAP); }
    private static byte[] unb64(String s) { return Base64.decode(s, Base64.DEFAULT); }
    private static SignalProtocolAddress addr(String name) { return new SignalProtocolAddress(name, 1); }

    // ---- libsignal store callbacks, backed by the maps above ----
    @Override public IdentityKeyPair getIdentityKeyPair() { return identity; }
    @Override public int getLocalRegistrationId() { return regId; }
    @Override public IdentityKeyStore.IdentityChange saveIdentity(SignalProtocolAddress a, IdentityKey k) {
        byte[] had = trusted.get(a.getName());
        trusted.put(a.getName(), k.serialize());
        return had != null && !Arrays.equals(had, k.serialize()) ? IdentityKeyStore.IdentityChange.REPLACED_EXISTING : IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED;
    }
    // Only a key that the caller has already checked against the account certificate is trusted.
    @Override public boolean isTrustedIdentity(SignalProtocolAddress a, IdentityKey k, IdentityKeyStore.Direction d) {
        byte[] t = trusted.get(a.getName());
        return t != null && Arrays.equals(t, k.serialize());
    }
    @Override public IdentityKey getIdentity(SignalProtocolAddress a) {
        byte[] t = trusted.get(a.getName());
        try { return t == null ? null : new IdentityKey(t); } catch (Exception e) { return null; }
    }

    @Override public PreKeyRecord loadPreKey(int id) throws InvalidKeyIdException { PreKeyRecord r = opk.get(id); if (r == null) throw new InvalidKeyIdException("unknown one-time prekey"); return r; }
    @Override public void storePreKey(int id, PreKeyRecord r) { opk.put(id, r); }
    @Override public boolean containsPreKey(int id) { return opk.containsKey(id); }
    @Override public void removePreKey(int id) { opk.remove(id); } // one-time means one-time

    @Override public SignedPreKeyRecord loadSignedPreKey(int id) throws InvalidKeyIdException { SignedPreKeyRecord r = spk.get(id); if (r == null) throw new InvalidKeyIdException("unknown signed prekey"); return r; }
    @Override public List<SignedPreKeyRecord> loadSignedPreKeys() { return new ArrayList<>(spk.values()); }
    @Override public void storeSignedPreKey(int id, SignedPreKeyRecord r) { spk.put(id, r); }
    @Override public boolean containsSignedPreKey(int id) { return spk.containsKey(id); }
    @Override public void removeSignedPreKey(int id) { spk.remove(id); }

    @Override public KyberPreKeyRecord loadKyberPreKey(int id) throws InvalidKeyIdException { KyberPreKeyRecord r = kyber.get(id); if (r == null) throw new InvalidKeyIdException("unknown kyber prekey"); return r; }
    @Override public List<KyberPreKeyRecord> loadKyberPreKeys() { return new ArrayList<>(kyber.values()); }
    @Override public void storeKyberPreKey(int id, KyberPreKeyRecord r) { kyber.put(id, r); }
    @Override public boolean containsKyberPreKey(int id) { return kyber.containsKey(id); }
    @Override public void markKyberPreKeyUsed(int id, int signedId, ECPublicKey base) throws ReusedBaseKeyException {
        // Last-resort Kyber keys may be reused, but the exact (key, base key) pair must never repeat: that would be a replay.
        String tag = id + ":" + signedId + ":" + b64(base.serialize());
        if (!usedKyber.add(tag)) throw new ReusedBaseKeyException("replayed first message");
    }

    @Override public SessionRecord loadSession(SignalProtocolAddress a) { SessionRecord r = sessions.get(a.getName()); return r != null ? r : new SessionRecord(); }
    @Override public List<SessionRecord> loadExistingSessions(List<SignalProtocolAddress> as) throws NoSessionException {
        List<SessionRecord> out = new ArrayList<>();
        for (SignalProtocolAddress a : as) { SessionRecord r = sessions.get(a.getName()); if (r == null) throw new NoSessionException("no session"); out.add(r); }
        return out;
    }
    @Override public List<Integer> getSubDeviceSessions(String name) { return new ArrayList<>(); }
    @Override public void storeSession(SignalProtocolAddress a, SessionRecord r) { sessions.put(a.getName(), r); }
    @Override public boolean containsSession(SignalProtocolAddress a) { return sessions.containsKey(a.getName()); }
    @Override public void deleteSession(SignalProtocolAddress a) { sessions.remove(a.getName()); }
    @Override public void deleteAllSessions(String name) { sessions.remove(name); }

    // Group sender keys are not used: groups run on MLS in the interface layer.
    @Override public void storeSenderKey(SignalProtocolAddress s, UUID id, SenderKeyRecord r) { }
    @Override public SenderKeyRecord loadSenderKey(SignalProtocolAddress s, UUID id) { return null; }

    // ---- operations (one at a time) ----
    synchronized void create() throws Exception {
        ECPrivateKey priv = ECPrivateKey.generate();
        identity = new IdentityKeyPair(new IdentityKey(priv.publicKey()), priv);
        regId = 1 + RNG.nextInt(0x3ffe); // 14 bits, as in libsignal
        spk.clear(); kyber.clear(); opk.clear(); sessions.clear(); trusted.clear(); usedKyber.clear();
        spkId = 0; kyberId = 0; nextOpk = 1;
        rotate();
    }

    synchronized void rotate() throws Exception {
        long now = System.currentTimeMillis();
        ECKeyPair sk = ECKeyPair.generate(); int sid = ++spkId;
        spk.put(sid, new SignedPreKeyRecord(sid, now, sk, identity.getPrivateKey().calculateSignature(sk.getPublicKey().serialize())));
        KEMKeyPair kp = KEMKeyPair.generate(KEMKeyType.KYBER_1024); int kid = ++kyberId;
        kyber.put(kid, new KyberPreKeyRecord(kid, now, kp, identity.getPrivateKey().calculateSignature(kp.getPublicKey().serialize())));
        prune(spk); prune(kyber);
    }
    private static void prune(TreeMap<Integer, ?> m) { while (m.size() > KEEP_OLD) m.remove(m.firstKey()); }

    synchronized JSONArray newOneTimePrekeys(int count) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = 0; i < count; i++) {
            ECKeyPair k = ECKeyPair.generate(); int id = nextOpk++;
            opk.put(id, new PreKeyRecord(id, k));
            out.put(new JSONObject().put("id", id).put("pub", b64(k.getPublicKey().serialize())));
        }
        return out;
    }
    synchronized int oneTimePrekeyCount() { return opk.size(); }
    synchronized String identityKey() { return b64(identity.getPublicKey().serialize()); }
    synchronized int registrationId() { return regId; }
    synchronized JSONObject signedPrekey() throws Exception { SignedPreKeyRecord r = spk.get(spkId); return new JSONObject().put("id", r.getId()).put("pub", b64(r.getKeyPair().getPublicKey().serialize())).put("sig", b64(r.getSignature())); }
    synchronized JSONObject kyberPrekey() throws Exception { KyberPreKeyRecord r = kyber.get(kyberId); return new JSONObject().put("id", r.getId()).put("pub", b64(r.getKeyPair().getPublicKey().serialize())).put("sig", b64(r.getSignature())); }

    boolean verify(String identityKey, byte[] message, String signature) {
        try { return new ECPublicKey(unb64(identityKey)).verifySignature(message, unb64(signature)); } catch (Exception e) { return false; }
    }
    synchronized void trust(String peer, String identityKey) {
        byte[] had = trusted.get(peer); byte[] now = unb64(identityKey);
        if (had != null && !Arrays.equals(had, now)) sessions.remove(peer); // a changed key invalidates the old session
        trusted.put(peer, now);
    }
    synchronized boolean hasSession(String peer) { SessionRecord r = sessions.get(peer); return r != null && r.hasSenderChain(); }
    synchronized void dropSession(String peer) { sessions.remove(peer); trusted.remove(peer); }

    synchronized void processBundle(String peer, int remoteDeviceId, JSONObject b) throws Exception {
        JSONObject o = b.optJSONObject("oneTimePrekey"), s = b.getJSONObject("signedPrekey"), k = b.getJSONObject("kyberPrekey");
        PreKeyBundle bundle = new PreKeyBundle(
            b.getInt("registrationId"), remoteDeviceId,
            o != null ? o.getInt("id") : PreKeyBundle.NULL_PRE_KEY_ID, o != null ? new ECPublicKey(unb64(o.getString("pub"))) : null,
            s.getInt("id"), new ECPublicKey(unb64(s.getString("pub"))), unb64(s.getString("sig")),
            new IdentityKey(unb64(b.getString("identityKey"))),
            k.getInt("id"), new KEMPublicKey(unb64(k.getString("pub"))), unb64(k.getString("sig")));
        new SessionBuilder(this, addr(peer)).process(bundle);
    }

    synchronized JSONObject encrypt(String peer, byte[] plaintext) throws Exception {
        CiphertextMessage ct = new SessionCipher(this, addr(peer)).encrypt(plaintext);
        return new JSONObject().put("type", ct.getType()).put("body", Bridge.u8(ct.serialize()));
    }

    synchronized byte[] decrypt(String peer, int type, byte[] body) throws Exception {
        SessionCipher c = new SessionCipher(this, addr(peer));
        if (type == CiphertextMessage.PREKEY_TYPE) return c.decrypt(new PreKeySignalMessage(body));
        if (type == CiphertextMessage.WHISPER_TYPE) return c.decrypt(new SignalMessage(body));
        throw new IllegalArgumentException("unsupported message type");
    }

    // ---- persistence (same JSON format as the Node engine) ----
    synchronized byte[] save() throws Exception {
        JSONObject s = new JSONObject().put("v", 1).put("identity", b64(identity.getPrivateKey().serialize())).put("regId", regId)
            .put("spkId", spkId).put("kyberId", kyberId).put("nextOpk", nextOpk);
        JSONObject a = new JSONObject(), b = new JSONObject(), c = new JSONObject(), d = new JSONObject(), t = new JSONObject();
        for (Map.Entry<Integer, SignedPreKeyRecord> e : spk.entrySet()) a.put(String.valueOf(e.getKey()), b64(e.getValue().serialize()));
        for (Map.Entry<Integer, KyberPreKeyRecord> e : kyber.entrySet()) b.put(String.valueOf(e.getKey()), b64(e.getValue().serialize()));
        for (Map.Entry<Integer, PreKeyRecord> e : opk.entrySet()) c.put(String.valueOf(e.getKey()), b64(e.getValue().serialize()));
        for (Map.Entry<String, SessionRecord> e : sessions.entrySet()) d.put(e.getKey(), b64(e.getValue().serialize()));
        for (Map.Entry<String, byte[]> e : trusted.entrySet()) t.put(e.getKey(), b64(e.getValue()));
        s.put("spk", a).put("kyber", b).put("opk", c).put("sessions", d).put("trusted", t).put("usedKyber", new JSONArray(usedKyber));
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    synchronized void load(byte[] state) throws Exception {
        JSONObject s = new JSONObject(new String(state, StandardCharsets.UTF_8));
        if (s.getInt("v") != 1) throw new IllegalStateException("unknown signal state version");
        ECPrivateKey priv = new ECPrivateKey(unb64(s.getString("identity")));
        identity = new IdentityKeyPair(new IdentityKey(priv.publicKey()), priv);
        regId = s.getInt("regId"); spkId = s.getInt("spkId"); kyberId = s.getInt("kyberId"); nextOpk = s.getInt("nextOpk");
        spk.clear(); kyber.clear(); opk.clear(); sessions.clear(); trusted.clear(); usedKyber.clear();
        JSONObject o = s.getJSONObject("spk"); for (Iterator<String> i = o.keys(); i.hasNext(); ) { String k = i.next(); spk.put(Integer.parseInt(k), new SignedPreKeyRecord(unb64(o.getString(k)))); }
        o = s.getJSONObject("kyber"); for (Iterator<String> i = o.keys(); i.hasNext(); ) { String k = i.next(); kyber.put(Integer.parseInt(k), new KyberPreKeyRecord(unb64(o.getString(k)))); }
        o = s.getJSONObject("opk"); for (Iterator<String> i = o.keys(); i.hasNext(); ) { String k = i.next(); opk.put(Integer.parseInt(k), new PreKeyRecord(unb64(o.getString(k)))); }
        o = s.getJSONObject("sessions"); for (Iterator<String> i = o.keys(); i.hasNext(); ) { String k = i.next(); sessions.put(k, new SessionRecord(unb64(o.getString(k)))); }
        o = s.getJSONObject("trusted"); for (Iterator<String> i = o.keys(); i.hasNext(); ) { String k = i.next(); trusted.put(k, unb64(o.getString(k))); }
        JSONArray u = s.getJSONArray("usedKyber"); for (int i = 0; i < u.length(); i++) usedKyber.add(u.getString(i));
    }
}
