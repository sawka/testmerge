// Copyright 2024, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import { FastAverageColor } from "fast-average-color";
import fs from "fs";
import * as child_process from "node:child_process";
import * as path from "path";
import { PNG } from "pngjs";
import * as readline from "readline";
import { sprintf } from "sprintf-js";
import { debounce } from "throttle-debounce";
import * as util from "util";
import winston from "winston";
import { initGlobal } from "../frontend/app/store/global";
import * as services from "../frontend/app/store/services";
import { initElectronWshrpc } from "../frontend/app/store/wshrpcutil";
import { WSServerEndpointVarName, WebServerEndpointVarName, getWebServerEndpoint } from "../frontend/util/endpoints";
import { fetch } from "../frontend/util/fetchutil";
import * as keyutil from "../frontend/util/keyutil";
import { fireAndForget } from "../frontend/util/util";
import { AuthKey, AuthKeyEnv, configureAuthKeyRequestInjection } from "./authkey";
import { ElectronWshClient, initElectronWshClient } from "./emain-wsh";
import { getAppMenu } from "./menu";
import {
    getElectronAppBasePath,
    getGoAppBasePath,
    getWaveHomeDir,
    getWaveSrvCwd,
    getWaveSrvPath,
    isDev,
    isDevVite,
    unameArch,
    unamePlatform,
} from "./platform";
import { configureAutoUpdater, updater } from "./updater";

const electronApp = electron.app;
let WaveVersion = "unknown"; // set by WAVESRV-ESTART
let WaveBuildTime = 0; // set by WAVESRV-ESTART

const WaveAppPathVarName = "WAVETERM_APP_PATH";
const WaveSrvReadySignalPidVarName = "WAVETERM_READY_SIGNAL_PID";
electron.nativeTheme.themeSource = "dark";

type WaveBrowserWindow = Electron.BrowserWindow & { waveWindowId: string; readyPromise: Promise<void> };

let waveSrvReadyResolve = (value: boolean) => {};
const waveSrvReady: Promise<boolean> = new Promise((resolve, _) => {
    waveSrvReadyResolve = resolve;
});
let globalIsQuitting = false;
let globalIsStarting = true;
let globalIsRelaunching = false;

// for activity updates
let wasActive = true;
let wasInFg = true;

let webviewFocusId: number = null; // set to the getWebContentsId of the webview that has focus (null if not focused)
let webviewKeys: string[] = []; // the keys to trap when webview has focus

let waveSrvProc: child_process.ChildProcessWithoutNullStreams | null = null;

const waveHome = getWaveHomeDir();

const oldConsoleLog = console.log;

const loggerTransports: winston.transport[] = [
    new winston.transports.File({ filename: path.join(getWaveHomeDir(), "waveapp.log"), level: "info" }),
];
if (isDev) {
    loggerTransports.push(new winston.transports.Console());
}
const loggerConfig = {
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf((info) => `${info.timestamp} ${info.message}`)
    ),
    transports: loggerTransports,
};
const logger = winston.createLogger(loggerConfig);
function log(...msg: any[]) {
    try {
        logger.info(util.format(...msg));
    } catch (e) {
        oldConsoleLog(...msg);
    }
}
console.log = log;
console.log(
    sprintf(
        "waveterm-app starting, WAVETERM_HOME=%s, electronpath=%s gopath=%s arch=%s/%s",
        waveHome,
        getElectronAppBasePath(),
        getGoAppBasePath(),
        unamePlatform,
        unameArch
    )
);
if (isDev) {
    console.log("waveterm-app WAVETERM_DEV set");
}

initGlobal({ windowId: null, clientId: null, platform: unamePlatform, environment: "electron" });

function getWindowForEvent(event: Electron.IpcMainEvent): Electron.BrowserWindow {
    const windowId = event.sender.id;
    return electron.BrowserWindow.fromId(windowId);
}

function setCtrlShift(wc: Electron.WebContents, state: boolean) {
    wc.send("control-shift-state-update", state);
}

function handleCtrlShiftState(sender: Electron.WebContents, waveEvent: WaveKeyboardEvent) {
    if (waveEvent.type == "keyup") {
        if (waveEvent.key === "Control" || waveEvent.key === "Shift") {
            setCtrlShift(sender, false);
        }
        if (waveEvent.key == "Meta") {
            if (waveEvent.control && waveEvent.shift) {
                setCtrlShift(sender, true);
            }
        }
        return;
    }
    if (waveEvent.type == "keydown") {
        if (waveEvent.key === "Control" || waveEvent.key === "Shift" || waveEvent.key === "Meta") {
            if (waveEvent.control && waveEvent.shift && !waveEvent.meta) {
                // Set the control and shift without the Meta key
                setCtrlShift(sender, true);
            } else {
                // Unset if Meta is pressed
                setCtrlShift(sender, false);
            }
        }
        return;
    }
}

function handleCtrlShiftFocus(sender: Electron.WebContents, focused: boolean) {
    if (!focused) {
        setCtrlShift(sender, false);
    }
}

function runWaveSrv(): Promise<boolean> {
    let pResolve: (value: boolean) => void;
    let pReject: (reason?: any) => void;
    const rtnPromise = new Promise<boolean>((argResolve, argReject) => {
        pResolve = argResolve;
        pReject = argReject;
    });
    const envCopy = { ...process.env };
    envCopy[WaveAppPathVarName] = getGoAppBasePath();
    envCopy[WaveSrvReadySignalPidVarName] = process.pid.toString();
    envCopy[AuthKeyEnv] = AuthKey;
    const waveSrvCmd = getWaveSrvPath();
    console.log("trying to run local server", waveSrvCmd);
    const proc = child_process.spawn(getWaveSrvPath(), {
        cwd: getWaveSrvCwd(),
        env: envCopy,
    });
    proc.on("exit", (e) => {
        if (globalIsQuitting || updater?.status == "installing") {
            return;
        }
        console.log("wavesrv exited, shutting down");
        electronApp.quit();
    });
    proc.on("spawn", (e) => {
        console.log("spawned wavesrv");
        waveSrvProc = proc;
        pResolve(true);
    });
    proc.on("error", (e) => {
        console.log("error running wavesrv", e);
        pReject(e);
    });
    const rlStdout = readline.createInterface({
        input: proc.stdout,
        terminal: false,
    });
    rlStdout.on("line", (line) => {
        console.log(line);
    });
    const rlStderr = readline.createInterface({
        input: proc.stderr,
        terminal: false,
    });
    rlStderr.on("line", (line) => {
        if (line.includes("WAVESRV-ESTART")) {
            const startParams = /ws:([a-z0-9.:]+) web:([a-z0-9.:]+) version:([a-z0-9.\-]+) buildtime:(\d+)/gm.exec(
                line
            );
            if (startParams == null) {
                console.log("error parsing WAVESRV-ESTART line", line);
                electronApp.quit();
                return;
            }
            process.env[WSServerEndpointVarName] = startParams[1];
            process.env[WebServerEndpointVarName] = startParams[2];
            WaveVersion = startParams[3];
            WaveBuildTime = parseInt(startParams[4]);
            waveSrvReadyResolve(true);
            return;
        }
        if (line.startsWith("WAVESRV-EVENT:")) {
            const evtJson = line.slice("WAVESRV-EVENT:".length);
            try {
                const evtMsg: WSEventType = JSON.parse(evtJson);
                handleWSEvent(evtMsg);
            } catch (e) {
                console.log("error handling WAVESRV-EVENT", e);
            }
            return;
        }
        console.log(line);
    });
    return rtnPromise;
}

async function handleWSEvent(evtMsg: WSEventType) {
    console.log("handleWSEvent", evtMsg?.eventtype);
    if (evtMsg.eventtype == "electron:newwindow") {
        const windowId: string = evtMsg.data;
        const windowData: WaveWindow = (await services.ObjectService.GetObject("window:" + windowId)) as WaveWindow;
        if (windowData == null) {
            return;
        }
        const clientData = await services.ClientService.GetClientData();
        const fullConfig = await services.FileService.GetFullConfig();
        const newWin = createBrowserWindow(clientData.oid, windowData, fullConfig);
        await newWin.readyPromise;
        newWin.show();
    } else if (evtMsg.eventtype == "electron:closewindow") {
        if (evtMsg.data === undefined) return;
        const windows = electron.BrowserWindow.getAllWindows();
        for (const window of windows) {
            if ((window as any).waveWindowId === evtMsg.data) {
                // Bypass the "Are you sure?" dialog, since this event is called when there's no more tabs for the window.
                window.destroy();
            }
        }
    } else {
        console.log("unhandled electron ws eventtype", evtMsg.eventtype);
    }
}

async function mainResizeHandler(_: any, windowId: string, win: WaveBrowserWindow) {
    if (win == null || win.isDestroyed() || win.fullScreen) {
        return;
    }
    const bounds = win.getBounds();
    try {
        await services.WindowService.SetWindowPosAndSize(
            windowId,
            { x: bounds.x, y: bounds.y },
            { width: bounds.width, height: bounds.height }
        );
    } catch (e) {
        console.log("error resizing window", e);
    }
}

function shNavHandler(event: Electron.Event<Electron.WebContentsWillNavigateEventParams>, url: string) {
    if (url.startsWith("http://127.0.0.1:5173/index.html") || url.startsWith("http://localhost:5173/index.html")) {
        // this is a dev-mode hot-reload, ignore it
        console.log("allowing hot-reload of index.html");
        return;
    }
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://") || url.startsWith("file://")) {
        console.log("open external, shNav", url);
        electron.shell.openExternal(url);
    } else {
        console.log("navigation canceled", url);
    }
}

function shFrameNavHandler(event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) {
    if (!event.frame?.parent) {
        // only use this handler to process iframe events (non-iframe events go to shNavHandler)
        return;
    }
    const url = event.url;
    console.log(`frame-navigation url=${url} frame=${event.frame.name}`);
    if (event.frame.name == "webview") {
        // "webview" links always open in new window
        // this will *not* effect the initial load because srcdoc does not count as an electron navigation
        console.log("open external, frameNav", url);
        event.preventDefault();
        electron.shell.openExternal(url);
        return;
    }
    if (
        event.frame.name == "pdfview" &&
        (url.startsWith("blob:file:///") || url.startsWith(getWebServerEndpoint() + "/wave/stream-file?"))
    ) {
        // allowed
        return;
    }
    event.preventDefault();
    console.log("frame navigation canceled");
}

// note, this does not *show* the window.
// to show, await win.readyPromise and then win.show()
function createBrowserWindow(clientId: string, waveWindow: WaveWindow, fullConfig: FullConfigType): WaveBrowserWindow {
    let winWidth = waveWindow?.winsize?.width;
    let winHeight = waveWindow?.winsize?.height;
    let winPosX = waveWindow.pos.x;
    let winPosY = waveWindow.pos.y;
    if (winWidth == null || winWidth == 0) {
        const primaryDisplay = electron.screen.getPrimaryDisplay();
        const { width } = primaryDisplay.workAreaSize;
        winWidth = width - winPosX - 100;
        if (winWidth > 2000) {
            winWidth = 2000;
        }
    }
    if (winHeight == null || winHeight == 0) {
        const primaryDisplay = electron.screen.getPrimaryDisplay();
        const { height } = primaryDisplay.workAreaSize;
        winHeight = height - winPosY - 100;
        if (winHeight > 1200) {
            winHeight = 1200;
        }
    }
    let winBounds = {
        x: winPosX,
        y: winPosY,
        width: winWidth,
        height: winHeight,
    };
    winBounds = ensureBoundsAreVisible(winBounds);
    const winOpts: Electron.BrowserWindowConstructorOptions = {
        titleBarStyle: unamePlatform === "darwin" ? "hiddenInset" : "hidden",
        titleBarOverlay:
            unamePlatform !== "darwin"
                ? {
                      symbolColor: "white",
                      color: "#00000000",
                  }
                : false,
        x: winBounds.x,
        y: winBounds.y,
        width: winBounds.width,
        height: winBounds.height,
        minWidth: 400,
        minHeight: 300,
        icon:
            unamePlatform == "linux"
                ? path.join(getElectronAppBasePath(), "public/logos/wave-logo-dark.png")
                : undefined,
        webPreferences: {
            preload: path.join(getElectronAppBasePath(), "preload", "index.cjs"),
            webviewTag: true,
        },
        show: false,
        autoHideMenuBar: true,
    };
    const settings = fullConfig?.settings;
    const isTransparent = settings?.["window:transparent"] ?? false;
    const isBlur = !isTransparent && (settings?.["window:blur"] ?? false);
    if (isTransparent) {
        winOpts.transparent = true;
    } else if (isBlur) {
        switch (unamePlatform) {
            case "win32": {
                winOpts.backgroundMaterial = "acrylic";
                break;
            }
            case "darwin": {
                winOpts.vibrancy = "fullscreen-ui";
                break;
            }
        }
    } else {
        winOpts.backgroundColor = "#222222";
    }
    const bwin = new electron.BrowserWindow(winOpts);
    (bwin as any).waveWindowId = waveWindow.oid;
    let readyResolve: (value: void) => void;
    (bwin as any).readyPromise = new Promise((resolve, _) => {
        readyResolve = resolve;
    });
    const win: WaveBrowserWindow = bwin as WaveBrowserWindow;
    const usp = new URLSearchParams();
    usp.set("clientid", clientId);
    usp.set("windowid", waveWindow.oid);
    const indexHtml = "index.html";
    if (isDevVite) {
        console.log("running as dev server");
        win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html?${usp.toString()}`);
    } else {
        console.log("running as file");
        win.loadFile(path.join(getElectronAppBasePath(), "frontend", indexHtml), { search: usp.toString() });
    }
    win.once("ready-to-show", () => {
        readyResolve();
    });
    win.webContents.on("will-navigate", shNavHandler);
    win.webContents.on("will-frame-navigate", shFrameNavHandler);
    win.webContents.on("did-attach-webview", (event, wc) => {
        wc.setWindowOpenHandler((details) => {
            win.webContents.send("webview-new-window", wc.id, details);
            return { action: "deny" };
        });
    });
    win.webContents.on("before-input-event", (e, input) => {
        const waveEvent = keyutil.adaptFromElectronKeyEvent(input);
        // console.log("WIN bie", waveEvent.type, waveEvent.code);
        handleCtrlShiftState(win.webContents, waveEvent);
        if (win.isFocused()) {
            wasActive = true;
        }
    });
    win.on(
        "resize",
        debounce(400, (e) => mainResizeHandler(e, waveWindow.oid, win))
    );
    win.on(
        "move",
        debounce(400, (e) => mainResizeHandler(e, waveWindow.oid, win))
    );
    win.on("focus", () => {
        wasInFg = true;
        wasActive = true;
        if (globalIsStarting) {
            return;
        }
        console.log("focus", waveWindow.oid);
        services.ClientService.FocusWindow(waveWindow.oid);
    });
    win.on("blur", () => {
        handleCtrlShiftFocus(win.webContents, false);
    });
    win.on("enter-full-screen", async () => {
        win.webContents.send("fullscreen-change", true);
    });
    win.on("leave-full-screen", async () => {
        win.webContents.send("fullscreen-change", false);
    });
    win.on("close", (e) => {
        if (globalIsQuitting || updater?.status == "installing") {
            return;
        }
        const numWindows = electron.BrowserWindow.getAllWindows().length;
        if (numWindows == 1) {
            return;
        }
        const choice = electron.dialog.showMessageBoxSync(win, {
            type: "question",
            buttons: ["Cancel", "Yes"],
            title: "Confirm",
            message: "Are you sure you want to close this window (all tabs and blocks will be deleted)?",
        });
        if (choice === 0) {
            e.preventDefault();
        }
    });
    win.on("closed", () => {
        if (globalIsQuitting || updater?.status == "installing") {
            return;
        }
        const numWindows = electron.BrowserWindow.getAllWindows().length;
        if (numWindows == 0) {
            return;
        }
        services.WindowService.CloseWindow(waveWindow.oid);
    });
    win.webContents.on("zoom-changed", (e) => {
        win.webContents.send("zoom-changed");
    });
    win.webContents.setWindowOpenHandler(({ url, frameName }) => {
        if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")) {
            console.log("openExternal fallback", url);
            electron.shell.openExternal(url);
        }
        console.log("window-open denied", url);
        return { action: "deny" };
    });
    configureAuthKeyRequestInjection(win.webContents.session);
    return win;
}

function isWindowFullyVisible(bounds: electron.Rectangle): boolean {
    const displays = electron.screen.getAllDisplays();

    // Helper function to check if a point is inside any display
    function isPointInDisplay(x: number, y: number) {
        for (const display of displays) {
            const { x: dx, y: dy, width, height } = display.bounds;
            if (x >= dx && x < dx + width && y >= dy && y < dy + height) {
                return true;
            }
        }
        return false;
    }

    // Check all corners of the window
    const topLeft = isPointInDisplay(bounds.x, bounds.y);
    const topRight = isPointInDisplay(bounds.x + bounds.width, bounds.y);
    const bottomLeft = isPointInDisplay(bounds.x, bounds.y + bounds.height);
    const bottomRight = isPointInDisplay(bounds.x + bounds.width, bounds.y + bounds.height);

    return topLeft && topRight && bottomLeft && bottomRight;
}

function findDisplayWithMostArea(bounds: electron.Rectangle): electron.Display {
    const displays = electron.screen.getAllDisplays();
    let maxArea = 0;
    let bestDisplay = null;

    for (let display of displays) {
        const { x, y, width, height } = display.bounds;
        const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x));
        const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y));
        const overlapArea = overlapX * overlapY;

        if (overlapArea > maxArea) {
            maxArea = overlapArea;
            bestDisplay = display;
        }
    }

    return bestDisplay;
}

function adjustBoundsToFitDisplay(bounds: electron.Rectangle, display: electron.Display): electron.Rectangle {
    const { x: dx, y: dy, width: dWidth, height: dHeight } = display.workArea;
    let { x, y, width, height } = bounds;

    // Adjust width and height to fit within the display's work area
    width = Math.min(width, dWidth);
    height = Math.min(height, dHeight);

    // Adjust x to ensure the window fits within the display
    if (x < dx) {
        x = dx;
    } else if (x + width > dx + dWidth) {
        x = dx + dWidth - width;
    }

    // Adjust y to ensure the window fits within the display
    if (y < dy) {
        y = dy;
    } else if (y + height > dy + dHeight) {
        y = dy + dHeight - height;
    }
    return { x, y, width, height };
}

function ensureBoundsAreVisible(bounds: electron.Rectangle): electron.Rectangle {
    if (!isWindowFullyVisible(bounds)) {
        let targetDisplay = findDisplayWithMostArea(bounds);

        if (!targetDisplay) {
            targetDisplay = electron.screen.getPrimaryDisplay();
        }

        return adjustBoundsToFitDisplay(bounds, targetDisplay);
    }
    return bounds;
}

// Listen for the open-external event from the renderer process
electron.ipcMain.on("open-external", (event, url) => {
    if (url && typeof url === "string") {
        electron.shell.openExternal(url).catch((err) => {
            console.error(`Failed to open URL ${url}:`, err);
        });
    } else {
        console.error("Invalid URL received in open-external event:", url);
    }
});

electron.ipcMain.on("download", (event, payload) => {
    const window = electron.BrowserWindow.fromWebContents(event.sender);
    const streamingUrl = getWebServerEndpoint() + "/wave/stream-file?path=" + encodeURIComponent(payload.filePath);
    window.webContents.downloadURL(streamingUrl);
});

electron.ipcMain.on("get-cursor-point", (event) => {
    const window = electron.BrowserWindow.fromWebContents(event.sender);
    const screenPoint = electron.screen.getCursorScreenPoint();
    const windowRect = window.getContentBounds();
    const retVal: Electron.Point = {
        x: screenPoint.x - windowRect.x,
        y: screenPoint.y - windowRect.y,
    };
    event.returnValue = retVal;
});

electron.ipcMain.on("get-env", (event, varName) => {
    event.returnValue = process.env[varName] ?? null;
});

electron.ipcMain.on("get-about-modal-details", (event) => {
    event.returnValue = { version: WaveVersion, buildTime: WaveBuildTime } as AboutModalDetails;
});

const hasBeforeInputRegisteredMap = new Map<number, boolean>();

electron.ipcMain.on("webview-focus", (event: Electron.IpcMainEvent, focusedId: number) => {
    webviewFocusId = focusedId;
    console.log("webview-focus", focusedId);
    if (focusedId == null) {
        return;
    }
    const parentWc = event.sender;
    const webviewWc = electron.webContents.fromId(focusedId);
    if (webviewWc == null) {
        webviewFocusId = null;
        return;
    }
    if (!hasBeforeInputRegisteredMap.get(focusedId)) {
        hasBeforeInputRegisteredMap.set(focusedId, true);
        webviewWc.on("before-input-event", (e, input) => {
            let waveEvent = keyutil.adaptFromElectronKeyEvent(input);
            // console.log(`WEB ${focusedId}`, waveEvent.type, waveEvent.code);
            handleCtrlShiftState(parentWc, waveEvent);
            if (webviewFocusId != focusedId) {
                return;
            }
            if (input.type != "keyDown") {
                return;
            }
            for (let keyDesc of webviewKeys) {
                if (keyutil.checkKeyPressed(waveEvent, keyDesc)) {
                    e.preventDefault();
                    parentWc.send("reinject-key", waveEvent);
                    console.log("webview reinject-key", keyDesc);
                    return;
                }
            }
        });
        webviewWc.on("destroyed", () => {
            hasBeforeInputRegisteredMap.delete(focusedId);
        });
    }
});

electron.ipcMain.on("register-global-webview-keys", (event, keys: string[]) => {
    webviewKeys = keys ?? [];
});

if (unamePlatform !== "darwin") {
    const fac = new FastAverageColor();

    electron.ipcMain.on("update-window-controls-overlay", async (event, rect: Dimensions) => {
        const zoomFactor = event.sender.getZoomFactor();
        const electronRect: Electron.Rectangle = {
            x: rect.left * zoomFactor,
            y: rect.top * zoomFactor,
            height: rect.height * zoomFactor,
            width: rect.width * zoomFactor,
        };
        const overlay = await event.sender.capturePage(electronRect);
        const overlayBuffer = overlay.toPNG();
        const png = PNG.sync.read(overlayBuffer);
        const color = fac.prepareResult(fac.getColorFromArray4(png.data));
        const window = electron.BrowserWindow.fromWebContents(event.sender);
        window.setTitleBarOverlay({
            color: unamePlatform === "linux" ? color.rgba : "#00000000", // Windows supports a true transparent overlay, so we don't need to set a background color.
            symbolColor: color.isDark ? "white" : "black",
        });
    });
}

async function createNewWaveWindow(): Promise<void> {
    const clientData = await services.ClientService.GetClientData();
    const fullConfig = await services.FileService.GetFullConfig();
    let recreatedWindow = false;
    if (electron.BrowserWindow.getAllWindows().length === 0 && clientData?.windowids?.length >= 1) {
        // reopen the first window
        const existingWindowId = clientData.windowids[0];
        const existingWindowData = (await services.ObjectService.GetObject("window:" + existingWindowId)) as WaveWindow;
        if (existingWindowData != null) {
            const win = createBrowserWindow(clientData.oid, existingWindowData, fullConfig);
            await win.readyPromise;
            win.show();
            recreatedWindow = true;
        }
    }
    if (recreatedWindow) {
        return;
    }
    const newWindow = await services.ClientService.MakeWindow();
    const newBrowserWindow = createBrowserWindow(clientData.oid, newWindow, fullConfig);
    await newBrowserWindow.readyPromise;
    newBrowserWindow.show();
}

electron.ipcMain.on("open-new-window", () => fireAndForget(createNewWaveWindow));

electron.ipcMain.on("contextmenu-show", (event, menuDefArr?: ElectronContextMenuItem[]) => {
    const window = electron.BrowserWindow.fromWebContents(event.sender);
    if (menuDefArr?.length === 0) {
        return;
    }
    const menu = menuDefArr ? convertMenuDefArrToMenu(menuDefArr) : instantiateAppMenu();
    const { x, y } = electron.screen.getCursorScreenPoint();
    const windowPos = window.getPosition();

    menu.popup({ window, x: x - windowPos[0], y: y - windowPos[1] });
    event.returnValue = true;
});

async function logActiveState() {
    const activeState = { fg: wasInFg, active: wasActive, open: true };
    const url = new URL(getWebServerEndpoint() + "/wave/log-active-state");
    try {
        const resp = await fetch(url, { method: "post", body: JSON.stringify(activeState) });
        if (!resp.ok) {
            console.log("error logging active state", resp.status, resp.statusText);
            return;
        }
    } catch (e) {
        console.log("error logging active state", e);
    } finally {
        // for next iteration
        wasInFg = electron.BrowserWindow.getFocusedWindow()?.isFocused() ?? false;
        wasActive = false;
    }
}

// this isn't perfect, but gets the job done without being complicated
function runActiveTimer() {
    logActiveState();
    setTimeout(runActiveTimer, 60000);
}

function convertMenuDefArrToMenu(menuDefArr: ElectronContextMenuItem[]): electron.Menu {
    const menuItems: electron.MenuItem[] = [];
    for (const menuDef of menuDefArr) {
        const menuItemTemplate: electron.MenuItemConstructorOptions = {
            role: menuDef.role as any,
            label: menuDef.label,
            type: menuDef.type,
            click: (_, window) => {
                (window as electron.BrowserWindow)?.webContents?.send("contextmenu-click", menuDef.id);
            },
        };
        if (menuDef.submenu != null) {
            menuItemTemplate.submenu = convertMenuDefArrToMenu(menuDef.submenu);
        }
        const menuItem = new electron.MenuItem(menuItemTemplate);
        menuItems.push(menuItem);
    }
    return electron.Menu.buildFromTemplate(menuItems);
}

function instantiateAppMenu(): electron.Menu {
    return getAppMenu({ createNewWaveWindow, relaunchBrowserWindows });
}

function makeAppMenu() {
    const menu = instantiateAppMenu();
    electron.Menu.setApplicationMenu(menu);
}

electronApp.on("window-all-closed", () => {
    if (globalIsRelaunching) {
        return;
    }
    if (unamePlatform !== "darwin") {
        electronApp.quit();
    }
});
electronApp.on("before-quit", () => {
    globalIsQuitting = true;
    updater?.stop();
});
process.on("SIGINT", () => {
    console.log("Caught SIGINT, shutting down");
    electronApp.quit();
});
process.on("SIGHUP", () => {
    console.log("Caught SIGHUP, shutting down");
    electronApp.quit();
});
process.on("SIGTERM", () => {
    console.log("Caught SIGTERM, shutting down");
    electronApp.quit();
});
let caughtException = false;
process.on("uncaughtException", (error) => {
    if (caughtException) {
        return;
    }
    logger.error("Uncaught Exception, shutting down: ", error);
    caughtException = true;
    // Optionally, handle cleanup or exit the app
    electronApp.quit();
});

async function relaunchBrowserWindows(): Promise<void> {
    globalIsRelaunching = true;
    const windows = electron.BrowserWindow.getAllWindows();
    for (const window of windows) {
        window.removeAllListeners();
        window.close();
    }
    globalIsRelaunching = false;

    const clientData = await services.ClientService.GetClientData();
    const fullConfig = await services.FileService.GetFullConfig();
    const wins: WaveBrowserWindow[] = [];
    for (const windowId of clientData.windowids.slice().reverse()) {
        const windowData: WaveWindow = (await services.ObjectService.GetObject("window:" + windowId)) as WaveWindow;
        if (windowData == null) {
            services.WindowService.CloseWindow(windowId).catch((e) => {
                /* ignore */
            });
            continue;
        }
        const win = createBrowserWindow(clientData.oid, windowData, fullConfig);
        wins.push(win);
    }
    for (const win of wins) {
        await win.readyPromise;
        console.log("show", win.waveWindowId);
        win.show();
    }
}

process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    console.error("Stack Trace:", error.stack);
    electron.app.quit();
});

async function appMain() {
    const startTs = Date.now();
    const instanceLock = electronApp.requestSingleInstanceLock();
    if (!instanceLock) {
        console.log("waveterm-app could not get single-instance-lock, shutting down");
        electronApp.quit();
        return;
    }
    const waveHomeDir = getWaveHomeDir();
    if (!fs.existsSync(waveHomeDir)) {
        fs.mkdirSync(waveHomeDir);
    }
    makeAppMenu();
    try {
        await runWaveSrv();
    } catch (e) {
        console.log(e.toString());
    }
    const ready = await waveSrvReady;
    console.log("wavesrv ready signal received", ready, Date.now() - startTs, "ms");
    await electronApp.whenReady();
    configureAuthKeyRequestInjection(electron.session.defaultSession);
    await relaunchBrowserWindows();
    setTimeout(runActiveTimer, 5000); // start active timer, wait 5s just to be safe
    try {
        initElectronWshClient();
        initElectronWshrpc(ElectronWshClient, { authKey: AuthKey });
    } catch (e) {
        console.log("error initializing wshrpc", e);
    }
    await configureAutoUpdater();

    globalIsStarting = false;

    electronApp.on("activate", async () => {
        if (electron.BrowserWindow.getAllWindows().length === 0) {
            await createNewWaveWindow();
        }
    });
}

appMain().catch((e) => {
    console.log("appMain error", e);
    electronApp.quit();
});
