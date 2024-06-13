// Copyright 2024, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WOS, getBackendHostPort, getEventORefSubject, sendWSCommand } from "@/store/global";
import * as services from "@/store/services";
import { base64ToArray } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import clsx from "clsx";
import * as React from "react";

import "public/xterm.css";
import { debounce } from "throttle-debounce";
import "./view.less";

function getThemeFromCSSVars(el: Element): ITheme {
    const theme: ITheme = {};
    const elemStyle = getComputedStyle(el);
    theme.foreground = elemStyle.getPropertyValue("--term-foreground");
    theme.background = elemStyle.getPropertyValue("--term-background");
    theme.black = elemStyle.getPropertyValue("--term-black");
    theme.red = elemStyle.getPropertyValue("--term-red");
    theme.green = elemStyle.getPropertyValue("--term-green");
    theme.yellow = elemStyle.getPropertyValue("--term-yellow");
    theme.blue = elemStyle.getPropertyValue("--term-blue");
    theme.magenta = elemStyle.getPropertyValue("--term-magenta");
    theme.cyan = elemStyle.getPropertyValue("--term-cyan");
    theme.white = elemStyle.getPropertyValue("--term-white");
    theme.brightBlack = elemStyle.getPropertyValue("--term-bright-black");
    theme.brightRed = elemStyle.getPropertyValue("--term-bright-red");
    theme.brightGreen = elemStyle.getPropertyValue("--term-bright-green");
    theme.brightYellow = elemStyle.getPropertyValue("--term-bright-yellow");
    theme.brightBlue = elemStyle.getPropertyValue("--term-bright-blue");
    theme.brightMagenta = elemStyle.getPropertyValue("--term-bright-magenta");
    theme.brightCyan = elemStyle.getPropertyValue("--term-bright-cyan");
    theme.brightWhite = elemStyle.getPropertyValue("--term-bright-white");
    theme.selectionBackground = elemStyle.getPropertyValue("--term-selection-background");
    theme.selectionInactiveBackground = elemStyle.getPropertyValue("--term-selection-background");
    theme.cursor = elemStyle.getPropertyValue("--term-selection-background");
    theme.cursorAccent = elemStyle.getPropertyValue("--term-cursor-accent");
    return theme;
}

function handleResize(fitAddon: FitAddon, blockId: string, term: Terminal) {
    if (term == null) {
        return;
    }
    const oldRows = term.rows;
    const oldCols = term.cols;
    fitAddon.fit();
    if (oldRows !== term.rows || oldCols !== term.cols) {
        const wsCommand: SetBlockTermSizeWSCommand = {
            wscommand: "setblocktermsize",
            blockid: blockId,
            termsize: { rows: term.rows, cols: term.cols },
        };
        sendWSCommand(wsCommand);
    }
}

type InitialLoadDataType = {
    loaded: boolean;
    heldData: Uint8Array[];
};

const TerminalView = ({ blockId }: { blockId: string }) => {
    const connectElemRef = React.useRef<HTMLDivElement>(null);
    const termRef = React.useRef<Terminal>(null);
    const initialLoadRef = React.useRef<InitialLoadDataType>({ loaded: false, heldData: [] });
    const htmlElemFocusRef = React.useRef<HTMLInputElement>(null);
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    React.useEffect(() => {
        console.log("terminal created");
        const newTerm = new Terminal({
            theme: getThemeFromCSSVars(connectElemRef.current),
            fontSize: 12,
            fontFamily: "Hack",
            drawBoldTextInBrightColors: false,
            fontWeight: "normal",
            fontWeightBold: "bold",
        });
        termRef.current = newTerm;
        const newFitAddon = new FitAddon();
        newTerm.loadAddon(newFitAddon);
        newTerm.open(connectElemRef.current);
        newFitAddon.fit();
        sendWSCommand({
            wscommand: "setblocktermsize",
            blockid: blockId,
            termsize: { rows: newTerm.rows, cols: newTerm.cols },
        });
        newTerm.onData((data) => {
            const b64data = btoa(data);
            const inputCmd: BlockInputCommand = { command: "controller:input", inputdata64: b64data };
            services.BlockService.SendCommand(blockId, inputCmd);
        });

        // block subject
        const blockSubject = getEventORefSubject("block:ptydata", WOS.makeORef("block", blockId));
        blockSubject.subscribe((msg: WSEventType) => {
            // base64 decode
            const data = msg.data;
            const decodedData = base64ToArray(data.ptydata);
            if (initialLoadRef.current.loaded) {
                newTerm.write(decodedData);
            } else {
                initialLoadRef.current.heldData.push(decodedData);
            }
        });
        // load data from filestore
        const startTs = Date.now();
        let loadedBytes = 0;
        const localTerm = termRef.current; // avoids devmode double effect running issue (terminal gets created twice)
        const usp = new URLSearchParams();
        usp.set("zoneid", blockId);
        usp.set("name", "main");
        fetch(getBackendHostPort() + "/wave/file?" + usp.toString())
            .then((resp) => {
                if (resp.ok) {
                    return resp.arrayBuffer();
                }
                console.log("error loading file", resp.status, resp.statusText);
            })
            .then((data: ArrayBuffer) => {
                const uint8View = new Uint8Array(data);
                localTerm.write(uint8View);
                loadedBytes = uint8View.byteLength;
            })
            .finally(() => {
                initialLoadRef.current.heldData.forEach((data) => {
                    localTerm.write(data);
                });
                initialLoadRef.current.loaded = true;
                initialLoadRef.current.heldData = [];
                console.log(`terminal loaded file ${loadedBytes} bytes, ${Date.now() - startTs}ms`);
            });

        const resize_debounced = debounce(50, () => {
            handleResize(newFitAddon, blockId, newTerm);
        });
        const rszObs = new ResizeObserver(() => {
            resize_debounced();
        });
        rszObs.observe(connectElemRef.current);

        return () => {
            newTerm.dispose();
            blockSubject.release();
        };
    }, []);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.code === "Escape" && event.metaKey) {
            // reset term:mode
            const metaCmd: BlockSetMetaCommand = { command: "setmeta", meta: { "term:mode": null } };
            services.BlockService.SendCommand(blockId, metaCmd);
            return false;
        }
        return true;
    };

    let termMode = blockData?.meta?.["term:mode"] ?? "term";
    if (termMode != "term" && termMode != "html") {
        termMode = "term";
    }
    return (
        <div className={clsx("view-term", "term-mode-" + termMode)}>
            <div key="conntectElem" className="term-connectelem" ref={connectElemRef}></div>
            <div
                key="htmlElem"
                className="term-htmlelem"
                onClick={() => {
                    if (htmlElemFocusRef.current != null) {
                        htmlElemFocusRef.current.focus();
                    }
                }}
            >
                <div key="htmlElemFocus" className="term-htmlelem-focus">
                    <input type="text" ref={htmlElemFocusRef} onKeyDown={handleKeyDown} />
                </div>
                <div key="htmlElemContent" className="term-htmlelem-content">
                    HTML MODE
                </div>
            </div>
        </div>
    );
};

export { TerminalView };
