package win.karatel.vanishgram;

import static org.junit.Assert.assertTrue;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Runs the real app in the emulator and drives the native libsignal engine from the page, through the same bridge the
 * interface uses: two engines do a key exchange and a message round trip. Nothing here touches the network.
 */
@RunWith(AndroidJUnit4.class)
public class BridgeTest {
    private static String js(ActivityScenario<MainActivity> sc, String code) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        String[] out = new String[1];
        sc.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(code, v -> { out[0] = v; done.countDown(); }));
        assertTrue("script did not return", done.await(20, TimeUnit.SECONDS));
        return out[0];
    }

    private static final String SCRIPT = String.join("\n",
        "(async () => {",
        "  const b = window.vgSignal; if (!b) return { error: 'no bridge' };",
        "  const a = await b.open(), c = await b.open();",
        "  await b.call(a, 'create', []); await b.call(c, 'create', []);",
        "  const bundle = async (h) => ({ identityKey: await b.call(h, 'identityKey', []), registrationId: await b.call(h, 'registrationId', []),",
        "    signedPrekey: await b.call(h, 'signedPrekey', []), kyberPrekey: await b.call(h, 'kyberPrekey', []), oneTimePrekey: (await b.call(h, 'newOneTimePrekeys', [1]))[0] });",
        "  const ab = await bundle(a), cb = await bundle(c);",
        "  await b.call(a, 'trust', ['c:1', cb.identityKey]); await b.call(c, 'trust', ['a:1', ab.identityKey]);",
        "  await b.call(a, 'processBundle', ['c:1', 1, cb]);",
        "  const ct = await b.call(a, 'encrypt', ['c:1', new TextEncoder().encode('hello')]);",
        "  const pt = await b.call(c, 'decrypt', ['a:1', ct]);",
        "  const ct2 = await b.call(c, 'encrypt', ['a:1', new TextEncoder().encode('back')]);",
        "  const pt2 = await b.call(a, 'decrypt', ['c:1', ct2]);",
        "  const state = await b.call(a, 'save', []);",
        "  return { ok: new TextDecoder().decode(pt) === 'hello' && new TextDecoder().decode(pt2) === 'back', first: ct.type, reply: ct2.type,",
        "    stateBytes: state.length, subtle: !!(window.crypto && crypto.subtle), wasm: typeof WebAssembly, secure: window.isSecureContext, ui: document.getElementById('root').children.length };",
        "})().then((r) => { window.__r = JSON.stringify(r); }).catch((e) => { window.__r = JSON.stringify({ error: String((e && e.message) || e) }); }); 0");

    @Test
    public void pageDrivesTheNativeEngine() throws Exception {
        try (ActivityScenario<MainActivity> sc = ActivityScenario.launch(MainActivity.class)) {
            for (int i = 0; i < 60 && !"true".equals(js(sc, "!!window.vgSignal")); i++) Thread.sleep(1000);
            js(sc, SCRIPT);
            String r = "";
            for (int i = 0; i < 60; i++) {
                r = js(sc, "window.__r || ''");
                if (!r.equals("\"\"")) break;
                Thread.sleep(1000);
            }
            String s = r.replace("\\\"", "\"");
            assertTrue("bridge result: " + s, s.contains("\"ok\":true") && s.contains("\"first\":3") && s.contains("\"reply\":2")
                && s.contains("\"subtle\":true") && s.contains("\"secure\":true") && s.contains("\"wasm\":\"object\""));
        }
    }
}
