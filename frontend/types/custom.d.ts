// Copyright 2024, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as jotai from "jotai";
import type * as rxjs from "rxjs";

declare global {
    type GlobalAtomsType = {
        windowId: jotai.Atom<string>; // readonly
        clientId: jotai.Atom<string>; // readonly
        client: jotai.Atom<Client>; // driven from WOS
        uiContext: jotai.Atom<UIContext>; // driven from windowId, activetabid, etc.
        waveWindow: jotai.Atom<WaveWindow>; // driven from WOS
        workspace: jotai.Atom<Workspace>; // driven from WOS
        fullConfigAtom: jotai.PrimitiveAtom<FullConfigType>; // driven from WOS, settings -- updated via WebSocket
        settingsAtom: jotai.Atom<SettingsType>; // derrived from fullConfig
        tabAtom: jotai.Atom<Tab>; // driven from WOS
        activeTabId: jotai.Atom<string>; // derrived from windowDataAtom
        isFullScreen: jotai.PrimitiveAtom<boolean>;
        controlShiftDelayAtom: jotai.PrimitiveAtom<boolean>;
        prefersReducedMotionAtom: jotai.Atom<boolean>;
        updaterStatusAtom: jotai.PrimitiveAtom<UpdaterStatus>;
        typeAheadModalAtom: jotai.PrimitiveAtom<TypeAheadModalType>;
        modalOpen: jotai.PrimitiveAtom<boolean>;
        allConnStatus: jotai.Atom<ConnStatus[]>;
        flashErrors: jotai.PrimitiveAtom<FlashErrorType[]>;
    };

    type WritableWaveObjectAtom<T extends WaveObj> = jotai.WritableAtom<T, [value: T], void>;

    type ThrottledValueAtom<T> = jotai.WritableAtom<T, [update: jotai.SetStateAction<T>], void>;

    type AtomWithThrottle<T> = {
        currentValueAtom: jotai.Atom<T>;
        throttledValueAtom: ThrottledValueAtom<T>;
    };

    type DebouncedValueAtom<T> = jotai.WritableAtom<T, [update: jotai.SetStateAction<T>], void>;

    type AtomWithDebounce<T> = {
        currentValueAtom: jotai.Atom<T>;
        debouncedValueAtom: DebouncedValueAtom<T>;
    };

    type SplitAtom<Item> = Atom<Atom<Item>[]>;
    type WritableSplitAtom<Item> = WritableAtom<PrimitiveAtom<Item>[], [SplitAtomAction<Item>], void>;

    type TabLayoutData = {
        blockId: string;
    };

    type ElectronApi = {
        getAuthKey(): string;
        getIsDev(): boolean;
        getCursorPoint: () => Electron.Point;
        getPlatform: () => NodeJS.Platform;
        getEnv: (varName: string) => string;
        getUserName: () => string;
        getHostName: () => string;
        getAboutModalDetails: () => AboutModalDetails;
        showContextMenu: (menu?: ElectronContextMenuItem[]) => void;
        onContextMenuClick: (callback: (id: string) => void) => void;
        onNavigate: (callback: (url: string) => void) => void;
        onIframeNavigate: (callback: (url: string) => void) => void;
        downloadFile: (path: string) => void;
        openExternal: (url: string) => void;
        onFullScreenChange: (callback: (isFullScreen: boolean) => void) => void;
        onUpdaterStatusChange: (callback: (status: UpdaterStatus) => void) => void;
        getUpdaterStatus: () => UpdaterStatus;
        getUpdaterChannel: () => string;
        installAppUpdate: () => void;
        onMenuItemAbout: (callback: () => void) => void;
        updateWindowControlsOverlay: (rect: Dimensions) => void;
        onReinjectKey: (callback: (waveEvent: WaveKeyboardEvent) => void) => void;
        setWebviewFocus: (focusedId: number) => void; // focusedId si the getWebContentsId of the webview
        registerGlobalWebviewKeys: (keys: string[]) => void;
        onControlShiftStateUpdate: (callback: (state: boolean) => void) => void;
    };

    type ElectronContextMenuItem = {
        id: string; // unique id, used for communication
        label: string;
        role?: string; // electron role (optional)
        type?: "separator" | "normal" | "submenu";
        submenu?: ElectronContextMenuItem[];
    };

    type ContextMenuItem = {
        label?: string;
        type?: "separator" | "normal" | "submenu";
        role?: string; // electron role (optional)
        click?: () => void; // not required if role is set
        submenu?: ContextMenuItem[];
    };

    type KeyPressDecl = {
        mods: {
            Cmd?: boolean;
            Option?: boolean;
            Shift?: boolean;
            Ctrl?: boolean;
            Alt?: boolean;
            Meta?: boolean;
        };
        key: string;
        keyType: string;
    };

    interface WaveKeyboardEvent {
        type: "keydown" | "keyup" | "keypress" | "unknown";
        /**
         * Equivalent to KeyboardEvent.key.
         */
        key: string;
        /**
         * Equivalent to KeyboardEvent.code.
         */
        code: string;
        /**
         * Equivalent to KeyboardEvent.shiftKey.
         */
        shift: boolean;
        /**
         * Equivalent to KeyboardEvent.controlKey.
         */
        control: boolean;
        /**
         * Equivalent to KeyboardEvent.altKey.
         */
        alt: boolean;
        /**
         * Equivalent to KeyboardEvent.metaKey.
         */
        meta: boolean;
        /**
         * cmd is special, on mac it is meta, on windows it is alt
         */
        cmd: boolean;
        /**
         * option is special, on mac it is alt, on windows it is meta
         */
        option: boolean;

        repeat: boolean;
        /**
         * Equivalent to KeyboardEvent.location.
         */
        location: number;
    }

    type SubjectWithRef<T> = rxjs.Subject<T> & { refCount: number; release: () => void };

    type HeaderElem = IconButtonDecl | HeaderText | HeaderInput | HeaderDiv | HeaderTextButton | ConnectionButton;

    type IconButtonDecl = {
        elemtype: "iconbutton";
        icon: string | React.ReactNode;
        iconColor?: string;
        className?: string;
        title?: string;
        click?: (e: React.MouseEvent<any>) => void;
        longClick?: (e: React.MouseEvent<any>) => void;
        disabled?: boolean;
    };

    type HeaderTextButton = {
        elemtype: "textbutton";
        text: string;
        className?: string;
        onClick?: (e: React.MouseEvent<any>) => void;
    };

    type HeaderText = {
        elemtype: "text";
        text: string;
        ref?: React.MutableRefObject<HTMLDivElement>;
        className?: string;
        onClick?: () => void;
    };

    type HeaderInput = {
        elemtype: "input";
        value: string;
        className?: string;
        isDisabled?: boolean;
        ref?: React.MutableRefObject<HTMLInputElement>;
        onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
        onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
        onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
        onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
    };

    type HeaderDiv = {
        elemtype: "div";
        className?: string;
        children: HeaderElem[];
        onMouseOver?: (e: React.MouseEvent<any>) => void;
        onMouseOut?: (e: React.MouseEvent<any>) => void;
        onClick?: (e: React.MouseEvent<any>) => void;
    };

    type ConnectionButton = {
        elemtype: "connectionbutton";
        icon: string;
        text: string;
        iconColor: string;
        onClick?: (e: React.MouseEvent<any>) => void;
        connected: boolean;
    };

    interface ViewModel {
        viewType: string;
        viewIcon?: jotai.Atom<string | IconButtonDecl>;
        viewName?: jotai.Atom<string>;
        viewText?: jotai.Atom<string | HeaderElem[]>;
        preIconButton?: jotai.Atom<IconButtonDecl>;
        endIconButtons?: jotai.Atom<IconButtonDecl[]>;
        blockBg?: jotai.Atom<MetaType>;
        manageConnection?: jotai.Atom<boolean>;

        onBack?: () => void;
        onForward?: () => void;
        onSearchChange?: (text: string) => void;
        onSearch?: (text: string) => void;
        getSettingsMenuItems?: () => ContextMenuItem[];
        giveFocus?: () => boolean;
        keyDownHandler?: (e: WaveKeyboardEvent) => boolean;
    }

    type UpdaterStatus = "up-to-date" | "checking" | "downloading" | "ready" | "error" | "installing";

    // jotai doesn't export this type :/
    type Loadable<T> = { state: "loading" } | { state: "hasData"; data: T } | { state: "hasError"; error: unknown };

    interface Dimensions {
        width: number;
        height: number;
        left: number;
        top: number;
    }

    type TypeAheadModalType = { [key: string]: boolean };

    interface AboutModalDetails {
        version: string;
        buildTime: number;
    }

    type BlockComponentModel = {
        openSwitchConnection?: () => void;
        viewModel: ViewModel;
    };

    type ConnStatusType = "connected" | "connecting" | "disconnected" | "error" | "init";

    interface SuggestionBaseItem {
        label: string;
        value: string;
        icon?: string | React.ReactNode;
    }

    interface SuggestionConnectionItem extends SuggestionBaseItem {
        status: ConnStatusType;
        iconColor: string;
        onSelect?: (_: string) => void;
    }

    interface SuggestionConnectionScope {
        headerText?: string;
        items: SuggestionConnectionItem[];
    }

    type SuggestionsType = SuggestionConnectionItem | SuggestionConnectionScope;

    type MarkdownResolveOpts = {
        connName: string;
        baseDir: string;
    };

    type FlashErrorType = {
        id: string;
        icon: string;
        title: string;
        message: string;
        expiration: number;
    };

    interface AbstractWshClient {
        recvRpcMessage(msg: RpcMessage): void;
    }

    type ClientRpcEntry = {
        reqId: string;
        startTs: number;
        command: string;
        msgFn: (msg: RpcMessage) => void;
    };
}

export {};
