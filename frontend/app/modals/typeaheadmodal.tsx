import { Input } from "@/app/element/input";
import { InputDecoration } from "@/app/element/inputdecoration";
import { useDimensions } from "@/app/hook/useDimensions";
import { makeIconClass } from "@/util/util";
import clsx from "clsx";
import React, { forwardRef, useLayoutEffect, useRef } from "react";
import ReactDOM from "react-dom";

import "./typeaheadmodal.less";

interface SuggestionsProps {
    suggestions?: SuggestionsType[];
    onSelect?: (_: string) => void;
    selectIndex: number;
}

const Suggestions = forwardRef<HTMLDivElement, SuggestionsProps>(
    ({ suggestions, onSelect, selectIndex }: SuggestionsProps, ref) => {
        const renderIcon = (icon: string | React.ReactNode, color: string) => {
            if (typeof icon === "string") {
                return <i className={makeIconClass(icon, false)} style={{ color: color }}></i>;
            }
            return icon;
        };

        const renderItem = (item: SuggestionBaseItem | SuggestionConnectionItem, index: number) => (
            <div
                key={index}
                onClick={() => {
                    if ("onSelect" in item && item.onSelect) {
                        item.onSelect(item.value);
                    } else {
                        onSelect(item.value);
                    }
                }}
                className={clsx("suggestion-item", { selected: selectIndex === index })}
            >
                <div className="typeahead-item-name">
                    {item.icon &&
                        renderIcon(item.icon, "iconColor" in item && item.iconColor ? item.iconColor : "inherit")}
                    {item.label}
                </div>
            </div>
        );

        let fullIndex = -1;
        return (
            <div ref={ref} className="suggestions">
                {suggestions.map((item, index) => {
                    if ("headerText" in item) {
                        return (
                            <div key={index}>
                                {item.headerText && <div className="suggestion-header">{item.headerText}</div>}
                                {item.items.map((subItem, subIndex) => {
                                    fullIndex += 1;
                                    return renderItem(subItem, fullIndex);
                                })}
                            </div>
                        );
                    }
                    return renderItem(item as SuggestionBaseItem, index);
                })}
            </div>
        );
    }
);

interface TypeAheadModalProps {
    anchorRef: React.RefObject<HTMLElement>;
    blockRef?: React.RefObject<HTMLDivElement>;
    suggestions?: SuggestionsType[];
    label?: string;
    className?: string;
    value?: string;
    onChange?: (_: string) => void;
    onSelect?: (_: string) => void;
    onClickBackdrop?: () => void;
    onKeyDown?: (_) => void;
    giveFocusRef?: React.MutableRefObject<() => boolean>;
    autoFocus?: boolean;
    selectIndex?: number;
}

const TypeAheadModal = ({
    className,
    suggestions,
    label,
    anchorRef,
    blockRef,
    value,
    onChange,
    onSelect,
    onKeyDown,
    onClickBackdrop,
    giveFocusRef,
    autoFocus,
    selectIndex,
}: TypeAheadModalProps) => {
    const { width, height } = useDimensions(blockRef);
    const modalRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLDivElement>(null);
    const realInputRef = useRef<HTMLInputElement>(null);
    const suggestionsWrapperRef = useRef<HTMLDivElement>(null);
    const suggestionsRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!modalRef.current || !inputRef.current || !suggestionsRef.current || !suggestionsWrapperRef.current) {
            return;
        }

        const modalStyles = window.getComputedStyle(modalRef.current);
        const paddingTop = parseFloat(modalStyles.paddingTop) || 0;
        const paddingBottom = parseFloat(modalStyles.paddingBottom) || 0;
        const borderTop = parseFloat(modalStyles.borderTopWidth) || 0;
        const borderBottom = parseFloat(modalStyles.borderBottomWidth) || 0;
        const modalPadding = paddingTop + paddingBottom;
        const modalBorder = borderTop + borderBottom;

        const suggestionsWrapperStyles = window.getComputedStyle(suggestionsWrapperRef.current);
        const suggestionsWrapperMarginTop = parseFloat(suggestionsWrapperStyles.marginTop) || 0;

        const inputHeight = inputRef.current.getBoundingClientRect().height;
        let suggestionsTotalHeight = 0;

        const suggestionItems = suggestionsRef.current.children;
        for (let i = 0; i < suggestionItems.length; i++) {
            suggestionsTotalHeight += suggestionItems[i].getBoundingClientRect().height;
        }

        const totalHeight =
            modalPadding + modalBorder + inputHeight + suggestionsTotalHeight + suggestionsWrapperMarginTop;
        const maxHeight = height * 0.8;
        const computedHeight = totalHeight > maxHeight ? maxHeight : totalHeight;

        modalRef.current.style.height = `${computedHeight}px`;

        suggestionsWrapperRef.current.style.height = `${computedHeight - inputHeight - modalPadding - modalBorder - suggestionsWrapperMarginTop}px`;
    }, [height, suggestions]);

    useLayoutEffect(() => {
        if (!blockRef.current || !modalRef.current) return;

        const blockRect = blockRef.current.getBoundingClientRect();
        const anchorRect = anchorRef.current.getBoundingClientRect();

        const minGap = 20;

        const availableWidth = blockRect.width - minGap * 2;
        let modalWidth = 300;

        if (modalWidth > availableWidth) {
            modalWidth = availableWidth;
        }

        let leftPosition = anchorRect.left - blockRect.left;

        const modalRightEdge = leftPosition + modalWidth;
        const blockRightEdge = blockRect.width - (minGap - 4);

        if (modalRightEdge > blockRightEdge) {
            leftPosition -= modalRightEdge - blockRightEdge;
        }

        if (leftPosition < minGap) {
            leftPosition = minGap;
        }

        modalRef.current.style.width = `${modalWidth}px`;
        modalRef.current.style.left = `${leftPosition}px`;
    }, [width]);

    useLayoutEffect(() => {
        if (giveFocusRef) {
            giveFocusRef.current = () => {
                realInputRef.current?.focus();
                return true;
            };
        }
        return () => {
            if (giveFocusRef) {
                giveFocusRef.current = null;
            }
        };
    }, []);

    useLayoutEffect(() => {
        if (anchorRef.current && modalRef.current) {
            const parentElement = anchorRef.current.closest(".block-frame-default-header");
            modalRef.current.style.top = `${parentElement?.getBoundingClientRect().height}px`;
        }
    }, []);

    const renderBackdrop = (onClick) => <div className="type-ahead-modal-backdrop" onClick={onClick}></div>;

    const handleKeyDown = (e) => {
        onKeyDown && onKeyDown(e);
    };

    const handleChange = (value) => {
        onChange && onChange(value);
    };

    const handleSelect = (value) => {
        onSelect && onSelect(value);
    };

    const renderModal = () => (
        <div className="type-ahead-modal-wrapper" onKeyDown={handleKeyDown}>
            {renderBackdrop(onClickBackdrop)}
            <div
                ref={modalRef}
                className={clsx("type-ahead-modal", className, { "has-suggestions": suggestions?.length > 0 })}
            >
                <Input
                    ref={inputRef}
                    inputRef={realInputRef}
                    onChange={handleChange}
                    value={value}
                    autoFocus={autoFocus}
                    placeholder={label}
                    decoration={{
                        endDecoration: (
                            <InputDecoration>
                                <i className="fa-regular fa-magnifying-glass"></i>
                            </InputDecoration>
                        ),
                    }}
                />
                <div
                    ref={suggestionsWrapperRef}
                    className="suggestions-wrapper"
                    style={{
                        marginTop: suggestions?.length > 0 ? "8px" : "0",
                        overflowY: "auto",
                    }}
                >
                    {suggestions?.length > 0 && (
                        <Suggestions
                            ref={suggestionsRef}
                            suggestions={suggestions}
                            onSelect={handleSelect}
                            selectIndex={selectIndex}
                        />
                    )}
                </div>
            </div>
        </div>
    );

    if (blockRef && blockRef.current == null) {
        return null;
    }

    return ReactDOM.createPortal(renderModal(), blockRef.current);
};

export { TypeAheadModal };
