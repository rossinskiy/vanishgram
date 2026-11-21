package win.karatel.vanishgram.signal;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

/** Byte arrays cross the page boundary as {"$u8": "<base64>"}; everything else is plain JSON. */
final class Bridge {
    static JSONObject u8(byte[] b) throws Exception { return new JSONObject().put("$u8", Base64.encodeToString(b, Base64.NO_WRAP)); }

    static byte[] bytes(Object o) throws Exception {
        if (!(o instanceof JSONObject) || !((JSONObject) o).has("$u8")) throw new IllegalArgumentException("expected bytes");
        return Base64.decode(((JSONObject) o).getString("$u8"), Base64.DEFAULT);
    }

    /** Runs one engine method. Method names are the SignalProvider interface of the interface layer. */
    static Object dispatch(SignalEngine e, String method, JSONArray a) throws Exception {
        switch (method) {
            case "create": e.create(); return JSONObject.NULL;
            case "load": e.load(bytes(a.get(0))); return JSONObject.NULL;
            case "save": return u8(e.save());
            case "identityKey": return e.identityKey();
            case "registrationId": return e.registrationId();
            case "signedPrekey": return e.signedPrekey();
            case "kyberPrekey": return e.kyberPrekey();
            case "newOneTimePrekeys": return e.newOneTimePrekeys(a.getInt(0));
            case "oneTimePrekeyCount": return e.oneTimePrekeyCount();
            case "rotatePrekeys": e.rotate(); return JSONObject.NULL;
            case "verify": return e.verify(a.getString(0), bytes(a.get(1)), a.getString(2));
            case "trust": e.trust(a.getString(0), a.getString(1)); return JSONObject.NULL;
            case "hasSession": return e.hasSession(a.getString(0));
            case "processBundle": e.processBundle(a.getString(0), a.getInt(1), a.getJSONObject(2)); return JSONObject.NULL;
            case "encrypt": return e.encrypt(a.getString(0), bytes(a.get(1)));
            case "decrypt": {
                JSONObject ct = a.getJSONObject(1);
                return u8(e.decrypt(a.getString(0), ct.getInt("type"), bytes(ct.get("body"))));
            }
            case "dropSession": e.dropSession(a.getString(0)); return JSONObject.NULL;
            default: throw new IllegalArgumentException("bad request");
        }
    }
}
