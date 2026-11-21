package win.karatel.vanishgram.signal;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;

/** The crypto engine lives here, in native code. The page only sees results over this narrow bridge. */
@CapacitorPlugin(name = "VgSignal")
public class VgSignalPlugin extends Plugin {
    private final HashMap<Integer, SignalEngine> engines = new HashMap<>();
    private int next = 1;

    @PluginMethod
    public synchronized void open(PluginCall call) {
        int id = next++;
        engines.put(id, new SignalEngine());
        JSObject r = new JSObject();
        r.put("handle", id);
        call.resolve(r);
    }

    @PluginMethod
    public synchronized void close(PluginCall call) {
        engines.remove(call.getInt("handle", 0));
        call.resolve();
    }

    @PluginMethod
    public void call(PluginCall call) {
        try {
            SignalEngine e;
            synchronized (this) { e = engines.get(call.getInt("handle", 0)); }
            String method = call.getString("method");
            if (e == null || method == null) throw new IllegalArgumentException("bad request");
            Object out = Bridge.dispatch(e, method, new JSONArray(call.getString("args", "[]")));
            JSObject r = new JSObject();
            r.put("result", new JSONObject().put("v", out).toString());
            call.resolve(r);
        } catch (Throwable t) {
            call.reject(t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
        }
    }
}
