import { app, session, type BrowserWindow, type Session, type WebContents } from "electron";
import {
  KONZEPT_PARTITION,
  WORKSPACE_HTML_CSP,
  guestAttachAllowed,
  guestNavigationAllowed,
  guestProtocolAllowed,
  guestRequestAllowed,
  guestWebPreferences,
} from "@x/shared/dist/konzept.js";

/**
 * Gastbereich der Konzept-Flaeche: Wissens-HTML laeuft in einem `<webview>` der nicht dauerhaften Partition
 * `konzept`. Nur diese Sitzung bekommt den toten Proxy, die Sperren und ein eigenes `app://`, das nur Wissens-HTML
 * mit der Kein-Netz-Regel ausliefert. Alles Entscheidende steht als reine Funktion in @x/shared/konzept; hier nur das
 * Verdrahten mit Electron. Die Standard-Sitzung bleibt unveraendert.
 */

/** Alle Schemata auf einen toten lokalen Port; `<-loopback>` noetig, sonst umgehen 127.0.0.1/localhost den Proxy. */
const TOTER_PROXY = { mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:9", proxyBypassRules: "<-loopback>" } as const;
const PROXY_PROBEN = ["http://127.0.0.1:8765/", "https://example.com/", "ws://127.0.0.1:8765/", "wss://example.com/", "http://localhost:8765/"];

/** Tag-Attribute, die der Hauptprozess nie vom `<webview>` uebernimmt (Namen laut webview-tag.md, Electron 39). */
const VERBOTENE_PARAMETER = [
  "allowpopups", "webpreferences", "nodeintegration", "nodeintegrationinsubframes", "plugins", "preload",
  "disablewebsecurity", "blinkfeatures", "disableblinkfeatures", "httpreferrer", "useragent",
];

type Vorbereitung = { serve: (request: Request) => Promise<Response>; guestPreloadPath: string };

let vorbereitet: boolean | null = null;
let proxyBereit: Promise<void> = Promise.reject(new Error("konzept: Gastbereich nicht eingerichtet"));
proxyBereit.catch(() => {});
let proxyFehler = false;
let gastPreload = "";
const gastHosts = new WeakSet<WebContents>();
/** Hauptdokument je Gast (webContents.id): die Adresse seiner ersten Hauptrahmen-Anfrage. */
const gastDokumente = new Map<number, string>();
/** Gaeste, die schon ein Dokument uebernommen haben (ab dann keine Navigation mehr). */
const gastUebernommen = new Set<number>();

function verweigern(): Response {
  return new Response("Forbidden", { status: 403 });
}

async function proxySetzen(ses: Session): Promise<void> {
  await ses.setProxy(TOTER_PROXY);
  for (const url of PROXY_PROBEN) {
    const r = await ses.resolveProxy(url);
    if (r.toUpperCase().includes("DIRECT") || !r.includes("127.0.0.1:9")) {
      throw new Error(`konzept: Proxy greift nicht fuer ${url}: ${r}`);
    }
  }
}

/** Liefert `app://` in der Gast-Sitzung: nur Wissens-Adressen, erst nach gesetztem Proxy, nur mit der Kein-Netz-Regel. */
function gastProtokoll(serve: Vorbereitung["serve"]) {
  return async (request: Request): Promise<Response> => {
    if (!guestProtocolAllowed(request.url)) return verweigern();
    try {
      await proxyBereit;
    } catch {
      return verweigern();
    }
    let res: Response;
    try {
      res = await serve(request);
    } catch {
      return verweigern();
    }
    if (res.headers.get("content-security-policy") === WORKSPACE_HTML_CSP) return res;
    // Kein Wissens-HTML (anderer Typ, Fehlerseite): im Gast nie ausfuehren.
    try {
      await res.body?.cancel();
    } catch {
      // Rumpf schon geschlossen
    }
    return verweigern();
  };
}

function sitzungEinrichten(ses: Session, serve: Vorbereitung["serve"]): void {
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  ses.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on("select-serial-port", (event, _ports, _wc, callback) => {
    event.preventDefault();
    callback("");
  });
  ses.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback?.();
  });
  ses.on("will-download", (event) => event.preventDefault());
  ses.setSpellCheckerEnabled(false);
  ses.protocol.handle("app", gastProtokoll(serve));
  ses.webRequest.onBeforeRequest((details, callback) => {
    let erlaubt = false;
    try {
      const id = details.webContents?.id;
      let dokument = id === undefined ? null : gastDokumente.get(id) ?? null;
      erlaubt = guestRequestAllowed(details.url, dokument);
      // Die erste Hauptrahmen-Anfrage eines Gasts ist das Laden seiner angehaengten Adresse: sie wird sein Dokument.
      if (erlaubt && id !== undefined && dokument === null && details.resourceType === "mainFrame") {
        dokument = details.url;
        gastDokumente.set(id, dokument);
      }
    } catch {
      erlaubt = false;
    }
    callback(erlaubt ? {} : { cancel: true });
  });
  proxyBereit = proxySetzen(ses);
  proxyBereit.catch((error: unknown) => {
    proxyFehler = true;
    console.error("[konzept] Proxy der Gast-Sitzung nicht gesetzt, Gaeste werden verweigert:", error);
  });
}

/** Guest-Ereignisse: WebRTC nur ueber den Proxy, keine Fenster, keine Navigation nach dem ersten Laden, keine Gaeste. */
function gastAbsichern(guest: WebContents): void {
  const id = guest.id;
  guest.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  guest.setWindowOpenHandler(() => ({ action: "deny" }));
  const darf = (url: string, isMainFrame: boolean) =>
    isMainFrame && guestNavigationAllowed(url, gastDokumente.get(id) ?? null, gastUebernommen.has(id));
  guest.on("will-navigate", (event) => {
    if (!darf(event.url, event.isMainFrame)) event.preventDefault();
  });
  guest.on("will-frame-navigate", (event) => {
    if (!darf(event.url, event.isMainFrame)) event.preventDefault();
  });
  guest.on("will-redirect", (event) => {
    if (!darf(event.url, event.isMainFrame)) event.preventDefault();
  });
  guest.on("did-navigate", () => gastUebernommen.add(id));
  guest.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  guest.once("destroyed", () => {
    gastDokumente.delete(id);
    gastUebernommen.delete(id);
  });
}

/** Waechter fuer jede Ansicht der App: nur registrierte Fenster duerfen Gaeste anhaengen, und nur Wissens-Dokumente. */
function anhaengenPruefen(wc: WebContents): void {
  wc.on("will-attach-webview", (event, webPreferences, params) => {
    if (!gastHosts.has(wc) || vorbereitet !== true || proxyFehler || !guestAttachAllowed(params.src ?? "")) {
      event.preventDefault();
      return;
    }
    const prefs = webPreferences as Record<string, unknown>;
    for (const key of Object.keys(prefs)) {
      if (key !== "zoomFactor") delete prefs[key];
    }
    Object.assign(webPreferences, guestWebPreferences(), {
      preload: gastPreload,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableWebSQL: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    });
    prefs.disablePopups = true;
    for (const key of VERBOTENE_PARAMETER) delete params[key];
    params.partition = KONZEPT_PARTITION;
  });
}

/**
 * Richtet die Gast-Sitzung einmal je Prozess ein (vor dem ersten Fenster). true, wenn alles ohne Fehler lief; dann
 * bekommt das App-Fenster `webviewTag` und das Kennzeichen. Der Proxy wird asynchron gesetzt und geprueft; bis dahin
 * liefert das Gast-`app://` nichts aus, schlaegt er fehl, werden Gaeste verweigert.
 */
export function prepareKonzeptGast(deps: Vorbereitung): boolean {
  if (vorbereitet !== null) return vorbereitet;
  vorbereitet = false;
  try {
    // Zuerst der Waechter: ab jetzt haengt keine Ansicht einen Gast an, die nicht ausdruecklich Gastgeber ist.
    app.on("web-contents-created", (_event, wc) => anhaengenPruefen(wc));
    gastPreload = deps.guestPreloadPath;
    sitzungEinrichten(session.fromPartition(KONZEPT_PARTITION), deps.serve);
    vorbereitet = true;
  } catch (error) {
    console.error("[konzept] Gastbereich nicht eingerichtet:", error);
  }
  return vorbereitet;
}

/** Macht das App-Fenster zum Gastgeber fuer Konzept-Gaeste (nur nach erfolgreichem {@link prepareKonzeptGast}). */
export function setupKonzeptGast(win: BrowserWindow): void {
  if (vorbereitet !== true) return;
  gastHosts.add(win.webContents);
  win.webContents.on("did-attach-webview", (_event, guest) => gastAbsichern(guest));
}
